const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NIGHTSCOUT_TOKEN = process.env.NIGHTSCOUT_TOKEN;

const GLUCOSE_URL =
  process.env.GLUCOSE_URL ||
  "https://glucose.precisionbiomodeling.com";

const NIGHTSCOUT_URL =
  process.env.NIGHTSCOUT_URL ||
  "https://nightscout.precisionbiomodeling.com";

const EMAIL_FROM =
  process.env.EMAIL_FROM ||
  "Glucose Report <glucose@precisionbiomodeling.com>";

const EMAIL_TO = process.env.EMAIL_TO;

if (!RESEND_API_KEY) {
  throw new Error("Missing RESEND_API_KEY");
}

if (!NIGHTSCOUT_TOKEN) {
  throw new Error("Missing NIGHTSCOUT_TOKEN");
}

if (!EMAIL_TO) {
  throw new Error("Missing EMAIL_TO");
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    const text = await response.text();

    throw new Error(
      `Request failed ${response.status}: ${text.slice(0, 300)}`
    );
  }

  return response.json();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatPercent(value) {
  return typeof value === "number" ? `${value}%` : "—";
}

function formatLondonTime(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value || "Unknown time";
  }

  return date.toLocaleString("en-GB", {
    timeZone: "Europe/London",
    dateStyle: "short",
    timeStyle: "short"
  });
}

function getTreatmentTimestamp(treatment) {
  return (
    treatment.created_at ||
    treatment.sysTime ||
    treatment.dateString ||
    treatment.timestamp ||
    treatment.date ||
    null
  );
}

function getTreatmentTimeMs(treatment) {
  const value = getTreatmentTimestamp(treatment);

  if (typeof value === "number") {
    return value;
  }

  const parsed = Date.parse(value);

  return Number.isNaN(parsed) ? 0 : parsed;
}

function roundInsulin(value) {
  if (typeof value !== "number") {
    return null;
  }

  return Math.round(value * 100) / 100;
}

function filterTreatmentsLast24Hours(
  rawTreatments,
  generatedAt
) {
  const cutoff =
    generatedAt.getTime() -
    24 * 60 * 60 * 1000;

  return rawTreatments
    .filter((t) => {
      const timeMs =
        getTreatmentTimeMs(t);

      return (
        timeMs >= cutoff &&
        timeMs <= generatedAt.getTime()
      );
    })
    .sort(
      (a, b) =>
        getTreatmentTimeMs(a) -
        getTreatmentTimeMs(b)
    );
}

function mergePumpEvents(treatments) {
  const events = new Map();

  for (const treatment of treatments) {
    const time =
      getTreatmentTimestamp(treatment);

    if (!time) {
      continue;
    }

    /*
     * CareLink commonly creates separate treatment records
     * for insulin and pump-entered carbs at the exact same time.
     *
     * We merge records sharing the same timestamp so the human
     * report shows a single pump event.
     */
    const key =
      new Date(time).toISOString();

    if (!events.has(key)) {
      events.set(key, {
        time: key,
        insulin: null,
        pump_entered_carbs: null,
        source:
          treatment.enteredBy || null,
        event_types: [],
        uuids: []
      });
    }

    const event =
      events.get(key);

    if (
      typeof treatment.insulin === "number"
    ) {
      event.insulin =
        roundInsulin(
          treatment.insulin
        );
    }

    if (
      typeof treatment.carbs === "number"
    ) {
      event.pump_entered_carbs =
        treatment.carbs;
    }

    if (
      treatment.enteredBy &&
      !event.source
    ) {
      event.source =
        treatment.enteredBy;
    }

    if (
      treatment.eventType &&
      !event.event_types.includes(
        treatment.eventType
      )
    ) {
      event.event_types.push(
        treatment.eventType
      );
    }

    if (
      treatment.uuid &&
      !event.uuids.includes(
        treatment.uuid
      )
    ) {
      event.uuids.push(
        treatment.uuid
      );
    }
  }

  return [...events.values()]
    .filter(
      (event) =>
        event.insulin !== null ||
        event.pump_entered_carbs !== null
    )
    .sort(
      (a, b) =>
        new Date(a.time).getTime() -
        new Date(b.time).getTime()
    );
}

function buildPumpEventRows(
  pumpEvents
) {
  if (!pumpEvents.length) {
    return `
      <tr>
        <td colspan="4">
          No pump events found in the previous 24 hours.
        </td>
      </tr>
    `;
  }

  return pumpEvents
    .map((event) => {
      const insulin =
        event.insulin !== null
          ? `${event.insulin} U`
          : "—";

      const pumpCarbs =
        event.pump_entered_carbs !== null
          ? `${event.pump_entered_carbs} g`
          : "—";

      return `
        <tr>
          <td>
            ${escapeHtml(
              formatLondonTime(
                event.time
              )
            )}
          </td>

          <td>
            ${escapeHtml(insulin)}
          </td>

          <td>
            ${escapeHtml(pumpCarbs)}
          </td>

          <td>
            ${escapeHtml(
              event.source || "—"
            )}
          </td>
        </tr>
      `;
    })
    .join("");
}

async function main() {
  console.log(
    "Fetching 24-hour glucose and treatment data..."
  );

  const generatedAt =
    new Date();

  const treatmentsUrl =
    `${NIGHTSCOUT_URL}/api/v1/treatments.json?count=1000&token=` +
    encodeURIComponent(
      NIGHTSCOUT_TOKEN
    );

  const [
    summary,
    readings,
    rawTreatments
  ] = await Promise.all([
    getJson(
      `${GLUCOSE_URL}/summary`
    ),

    getJson(
      `${GLUCOSE_URL}/readings?hours=24`
    ),

    getJson(
      treatmentsUrl
    )
  ]);

  const treatments =
    filterTreatmentsLast24Hours(
      rawTreatments,
      generatedAt
    );

  const pumpEvents =
    mergePumpEvents(
      treatments
    );

  const subject =
    `Glucose 24h Report — ${generatedAt.toLocaleString(
      "en-GB",
      {
        timeZone:
          "Europe/London",
        dateStyle:
          "medium",
        timeStyle:
          "short"
      }
    )}`;

  const interpretationNotes = {
    glucose:
      "Libre glucose data. Treat as CGM measurements rather than confirmed blood glucose.",

    insulin:
      "Delivered insulin from CareLink. Use as the primary dosing signal.",

    pump_entered_carbs:
      "Pump-entered carbohydrate values may be estimates or may have been entered to obtain a desired insulin dose. Do not assume they represent carbohydrate actually eaten.",

    meal_detection:
      "Do not infer a meal solely from a pump-entered carbohydrate value.",

    correction_detection:
      "Do not infer whether a bolus was for food or correction unless additional evidence is available."
  };

  /*
   * Keep all source data in the email so future analysis
   * can be re-done without relying on the human-readable table.
   */
  const rawData =
    JSON.stringify(
      {
        generated_at:
          generatedAt.toISOString(),

        period_hours: 24,

        interpretation_notes:
          interpretationNotes,

        summary,

        readings:
          readings.readings || [],

        pump_events:
          pumpEvents,

        raw_treatments:
          treatments
      },
      null,
      2
    );

  const pumpEventRows =
    buildPumpEventRows(
      pumpEvents
    );

  const html = `
<!doctype html>
<html>
  <body
    style="
      font-family: Arial, sans-serif;
      line-height: 1.5;
    "
  >

    <h1>
      24-hour Glucose Report
    </h1>

    <p>
      Generated:
      ${escapeHtml(
        generatedAt.toLocaleString(
          "en-GB",
          {
            timeZone:
              "Europe/London",

            dateStyle:
              "full",

            timeStyle:
              "short"
          }
        )
      )}
    </p>

    <h2>
      Glucose Summary
    </h2>

    <table
      cellpadding="6"
      cellspacing="0"
      border="1"
      style="
        border-collapse:
          collapse;
      "
    >
      <tr>
        <td>
          <strong>
            Readings
          </strong>
        </td>

        <td>
          ${escapeHtml(
            summary.readings
          )}
        </td>
      </tr>

      <tr>
        <td>
          <strong>
            Mean glucose
          </strong>
        </td>

        <td>
          ${escapeHtml(
            summary.mean_mmol
          )}
          mmol/L
        </td>
      </tr>

      <tr>
        <td>
          <strong>
            Minimum
          </strong>
        </td>

        <td>
          ${escapeHtml(
            summary.min_mmol
          )}
          mmol/L
        </td>
      </tr>

      <tr>
        <td>
          <strong>
            Maximum
          </strong>
        </td>

        <td>
          ${escapeHtml(
            summary.max_mmol
          )}
          mmol/L
        </td>
      </tr>

      <tr>
        <td>
          <strong>
            Standard deviation
          </strong>
        </td>

        <td>
          ${escapeHtml(
            summary.sd_mmol
          )}
          mmol/L
        </td>
      </tr>

      <tr>
        <td>
          <strong>
            CV
          </strong>
        </td>

        <td>
          ${escapeHtml(
            summary.cv_pct
          )}%
        </td>
      </tr>

      <tr>
        <td>
          <strong>
            Time in range
            3.9–10.0
          </strong>
        </td>

        <td>
          ${formatPercent(
            summary
              .time_in_range_3_9_to_10_pct
          )}
        </td>
      </tr>

      <tr>
        <td>
          <strong>
            Below 3.9
          </strong>
        </td>

        <td>
          ${formatPercent(
            summary
              .time_below_3_9_pct
          )}
        </td>
      </tr>

      <tr>
        <td>
          <strong>
            Below 3.0
          </strong>
        </td>

        <td>
          ${formatPercent(
            summary
              .time_below_3_0_pct
          )}
        </td>
      </tr>

      <tr>
        <td>
          <strong>
            Above 10.0
          </strong>
        </td>

        <td>
          ${formatPercent(
            summary
              .time_above_10_pct
          )}
        </td>
      </tr>

      <tr>
        <td>
          <strong>
            Above 13.9
          </strong>
        </td>

        <td>
          ${formatPercent(
            summary
              .time_above_13_9_pct
          )}
        </td>
      </tr>
    </table>

    <h2>
      Latest Reading
    </h2>

    <p>
      ${
        summary.newest
          ? `
            ${escapeHtml(
              summary
                .newest
                .sgv_mmol
            )}
            mmol/L

            —

            ${escapeHtml(
              summary
                .newest
                .direction
            )}

            —

            ${escapeHtml(
              summary
                .newest
                .dateString
            )}
          `
          : "No latest reading available"
      }
    </p>

    <h2>
      Pump Events
    </h2>

    <p>
      ${pumpEvents.length}
      pump event(s) found
      in the previous
      24 hours.
    </p>

    <p>
      <strong>
        Note:
      </strong>

      Pump-entered carbs
      are contextual only
      and should not be
      assumed to represent
      carbohydrate actually
      eaten.
    </p>

    <table
      cellpadding="6"
      cellspacing="0"
      border="1"
      style="
        border-collapse:
          collapse;
      "
    >
      <tr>
        <th>
          Time
        </th>

        <th>
          Insulin
        </th>

        <th>
          Pump-entered carbs
        </th>

        <th>
          Source
        </th>
      </tr>

      ${pumpEventRows}

    </table>

    <h2>
      Machine-readable
      24-hour Dataset
    </h2>

    <p>
      The complete glucose,
      pump-event and raw
      treatment dataset is
      included below for
      later analysis.
    </p>

    <pre
      style="
        white-space:
          pre-wrap;

        font-family:
          monospace;

        font-size:
          11px;

        background:
          #f4f4f4;

        padding:
          12px;

        border-radius:
          6px;
      "
    >${escapeHtml(
      rawData
    )}</pre>

  </body>
</html>
  `;

  console.log(
    `Sending report containing ${
      readings.readings?.length ||
      0
    } glucose readings, ${
      treatments.length
    } raw treatment records and ${
      pumpEvents.length
    } merged pump events...`
  );

  const response =
    await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${RESEND_API_KEY}`,

          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            from:
              EMAIL_FROM,

            to: [
              EMAIL_TO
            ],

            subject,

            html
          })
      }
    );

  if (!response.ok) {
    const text =
      await response.text();

    throw new Error(
      `Resend returned ${response.status}: ${text}`
    );
  }

  const result =
    await response.json();

  console.log(
    "Glucose report sent successfully."
  );

  console.log(
    `Resend message ID: ${result.id}`
  );
}

main().catch(
  (error) => {
    console.error(
      "Glucose email job failed:"
    );

    console.error(
      error
    );

    process.exit(1);
  }
);

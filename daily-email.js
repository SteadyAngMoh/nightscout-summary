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

function round(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
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

function filterTreatmentsByHours(
  rawTreatments,
  generatedAt,
  hours
) {
  const cutoff =
    generatedAt.getTime() -
    hours * 60 * 60 * 1000;

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

    let key;

    try {
      key =
        new Date(time).toISOString();
    } catch {
      continue;
    }

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
          No pump events found in the previous 48 hours.
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

function calculateDataQuality(readings, hours) {
  const valid = readings
    .filter(
      (r) =>
        r &&
        typeof r.time === "string" &&
        typeof r.mmol === "number"
    )
    .map((r) => ({
      time: new Date(r.time),
      mmol: r.mmol
    }))
    .filter(
      (r) =>
        !Number.isNaN(
          r.time.getTime()
        )
    )
    .sort(
      (a, b) =>
        a.time.getTime() -
        b.time.getTime()
    );

  const expectedReadings =
    Math.round(
      hours * 12
    );

  if (!valid.length) {
    return {
      expected_readings:
        expectedReadings,
      actual_readings: 0,
      completeness_pct: 0,
      first_reading: null,
      last_reading: null,
      largest_gap_minutes: null,
      gaps_over_10_min: 0,
      gaps_over_20_min: 0
    };
  }

  let largestGapMinutes = 0;
  let gapsOver10 = 0;
  let gapsOver20 = 0;

  for (
    let i = 1;
    i < valid.length;
    i += 1
  ) {
    const gapMinutes =
      (
        valid[i].time.getTime() -
        valid[i - 1].time.getTime()
      ) /
      60000;

    if (
      gapMinutes >
      largestGapMinutes
    ) {
      largestGapMinutes =
        gapMinutes;
    }

    if (gapMinutes > 10) {
      gapsOver10 += 1;
    }

    if (gapMinutes > 20) {
      gapsOver20 += 1;
    }
  }

  const completeness =
    expectedReadings > 0
      ? (
          valid.length /
          expectedReadings
        ) * 100
      : 0;

  return {
    expected_readings:
      expectedReadings,

    actual_readings:
      valid.length,

    completeness_pct:
      round(
        Math.min(
          completeness,
          100
        ),
        1
      ),

    first_reading:
      valid[0].time.toISOString(),

    last_reading:
      valid[
        valid.length - 1
      ].time.toISOString(),

    largest_gap_minutes:
      round(
        largestGapMinutes,
        1
      ),

    gaps_over_10_min:
      gapsOver10,

    gaps_over_20_min:
      gapsOver20
  };
}

function buildDataQualityRows(
  quality
) {
  return `
    <tr>
      <td>
        <strong>
          Expected readings
        </strong>
      </td>

      <td>
        ${escapeHtml(
          quality.expected_readings
        )}
      </td>
    </tr>

    <tr>
      <td>
        <strong>
          Actual readings
        </strong>
      </td>

      <td>
        ${escapeHtml(
          quality.actual_readings
        )}
      </td>
    </tr>

    <tr>
      <td>
        <strong>
          Data completeness
        </strong>
      </td>

      <td>
        ${escapeHtml(
          quality.completeness_pct
        )}%
      </td>
    </tr>

    <tr>
      <td>
        <strong>
          First reading
        </strong>
      </td>

      <td>
        ${escapeHtml(
          quality.first_reading
            ? formatLondonTime(
                quality.first_reading
              )
            : "—"
        )}
      </td>
    </tr>

    <tr>
      <td>
        <strong>
          Last reading
        </strong>
      </td>

      <td>
        ${escapeHtml(
          quality.last_reading
            ? formatLondonTime(
                quality.last_reading
              )
            : "—"
        )}
      </td>
    </tr>

    <tr>
      <td>
        <strong>
          Largest gap
        </strong>
      </td>

      <td>
        ${
          quality.largest_gap_minutes !==
          null
            ? `${escapeHtml(
                quality.largest_gap_minutes
              )} min`
            : "—"
        }
      </td>
    </tr>

    <tr>
      <td>
        <strong>
          Gaps &gt;10 min
        </strong>
      </td>

      <td>
        ${escapeHtml(
          quality.gaps_over_10_min
        )}
      </td>
    </tr>

    <tr>
      <td>
        <strong>
          Gaps &gt;20 min
        </strong>
      </td>

      <td>
        ${escapeHtml(
          quality.gaps_over_20_min
        )}
      </td>
    </tr>
  `;
}

async function main() {
  console.log(
    "Fetching 24-hour summary and 48-hour glucose/treatment data..."
  );

  const generatedAt =
    new Date();

  const treatmentsUrl =
    `${NIGHTSCOUT_URL}/api/v1/treatments.json?count=2000&token=` +
    encodeURIComponent(
      NIGHTSCOUT_TOKEN
    );

  const [
    summary24h,
    readings48hResponse,
    rawTreatments
  ] = await Promise.all([
    getJson(
      `${GLUCOSE_URL}/summary`
    ),

    getJson(
      `${GLUCOSE_URL}/readings?hours=48`
    ),

    getJson(
      treatmentsUrl
    )
  ]);

  const readings48h =
    readings48hResponse.readings ||
    [];

  const treatments48h =
    filterTreatmentsByHours(
      rawTreatments,
      generatedAt,
      48
    );

  const pumpEvents48h =
    mergePumpEvents(
      treatments48h
    );

  const dataQuality48h =
    calculateDataQuality(
      readings48h,
      48
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
      "Do not infer whether a bolus was for food or correction unless additional evidence is available.",

    data_window:
      "Headline glucose statistics cover the latest 24 hours. Raw glucose and pump data cover the latest 48 hours for context and trend reconstruction."
  };

  const rawData =
    JSON.stringify(
      {
        generated_at:
          generatedAt.toISOString(),

        headline_period_hours: 24,

        raw_data_period_hours: 48,

        interpretation_notes:
          interpretationNotes,

        summary_24h:
          summary24h,

        data_quality_48h:
          dataQuality48h,

        readings_48h:
          readings48h,

        pump_events_48h:
          pumpEvents48h,

        raw_treatments_48h:
          treatments48h
      },
      null,
      2
    );

  const pumpEventRows =
    buildPumpEventRows(
      pumpEvents48h
    );

  const dataQualityRows =
    buildDataQualityRows(
      dataQuality48h
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

    <p>
      Headline statistics cover the latest
      <strong>24 hours</strong>.
      Raw glucose and pump-event data cover the latest
      <strong>48 hours</strong>.
    </p>

    <h2>
      Glucose Summary — 24 hours
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
            summary24h.readings
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
            summary24h.mean_mmol
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
            summary24h.min_mmol
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
            summary24h.max_mmol
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
            summary24h.sd_mmol
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
            summary24h.cv_pct
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
            summary24h
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
            summary24h
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
            summary24h
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
            summary24h
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
            summary24h
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
        summary24h.newest
          ? `
            ${escapeHtml(
              summary24h
                .newest
                .sgv_mmol
            )}
            mmol/L

            —

            ${escapeHtml(
              summary24h
                .newest
                .direction
            )}

            —

            ${escapeHtml(
              summary24h
                .newest
                .dateString
            )}
          `
          : "No latest reading available"
      }
    </p>

    <h2>
      Data Quality — 48 hours
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
      ${dataQualityRows}
    </table>

    <h2>
      Pump Events — 48 hours
    </h2>

    <p>
      ${pumpEvents48h.length}
      pump event(s) found in
      the previous 48 hours.
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
      Machine-readable Dataset
    </h2>

    <p>
      Headline metrics cover
      24 hours. Raw glucose,
      pump-event and raw
      treatment data cover
      48 hours for context.
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
      readings48h.length
    } glucose readings over 48h, ${
      treatments48h.length
    } raw treatment records and ${
      pumpEvents48h.length
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

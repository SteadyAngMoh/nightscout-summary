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

function normaliseTreatments(treatments, generatedAt) {
  const cutoff =
    generatedAt.getTime() - 24 * 60 * 60 * 1000;

  return treatments
    .filter((t) => {
      const time =
        t.created_at ||
        t.sysTime ||
        t.timestamp;

      const parsed =
        typeof time === "number"
          ? time
          : Date.parse(time);

      return (
        Number.isFinite(parsed) &&
        parsed >= cutoff &&
        parsed <= generatedAt.getTime()
      );
    })
    .map((t) => ({
      time:
        t.created_at ||
        t.sysTime ||
        t.timestamp ||
        null,

      insulin:
        typeof t.insulin === "number"
          ? Math.round(t.insulin * 100) / 100
          : null,

      carbs:
        typeof t.carbs === "number"
          ? t.carbs
          : null,

      eventType:
        t.eventType || null,

      enteredBy:
        t.enteredBy || null,

      uuid:
        t.uuid || null
    }))
    .filter(
      (t) =>
        t.insulin !== null ||
        t.carbs !== null
    )
    .sort((a, b) => {
      return (
        new Date(a.time).getTime() -
        new Date(b.time).getTime()
      );
    });
}

function buildTreatmentRows(treatments) {
  if (!treatments.length) {
    return `
      <tr>
        <td colspan="4">No insulin/carbohydrate treatments found in the last 24 hours.</td>
      </tr>
    `;
  }

  return treatments
    .map((t) => {
      const insulin =
        t.insulin !== null
          ? `${t.insulin} U`
          : "—";

      const carbs =
        t.carbs !== null
          ? `${t.carbs} g`
          : "—";

      return `
        <tr>
          <td>${escapeHtml(formatLondonTime(t.time))}</td>
          <td>${escapeHtml(insulin)}</td>
          <td>${escapeHtml(carbs)}</td>
          <td>${escapeHtml(t.enteredBy || "—")}</td>
        </tr>
      `;
    })
    .join("");
}

async function main() {
  console.log("Fetching 24-hour glucose and treatment data...");

  const generatedAt = new Date();

  const treatmentsUrl =
    `${NIGHTSCOUT_URL}/api/v1/treatments.json?count=1000&token=` +
    encodeURIComponent(NIGHTSCOUT_TOKEN);

  const [summary, readings, rawTreatments] =
    await Promise.all([
      getJson(`${GLUCOSE_URL}/summary`),
      getJson(`${GLUCOSE_URL}/readings?hours=24`),
      getJson(treatmentsUrl)
    ]);

  const treatments =
    normaliseTreatments(
      rawTreatments,
      generatedAt
    );

  const subject =
    `Glucose 24h Report — ${generatedAt.toLocaleString("en-GB", {
      timeZone: "Europe/London",
      dateStyle: "medium",
      timeStyle: "short"
    })}`;

  /*
   * Keep all glucose readings and treatment events in the email
   * so ChatGPT can analyse the complete timeline later.
   */
  const rawData = JSON.stringify(
    {
      generated_at: generatedAt.toISOString(),
      period_hours: 24,
      summary,
      readings: readings.readings || [],
      treatments
    },
    null,
    2
  );

  const treatmentRows =
    buildTreatmentRows(treatments);

  const html = `
<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; line-height: 1.5;">
    <h1>24-hour Glucose Report</h1>

    <p>
      Generated:
      ${escapeHtml(
        generatedAt.toLocaleString("en-GB", {
          timeZone: "Europe/London",
          dateStyle: "full",
          timeStyle: "short"
        })
      )}
    </p>

    <h2>Summary</h2>

    <table cellpadding="6" cellspacing="0" border="1"
      style="border-collapse: collapse;">
      <tr>
        <td><strong>Readings</strong></td>
        <td>${escapeHtml(summary.readings)}</td>
      </tr>

      <tr>
        <td><strong>Mean glucose</strong></td>
        <td>${escapeHtml(summary.mean_mmol)} mmol/L</td>
      </tr>

      <tr>
        <td><strong>Minimum</strong></td>
        <td>${escapeHtml(summary.min_mmol)} mmol/L</td>
      </tr>

      <tr>
        <td><strong>Maximum</strong></td>
        <td>${escapeHtml(summary.max_mmol)} mmol/L</td>
      </tr>

      <tr>
        <td><strong>Standard deviation</strong></td>
        <td>${escapeHtml(summary.sd_mmol)} mmol/L</td>
      </tr>

      <tr>
        <td><strong>CV</strong></td>
        <td>${escapeHtml(summary.cv_pct)}%</td>
      </tr>

      <tr>
        <td><strong>Time in range 3.9–10.0</strong></td>
        <td>${formatPercent(
          summary.time_in_range_3_9_to_10_pct
        )}</td>
      </tr>

      <tr>
        <td><strong>Below 3.9</strong></td>
        <td>${formatPercent(
          summary.time_below_3_9_pct
        )}</td>
      </tr>

      <tr>
        <td><strong>Below 3.0</strong></td>
        <td>${formatPercent(
          summary.time_below_3_0_pct
        )}</td>
      </tr>

      <tr>
        <td><strong>Above 10.0</strong></td>
        <td>${formatPercent(
          summary.time_above_10_pct
        )}</td>
      </tr>

      <tr>
        <td><strong>Above 13.9</strong></td>
        <td>${formatPercent(
          summary.time_above_13_9_pct
        )}</td>
      </tr>
    </table>

    <h2>Latest reading</h2>

    <p>
      ${
        summary.newest
          ? `${escapeHtml(summary.newest.sgv_mmol)} mmol/L
             — ${escapeHtml(summary.newest.direction)}
             — ${escapeHtml(summary.newest.dateString)}`
          : "No latest reading available"
      }
    </p>

    <h2>Insulin & Carbohydrate Treatments</h2>

    <p>
      ${treatments.length} treatment event(s) found in the previous 24 hours.
    </p>

    <table cellpadding="6" cellspacing="0" border="1"
      style="border-collapse: collapse;">
      <tr>
        <th>Time</th>
        <th>Insulin</th>
        <th>Carbs</th>
        <th>Source</th>
      </tr>

      ${treatmentRows}
    </table>

    <h2>Machine-readable 24-hour dataset</h2>

    <p>
      The complete glucose and treatment dataset is included below
      so it can be analysed later.
    </p>

    <pre style="
      white-space: pre-wrap;
      font-family: monospace;
      font-size: 11px;
      background: #f4f4f4;
      padding: 12px;
      border-radius: 6px;
    ">${escapeHtml(rawData)}</pre>

  </body>
</html>
  `;

  console.log(
    `Sending report containing ${
      readings.readings?.length || 0
    } glucose readings and ${
      treatments.length
    } treatment events...`
  );

  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",

      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [EMAIL_TO],
        subject,
        html
      })
    }
  );

  if (!response.ok) {
    const text = await response.text();

    throw new Error(
      `Resend returned ${response.status}: ${text}`
    );
  }

  const result = await response.json();

  console.log("Glucose report sent successfully.");
  console.log(`Resend message ID: ${result.id}`);
}

main().catch((error) => {
  console.error("Glucose email job failed:");
  console.error(error);

  process.exit(1);
});

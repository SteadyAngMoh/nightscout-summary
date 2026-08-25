const RESEND_API_KEY = process.env.RESEND_API_KEY;

const GLUCOSE_URL =
  process.env.GLUCOSE_URL ||
  "https://glucose.precisionbiomodeling.com";

const EMAIL_FROM =
  process.env.EMAIL_FROM ||
  "Glucose Report <glucose@precisionbiomodeling.com>";

const EMAIL_TO = process.env.EMAIL_TO;

if (!RESEND_API_KEY) {
  throw new Error("Missing RESEND_API_KEY");
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

async function main() {
  console.log("Fetching 24-hour glucose data...");

  const [summary, readings] = await Promise.all([
    getJson(`${GLUCOSE_URL}/summary`),
    getJson(`${GLUCOSE_URL}/readings?hours=24`)
  ]);

  const generatedAt = new Date();

  const subject =
    `Glucose 24h Report — ${generatedAt.toLocaleString("en-GB", {
      timeZone: "Europe/London",
      dateStyle: "medium",
      timeStyle: "short"
    })}`;

  /*
   * Keep the complete readings in the email.
   * This means ChatGPT can later analyse the individual glucose
   * measurements rather than relying only on the summary.
   */
  const rawData = JSON.stringify(
    {
      generated_at: generatedAt.toISOString(),
      period_hours: 24,
      summary,
      readings: readings.readings || []
    },
    null,
    2
  );

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

    <h2>Machine-readable 24-hour dataset</h2>

    <p>
      The complete glucose dataset is included below so it can be
      analysed later.
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
    } glucose readings...`
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

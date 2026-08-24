import http from "node:http";

const PORT = process.env.PORT || 8080;
const NIGHTSCOUT_URL = process.env.NIGHTSCOUT_URL;
const NIGHTSCOUT_TOKEN = process.env.NIGHTSCOUT_TOKEN;

if (!NIGHTSCOUT_URL || !NIGHTSCOUT_TOKEN) {
  throw new Error("Missing NIGHTSCOUT_URL or NIGHTSCOUT_TOKEN");
}

function mgdlToMmol(mgdl) {
  return mgdl / 18.0;
}

function round(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

async function fetchEntries(count = 288) {
  const base = NIGHTSCOUT_URL.replace(/\/$/, "");

  const url =
    `${base}/api/v1/entries.json?count=${count}&token=` +
    encodeURIComponent(NIGHTSCOUT_TOKEN);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    const text = await response.text();

    throw new Error(
      `Nightscout returned ${response.status}: ${text.slice(0, 300)}`
    );
  }

  return response.json();
}

function calculateSummary(entries) {
  const values = entries
    .filter((e) => typeof e.sgv === "number")
    .map((e) => e.sgv);

  if (!values.length) {
    return {
      readings: 0,
      error: "No SGV readings found"
    };
  }

  const mmol = values.map(mgdlToMmol);

  const mean =
    mmol.reduce((sum, value) => sum + value, 0) / mmol.length;

  const variance =
    mmol.reduce(
      (sum, value) => sum + (value - mean) ** 2,
      0
    ) / mmol.length;

  const sd = Math.sqrt(variance);

  const cv =
    mean > 0
      ? (sd / mean) * 100
      : null;

  const below54 =
    mmol.filter((v) => v < 3.0).length;

  const below70 =
    mmol.filter((v) => v < 3.9).length;

  const inRange =
    mmol.filter(
      (v) => v >= 3.9 && v <= 10.0
    ).length;

  const above180 =
    mmol.filter((v) => v > 10.0).length;

  const above250 =
    mmol.filter((v) => v > 13.9).length;

  const pct = (count) =>
    round(
      (count / mmol.length) * 100,
      1
    );

  return {
    period_hours_approx:
      round((entries.length * 5) / 60, 1),

    readings: mmol.length,

    mean_mmol:
      round(mean, 1),

    min_mmol:
      round(Math.min(...mmol), 1),

    max_mmol:
      round(Math.max(...mmol), 1),

    sd_mmol:
      round(sd, 1),

    cv_pct:
      cv === null
        ? null
        : round(cv, 1),

    time_below_3_0_pct:
      pct(below54),

    time_below_3_9_pct:
      pct(below70),

    time_in_range_3_9_to_10_pct:
      pct(inRange),

    time_above_10_pct:
      pct(above180),

    time_above_13_9_pct:
      pct(above250),

    newest:
      entries[0]
        ? {
            dateString:
              entries[0].dateString,

            sgv_mgdl:
              entries[0].sgv,

            sgv_mmol:
              round(
                mgdlToMmol(entries[0].sgv),
                1
              ),

            direction:
              entries[0].direction
          }
        : null
  };
}

function makeReadings(entries) {
  return entries
    .filter(
      (e) =>
        typeof e.sgv === "number" &&
        typeof e.dateString === "string"
    )
    .map((e) => ({
      time: e.dateString,
      mmol: round(
        mgdlToMmol(e.sgv),
        1
      )
    }))
    .reverse();
}

const server = http.createServer(
  async (req, res) => {
    try {
      const requestUrl =
        new URL(
          req.url,
          `http://${req.headers.host}`
        );

      // Log every request so we can see
      // exactly what the M5Stacks request.
      console.log(
        `${new Date().toISOString()} ${req.method} ${req.url}`
      );

      /*
       * HEALTH CHECK
       */
      if (
        requestUrl.pathname === "/health"
      ) {
        res.writeHead(200, {
          "content-type":
            "application/json"
        });

        res.end(
          JSON.stringify({
            status: "ok"
          })
        );

        return;
      }

      /*
       * ROBOTS.TXT
       */
      if (
        requestUrl.pathname ===
        "/robots.txt"
      ) {
        res.writeHead(200, {
          "content-type":
            "text/plain; charset=utf-8",

          "cache-control":
            "public, max-age=3600"
        });

        res.end(
`User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: *
Allow: /`
        );

        return;
      }

      /*
       * HOMEPAGE
       */
      if (
        requestUrl.pathname === "/"
      ) {
        res.writeHead(200, {
          "content-type":
            "text/html; charset=utf-8",

          "cache-control":
            "public, max-age=300"
        });

        res.end(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Glucose Data API</title>
</head>

<body>
  <h1>Glucose Data API</h1>

  <p>
    Read-only glucose data endpoint.
  </p>

  <p>
    <a href="/summary">
      24-hour glucose summary
    </a>
  </p>

  <p>
    <a href="/readings?hours=24">
      24-hour glucose readings
    </a>
  </p>
</body>
</html>
        `);

        return;
      }

            /*
       * NIGHTSCOUT V2 PROPERTIES
       *
       * Required by the M5Stack.
       */
      if (
        requestUrl.pathname.startsWith(
          "/api/v2/properties/"
        )
      ) {
        const base =
          NIGHTSCOUT_URL.replace(/\/$/, "");

        const upstreamUrl =
          `${base}${requestUrl.pathname}`;

        const response =
          await fetch(upstreamUrl, {
            headers: {
              Accept: "application/json",
              Authorization:
                `Bearer ${NIGHTSCOUT_TOKEN}`
            }
          });

        if (!response.ok) {
          const text =
            await response.text();

          throw new Error(
            `Nightscout properties returned ${response.status}: ${text.slice(0, 300)}`
          );
        }

        const data =
          await response.json();

        res.writeHead(200, {
          "content-type":
            "application/json",
          "cache-control":
            "no-store"
        });

        res.end(JSON.stringify(data));
        return;
      }

      /*
       * NIGHTSCOUT STATUS
       *
       * Required by some Nightscout clients.
       */
      if (
        requestUrl.pathname ===
        "/api/v1/status.json"
      ) {
        const base =
          NIGHTSCOUT_URL.replace(
            /\/$/,
            ""
          );

        const url =
          `${base}/api/v1/status.json?token=` +
          encodeURIComponent(
            NIGHTSCOUT_TOKEN
          );

        const response =
          await fetch(
            url,
            {
              headers: {
                Accept:
                  "application/json"
              }
            }
          );

        if (!response.ok) {
          const text =
            await response.text();

          throw new Error(
            `Nightscout status returned ${response.status}: ${text.slice(0, 300)}`
          );
        }

        const status =
          await response.json();

        res.writeHead(200, {
          "content-type":
            "application/json",

          "cache-control":
            "no-store"
        });

        res.end(
          JSON.stringify(status)
        );

        return;
      }

      /*
       * NIGHTSCOUT ENTRIES
       *
       * Used by the M5Stacks to retrieve
       * glucose readings.
       */
      if (
        requestUrl.pathname ===
        "/api/v1/entries.json"
      ) {
        const count =
          Math.min(
            Math.max(
              Number(
                requestUrl.searchParams.get(
                  "count"
                ) || 1
              ),
              1
            ),
            288
          );

        const entries =
          await fetchEntries(count);

        const output =
          entries.map((e) => ({
            _id: e._id,
            device: e.device,
            date: e.date,
            dateString:
              e.dateString,
            sgv: e.sgv,
            delta: e.delta,
            direction:
              e.direction,
            type:
              e.type || "sgv",
            sysTime:
              e.sysTime,
            utcOffset:
              e.utcOffset,
            mills:
              e.mills
          }));

        res.writeHead(200, {
          "content-type":
            "application/json",

          "cache-control":
            "no-store"
        });

        res.end(
          JSON.stringify(output)
        );

        return;
      }

      /*
       * 24-HOUR SUMMARY
       */
      if (
        requestUrl.pathname ===
        "/summary"
      ) {
        const entries =
          await fetchEntries(288);

        const summary =
          calculateSummary(entries);

        res.writeHead(200, {
          "content-type":
            "application/json",

          "cache-control":
            "no-store"
        });

        res.end(
          JSON.stringify(
            summary,
            null,
            2
          )
        );

        return;
      }

      /*
       * RAW GLUCOSE READINGS
       *
       * Example:
       * /readings?hours=24
       */
      if (
        requestUrl.pathname ===
        "/readings"
      ) {
        const requestedHours =
          Number(
            requestUrl.searchParams.get(
              "hours"
            ) || 24
          );

        const hours =
          Math.min(
            Math.max(
              requestedHours,
              1
            ),
            168
          );

        const count =
          Math.ceil(
            hours * 12
          );

        const entries =
          await fetchEntries(count);

        const readings =
          makeReadings(entries);

        res.writeHead(200, {
          "content-type":
            "application/json",

          "cache-control":
            "no-store"
        });

        res.end(
          JSON.stringify(
            {
              hours,
              readings
            },
            null,
            2
          )
        );

        return;
      }

      /*
       * EVERYTHING ELSE
       */
      res.writeHead(404, {
        "content-type":
          "application/json"
      });

      res.end(
        JSON.stringify({
          error: "Not found"
        })
      );
    } catch (error) {
      console.error(error);

      res.writeHead(500, {
        "content-type":
          "application/json"
      });

      res.end(
        JSON.stringify({
          error: error.message
        })
      );
    }
  }
);

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Listening on port ${PORT}`
    );
  }
);

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const LOG_FILE = path.join(__dirname, "../logs/victron-flux.log");
const HTTP_PORT = 3000;

// Serve logs with auto-refresh
app.get("/", (req, res) => {
  let logs = "";
  try {
    logs = fs.readFileSync(LOG_FILE, "utf8");
  } catch {
    logs = "No logs yet.";
  }

  res.send(`
    <html>
    <head>
      <title>Victron Flux Logs</title>
      <meta http-equiv="refresh" content="10">
      <style>
        body { font-family: monospace; background: #111; color: #0f0; padding: 1em; }
        pre { white-space: pre-wrap; }
      </style>
    </head>
    <body>
      <h1>Victron Flux Logs</h1>
      <pre>${logs}</pre>
    </body>
    </html>
  `);
});

app.listen(HTTP_PORT, () => {
  console.log(`Log server running on http://0.0.0.0:${HTTP_PORT}`);
});

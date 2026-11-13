// Local dev server: static files + the real /api/request-signals handler,
// with a stand-in n8n webhook so the whole form can be exercised without Vercel.
// Run: node tests/devserver.js   (see tests/smoke.md for the browser steps)
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
process.env.N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "http://127.0.0.1:8900/_hook";
process.env.N8N_SECRET = process.env.N8N_SECRET || "dev-secret";

const handler = require(path.join(ROOT, "api", "request-signals.js"));

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".mp4": "video/mp4", ".svg": "image/svg+xml" };

const received = [];

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/_hook") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    return req.on("end", () => {
      received.push({ headers: req.headers, body: raw });
      console.log("[stand-in n8n] hit:", raw.slice(0, 160));
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  }

  if (url.pathname === "/_received") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(received));
  }

  if (url.pathname === "/api/request-signals") return handler(req, res);

  let file = path.join(ROOT, url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, ""));
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end("not found");
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}).listen(8900, () => console.log("dev server on http://127.0.0.1:8900"));

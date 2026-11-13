// Local verification of api/request-signals.js — no Vercel, no network beyond localhost.
// Run: node tests/request-signals.selftest.js
const http = require("http");
const handler = require("../api/request-signals.js");

function mockReq({ method = "POST", body = {}, headers = {} }) {
  const chunks = [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
  const req = {
    method,
    headers: { "content-type": "application/json", origin: "https://aiverticalnetwork.com", "x-forwarded-for": "9.9.9.9", ...headers },
    socket: { remoteAddress: "9.9.9.9" },
    on(ev, fn) {
      if (ev === "data") chunks.forEach(fn);
      if (ev === "end") fn();
      return req;
    },
    destroy() {},
  };
  // readBody() checks req.body first; leave it undefined so the stream path is exercised.
  return req;
}
// Raw Node shape on purpose: the handler must not depend on Vercel's res.status().json().
function mockRes() {
  const r = { statusCode: 0, headers: {}, body: null, ended: false };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => {
    r.ended = true;
    if (typeof b === "string" && b.length) { try { r.body = JSON.parse(b); } catch { r.body = b; } }
    return r;
  };
  return r;
}

(async () => {
  let seen = null;
  const webhook = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen = { headers: req.headers, payload: JSON.parse(raw || "{}") };
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => webhook.listen(8787, r));

  let pass = 0, fail = 0;
  const check = (name, cond, extra = "") => {
    console.log((cond ? "PASS  " : "FAIL  ") + name + (extra ? "  " + extra : ""));
    cond ? pass++ : fail++;
  };

  const run = async (opts) => {
    const res = mockRes();
    await handler(mockReq(opts), res);
    return res;
  };

  process.env.N8N_WEBHOOK_URL = "http://127.0.0.1:8787/webhook";
  process.env.N8N_SECRET = "test-secret-123";

  let r = await run({ body: { trade: "bookkeeping for UK tradespeople", email: "A@B.co" } });
  check("valid submission -> 200", r.statusCode === 200 && r.body.ok === true, JSON.stringify(r.body));
  check("webhook received the payload", seen && seen.payload.trade === "bookkeeping for UK tradespeople");
  check("email normalised to lowercase", seen && seen.payload.email === "a@b.co", seen && seen.payload.email);
  check("secret header forwarded", seen && seen.headers["x-avn-secret"] === "test-secret-123");
  check("no secret leaked in response", !JSON.stringify(r.body).includes("test-secret"));

  r = await run({ body: { trade: "bookkeeping for UK tradespeople", email: "a@b.co", company_site: "http://spam.example" } });
  check("honeypot -> 200 but silent", r.statusCode === 200 && r.body.ok === true);

  r = await run({ body: { trade: "x", email: "a@b.co" } });
  check("short trade -> 400", r.statusCode === 400, JSON.stringify(r.body));

  r = await run({ body: { trade: "bookkeeping for UK tradespeople", email: "not-an-email" } });
  check("bad email -> 400", r.statusCode === 400, JSON.stringify(r.body));

  r = await run({ body: { trade: "bookkeeping for UK tradespeople", email: "a@b.co" }, headers: { origin: "https://evil.example" } });
  check("foreign origin -> 403", r.statusCode === 403, JSON.stringify(r.body));

  r = await run({ method: "GET" });
  check("GET -> 405", r.statusCode === 405);

  // form-encoded body path
  r = await run({ body: "trade=" + encodeURIComponent("AI receptionists for home services") + "&email=c%40d.co",
                  headers: { "content-type": "application/x-www-form-urlencoded" } });
  check("form-encoded accepted -> 200", r.statusCode === 200, JSON.stringify(r.body));

  // rate limit: 5 per minute, and we have spent several from 9.9.9.9 already
  let limited = false;
  for (let i = 0; i < 8 && !limited; i++) {
    const x = await run({ body: { trade: "bookkeeping for UK tradespeople", email: "a@b.co" } });
    if (x.statusCode === 429) limited = true;
  }
  check("rate limit fires -> 429", limited);

  // missing env
  delete process.env.N8N_WEBHOOK_URL;
  r = await run({ body: { trade: "bookkeeping for UK tradespeople", email: "a@b.co" }, headers: { "x-forwarded-for": "8.8.8.8" } });
  check("missing N8N_WEBHOOK_URL -> 500 with support address", r.statusCode === 500 && /support@aiverticalnetwork\.com/.test(r.body.error));

  webhook.close();
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();

// /api/request-signals — the only door on the site.
// Takes the two-field "what you sell / where to send it" form and forwards it to the
// n8n webhook. The webhook URL stays in the Vercel environment, so it never appears in
// page source, in this repo, or in a network tab.
//
// Vercel env vars to set (Project -> Settings -> Environment Variables):
//   N8N_WEBHOOK_URL   required  full URL of the n8n Webhook node
//   N8N_SECRET        strongly recommended  sent as the x-avn-secret request header;
//                     put the same value on the n8n Webhook node as Header Auth
//   ALLOWED_ORIGIN    optional  defaults to https://aiverticalnetwork.com

const SUPPORT = "support@aiverticalnetwork.com";
const WEBHOOK_TIMEOUT_MS = 9000;

// Best-effort in-process throttle. Serverless instances are ephemeral, so this is a
// speed bump, not a wall - the honeypot and the n8n side are the real filters.
const HITS = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function rateLimited(ip) {
  const now = Date.now();
  const hits = (HITS.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  HITS.set(ip, hits);
  if (HITS.size > 5000) HITS.clear(); // never let the map grow unbounded
  return hits.length > MAX_PER_WINDOW;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    let raw = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 20_000) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      const type = String(req.headers["content-type"] || "");
      try {
        if (type.includes("application/json")) return resolve(JSON.parse(raw));
        const out = {};
        for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
        resolve(out);
      } catch (err) {
        reject(new Error("unparseable body"));
      }
    });
    req.on("error", reject);
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Plain Node responder. Vercel's runtime also offers res.status().json(), but writing
// this out on the standard API keeps the function runnable under `node` and under any
// handler harness, which is how it gets tested. One less runtime assumption.
function send(res, code, payload) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "POST only." });
  }

  const allowed = (process.env.ALLOWED_ORIGIN || "https://aiverticalnetwork.com").replace(/\/+$/, "");
  const origin = String(req.headers.origin || "");
  const referer = String(req.headers.referer || "");
  const fromSite =
    origin.startsWith(allowed) ||
    referer.startsWith(allowed) ||
    // preview deployments and local dev still work
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
    /^https?:\/\/localhost(:\d+)?/.test(referer) ||
    /^https?:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin);
  if (!fromSite) {
    return send(res, 403, { error: "That request didn't come from the site." });
  }

  if (rateLimited(clientIp(req))) {
    return send(res, 429, { error: "Too many requests." });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return send(res, 400, { error: "The request body couldn't be read." });
  }

  const trade = String(body.trade || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const honeypot = String(body.company_site || "").trim();

  // Honeypot tripped: answer exactly as if it worked. Never tell a bot why.
  if (honeypot) return send(res, 200, { ok: true });

  if (trade.length < 6) {
    return send(res, 400, { error: "Tell me a bit more about what you sell — one clear sentence is enough." });
  }
  if (trade.length > 600) {
    return send(res, 400, { error: "That's longer than this form takes. Trim it to one or two sentences." });
  }
  if (!EMAIL_RE.test(email) || email.length > 200) {
    return send(res, 400, { error: "That email doesn't look right. Check it and send again." });
  }

  const webhook = process.env.N8N_WEBHOOK_URL;
  if (!webhook) {
    // Config error, not a visitor error: log loudly, tell the visitor something usable.
    console.error("[request-signals] N8N_WEBHOOK_URL is not set — nothing was forwarded.");
    return send(res, 500, {
      error: `The form isn't wired up on this deployment yet. Email ${SUPPORT} and it will be handled by hand.`,
    });
  }

  const payload = {
    source: "aiverticalnetwork.com",
    received_at: new Date().toISOString(),
    trade,
    email,
    page: String(req.headers.referer || ""),
    ip: clientIp(req),
    user_agent: String(req.headers["user-agent"] || ""),
  };

  const headers = { "Content-Type": "application/json" };
  if (process.env.N8N_SECRET) headers["x-avn-secret"] = process.env.N8N_SECRET;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const upstream = await fetch(webhook, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      console.error("[request-signals] webhook responded", upstream.status, text.slice(0, 500));
      return send(res, 502, {
        error: `The form reached the server but the handoff failed. Email ${SUPPORT} and it will be handled by hand.`,
      });
    }

    return send(res, 200, { ok: true });
  } catch (err) {
    clearTimeout(timer);
    const timedOut = err && err.name === "AbortError";
    console.error("[request-signals] forward failed:", timedOut ? "timeout" : err);
    return send(res, 504, {
      error: `The handoff took too long. Email ${SUPPORT} and it will be handled by hand.`,
    });
  }
};

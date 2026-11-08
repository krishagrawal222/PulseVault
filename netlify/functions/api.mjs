// PulseVault consent / token service (Netlify Functions v2 + Netlify Blobs).
//
// Zero-knowledge by design: the server only ever stores CIPHERTEXT of the shared
// record. The AES key lives in the QR's URL fragment (#k=...), which browsers never
// send to a server. The server's job is access control:
//   - signed (HMAC-SHA256) short-lived tokens, verified on EVERY request
//   - server-side revoke list: revocation deletes the ciphertext, so access ends on the very next request
//   - tamper-evident (hash-chained) audit log
//
// Security-state key layout (kept separate to avoid read-modify-write races with polling):
//   s:<id>  session: ciphertext, scope, expiry, revoked flag (written ONLY on create / revoke / expiry)
//   l:<id>  liveness: lastSeen, view count, latency (written by viewer polling)
//   a:<id>  audit chain
//   p:<id>  provider-proposed notes (ciphertext), awaiting patient approval
//   o:<otp> OTP -> session id

import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

// The fallback key exists for local development and tests only. On Netlify the service refuses to run without TOKEN_SECRET.
const ON_NETLIFY = !!process.env.NETLIFY;
const SECRET = process.env.TOKEN_SECRET || "dev-only-secret-set-TOKEN_SECRET-in-netlify";
const SCOPES = ["allergies", "medications", "conditions", "reports"];
const MAX_CIPHER = 300_000;

/* ---------- storage (Netlify Blobs, in-memory fallback for local dev) ---------- */
let blobs = null; // null = not probed, false = use memory
const mem = new Map();
async function backend() {
  if (blobs !== null) return blobs;
  try {
    const s = getStore({ name: "pulsevault", consistency: "strong" });
    await s.get("__probe__");
    blobs = s;
  } catch (e) {
    blobs = false;
    console.warn("[pulsevault] Netlify Blobs unavailable (" + (e && e.name) + "); using in-memory store. Fine for local dev, NOT for production.");
  }
  return blobs;
}
const db = {
  async get(k) {
    const b = await backend();
    if (b) return await b.get(k, { type: "json" });
    return mem.has(k) ? JSON.parse(mem.get(k)) : null;
  },
  async set(k, v) {
    const b = await backend();
    if (b) return await b.setJSON(k, v);
    mem.set(k, JSON.stringify(v));
  },
  async del(k) {
    const b = await backend();
    if (b) return await b.delete(k);
    mem.delete(k);
  },
};

/* ---------- helpers ---------- */
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const rand = (n) => b64u(crypto.randomBytes(n));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const signToken = (id, exp) => `${id}.${exp}.${hmac(id + "." + exp)}`;
function verifyToken(t) {
  if (typeof t !== "string") return null;
  const p = t.split(".");
  if (p.length !== 3) return null;
  const [id, exp, sig] = p;
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(id) || !/^\d{10,15}$/.test(exp)) return null;
  if (!safeEq(sig, hmac(id + "." + exp))) return null;
  return { id, exp: Number(exp) };
}

async function audit(id, ev, detail = "") {
  const log = (await db.get("a:" + id)) || [];
  const prev = log.length ? log[log.length - 1].h : "genesis";
  const t = Date.now();
  const h = sha(prev + "|" + t + "|" + ev + "|" + detail).slice(0, 24);
  log.push({ t, ev, detail, prev: prev.slice(0, 24), h });
  await db.set("a:" + id, log.slice(-100));
}

// Is the session usable right now? Returns {s} or {err,status}.
async function gate(id) {
  const s = await db.get("s:" + id);
  if (!s) return { err: "gone", status: 404 };
  if (s.revoked) return { err: "revoked", status: 410 };
  if (!s.cipher) return { err: "expired", status: 410 };
  if (Date.now() > s.exp) {
    await purge(s, "expired");
    return { err: "expired", status: 410 };
  }
  return { s };
}
async function purge(s, why) {
  // Terminal state: ciphertext and escrow key destroyed. Writes only terminal fields.
  const next = { ...s, cipher: null, iv: null, escrow: null, ended: why };
  if (why === "revoked") next.revoked = true;
  await db.set("s:" + s.id, next);
  if (s.otp) await db.del("o:" + s.otp);
  await audit(s.id, why, why === "revoked" ? "patient revoked access" : "time limit reached");
}
async function ownerAuth(req, id) {
  const s = await db.get("s:" + id);
  if (!s) return { err: json({ error: "gone" }, 404) };
  const o = req.headers.get("x-owner") || "";
  if (!o || !safeEq(sha(o), s.ownerHash)) return { err: json({ error: "unauthorized" }, 401) };
  return { s };
}
const idOk = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{8,40}$/.test(id);

/* ---------- handler ---------- */
export default async (req, context) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  try {
    if (ON_NETLIFY && !process.env.TOKEN_SECRET && route !== "health") return json({ error: "server_not_configured" }, 503);
    /* health */
    if (route === "health") {
      const b = await backend();
      return json({ ok: true, store: b ? "netlify-blobs" : "memory", secretSet: !!process.env.TOKEN_SECRET, now: Date.now() });
    }

    /* patient: create a time-bound consent session */
    if (route === "session" && req.method === "POST") {
      const b = await req.json();
      if (typeof b.cipher !== "string" || b.cipher.length > MAX_CIPHER || typeof b.iv !== "string" || b.iv.length !== 16)
        return json({ error: "bad_payload" }, 400);
      const scope = Array.isArray(b.scope) ? b.scope.filter((x) => SCOPES.includes(x)) : [];
      const ttl = Math.min(1440, Math.max(1, Number(b.ttlMin) || 15));
      const mode = b.mode === "otp" ? "otp" : "qr";
      if (mode === "otp" && (typeof b.key !== "string" || b.key.length !== 43)) return json({ error: "bad_key" }, 400);

      const id = rand(12), owner = rand(24), now = Date.now(), exp = now + ttl * 60_000;
      let otp = null;
      if (mode === "otp") {
        for (let i = 0; i < 8 && !otp; i++) {
          const c = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
          if (!(await db.get("o:" + c))) otp = c;
        }
        if (!otp) return json({ error: "try_again" }, 503);
        await db.set("o:" + otp, { id, exp });
      }
      await db.set("s:" + id, {
        id, ownerHash: sha(owner), exp, scope, allowNotes: !!b.allowNotes,
        label: String(b.label || "").slice(0, 60), cipher: b.cipher, iv: b.iv, mode,
        escrow: mode === "otp" ? b.key : null, otp, revoked: false, created: now,
      });
      await audit(id, "created", `scope=${scope.join("+") || "none"}; ${ttl} min; ${mode.toUpperCase()}; notes=${!!b.allowNotes}`);
      return json({ id, token: signToken(id, exp), exp, owner, otp });
    }

    /* provider: fetch ciphertext (or just poll consent status) */
    if (route === "access" && req.method === "GET") {
      const v = verifyToken(url.searchParams.get("t"));
      if (!v) return json({ error: "invalid_token" }, 401);
      const g = await gate(v.id);
      if (g.err) return json({ error: g.err }, g.status);
      const s = g.s;
      const live = (await db.get("l:" + v.id)) || { views: 0, firstView: null };
      live.lastSeen = Date.now();
      const lat = Number(url.searchParams.get("lat"));
      if (lat > 0 && lat < 600000) live.lastLatency = Math.round(lat);
      const poll = url.searchParams.get("poll") === "1";
      if (!poll) {
        live.views++;
        if (!live.firstView) {
          live.firstView = live.lastSeen;
          await audit(v.id, "viewed", "provider opened the record");
        }
      }
      await db.set("l:" + v.id, live);
      const base = { exp: s.exp, now: Date.now() };
      if (poll) return json({ ok: true, ...base });
      return json({ ok: true, ...base, cipher: s.cipher, iv: s.iv, scope: s.scope, allowNotes: s.allowNotes, label: s.label });
    }

    /* provider: 6-digit code fallback (lower-security tier: key is escrowed for the session's life only) */
    if (route === "otp" && req.method === "POST") {
      const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
      const rl = (await db.get("rl:" + ip)) || { n: 0, until: 0 };
      if (rl.until > Date.now() && rl.n >= 8) return json({ error: "rate_limited" }, 429);
      if (rl.until <= Date.now()) { rl.n = 0; rl.until = Date.now() + 600_000; }
      const b = await req.json();
      const code = String(b.otp || "");
      const m = /^\d{6}$/.test(code) ? await db.get("o:" + code) : null;
      const g = m ? await gate(m.id) : { err: "invalid", status: 404 };
      if (g.err) {
        rl.n++;
        await db.set("rl:" + ip, rl);
        return json({ error: g.err === "invalid" ? "invalid_code" : g.err }, g.status === 404 ? 404 : g.status);
      }
      await db.del("rl:" + ip);
      return json({ token: signToken(g.s.id, g.s.exp), key: g.s.escrow });
    }

    /* provider: propose a note / prescription (encrypted client-side; needs patient approval) */
    if (route === "propose" && req.method === "POST") {
      const b = await req.json();
      const v = verifyToken(b.t);
      if (!v) return json({ error: "invalid_token" }, 401);
      const g = await gate(v.id);
      if (g.err) return json({ error: g.err }, g.status);
      if (!g.s.allowNotes) return json({ error: "notes_not_allowed" }, 403);
      if (typeof b.cipher !== "string" || b.cipher.length > 6000 || typeof b.iv !== "string" || b.iv.length !== 16)
        return json({ error: "bad_payload" }, 400);
      const list = (await db.get("p:" + v.id)) || [];
      if (list.length >= 5) return json({ error: "too_many_pending" }, 429);
      const pid = rand(8);
      list.push({ pid, cipher: b.cipher, iv: b.iv, at: Date.now() });
      await db.set("p:" + v.id, list);
      await audit(v.id, "proposal", "provider proposed an addition (awaiting patient approval)");
      return json({ ok: true, pid });
    }

    /* patient (owner-only): status, audit, proposals */
    if (route === "status" && req.method === "GET") {
      const id = url.searchParams.get("id");
      if (!idOk(id)) return json({ error: "bad_id" }, 400);
      const a = await ownerAuth(req, id);
      if (a.err) return a.err;
      let s = a.s;
      if (!s.revoked && s.cipher && Date.now() > s.exp) { await purge(s, "expired"); s = await db.get("s:" + id); }
      const live = (await db.get("l:" + id)) || {};
      return json({
        now: Date.now(), exp: s.exp, revoked: !!s.revoked, ended: s.ended || null,
        views: live.views || 0, firstView: live.firstView || null, lastSeen: live.lastSeen || null,
        lastLatency: live.lastLatency || null,
        proposals: s.revoked || !s.cipher ? [] : (await db.get("p:" + id)) || [],
        audit: (await db.get("a:" + id)) || [],
      });
    }

    /* patient (owner-only): one-tap revoke */
    if (route === "revoke" && req.method === "POST") {
      const b = await req.json();
      if (!idOk(b.id)) return json({ error: "bad_id" }, 400);
      const a = await ownerAuth(req, b.id);
      if (a.err) return a.err;
      if (!a.s.revoked) await purge(a.s, "revoked");
      await db.del("p:" + b.id);
      return json({ ok: true, revokedAt: Date.now() });
    }

    /* patient (owner-only): approve / reject a proposal */
    if (route === "resolve" && req.method === "POST") {
      const b = await req.json();
      if (!idOk(b.id)) return json({ error: "bad_id" }, 400);
      const a = await ownerAuth(req, b.id);
      if (a.err) return a.err;
      const list = ((await db.get("p:" + b.id)) || []).filter((p) => p.pid !== b.pid);
      await db.set("p:" + b.id, list);
      await audit(b.id, b.decision === "approved" ? "proposal_approved" : "proposal_rejected", "patient decision");
      return json({ ok: true });
    }

    return json({ error: "not_found" }, 404);
  } catch (e) {
    console.error("[pulsevault] error", e);
    return json({ error: "server_error" }, 500);
  }
};

export const config = { path: "/api/*" };

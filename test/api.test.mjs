import api from "../netlify/functions/api.mjs";
import assert from "node:assert/strict";
const call = async (method, path, body, headers = {}) => {
  const r = await api(new Request("http://x" + path, { method, body: body ? JSON.stringify(body) : undefined, headers }), { ip: "1.2.3.4" });
  return { status: r.status, body: await r.json() };
};
const iv = "AAAAAAAAAAAAAAAA", cipher = "Y2lwaGVydGV4dA", key = "k".repeat(43);
let pass = 0; const ok = (n) => { pass++; console.log("  ok -", n); };

console.log("QR flow");
let c = await call("POST", "/api/session", { cipher, iv, scope: ["allergies", "medications", "evil"], ttlMin: 15, allowNotes: true, label: "PHC Anand" });
assert.equal(c.status, 200); const { id, token, owner } = c.body; ok("session created");
let a = await call("GET", "/api/access?t=" + token);
assert.equal(a.status, 200); assert.deepEqual(a.body.scope, ["allergies", "medications"]); assert.equal(a.body.cipher, cipher); ok("valid token returns ciphertext, scope filtered");
let bad = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
assert.equal((await call("GET", "/api/access?t=" + bad)).status, 401); ok("tampered token rejected");
assert.equal((await call("GET", "/api/access?t=" + token + "&poll=1&lat=812")).status, 200); ok("poll ok");
let st = await call("GET", "/api/status?id=" + id, null, { "x-owner": owner });
assert.equal(st.status, 200); assert.equal(st.body.views, 1); assert.equal(st.body.lastLatency, 812); ok("owner sees live status + latency");
assert.equal((await call("GET", "/api/status?id=" + id, null, { "x-owner": "nope" })).status, 401); ok("status needs owner secret");
assert.equal((await call("POST", "/api/revoke", { id }, { "x-owner": "nope" })).status, 401); ok("revoke needs owner secret");
let p = await call("POST", "/api/propose", { t: token, cipher: "abc", iv }); assert.equal(p.status, 200); ok("proposal accepted when allowed");
st = await call("GET", "/api/status?id=" + id, null, { "x-owner": owner }); assert.equal(st.body.proposals.length, 1); ok("patient sees pending proposal");
await call("POST", "/api/resolve", { id, pid: p.body.pid, decision: "approved" }, { "x-owner": owner });
st = await call("GET", "/api/status?id=" + id, null, { "x-owner": owner }); assert.equal(st.body.proposals.length, 0); ok("proposal resolved");
let r = await call("POST", "/api/revoke", { id }, { "x-owner": owner }); assert.equal(r.status, 200);
a = await call("GET", "/api/access?t=" + token); assert.equal(a.status, 410); assert.equal(a.body.error, "revoked"); assert.equal(a.body.cipher, undefined); ok("REVOKED: next request 410, no ciphertext");
assert.equal((await call("GET", "/api/access?t=" + token + "&poll=1")).status, 410); ok("poll also 410");
assert.equal((await call("POST", "/api/propose", { t: token, cipher: "abc", iv })).status, 410); ok("no proposals after revoke");
st = await call("GET", "/api/status?id=" + id, null, { "x-owner": owner });
const evs = st.body.audit.map((e) => e.ev); assert.deepEqual(evs, ["created", "viewed", "proposal", "proposal_approved", "revoked"]); ok("audit: " + evs.join(" > "));
for (let i = 1; i < st.body.audit.length; i++) assert.equal(st.body.audit[i].prev, st.body.audit[i - 1].h); ok("audit hash-chain links verify");

console.log("OTP flow");
c = await call("POST", "/api/session", { cipher, iv, scope: ["allergies"], ttlMin: 15, mode: "otp", key }); assert.match(c.body.otp, /^\d{6}$/);
let o = await call("POST", "/api/otp", { otp: c.body.otp }); assert.equal(o.status, 200); assert.equal(o.body.key, key);
assert.equal((await call("GET", "/api/access?t=" + o.body.token)).status, 200); ok("valid OTP -> token + key");
await call("POST", "/api/revoke", { id: c.body.id }, { "x-owner": c.body.owner });
assert.equal((await call("POST", "/api/otp", { otp: c.body.otp })).status, 404); ok("OTP dead after revoke");
for (let i = 0; i < 9; i++) await call("POST", "/api/otp", { otp: "000000" });
assert.equal((await call("POST", "/api/otp", { otp: "123456" })).status, 429); ok("OTP brute force rate-limited");

console.log("Expiry");
c = await call("POST", "/api/session", { cipher, iv, scope: ["allergies"], ttlMin: 1 });
const real = Date.now; Date.now = () => real() + 61_000;
a = await call("GET", "/api/access?t=" + c.body.token); Date.now = real;
assert.equal(a.status, 410); assert.equal(a.body.error, "expired"); ok("expired token rejected server-side");
assert.equal((await call("POST", "/api/session", { cipher: 5, iv })).status, 400); ok("bad payload rejected");
console.log("\nAll " + pass + " checks passed");

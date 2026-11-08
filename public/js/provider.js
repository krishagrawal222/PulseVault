/* PulseVault provider (point-of-care) view: no login, no install. */
(function () {
  "use strict";
  const { esc, CATS } = PV;
  const $ = (s) => document.querySelector(s);
  let S = null;            // {t, key, data, exp, skew, allowNotes, label, latency}
  let pollTimer = null, clockTimer = null, stream = null;

  PV.registerSW();
  $("#ecg").innerHTML = PV.ECG;

  /* ---------- boot: link arrival (phone camera / copied link) or saved session ---------- */
  (function boot() {
    const q = new URLSearchParams(location.search), t = q.get("t"), k = new URLSearchParams(location.hash.slice(1)).get("k");
    if (t && k) { sessionStorage.setItem("pv-s", JSON.stringify({ t, k })); history.replaceState(null, "", "/provider.html"); open(t, k, 0); return; }
    try { const sv = JSON.parse(sessionStorage.getItem("pv-s") || "null"); if (sv) open(sv.t, sv.k, performance.now()); } catch (e) {}
  })();

  /* ---------- OTP fallback ---------- */
  $("#otpbtn").onclick = async () => {
    const code = $("#otp").value.replace(/\D/g, ""), t0 = performance.now(); $("#otperr").textContent = "";
    if (code.length !== 6) return ($("#otperr").textContent = "Enter the 6-digit code.");
    const r = await PV.api("otp", { method: "POST", body: { otp: code } });
    if (!r.ok) return ($("#otperr").textContent = r.status === 429 ? "Too many wrong attempts. Wait a few minutes." : r.status === 410 ? "That access has ended." : "Invalid or expired code.");
    sessionStorage.setItem("pv-s", JSON.stringify({ t: r.data.token, k: r.data.key })); open(r.data.token, r.data.key, t0);
  };

  /* ---------- camera scanning (BarcodeDetector when available, jsQR fallback) ---------- */
  $("#scanbtn").onclick = async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    } catch (e) { return PV.toast("Camera unavailable. Use your phone's camera app to scan, or type the 6-digit code."); }
    const v = $("#video"); v.srcObject = stream; await v.play(); $("#scanwrap").classList.remove("hidden"); $("#scanbtn").classList.add("hidden");
    const det = "BarcodeDetector" in window ? new BarcodeDetector({ formats: ["qr_code"] }) : null;
    const cv = document.createElement("canvas"), cx = cv.getContext("2d", { willReadFrequently: true });
    const loop = async () => {
      if (!stream) return;
      let text = null;
      if (v.videoWidth) {
        try {
          if (det) { const r = await det.detect(v); if (r[0]) text = r[0].rawValue; }
          else { const w = Math.min(640, v.videoWidth), h = Math.round((w * v.videoHeight) / v.videoWidth); cv.width = w; cv.height = h; cx.drawImage(v, 0, 0, w, h); const img = cx.getImageData(0, 0, w, h), c = jsQR(img.data, w, h); if (c) text = c.data; }
        } catch (e) {}
      }
      if (text) {
        const t0 = performance.now();
        try { const u = new URL(text), t = u.searchParams.get("t"), k = new URLSearchParams(u.hash.slice(1)).get("k");
          if (!t || !k) throw 0; stopCam(); sessionStorage.setItem("pv-s", JSON.stringify({ t, k })); return open(t, k, t0); }
        catch (e) { $("#scanmsg").textContent = "That QR isn't a PulseVault consent code."; }
      }
      setTimeout(loop, 90);
    };
    loop();
  };
  function stopCam() { if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; $("#scanwrap").classList.add("hidden"); $("#scanbtn").classList.remove("hidden"); }

  /* ---------- open a session: fetch ciphertext, decrypt locally, render ---------- */
  async function open(t, key, t0) {
    const r = await PV.api("access?t=" + encodeURIComponent(t) + (S && S.latency ? "&lat=" + S.latency : ""));
    if (!r.ok) return fail(r.status, r.data.error);
    let data;
    try { data = await PV.decJSON(r.data.cipher, r.data.iv, key); } catch (e) { return fail(0, "decrypt"); }
    const latency = Math.round(performance.now() - t0);
    S = { t, key, data, exp: r.data.exp, skew: r.data.now - Date.now(), allowNotes: r.data.allowNotes, scope: r.data.scope, label: r.data.label, latency };
    $("#entry").classList.add("hidden"); $("#viewer").classList.remove("hidden");
    render(); PV.api("access?t=" + encodeURIComponent(t) + "&poll=1&lat=" + latency);   // report scan-to-view latency
    clearInterval(pollTimer); clearInterval(clockTimer);
    pollTimer = setInterval(poll, 2000); clockTimer = setInterval(tickClock, 500);
  }
  async function poll() {
    if (!S) return;
    const r = await PV.api("access?t=" + encodeURIComponent(S.t) + "&poll=1");
    if (r.status === 410 || r.status === 404 || r.status === 401) return fail(r.status, r.data.error);
    if (r.ok) { S.exp = r.data.exp; S.skew = r.data.now - Date.now(); }
  }
  function tickClock() {
    if (!S) return; const left = S.exp - (Date.now() + S.skew), el = $("#clk");
    if (el) el.textContent = PV.fmtClock(left);
    if (left <= 0) { poll(); }
  }
  function fail(status, why) {
    clearInterval(pollTimer); clearInterval(clockTimer); S = null; sessionStorage.removeItem("pv-s"); stopCam();
    $("#entry").classList.add("hidden"); $("#viewer").classList.remove("hidden");
    const m = { revoked: ["Access revoked by the patient", "The patient withdrew consent. The record has been cleared from this screen."],
      expired: ["Time limit reached", "This consent has expired. Ask the patient for a new QR if you still need access."],
      decrypt: ["Couldn't unlock the record", "The QR link looks incomplete or damaged. Ask the patient to generate a new one."] }[why] || ["This link isn't valid", "It may be mistyped, already ended, or tampered with. Ask the patient for a new QR."];
    $("#viewer").innerHTML = `<div class="dead" role="alert"><div style="font-size:3rem">🔒</div><h2>${m[0]}</h2><p>${m[1]}</p><button class="btn btn-teal" onclick="location.href='/provider.html'">Scan another QR</button></div>`;
  }

  /* ---------- render the Critical Snapshot ---------- */
  function section(k, title, rows) {
    if (!S.scope.includes(k)) return `<div class="card" style="margin-bottom:12px;opacity:.7"><h3 style="margin:0">${title} <span class="chip grey">Not shared by patient</span></h3></div>`;
    return `<div class="card" style="margin-bottom:12px"><h3>${title} <span class="chip">${rows.length}</span></h3>${rows.length ? rows.join("") : '<p class="muted small" style="margin:0">None recorded.</p>'}</div>`;
  }
  const row = (i, ico) => `<div class="rec ${i.high ? "high" : ""}"><div><div class="t">${ico || ""}${esc(i.title)}</div><div class="s">${esc(i.sub || "")}${i.by ? " · " + esc(i.by) : ""}</div></div></div>`;
  function render() {
    const d = S.data, p = d.profile, al = d.allergies || [], md = d.medications || [], cc = d.conditions || [], rp = d.reports || [];
    const high = al.filter((a) => a.high);
    const ok = S.latency < 3000;
    $("#viewer").innerHTML = `
      <div class="banner"><div><b style="font-size:1.1rem">${esc(p.name)}</b><div class="small" style="color:#CFE2E0">${p.age != null ? esc(p.age) + " yrs · " : ""}${p.bloodGroup ? "Blood " + esc(p.bloodGroup) + " · " : ""}${p.abha ? "ABHA " + esc(p.abha) : "Phone-verified"}</div>
        <div class="small" style="color:#CFE2E0">Shared by patient${S.label ? " with " + esc(S.label) : ""} · ${S.allowNotes ? "view + propose (patient approves)" : "view-only"}</div></div>
        <div style="text-align:right"><div class="timer" id="clk"></div><div class="small" style="color:#CFE2E0">access remaining</div></div></div>
      <div style="margin:10px 0 16px"><span class="chip ${ok ? "green" : "gold"}">⚡ Scan-to-record ${(S.latency / 1000).toFixed(2)} s ${ok ? "(under 3 s target)" : ""}</span> <span class="chip grey">decrypted on this device</span></div>
      ${S.scope.includes("allergies") && high.length ? high.map((a) => `<div class="alert"><span class="big">⚠</span><span>HIGH-RISK ALERT: ${esc(a.title).toUpperCase()} ALLERGY${a.sub ? " (" + esc(a.sub) + ")" : ""}</span></div>`).join("") : ""}
      ${S.scope.includes("allergies") && !al.length ? `<div class="warn">No allergies recorded. This may mean none are known, not that none exist.</div>` : ""}
      ${section("allergies", "⚠️ Allergies", al.map((a) => row(a)))}
      ${section("medications", "💊 Active medicines", md.map((m) => row(m)))}
      ${section("conditions", "❤️ Chronic conditions", cc.map((c) => row(c)))}
      ${section("reports", "🧪 Tests & reports", rp.map((r) => row(r)))}
      ${S.allowNotes ? proposeForm() : ""}
      <div class="row" style="margin-top:14px"><button class="btn btn-ghost" id="end">End session &amp; clear screen</button></div>
      <p class="small muted" style="margin-top:10px">Revocation stops further access and clears this screen. It cannot un-see what was already displayed. Use judgement.</p>`;
    $("#end").onclick = () => { S = null; clearInterval(pollTimer); clearInterval(clockTimer); sessionStorage.removeItem("pv-s"); location.href = "/provider.html"; };
    if (S.allowNotes) bindPropose(); tickClock();
  }

  /* ---------- propose a note / prescription (encrypted client-side, patient must approve) ---------- */
  function proposeForm() {
    return `<div class="card" style="border-color:var(--gold)"><h3>Add to patient's record <span class="chip gold">needs patient approval</span></h3>
      <div class="seg" id="pk" style="margin-bottom:12px"><button data-v="med" aria-pressed="true">Prescription</button><button data-v="note" aria-pressed="false">Note</button></div>
      <div id="pf-med"><label class="f">Medicine<input id="pn" type="text" placeholder="e.g. Amoxicillin 500 mg"></label><div class="row"><label class="f">Dose<input id="pd" type="text" placeholder="1 capsule"></label><label class="f">Frequency<input id="pq" type="text" placeholder="three times daily"></label></div></div>
      <div id="pf-note" class="hidden"><label class="f">Clinical note<textarea id="pt" maxlength="800"></textarea></label></div>
      <div id="pw"></div>
      <label class="f">Your name <span class="muted">(shown to the patient)</span><input id="pb" type="text" maxlength="60" placeholder="Dr. ..."></label>
      <button class="btn btn-teal" id="psend">Send to patient for approval</button> <span class="small muted" id="pmsg"></span></div>`;
  }
  function bindPropose() {
    let kind = "med", warns = [];
    document.querySelectorAll("#pk button").forEach((b) => (b.onclick = () => { kind = b.dataset.v; document.querySelectorAll("#pk button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); $("#pf-med").classList.toggle("hidden", kind !== "med"); $("#pf-note").classList.toggle("hidden", kind !== "note"); }));
    $("#pn").oninput = () => {
      warns = S.scope.includes("allergies") ? PV.allergyCheck($("#pn").value, (S.data.allergies || []).map((a) => ({ title: a.title, sub: a.sub }))) : [];
      $("#pw").innerHTML = warns.map((w) => `<div class="warn ${w.level === "block" ? "red" : ""}">⚠ ${esc(w.text)}</div>`).join("") + (warns.length ? `<div class="small muted">Rule-based check against recorded allergies. Not a substitute for clinical judgement.</div>` : "");
    };
    $("#psend").onclick = async () => {
      const payload = { kind, by: $("#pb").value.trim() };
      if (kind === "med") { payload.name = $("#pn").value.trim(); payload.dose = $("#pd").value.trim(); payload.freq = $("#pq").value.trim(); if (!payload.name) return ($("#pmsg").textContent = "Enter the medicine."); }
      else { payload.text = $("#pt").value.trim(); if (!payload.text) return ($("#pmsg").textContent = "Write a note first."); }
      if (warns.some((w) => w.level === "block") && !confirm("This medicine matches a recorded allergy. Send anyway? The patient will see this warning too.")) return;
      const { cipher, iv } = await PV.encJSON(payload, S.key);
      const r = await PV.api("propose", { method: "POST", body: { t: S.t, cipher, iv } });
      if (r.ok) { $("#pmsg").textContent = "Sent. Waiting for the patient to approve."; ["pn", "pd", "pq", "pt"].forEach((i) => $("#" + i) && ($("#" + i).value = "")); $("#pw").innerHTML = ""; }
      else if (r.status === 410) fail(410, r.data.error); else $("#pmsg").textContent = r.status === 429 ? "Too many pending proposals." : "Couldn't send.";
    };
  }
})();

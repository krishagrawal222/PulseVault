/* PulseVault patient app */
(function () {
  "use strict";
  const { esc, CATS, view, FHIR } = PV;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  let V = null;               // decrypted vault (in memory only)
  let tab = "vault", cat = "allergies", skew = 0, dirty = false;
  const share = { scope: new Set(["allergies", "medications", "conditions"]), ttl: 15, mode: "qr" };
  const pending = {};         // sessionId -> [decrypted proposals]
  const ago = (iso) => { const d = Math.floor((Date.now() - new Date(iso)) / 864e5); return d <= 0 ? "today" : d === 1 ? "yesterday" : d + " days ago"; };
  const clock = (t) => new Date(t).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const persist = async () => { dirty = false; await PV.saveVault(V); };

  function addAudit(ev, detail, sid) { V.audit.unshift({ t: Date.now(), src: "device", ev, detail: detail || "", sid: sid || null }); V.audit = V.audit.slice(0, 300); dirty = true; }
  const EV = { created: "Consent created", viewed: "Provider opened your record", proposal: "Provider proposed an addition", proposal_approved: "You approved a proposal",
    proposal_rejected: "You rejected a proposal", revoked: "Access revoked", expired: "Access expired", record_added: "Record added", record_removed: "Record removed",
    abha_linked: "ABHA linked (sandbox)", emergency_qr: "Emergency QR generated", vault_created: "Vault created", exported: "FHIR bundle exported" };

  /* ================= boot ================= */
  async function boot() {
    PV.registerSW();
    $("#ecg").style.flex = "1"; $("#ecg").innerHTML = PV.ECG;
    try { V = await PV.loadVault(); } catch (e) { PV.toast("Could not open the secure vault on this browser (private mode?)."); }
    if (V) showShell(); else showOnboard();
  }

  /* ================= onboarding (hybrid identity: phone OTP, ABHA optional later) ================= */
  let obCode = null;
  function showOnboard() {
    $("#onboard").classList.remove("hidden");
    $("#ob-go").onclick = async () => {
      const name = $("#ob-name").value.trim(), phone = $("#ob-phone").value.replace(/\D/g, "").slice(-10);
      if (name.length < 2) return PV.toast("Please enter your name.");
      if (phone.length !== 10) return PV.toast("Enter a valid 10-digit mobile number.");
      if (!obCode) {
        obCode = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, "0");
        $("#ob-otp-show").textContent = obCode; $("#ob-otp-wrap").classList.remove("hidden");
        $("#ob-go").textContent = "Confirm code & create vault"; $("#ob-otp").focus(); return;
      }
      if ($("#ob-otp").value.trim() !== obCode) return PV.toast("That code doesn't match.");
      V = { profile: { id: PV.uid(), name, phone, dob: $("#ob-dob").value.trim(), bloodGroup: $("#ob-bg").value, abha: "" },
        records: $("#ob-demo").checked ? PV.demoRecords() : { allergies: [], medications: [], conditions: [], reports: [], notes: [] },
        sessions: [], audit: [], emergency: { enabled: false } };
      addAudit("vault_created", "Encrypted vault created on this device");
      await persist(); $("#onboard").classList.add("hidden"); showShell();
    };
  }

  function showShell() {
    $("#shell").classList.remove("hidden");
    $$(".tab").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
    bindShare(); bindEmergency(); bindMe();
    $("#add-rec").onclick = addModal;
    setTab(location.hash.slice(1) || "vault"); renderAll();
    pollAll(); setInterval(pollAll, 2500); setInterval(tick, 1000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) pollAll(); });
    fetch("/api/health").then((r) => r.json()).then((h) => {
      $("#health").textContent = "Consent server: online" + (h.secretSet ? "" : " · ⚠ TOKEN_SECRET env var not set (developer: set it in Netlify)");
    }).catch(() => ($("#health").textContent = "Consent server: unreachable (offline). Emergency QR still works."));
  }
  function setTab(t) {
    if (!$("#tab-" + t)) t = "vault"; tab = t;
    $$(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
    $$("main section").forEach((s) => s.classList.toggle("hidden", s.id !== "tab-" + t));
    if (t === "live") renderLive(); if (t === "audit") renderAudit(); history.replaceState(null, "", "#" + t);
  }
  function renderAll() { renderVault(); renderLive(); renderAudit(); renderMe(); renderEmergencyState(); }

  /* ================= vault ================= */
  function renderVault() {
    const R = V.records, first = V.profile.name.split(" ")[0];
    $("#hello").textContent = `Hey, ${first}!`;
    const lastTest = R.reports.slice().sort((a, b) => new Date(b.effectiveDateTime) - new Date(a.effectiveDateTime))[0];
    const highs = R.allergies.filter((a) => a.criticality === "high");
    $("#snap").innerHTML = `<h3>Critical Snapshot</h3><div class="sub">${V.profile.bloodGroup ? "Blood group " + esc(V.profile.bloodGroup) + " · " : ""}${V.profile.abha ? "ABHA " + esc(PV.abhaMask(V.profile.abha)) : "Phone-verified (ABHA not linked)"}</div>
      ${highs.length ? `<div class="alert" style="margin-bottom:12px"><span class="big">⚠</span><span>HIGH-RISK ALLERGY: ${highs.map((a) => esc(a.code.text)).join(", ")}</span></div>` : ""}
      <div class="stats3"><div><b>${R.medications.length}</b><span>Active medications</span></div><div><b>${lastTest ? ago(lastTest.effectiveDateTime) : "—"}</b><span>Last test</span></div><div><b>${R.conditions.length}</b><span>Conditions</span></div></div>`;
    $("#tiles").innerHTML = Object.entries(CATS).map(([k, c]) => `<button class="tile" data-cat="${k}" aria-pressed="${k === cat}"><span class="ico" aria-hidden="true">${c.icon}</span>${c.label}<small>${R[k].length} on file</small></button>`).join("");
    $$(".tile").forEach((b) => (b.onclick = () => { cat = b.dataset.cat; renderVault(); }));
    $("#list-title").textContent = CATS[cat].label;
    const items = R[cat].map(view[CATS[cat].type]);
    $("#list").innerHTML = items.length ? items.map((i) => `<div class="rec ${i.high ? "high" : ""}"><div><div class="t">${i.high ? "⚠ " : ""}${esc(i.title)}</div><div class="s">${esc(i.sub)}${i.by ? " · " + esc(i.by) : ""}</div></div><button class="x" data-del="${esc(i.id)}" aria-label="Remove ${esc(i.title)}">✕</button></div>`).join("")
      : `<p class="muted">Nothing here yet. Tap “+ Add record”.</p>`;
    $$("[data-del]").forEach((b) => (b.onclick = async () => { R[cat] = R[cat].filter((r) => r.id !== b.dataset.del); addAudit("record_removed", CATS[cat].label); await persist(); renderVault(); }));
    const all = [...R.allergies.map((r) => [r.recordedDate, "Allergy", r.code.text]), ...R.medications.map((r) => [r.authoredOn, "Medication", r.medicationCodeableConcept.text]),
      ...R.conditions.map((r) => [r.recordedDate, "Condition", r.code.text]), ...R.reports.map((r) => [r.effectiveDateTime, "Report", r.code.text])].sort((a, b) => new Date(b[0]) - new Date(a[0])).slice(0, 4);
    const notes = R.notes.length ? `<div style="margin-top:12px"><b>Provider notes you approved</b>${R.notes.map((n) => `<div class="rec"><div><div class="t">${esc(n.text)}</div><div class="s">${esc(n.by)} · ${clock(n.at)}</div></div></div>`).join("")}</div>` : "";
    $("#recent").innerHTML = all.map((a) => `${esc(a[1])} “${esc(a[2])}” added ${ago(a[0])}`).join("<br>") + notes;
  }

  function addModal() {
    const t = CATS[cat].type, bg = document.createElement("div"); bg.className = "modal-bg";
    const forms = {
      allergy: `<label class="f">Substance<input id="m1" type="text" placeholder="e.g. Penicillin"></label><label class="f">Reaction<input id="m2" type="text" placeholder="e.g. Rash, anaphylaxis"></label><label class="f">Severity<select id="m3"><option value="high">High / life-threatening</option><option value="moderate">Moderate</option><option value="low">Mild</option></select></label>`,
      med: `<label class="f">Medicine<input id="m1" type="text" placeholder="e.g. Metformin 500 mg"></label><div class="row"><label class="f">Dose<input id="m2" type="text" placeholder="1 tablet"></label><label class="f">Frequency<input id="m3" type="text" placeholder="twice daily"></label></div><label class="f">Prescribed by<input id="m4" type="text" placeholder="optional"></label>`,
      condition: `<label class="f">Condition<input id="m1" type="text" placeholder="e.g. Hypertension"></label>`,
      report: `<label class="f">Test / report<input id="m1" type="text" placeholder="e.g. HbA1c"></label><label class="f">Result / conclusion<input id="m2" type="text"></label><div class="row"><label class="f">Date<input id="m3" type="text" placeholder="YYYY-MM-DD"></label><label class="f">Lab / facility<input id="m4" type="text"></label></div>`,
    };
    bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Add record"><h3>Add to ${esc(CATS[cat].label)}</h3>${forms[t]}<div class="row"><button class="btn btn-ghost" id="mc">Cancel</button><button class="btn btn-teal" id="ms">Save (FHIR R4)</button></div></div>`;
    document.body.appendChild(bg); $("#m1", bg).focus();
    $("#mc", bg).onclick = () => bg.remove();
    $("#ms", bg).onclick = async () => {
      const g = (i) => ($("#m" + i, bg) ? $("#m" + i, bg).value.trim() : "");
      if (!g(1)) return PV.toast("Please fill the first field.");
      let r;
      if (t === "allergy") r = FHIR.allergy(g(1), g(2), g(3)); else if (t === "med") r = FHIR.med(g(1), g(2), g(3), g(4));
      else if (t === "condition") r = FHIR.condition(g(1));
      else { const d = g(3) && !isNaN(new Date(g(3))) ? new Date(g(3)).toISOString() : null; r = FHIR.report(g(1), g(2), d, g(4)); }
      V.records[cat].push(r); addAudit("record_added", CATS[cat].label + ": " + g(1)); await persist(); bg.remove(); renderVault();
    };
  }

  /* ================= share / consent generator ================= */
  const SCOPE_DESC = { allergies: "Drug & other allergies", medications: "Current prescriptions", conditions: "Chronic conditions", reports: "Diagnostic tests & reports" };
  function bindShare() {
    $("#scope-toggles").innerHTML = Object.entries(CATS).map(([k, c]) => `<label class="tg"><input type="checkbox" data-scope="${k}" ${share.scope.has(k) ? "checked" : ""}><span><b>${c.icon} ${c.label}</b><small>${SCOPE_DESC[k]}</small></span></label>`).join("");
    $$("[data-scope]").forEach((i) => (i.onchange = () => (i.checked ? share.scope.add(i.dataset.scope) : share.scope.delete(i.dataset.scope))));
    const seg = (id, key, cb) => $$("#" + id + " button").forEach((b) => (b.onclick = () => { $$("#" + id + " button").forEach((x) => x.setAttribute("aria-pressed", "false")); b.setAttribute("aria-pressed", "true"); share[key] = key === "ttl" ? Number(b.dataset.v) : b.dataset.v; cb && cb(); }));
    seg("ttl-seg", "ttl"); seg("mode-seg", "mode", () => ($("#mode-note").textContent = share.mode === "qr"
      ? "Most private: the key lives only in the QR (never sent to our server)."
      : "Fallback for when scanning isn't possible. The key is held by the server for this session only, a lower-security tier. Short, rate-limited code."));
    $("#gen").onclick = generate;
  }
  async function generate() {
    const scope = [...share.scope]; if (!scope.length) return PV.toast("Choose at least one category to share.");
    const btn = $("#gen"); btn.disabled = true; btn.textContent = "Encrypting…";
    try {
      const key = await PV.newKey(), snap = PV.buildSnapshot(V, scope), { cipher, iv } = await PV.encJSON(snap, key);
      const allowNotes = $("#allow-notes").checked, label = $("#share-label").value.trim();
      const r = await PV.api("session", { method: "POST", body: { cipher, iv, scope, ttlMin: share.ttl, mode: share.mode, allowNotes, label, key: share.mode === "otp" ? key : undefined } });
      if (!r.ok) throw new Error(r.status ? "server " + r.status : "offline");
      const s = { id: r.data.id, owner: r.data.owner, token: r.data.token, key, label, scope, exp: r.data.exp, mode: share.mode, otp: r.data.otp, allowNotes, created: Date.now(), status: "active", views: 0, lastSeen: null, firstView: null, lastLatency: null, srvAuditN: 0 };
      V.sessions.unshift(s); addAudit("created", `${scope.length} categories · ${share.ttl} min`, s.id); await persist(); showShareOut(s); renderLive();
    } catch (e) { PV.toast("Couldn't create the consent (" + e.message + "). Check your connection."); }
    btn.disabled = false; btn.textContent = "Generate consent";
  }
  const sessionUrl = (s) => `${location.origin}/provider.html?t=${s.token}#k=${s.key}`;
  function showShareOut(s) {
    const o = $("#share-out");
    o.innerHTML = `<h3>${s.mode === "qr" ? "Show this to the provider" : "Give this code to the provider"}</h3>
      ${s.mode === "qr" ? `<div class="qrbox" aria-label="Consent QR code">${PV.qrSvg(sessionUrl(s), "M")}</div><p class="small muted center" style="margin-top:10px">Provider scans with any phone camera or the Provider view. No login.</p>`
        : `<div class="otp" aria-label="One-time code">${esc(s.otp)}</div><p class="small muted center" style="margin-top:10px">Provider opens <b>${esc(location.host)}/provider.html</b> and enters this code.</p>`}
      <p class="center" style="margin:10px 0">Expires in <b class="timer" style="color:var(--teal-800);font-size:1.4rem" data-exp="${s.exp}"></b></p>
      <p class="small center muted">Shared: ${s.scope.map((k) => CATS[k].label).join(", ")}${s.allowNotes ? " · notes need your approval" : " · view-only"}</p>
      <div class="row" style="margin-top:10px">${s.mode === "qr" ? `<button class="btn btn-ghost btn-sm" id="cp">Copy link</button><button class="btn btn-ghost btn-sm" id="sh">Share…</button>` : ""}<button class="btn btn-teal btn-sm" id="gl">Open Live Access</button></div>`;
    if (s.mode === "qr") {
      $("#cp").onclick = () => navigator.clipboard.writeText(sessionUrl(s)).then(() => PV.toast("Link copied (it contains the key; share it only with the provider)."));
      $("#sh").onclick = () => (navigator.share ? navigator.share({ title: "PulseVault consent", url: sessionUrl(s) }).catch(() => {}) : PV.toast("Sharing isn't supported here; use Copy link."));
    }
    $("#gl").onclick = () => setTab("live"); tick();
  }

  /* ================= live access / polling ================= */
  function tick() {
    $$("[data-exp]").forEach((el) => { const left = Number(el.dataset.exp) - (Date.now() + skew); el.textContent = left > 0 ? PV.fmtClock(left) : "00:00"; });
  }
  async function pollAll() {
    const active = V.sessions.filter((s) => s.status === "active"); let changed = false;
    await Promise.all(active.map(async (s) => {
      try {
        const r = await PV.api("status?id=" + encodeURIComponent(s.id), { owner: s.owner });
        if (!r.ok) { if (r.status === 404 || r.status === 401) { s.status = "expired"; changed = true; } return; }
        const d = r.data; skew = d.now - Date.now();
        if (d.views !== s.views || d.lastSeen !== s.lastSeen || d.lastLatency !== s.lastLatency) { Object.assign(s, { views: d.views, lastSeen: d.lastSeen, firstView: d.firstView, lastLatency: d.lastLatency }); changed = true; }
        const known = new Set(V.audit.filter((a) => a.sid === s.id && a.src === "server").map((a) => a.h));
        for (const e of d.audit) if (!known.has(e.h)) { V.audit.push({ ...e, src: "server", sid: s.id }); changed = true; }
        if (d.revoked || d.ended) { s.status = d.revoked ? "revoked" : "expired"; changed = true; pending[s.id] = []; }
        else {
          const list = [];
          for (const p of d.proposals) { try { list.push({ ...(await PV.decJSON(p.cipher, p.iv, s.key)), pid: p.pid, at: p.at, sid: s.id }); } catch (e) {} }
          if (JSON.stringify((pending[s.id] || []).map((p) => p.pid)) !== JSON.stringify(list.map((p) => p.pid))) changed = true;
          pending[s.id] = list;
        }
      } catch (e) { /* offline: keep last known state */ }
    }));
    if (changed) { V.audit.sort((a, b) => b.t - a.t); await persist(); if (tab === "live") renderLive(); if (tab === "audit") renderAudit(); }
    const n = Object.values(pending).reduce((a, l) => a + l.length, 0);
    const dot = $("#live-dot"); dot.textContent = n; dot.classList.toggle("hidden", !n);
    if (changed) renderLive();
  }
  function renderLive() {
    const act = V.sessions.filter((s) => s.status === "active"), past = V.sessions.filter((s) => s.status !== "active");
    const props = Object.values(pending).flat();
    $("#proposals").innerHTML = props.map((p) => {
      const s = V.sessions.find((x) => x.id === p.sid) || {}, warns = p.kind === "med" ? PV.allergyCheck(p.name, V.records.allergies.map(view.allergy)) : [];
      return `<div class="card" style="border-color:var(--gold);margin-bottom:14px"><span class="chip gold">Approval needed</span> <b>${esc(s.label || "Provider")}</b> wants to add to your record
        <div class="rec" style="margin-top:10px"><div><div class="t">${p.kind === "med" ? "💊 Prescription: " + esc(p.name) : "📝 Note"}</div><div class="s">${p.kind === "med" ? esc([p.dose, p.freq].filter(Boolean).join(" · ")) : esc(p.text)}</div></div></div>
        ${warns.map((w) => `<div class="warn ${w.level === "block" ? "red" : ""}">⚠ ${esc(w.text)}</div>`).join("")}
        <div class="row"><button class="btn btn-teal btn-sm" data-ap="${esc(p.pid)}|${esc(p.sid)}">Approve &amp; add</button><button class="btn btn-ghost btn-sm" data-rj="${esc(p.pid)}|${esc(p.sid)}">Reject</button></div></div>`;
    }).join("");
    $$("[data-ap]").forEach((b) => (b.onclick = () => resolve(b.dataset.ap, "approved")));
    $$("[data-rj]").forEach((b) => (b.onclick = () => resolve(b.dataset.rj, "rejected")));
    $("#live-list").innerHTML = act.length ? act.map((s) => {
      const viewing = s.lastSeen && Date.now() + skew - s.lastSeen < 8000;
      const status = viewing ? "👁 Provider is viewing now" : s.firstView ? "Viewed · last seen " + clock(s.lastSeen) : "Waiting for provider to scan";
      return `<div class="card dark" style="margin-bottom:16px"><div class="row" style="align-items:center"><div><h3 style="margin:0">Live consent</h3><div class="small" style="color:#CFE2E0">${esc(s.label || "Provider")} · ${s.mode === "otp" ? "6-digit code" : "QR"} · ${esc(status)}</div></div><div style="text-align:right;flex:0 0 auto"><div class="timer" data-exp="${s.exp}"></div><div class="small" style="color:#CFE2E0">left</div></div></div>
        <div class="sep" style="background:rgba(255,255,255,.2)"></div>
        <b style="color:var(--gold-200)">Current access permissions</b>
        ${Object.entries(CATS).map(([k, c]) => `<div class="perm"><i class="${s.scope.includes(k) ? "" : "no"}">${s.scope.includes(k) ? "✓" : "–"}</i>${c.label}: ${s.scope.includes(k) ? "Shared" : "Not shared"}</div>`).join("")}
        <div class="perm"><i class="${s.allowNotes ? "" : "no"}">${s.allowNotes ? "✓" : "–"}</i>Provider may propose notes (needs your OK)</div>
        <div class="small" style="margin:10px 0;color:#CFE2E0">Views: ${s.views}${s.lastLatency ? " · scan-to-record: " + (s.lastLatency / 1000).toFixed(2) + " s" : ""}</div>
        <div class="row"><button class="btn btn-red" data-rv="${esc(s.id)}">Revoke instant access</button></div>
        ${s.mode === "qr" ? `<button class="btn btn-ghost-light btn-sm" style="margin-top:10px" data-qr="${esc(s.id)}">Show QR again</button>` : `<div class="small" style="margin-top:10px;color:#CFE2E0">Code: <b class="mono">${esc(s.otp)}</b></div>`}</div>`;
    }).join("") : `<div class="card"><p class="muted" style="margin:0">No active shares. Providers can't see anything right now. <a href="#share" data-go="share">Create a consent →</a></p></div>`;
    $$("[data-rv]").forEach((b) => (b.onclick = () => revoke(b.dataset.rv)));
    $$("[data-qr]").forEach((b) => (b.onclick = () => { setTab("share"); showShareOut(V.sessions.find((s) => s.id === b.dataset.qr)); }));
    $$("[data-go]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); setTab(a.dataset.go); }));
    $("#past-list").innerHTML = past.length ? past.slice(0, 10).map((s) => `<div class="audit"><b>${esc(s.label || "Provider")}</b> · ${s.status === "revoked" ? '<span class="chip red">revoked</span>' : '<span class="chip grey">expired</span>'} · ${esc(s.scope.map((k) => CATS[k].label).join(", "))} · ${clock(s.created)}</div>`).join("") : "None yet.";
    tick();
  }
  async function revoke(id) {
    const s = V.sessions.find((x) => x.id === id); if (!s) return;
    const t0 = performance.now(); const r = await PV.api("revoke", { method: "POST", owner: s.owner, body: { id } });
    if (!r.ok) return PV.toast("Couldn't reach the server to revoke. Try again, or check your connection.", 5000);
    s.status = "revoked"; pending[id] = []; addAudit("revoked", "You revoked access", id); await persist(); renderLive();
    PV.toast(`Access revoked in ${Math.round(performance.now() - t0)} ms. The provider's session is closed.`); pollAll();
  }
  async function resolve(key, decision) {
    const [pid, sid] = key.split("|"), s = V.sessions.find((x) => x.id === sid), p = (pending[sid] || []).find((x) => x.pid === pid); if (!s || !p) return;
    if (decision === "approved") {
      if (p.kind === "med") V.records.medications.push(FHIR.med(p.name, p.dose, p.freq, `${p.by || "Provider"} (${s.label || "shared session"})`));
      else V.records.notes.push({ id: PV.uid(), text: p.text, by: `${p.by || "Provider"} (${s.label || "shared session"})`, at: Date.now() });
    }
    await PV.api("resolve", { method: "POST", owner: s.owner, body: { id: sid, pid, decision } });
    pending[sid] = pending[sid].filter((x) => x.pid !== pid); await persist(); renderAll(); PV.toast(decision === "approved" ? "Added to your record." : "Rejected.");
  }

  /* ================= emergency QR ================= */
  function bindEmergency() {
    const e = V.emergency; $("#em-on").checked = !!e.enabled; $("#em-opts").classList.toggle("hidden", !e.enabled); $("#em-phone").value = e.phone || "";
    $("#em-on").onchange = async () => { V.emergency.enabled = $("#em-on").checked; $("#em-opts").classList.toggle("hidden", !V.emergency.enabled); if (!V.emergency.enabled) V.emergency.token = null; await persist(); renderEmergencyState(); };
    $("#em-gen").onclick = async () => {
      const R = V.records, t = (arr, f) => arr.slice(0, 6).map(f).map((x) => String(x || "").slice(0, 40));
      const p = { v: 1, n: V.profile.name, ts: Date.now() };
      if ($("#em-bg").checked && V.profile.bloodGroup) p.bg = V.profile.bloodGroup;
      if ($("#em-al").checked) p.al = t(R.allergies, (a) => a.code.text + (a.criticality === "high" ? " (HIGH)" : ""));
      if ($("#em-mc").checked) p.mc = t(R.medications, (m) => m.medicationCodeableConcept.text);
      if ($("#em-cc").checked) p.cc = t(R.conditions, (c) => c.code.text);
      const ph = $("#em-phone").value.replace(/\D/g, ""); if (ph) p.ph = ph;
      V.emergency.phone = $("#em-phone").value; V.emergency.token = await PV.signEmergency(p, V);
      addAudit("emergency_qr", "Emergency QR generated"); await persist(); renderEmergencyState();
    };
  }
  function renderEmergencyState() {
    const e = V.emergency, out = $("#em-out");
    if (!e.enabled || !e.token) return (out.innerHTML = `<p class="muted">${e.enabled ? "Tap “Generate” to create your QR." : "Enable and generate to see the QR."}</p>`);
    const url = `${location.origin}/emergency.html#${e.token}`;
    out.innerHTML = `<div class="qrbox">${PV.qrSvg(url, "L")}</div><p class="small muted" style="margin-top:10px">Works offline once the page is cached. Signed, so edits are detectable. Print it or save it as your lock-screen image.</p><button class="btn btn-ghost btn-sm" onclick="window.print()">Print</button>`;
  }

  /* ================= audit ================= */
  function renderAudit() {
    const chainOk = (sid) => { const l = V.audit.filter((a) => a.sid === sid && a.src === "server").sort((a, b) => a.t - b.t); for (let i = 1; i < l.length; i++) if (l[i].prev !== l[i - 1].h) return false; return true; };
    const ok = {}; V.sessions.forEach((s) => (ok[s.id] = chainOk(s.id)));
    $("#audit-list").innerHTML = V.audit.length ? V.audit.map((a) => {
      const s = V.sessions.find((x) => x.id === a.sid);
      return `<div class="audit"><b>${esc(EV[a.ev] || a.ev)}</b> ${a.src === "server" ? '<span class="chip">server · hash-chained</span>' : '<span class="chip grey">this device</span>'}${s && s.label ? " · " + esc(s.label) : ""}<br><span class="muted">${clock(a.t)}${a.detail ? " · " + esc(a.detail) : ""}</span>${a.h ? `<div class="h">${ok[a.sid] === false ? "⚠ chain mismatch" : "🔗 " + esc(a.h)}</div>` : ""}</div>`;
    }).join("") : `<p class="muted">Nothing yet.</p>`;
  }

  /* ================= identity & data ================= */
  function renderMe() {
    const p = V.profile;
    $("#me-profile").innerHTML = `<div class="rec"><div><div class="t">${esc(p.name)}</div><div class="s">Phone ••••••${esc(p.phone.slice(-4))} (verified) ${p.bloodGroup ? "· " + esc(p.bloodGroup) : ""}</div></div></div>`;
    $("#abha-box").innerHTML = p.abha ? `<div class="rec"><div><div class="t">${esc(PV.abhaFormat(p.abha))} <span class="chip green">linked</span></div><div class="s">Only the masked form (${esc(PV.abhaMask(p.abha))}) is ever shared.</div></div><button class="x" id="unlink">Unlink</button></div>`
      : `<label class="f">14-digit ABHA number<input id="abha-in" type="text" inputmode="numeric" placeholder="XX-XXXX-XXXX-XXXX"></label><div id="abha-otp" class="hidden"><div class="warn">Sandbox OTP: <b class="mono" id="abha-code"></b></div><label class="f">Enter OTP<input id="abha-otp-in" type="text" maxlength="6" inputmode="numeric"></label></div><button id="abha-go" class="btn btn-teal btn-sm">Link ABHA</button>`;
    if (p.abha) $("#unlink").onclick = async () => { V.profile.abha = ""; await persist(); renderAll(); };
    else {
      let code = null;
      $("#abha-go").onclick = async () => {
        if (!PV.abhaValid($("#abha-in").value)) return PV.toast("An ABHA number has 14 digits.");
        if (!code) { code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, "0"); $("#abha-code").textContent = code; $("#abha-otp").classList.remove("hidden"); return; }
        if ($("#abha-otp-in").value.trim() !== code) return PV.toast("OTP doesn't match.");
        V.profile.abha = PV.abhaDigits($("#abha-in").value); addAudit("abha_linked", "Sandbox M1 flow (mock)"); await persist(); renderAll(); PV.toast("ABHA linked (sandbox).");
      };
    }
  }
  function bindMe() {
    $("#exp").onclick = () => {
      const p = V.profile, entries = [FHIR.patient({ ...p, abha: PV.abhaFormat(p.abha) }), ...V.records.allergies, ...V.records.medications, ...V.records.conditions, ...V.records.reports].map((r) => ({ fullUrl: "urn:uuid:" + r.id, resource: r }));
      const bundle = { resourceType: "Bundle", type: "collection", timestamp: new Date().toISOString(), entry: entries };
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/fhir+json" })); a.download = "pulsevault-fhir-bundle.json"; a.click();
      addAudit("exported", entries.length + " FHIR resources"); persist();
    };
    $("#wipe").onclick = async () => {
      if (!confirm("Erase your vault from this device? Active shares will be revoked. This cannot be undone (export first if needed).")) return;
      for (const s of V.sessions.filter((x) => x.status === "active")) await PV.api("revoke", { method: "POST", owner: s.owner, body: { id: s.id } }).catch(() => {});
      await PV.kvClear(); location.href = "/app.html";
    };
  }

  boot();
})();

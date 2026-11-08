/* PulseVault shared core: E2EE crypto, encrypted local vault, FHIR R4 helpers, allergy rules, QR helpers. */
(function (root) {
  "use strict";
  const enc = new TextEncoder(), dec = new TextDecoder();

  /* ---------- base64url ---------- */
  const b64u = {
    enc(buf) {
      const b = new Uint8Array(buf); let s = "";
      for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    },
    dec(str) {
      str = str.replace(/-/g, "+").replace(/_/g, "/"); while (str.length % 4) str += "=";
      const s = atob(str), b = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
      return b;
    },
  };
  const uid = () => b64u.enc(crypto.getRandomValues(new Uint8Array(9)));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- AES-256-GCM (end-to-end encryption of shared records) ---------- */
  async function newKey() {
    const k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    return b64u.enc(await crypto.subtle.exportKey("raw", k));
  }
  const importKey = (raw) => crypto.subtle.importKey("raw", b64u.dec(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
  async function encJSON(obj, keyB64) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(keyB64), enc.encode(JSON.stringify(obj)));
    return { cipher: b64u.enc(ct), iv: b64u.enc(iv) };
  }
  async function decJSON(cipher, iv, keyB64) {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64u.dec(iv) }, await importKey(keyB64), b64u.dec(cipher));
    return JSON.parse(dec.decode(pt));
  }

  /* ---------- encrypted-at-rest local vault (IndexedDB + non-extractable device key) ---------- */
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("pulsevault", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function kvGet(k) {
    const db = await idb();
    return new Promise((res, rej) => { const t = db.transaction("kv").objectStore("kv").get(k); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); });
  }
  async function kvSet(k, v) {
    const db = await idb();
    return new Promise((res, rej) => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); });
  }
  async function kvClear() {
    const db = await idb();
    return new Promise((res, rej) => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").clear(); t.oncomplete = res; t.onerror = () => rej(t.error); });
  }
  async function deviceKey() {
    let k = await kvGet("dk");
    if (!k) { k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); await kvSet("dk", k); }
    return k;
  }
  async function loadVault() {
    const rec = await kvGet("vault"); if (!rec) return null;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64u.dec(rec.iv) }, await deviceKey(), b64u.dec(rec.ct));
    return JSON.parse(dec.decode(pt));
  }
  async function saveVault(v) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await deviceKey(), enc.encode(JSON.stringify(v)));
    await kvSet("vault", { iv: b64u.enc(iv), ct: b64u.enc(ct) });
  }

  /* ---------- FHIR R4 resources ---------- */
  const nowIso = () => new Date().toISOString();
  const CS = "http://terminology.hl7.org/CodeSystem/";
  const FHIR = {
    allergy(substance, reaction, severity) {
      return { resourceType: "AllergyIntolerance", id: uid(),
        clinicalStatus: { coding: [{ system: CS + "allergyintolerance-clinical", code: "active" }] },
        criticality: severity === "high" ? "high" : "low", code: { text: substance },
        reaction: [{ manifestation: [{ text: reaction || "Reaction not specified" }], severity: severity === "high" ? "severe" : severity === "moderate" ? "moderate" : "mild" }],
        recordedDate: nowIso() };
    },
    med(name, dose, freq, by) {
      return { resourceType: "MedicationRequest", id: uid(), status: "active", intent: "order",
        medicationCodeableConcept: { text: name }, dosageInstruction: [{ text: [dose, freq].filter(Boolean).join(" · ") }],
        requester: by ? { display: by } : undefined, authoredOn: nowIso() };
    },
    condition(name) {
      return { resourceType: "Condition", id: uid(),
        clinicalStatus: { coding: [{ system: CS + "condition-clinical", code: "active" }] }, code: { text: name }, recordedDate: nowIso() };
    },
    report(name, result, date, by) {
      return { resourceType: "DiagnosticReport", id: uid(), status: "final", code: { text: name },
        effectiveDateTime: date || nowIso(), conclusion: result || "", performer: by ? [{ display: by }] : undefined };
    },
    patient(p) {
      const ids = [];
      if (p.abha) ids.push({ system: "https://healthid.abdm.gov.in", value: p.abha });
      return { resourceType: "Patient", id: p.id || uid(), identifier: ids, name: [{ text: p.name }], birthDate: p.dob || undefined, telecom: p.phone ? [{ system: "phone", value: p.phone }] : undefined };
    },
  };
  // Human-friendly view of a resource
  const view = {
    allergy: (r) => ({ id: r.id, title: r.code?.text, sub: r.reaction?.[0]?.manifestation?.[0]?.text || "", high: r.criticality === "high", sev: r.reaction?.[0]?.severity }),
    med: (r) => ({ id: r.id, title: r.medicationCodeableConcept?.text, sub: r.dosageInstruction?.[0]?.text || "", by: r.requester?.display }),
    condition: (r) => ({ id: r.id, title: r.code?.text, sub: "Active" }),
    report: (r) => ({ id: r.id, title: r.code?.text, sub: [r.conclusion, r.effectiveDateTime ? new Date(r.effectiveDateTime).toLocaleDateString() : ""].filter(Boolean).join(" · "), by: r.performer?.[0]?.display }),
  };
  const CATS = {
    allergies: { label: "Allergies", icon: "⚠️", type: "allergy" },
    medications: { label: "Medications", icon: "💊", type: "med" },
    conditions: { label: "Conditions", icon: "❤️", type: "condition" },
    reports: { label: "Tests & Reports", icon: "🧪", type: "report" },
  };

  /* Synthetic demo data (no real patient data anywhere in this app) */
  function demoRecords() {
    const d = (n) => new Date(Date.now() - n * 864e5).toISOString();
    return {
      allergies: [FHIR.allergy("Penicillin", "Anaphylaxis", "high"), FHIR.allergy("Sulfa drugs", "Skin rash", "moderate")],
      medications: [FHIR.med("Metformin 500 mg", "1 tablet", "twice daily", "Dr. Mehta, PHC Anand"), FHIR.med("Lisinopril 10 mg", "1 tablet", "daily", "Dr. Mehta, PHC Anand"),
        FHIR.med("Atorvastatin 10 mg", "1 tablet", "at night", "District Hospital"), FHIR.med("Vitamin D3 60k IU", "1 sachet", "weekly", "Dr. Shah"), FHIR.med("Aspirin 75 mg", "1 tablet", "daily", "District Hospital")],
      conditions: [FHIR.condition("Hypertension"), FHIR.condition("Type 2 Diabetes Mellitus")],
      reports: [FHIR.report("HbA1c", "7.4 % (above target)", d(2), "Sanjivani Diagnostics"), FHIR.report("Lipid profile", "LDL 128 mg/dL", d(40), "District Hospital"),
        FHIR.report("Chest X-ray", "No active lesion", d(120), "District Hospital")],
      notes: [],
    };
  }

  /* ---------- rule-based allergy cross-check (NOT ML, NOT clinical decision support) ---------- */
  const CLASSES = {
    penicillin: ["penicillin", "amoxicillin", "ampicillin", "amoxiclav", "augmentin", "piperacillin", "cloxacillin", "flucloxacillin", "benzathine"],
    sulfonamide: ["sulfa", "sulpha", "sulfamethoxazole", "cotrimoxazole", "co-trimoxazole", "bactrim", "sulfasalazine"],
    nsaid: ["nsaid", "aspirin", "ibuprofen", "diclofenac", "naproxen", "ketorolac", "aceclofenac"],
    cephalosporin: ["cephalosporin", "cefixime", "ceftriaxone", "cefuroxime", "cephalexin", "cefpodoxime", "cefotaxime"],
    macrolide: ["macrolide", "azithromycin", "clarithromycin", "erythromycin"],
    fluoroquinolone: ["fluoroquinolone", "ciprofloxacin", "levofloxacin", "ofloxacin", "norfloxacin"],
  };
  const CAUTION = { penicillin: ["cephalosporin"] }; // known (low-rate) cross-reactivity
  function allergyCheck(drugText, allergies) {
    const d = String(drugText || "").toLowerCase(), out = [];
    if (d.length < 3) return out;
    for (const a of allergies) {
      const al = String(a.title || "").toLowerCase(); if (!al) continue;
      let hit = false;
      if (d.includes(al) || al.includes(d.split(/\s+/)[0])) hit = true;
      for (const [cls, names] of Object.entries(CLASSES)) {
        const allergyInCls = names.some((n) => al.includes(n));
        if (!allergyInCls) continue;
        if (names.some((n) => d.includes(n))) hit = true;
        else if ((CAUTION[cls] || []).some((c2) => CLASSES[c2].some((n) => d.includes(n))))
          out.push({ level: "caution", text: `Recorded ${a.title} allergy: possible cross-reactivity with this ${(CAUTION[cls])[0]} (low but real risk). Verify before prescribing.` });
      }
      if (hit) out.push({ level: "block", text: `Recorded ALLERGY to ${a.title}${a.sub ? " (" + a.sub + ")" : ""}: this drug matches.` });
    }
    return out;
  }

  /* ---------- identity helpers (hybrid: phone OTP and/or ABHA) ---------- */
  const abhaDigits = (s) => String(s || "").replace(/\D/g, "");
  const abhaValid = (s) => abhaDigits(s).length === 14;
  const abhaFormat = (s) => { const d = abhaDigits(s); return d.length === 14 ? `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6, 10)}-${d.slice(10)}` : s; };
  const abhaMask = (s) => { const d = abhaDigits(s); return d.length === 14 ? `${d.slice(0, 2)}-XXXX-XXXX-${d.slice(10)}` : ""; };
  const age = (dob) => { if (!dob) return null; const t = new Date(dob); if (isNaN(t)) return null; return Math.floor((Date.now() - t) / 31557600000); };

  /* ---------- scoped snapshot: what actually leaves the device ---------- */
  function buildSnapshot(vault, scope) {
    const p = vault.profile, snap = { v: 1, at: Date.now(), profile: { name: p.name, bloodGroup: p.bloodGroup || "", age: age(p.dob), abha: abhaMask(p.abha) } };
    for (const c of Object.keys(CATS)) if (scope.includes(c)) snap[c] = (vault.records[c] || []).map(view[CATS[c].type]);
    return snap;
  }

  /* ---------- API ---------- */
  async function api(path, opts = {}) {
    const r = await fetch("/api/" + path, { method: opts.method || "GET", headers: { "content-type": "application/json", ...(opts.owner ? { "x-owner": opts.owner } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: "no-store" });
    let data = {}; try { data = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, data };
  }

  /* ---------- QR ---------- */
  function qrSvg(text, ecc) {
    const q = root.qrcode(0, ecc || "M"); q.addData(text); q.make();
    return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }

  /* ---------- Emergency QR: integrity-signed (ECDSA P-256), readable offline ---------- */
  async function signEmergency(payload, vault) {
    let kp = vault.emergencyKey;
    let priv, pub;
    if (!kp) {
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      kp = { priv: await crypto.subtle.exportKey("jwk", pair.privateKey), pub: b64u.enc(await crypto.subtle.exportKey("raw", pair.publicKey)) };
      vault.emergencyKey = kp;
    }
    priv = await crypto.subtle.importKey("jwk", kp.priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const body = b64u.enc(enc.encode(JSON.stringify(payload)));
    const sig = b64u.enc(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, enc.encode(body)));
    return `${body}.${sig}.${kp.pub}`;
  }
  async function verifyEmergency(token) {
    const [body, sig, pub] = String(token || "").split(".");
    if (!body || !sig || !pub) throw new Error("malformed");
    const key = await crypto.subtle.importKey("raw", b64u.dec(pub), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64u.dec(sig), enc.encode(body));
    return { ok, data: JSON.parse(dec.decode(b64u.dec(body))) };
  }

  /* ---------- UI helpers ---------- */
  function toast(msg, ms) {
    const t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), ms || 3200);
  }
  const fmtClock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); };
  const ECG = '<svg class="ecg" viewBox="0 0 300 26" preserveAspectRatio="none" aria-hidden="true"><path d="M0 14 H90 L100 14 L108 3 L118 24 L127 8 L134 14 H300" fill="none" stroke="#CFA64A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function registerSW() { if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {}); }

  root.PV = { b64u, uid, esc, newKey, encJSON, decJSON, loadVault, saveVault, kvClear, FHIR, view, CATS, demoRecords, allergyCheck,
    abhaValid, abhaFormat, abhaMask, abhaDigits, age, buildSnapshot, api, qrSvg, signEmergency, verifyEmergency, toast, fmtClock, ECG, registerSW };
})(typeof window !== "undefined" ? window : globalThis);

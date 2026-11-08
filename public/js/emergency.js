(async function(){
  PV.registerSW(); document.getElementById('ecg').innerHTML = PV.ECG;
  const out = document.getElementById('out'), esc = PV.esc;
  try {
    const { ok, data } = await PV.verifyEmergency(location.hash.slice(1));
    const list = (a) => (a && a.length) ? a.map(x => `<li>${esc(x)}</li>`).join('') : '<li class="muted">None listed</li>';
    out.innerHTML = `
      <div class="em-head"><span style="font-size:1.6rem">🚑</span><div>EMERGENCY SUMMARY<div class="small" style="font-weight:400">Patient-provided · works offline</div></div></div>
      <div class="card" style="margin:14px 0"><h1 style="font-size:1.8rem;margin:0">${esc(data.n)}</h1>${data.bg ? `<p style="margin:6px 0 0"><span class="chip red">Blood group ${esc(data.bg)}</span></p>` : ''}</div>
      ${data.al ? `<div class="card" style="margin-bottom:12px;border-color:#E0463C"><h3 style="color:var(--red-dark)">⚠ Allergies</h3><ul>${list(data.al)}</ul></div>` : ''}
      ${data.mc ? `<div class="card" style="margin-bottom:12px"><h3>💊 Chronic medicines</h3><ul>${list(data.mc)}</ul></div>` : ''}
      ${data.cc ? `<div class="card" style="margin-bottom:12px"><h3>❤️ Chronic conditions</h3><ul>${list(data.cc)}</ul></div>` : ''}
      ${data.ph ? `<a class="btn btn-red" href="tel:${esc(data.ph)}" style="margin-bottom:12px">Call emergency contact ${esc(data.ph)}</a>` : ''}
      <p class="chip ${ok ? 'green' : 'red'}">${ok ? '✓ Integrity check passed: data not altered since the QR was made' : '✗ Integrity check FAILED: do not trust this data'}</p>
      <p class="small muted">Generated ${new Date(data.ts).toLocaleString()}. Self-signed by the patient's device: it proves the content wasn't edited, not who the patient is. For the full record, ask the patient (or a bystander with their phone) for a consent QR.</p>`;
  } catch (e) {
    out.innerHTML = '<div class="dead"><h2>Couldn\'t read this QR</h2><p>It may be damaged or not a PulseVault emergency code.</p></div>';
  }
})();

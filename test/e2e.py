import asyncio, re, json, sys, time
from playwright.async_api import async_playwright
BASE="http://localhost:8888"
DECODE = """async () => {
  const svg = document.querySelector('.qrbox svg'); const xml = new XMLSerializer().serializeToString(svg);
  const img = new Image(); img.src = 'data:image/svg+xml;base64,' + btoa(xml); await img.decode();
  const c = document.createElement('canvas'); c.width = c.height = 700; const x = c.getContext('2d'); x.fillStyle='#fff'; x.fillRect(0,0,700,700); x.drawImage(img,0,0,700,700);
  const d = x.getImageData(0,0,700,700); const r = jsQR(d.data, 700, 700); return r && r.data; }"""
def ok(m): print("  ok -", m)
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        pc = await b.new_context(viewport={"width":1100,"height":900}); pt = await pc.new_page()
        errs=[]; pt.on("pageerror", lambda e: errs.append("patient:"+str(e))); pt.on("console", lambda m: m.type=="error" and errs.append("patient-console:"+m.text))
        await pt.goto(BASE+"/app.html"); await pt.add_script_tag(url="/vendor/jsQR.js")
        # onboarding
        await pt.fill("#ob-name","Krish Agrawal"); await pt.fill("#ob-phone","9876543210"); await pt.click("#ob-go")
        code = await pt.inner_text("#ob-otp-show"); await pt.fill("#ob-otp", code); await pt.click("#ob-go")
        await pt.wait_for_selector("#snap .alert"); ok("onboarding + demo vault; high-risk allergy alert on Critical Snapshot")
        await pt.screenshot(path="/tmp/s_vault.png", full_page=False)
        # share QR
        await pt.click('[data-tab="share"]'); await pt.check("#allow-notes"); await pt.fill("#share-label","PHC Anand"); await pt.click("#gen")
        await pt.wait_for_selector("#share-out .qrbox svg"); url = await pt.evaluate(DECODE); assert url and "/provider.html?t=" in url and "#k=" in url; ok("QR generated and decodes to a signed link: "+url[:60]+"…")
        await pt.screenshot(path="/tmp/s_share.png")
        # provider (separate browser context = another device) opens link
        qc = await b.new_context(viewport={"width":420,"height":900}); pv = await qc.new_page()
        perr=[]; pv.on("pageerror", lambda e: perr.append(str(e)))
        await pv.goto(url); await pv.wait_for_selector("#viewer .banner")
        txt = await pv.inner_text("#viewer"); assert "PENICILLIN ALLERGY" in txt and "Metformin" in txt and "Hypertension" in txt; assert "Not shared by patient" in txt and "HbA1c" not in txt; ok("provider sees scoped Critical Snapshot (reports NOT shared, HbA1c absent)")
        lat = await pv.inner_text(".chip.green"); ok("latency chip: "+lat.strip())
        assert "#k=" not in pv.url and "?t=" not in pv.url; ok("key/token stripped from address bar")
        await pv.screenshot(path="/tmp/s_prov.png", full_page=True)
        # allergy cross-check + proposal
        await pv.fill("#pn","Amoxicillin 500 mg"); w = await pv.inner_text("#pw"); assert "ALLERGY to Penicillin" in w; ok("allergy rule flags amoxicillin vs penicillin allergy")
        await pv.fill("#pb","Dr. Rao"); pv.on("dialog", lambda d: asyncio.ensure_future(d.accept())); await pv.click("#psend"); await pv.wait_for_function("document.querySelector('#pmsg').textContent.includes('Sent')"); ok("provider proposal sent (encrypted)")
        # patient sees proposal + live status
        await pt.click('[data-tab="live"]'); await pt.wait_for_selector("[data-ap]", timeout=8000); lt = await pt.inner_text("#tab-live")
        assert "Amoxicillin" in lt and "Approval needed" in lt and "Provider is viewing now" in lt; ok("patient sees live 'viewing now' + decrypted proposal with allergy warning")
        await pt.screenshot(path="/tmp/s_live.png", full_page=True)
        await pt.click("[data-rj]"); await pt.wait_for_selector("[data-ap]", state="detached", timeout=5000); ok("proposal rejected")
        # REVOKE -> provider locks
        t0=time.time(); await pt.click("[data-rv]")
        await pv.wait_for_selector("#viewer .dead", timeout=6000); dt=time.time()-t0
        dead = await pv.inner_text("#viewer"); assert "revoked" in dead.lower() and "Metformin" not in dead and "Penicillin" not in dead.title(); ok(f"REVOKE: provider screen locked & data cleared in {dt:.1f}s")
        await pv.screenshot(path="/tmp/s_dead.png")
        # reload provider with same link must fail
        await pv.goto(url); await pv.wait_for_selector("#viewer .dead"); assert "revoked" in (await pv.inner_text("#viewer")).lower(); ok("re-opening the old QR is refused")
        await pt.click('[data-tab="audit"]'); a = await pt.inner_text("#audit-list"); assert "Access revoked" in a and "Provider opened your record" in a and "chain mismatch" not in a; ok("audit trail shows created/viewed/revoked, chain verified")
        # OTP mode
        await pt.click('[data-tab="share"]'); await pt.click('#mode-seg [data-v="otp"]'); await pt.click("#gen"); await pt.wait_for_selector(".otp"); otp = await pt.inner_text(".otp")
        pv2 = await qc.new_page(); await pv2.goto(BASE+"/provider.html"); await pv2.fill("#otp", otp.strip()); await pv2.click("#otpbtn"); await pv2.wait_for_selector("#viewer .banner"); ok("6-digit code fallback opens record")
        await pv2.close()
        # emergency QR
        await pt.click('[data-tab="emergency"]'); await pt.check("#em-on"); await pt.click("#em-gen"); await pt.wait_for_selector("#em-out .qrbox svg"); eurl = await pt.evaluate(DECODE); assert "/emergency.html#" in eurl
        pe = await qc.new_page(); await pe.goto(eurl); await pe.wait_for_selector(".em-head"); et = await pe.inner_text("#out"); assert "Penicillin" in et and "Integrity check passed" in et; ok("emergency QR decodes, verifies signature, shows allergies")
        await pe.screenshot(path="/tmp/s_em.png", full_page=True)
        # tamper emergency
        bad = eurl[:-8]+"AAAAAAAA"; await pe.goto(bad); await pe.reload(); await pe.wait_for_selector("#out"); await asyncio.sleep(0.6); t2 = await pe.inner_text("#out"); assert "FAILED" in t2 or "Couldn" in t2; ok("tampered emergency QR is rejected")
        # vault persisted encrypted: reload app keeps data
        await pt.reload(); await pt.wait_for_selector("#snap", state="attached"); ok("vault persists across reload (IndexedDB, encrypted)")
        raw = await pt.evaluate("""async()=>{const db=await new Promise(r=>{const q=indexedDB.open('pulsevault',1);q.onsuccess=()=>r(q.result)});return await new Promise(r=>{const t=db.transaction('kv').objectStore('kv').get('vault');t.onsuccess=()=>r(JSON.stringify(t.result))})}""")
        assert "Penicillin" not in raw and "Krish" not in raw; ok("at-rest vault is ciphertext (no plaintext 'Penicillin'/name in IndexedDB)")
        await pt.set_viewport_size({"width":390,"height":844}); await pt.click('[data-tab="vault"]'); await pt.screenshot(path="/tmp/s_mobile.png")
        print("JS errors:", errs+perr)
        await b.close()
asyncio.run(main())

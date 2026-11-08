/* PulseVault service worker: offline-first app shell. API calls are never cached. */
const V = "pv-v1";
const SHELL = ["/", "/app.html", "/provider.html", "/emergency.html", "/css/style.css", "/js/common.js", "/js/app.js", "/js/provider.js", "/js/emergency.js", "/js/landing.js",
  "/vendor/qrcode.js", "/vendor/jsQR.js", "/assets/emblem.jpg", "/assets/logo.jpg", "/assets/preview.jpg", "/assets/favicon.png", "/assets/icon-192.png", "/manifest.webmanifest"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request).then((r) => { const copy = r.clone(); caches.open(V).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m || caches.match("/app.html")))
  );
});

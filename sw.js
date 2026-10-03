/* Service Worker — يخزّن ملفات التطبيق للعمل بدون إنترنت (النماذج تُخزَّن في OPFS وليس هنا) */
const CACHE = "sproochentest-shell-v1";
const SHELL = ["./", "index.html", "piper-engine.js", "wasm/piper_phonemize.wasm", "wasm/piper_phonemize.data", "ort/ort-wasm-simd.wasm", "ort/ort-wasm.wasm"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.indexOf("/models/") !== -1) return;       // النماذج الكبيرة: OPFS
  if (req.headers.has("range")) return;
  const isPage = req.mode === "navigate" || url.pathname.endsWith("index.html") || url.pathname.endsWith("/");
  e.respondWith(
    caches.open(CACHE).then(function (c) {
      return c.match(req).then(function (hit) {
        const net = fetch(req).then(function (res) {
          if (res && res.ok) c.put(req, res.clone());
          return res;
        }).catch(function () { return hit; });
        return isPage ? (net.then(function (r) { return r || hit; })) : (hit || net);
      });
    })
  );
});

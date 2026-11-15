// Offline support for the browser / installed-app version of ez-ocr.
const CACHE = "ez-ocr-v2";
const WARM = ["tesseract/worker.min.js", "tesseract/tesseract-core-simd-lstm.wasm.js", "tessdata/eng.traineddata.gz"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.add("./")));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (e) => {
  if (e.data?.type !== "warm") return;
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.all(WARM.map(async (u) => (await c.match(u)) || c.add(u).catch(() => {})))
    )
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  const store = (res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  };
  if (req.mode === "navigate") {
    // always try for the newest page, fall back to the saved one when offline
    e.respondWith(fetch(req).then(store).catch(() => caches.match(req).then((r) => r || caches.match("./"))));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(store)));
});

// Offline support and updates for the browser / installed-app version.
// __BUILD__ is replaced at build time, so every deploy installs a new worker.
const APP = "ocr-magic-app-__BUILD__"; // page, scripts, styles, images: replaced on every update
const DATA = "ocr-magic-data-v1"; // OCR engine and language data: large, kept across updates
const WARM = ["tesseract/worker.min.js", "tesseract/tesseract-core-simd-lstm.wasm.js", "tessdata/eng.traineddata.gz"];
const isData = (url) => /\/(tessdata|tesseract)\//.test(new URL(url, location.href).pathname);

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(APP).then((c) => c.add(new Request("./", { cache: "reload" }))));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== APP && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (e) => {
  if (e.data?.type !== "warm") return;
  e.waitUntil(
    caches.open(DATA).then((c) =>
      Promise.all(WARM.map(async (u) => (await c.match(u)) || c.add(u).catch(() => {})))
    )
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  const name = isData(req.url) ? DATA : APP;
  const store = (res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(name).then((c) => c.put(req, copy));
    }
    return res;
  };
  if (req.mode === "navigate") {
    // always try for the newest page, fall back to the saved one when offline
    e.respondWith(
      fetch(req)
        .then(store)
        .catch(() => caches.match(req).then((r) => r || caches.match("./")))
    );
    return;
  }
  e.respondWith(
    caches.open(name).then((c) => c.match(req)).then((hit) => hit || fetch(req).then(store))
  );
});

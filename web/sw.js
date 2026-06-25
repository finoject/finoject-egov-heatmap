// web/sw.js — オフライン対応のサービスワーカー
// 方針: ドキュメント／集計JSONは network-first（オンライン時は最新、オフライン時はキャッシュ）。
//       静的アセット（D3・アイコン・manifest）は cache-first。
// データ更新時は CACHE のバージョンを上げると確実に入れ替わる。
const CACHE = "egov-heatmap-v3";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "../data/heatmap.json",
  "../data/insights.json",
  "https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()).catch(() => {})
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const isData = url.pathname.endsWith("/data/heatmap.json");
  const isDoc = req.mode === "navigate" || url.pathname.endsWith("/web/") || url.pathname.endsWith("/web/index.html");

  if (isData || isDoc) {
    // network-first
    e.respondWith(
      fetch(req)
        .then((resp) => { const copy = resp.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); return resp; })
        .catch(() => caches.match(req).then((m) => m || caches.match("./index.html")))
    );
  } else {
    // cache-first
    e.respondWith(
      caches.match(req).then((m) => m || fetch(req).then((resp) => {
        const copy = resp.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); return resp;
      }))
    );
  }
});

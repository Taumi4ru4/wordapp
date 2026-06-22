// Service Worker: アプリの見た目(HTML/CSS/JS/アイコン)をキャッシュし、
// オフラインでもアプリが開けるようにします。
// ※ データ自体の同期はFirestoreのオフライン機能が別途担当します。

const CACHE_NAME = "tangocho-shell-v3";

const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./firebase-config.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

// Firebase SDKなど、外部CDNのスクリプトも初回取得時にキャッシュする
const RUNTIME_CACHE_HOSTS = ["www.gstatic.com"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isRuntimeHost = RUNTIME_CACHE_HOSTS.includes(url.hostname);
  const isAppShell = url.origin === self.location.origin;

  // FirestoreやAuthへのAPI通信(firestore.googleapis.com等)はキャッシュせず、
  // ブラウザ/Firebase SDK自身のオフライン処理に任せる
  if (!isAppShell && !isRuntimeHost) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // キャッシュを返しつつ、バックグラウンドで更新（次回以降に反映）
        fetch(event.request)
          .then((resp) => {
            if (resp && resp.status === 200) {
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resp));
            }
          })
          .catch(() => {});
        return cached;
      }
      return fetch(event.request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const respClone = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, respClone));
          }
          return resp;
        })
        .catch(() => caches.match("./index.html"));
    })
  );
});

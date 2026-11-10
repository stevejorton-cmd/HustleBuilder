// Offline shell for the builder. Network first, cache as the fallback.
//
// The builder is opened with many different query strings (/?draft=…,
// /?ask=…, /?account=1, /?hosting=paid). They are all the same 1.4 MB file,
// so it is stored once under "/" — never once per link — and private links
// never end up as cache keys. Only good same-origin responses are stored, so
// an error page can never replace the working offline copy.
const CACHE = "hustle-shell-2";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-192.png", "/icons/maskable-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE && name.startsWith("hustle-shell-")).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  const isBuilder = url.pathname === "/" || url.pathname === "/index.html";
  if (!isBuilder && SHELL.indexOf(url.pathname) < 0) return;
  const key = isBuilder ? "/" : url.pathname;
  event.respondWith(
    fetch(event.request).then((res) => {
      if (res.ok && res.type === "basic") {
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(key, copy)));
      }
      return res;
    }).catch(() => caches.open(CACHE).then((cache) => cache.match(key)).then((hit) => hit || Response.error()))
  );
});

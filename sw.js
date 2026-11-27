// Offline shell for the builder. Network first, cache as the fallback.
//
// The builder is opened with many different query strings (/?draft=…,
// /?ask=…, /?account=1, /?hosting=paid). They are all the same 1.4 MB file,
// so it is stored once under "/" — never once per link — and private links
// never end up as cache keys. Only good same-origin responses are stored, so
// an error page can never replace the working offline copy.
const CACHE = "hustle-shell-5";
const SHELL = ["/", "/config/season.js", "/manifest.webmanifest", "/assets/barlow.css", "/assets/print-libs.js", "/assets/gear-studio.css", "/assets/gear-studio.mjs", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-192.png", "/icons/maskable-512.png"];

// Only bundled public artwork is cached. Uploaded photos and all API data stay out.
const ARTWORK = [
  "/assets/hustle/both.webp",
  "/assets/hustle/help.webp",
  "/assets/hustle/other.webp",
  "/assets/hustle/prep.webp",
  "/assets/hustle/snow.webp",
  "/assets/hustle/tutor.webp",
  "/assets/hustle/wash.webp",
  "/assets/jobs/help-hero.webp",
  "/assets/jobs/help.webp",
  "/assets/jobs/odd-hero.webp",
  "/assets/jobs/odd.webp",
  "/assets/jobs/other-hero.webp",
  "/assets/jobs/other.webp",
  "/assets/jobs/prep.webp",
  "/assets/jobs/tutor-hero.webp",
  "/assets/jobs/tutor.webp",
  "/assets/jobs/wash-hero.webp",
  "/assets/jobs/wash.webp",
  "/assets/pets/pet-bird.webp",
  "/assets/pets/pet-cat.webp",
  "/assets/pets/pet-dog.webp",
  "/assets/pets/pet-fish.webp",
  "/assets/pets/pet-hero.webp",
  "/assets/pets/pet-og.jpg",
  "/assets/pets/pet-small.webp",
  "/assets/refresh/help.webp",
  "/assets/refresh/other.webp",
  "/assets/refresh/pet.webp",
  "/assets/refresh/prep.webp",
  "/assets/refresh/snow.webp",
  "/assets/refresh/tutor.webp",
  "/assets/refresh/wash.webp",
  "/assets/scenes/day-both.jpg",
  "/assets/scenes/day-lawn.jpg",
  "/assets/scenes/day-snow.jpg",
  "/assets/scenes/dusk-both.jpg",
  "/assets/scenes/dusk-lawn.jpg",
  "/assets/scenes/dusk-snow.jpg"
];
const imagePaths = new Set(ARTWORK);
function usableImage(res) {
  return res.ok && res.type === "basic" && /^image\//.test(res.headers.get("content-type") || "");
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then(async (cache) => {
    await cache.addAll(SHELL);
    // An unavailable optional photo must not prevent the app from updating.
    await Promise.allSettled(ARTWORK.map(async (path) => {
      const res = await fetch(new Request(path, { cache: "reload" }));
      if (usableImage(res)) await cache.put(path, res);
    }));
  }));
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
  const isBuilder = url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/parents";
  const isImage = imagePaths.has(url.pathname);
  if (!isBuilder && !isImage && SHELL.indexOf(url.pathname) < 0) return;
  const key = isBuilder ? "/" : url.pathname;
  event.respondWith(
    fetch(event.request).then((res) => {
      const good = isImage ? usableImage(res) : res.ok && res.type === "basic";
      if (good) {
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(key, copy)));
        return res;
      }
      return caches.open(CACHE).then((cache) => cache.match(key)).then((hit) => hit || res);
    }).catch(() => caches.open(CACHE).then((cache) => cache.match(key)).then((hit) => hit || Response.error()))
  );
});

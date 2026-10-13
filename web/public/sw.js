// Minimal service worker — just enough for installability.
//
// v1 bug (found live): it cache-first'd "/" (the HTML document) in SHELL. Vite's build
// output uses content-hashed asset filenames that change every build and old ones get
// deleted (emptyOutDir) — so a cached HTML referencing a since-deleted hash caused
// "Failed to load module script ... MIME type text/html" (express.static fell through
// to the SPA-fallback route for the missing asset, which serves index.html).
//
// Fix: never cache-first the HTML or hashed assets — always prefer the network for
// those (this app needs network for the live API anyway), falling back to cache only
// if truly offline. Only the handful of genuinely static, unhashed files (manifest,
// icon) are safe to cache-first.
const CACHE = "scuttle-shell-v2";
const SHELL = ["/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-180.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Never intercept the API, the live event stream, or auth.
  if (url.pathname.startsWith("/sessions") || url.pathname === "/health" || url.pathname.startsWith("/login") || url.pathname.startsWith("/logout") || url.pathname.startsWith("/browse")) return;

  // The HTML document and hashed build assets: network-first, always. A stale cached
  // HTML referencing a deleted hash is exactly the bug above — only fall back to
  // whatever's cached (which may itself be stale) if genuinely offline.
  if (event.request.mode === "navigate" || url.pathname.startsWith("/assets/")) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  // Truly static, unhashed files: cache-first is safe and fine.
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});

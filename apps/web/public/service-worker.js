const CACHE_PREFIX = "scribe-drop-static-";
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const PUBLIC_STATIC_PATHS = new Set([
  "/manifest.webmanifest",
  "/offline.css",
  "/offline.html",
  "/pwa-192.png",
  "/pwa-512.png",
  "/scribe-drop.svg",
]);
const INSTALL_PATHS = [...PUBLIC_STATIC_PATHS];

function isSafeCacheResponse(response) {
  const responseUrl = new URL(response.url);
  return (
    response.ok &&
    response.type === "basic" &&
    !response.redirected &&
    responseUrl.origin === self.location.origin
  );
}

function isPrivatePath(pathname) {
  return pathname === "/api" || pathname.startsWith("/api/") || pathname.includes("/artifacts/");
}

function isCacheableStaticRequest(request, url) {
  return (
    request.method === "GET" &&
    url.origin === self.location.origin &&
    !isPrivatePath(url.pathname) &&
    (url.pathname.startsWith("/assets/") || PUBLIC_STATIC_PATHS.has(url.pathname))
  );
}

async function fetchAndCacheStatic(cache, path) {
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
  });
  if (!isSafeCacheResponse(response)) {
    throw new Error("Static response is not safe to cache");
  }
  await cache.put(path, response);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => Promise.all(INSTALL_PATHS.map((path) => fetchAndCacheStatic(cache, path))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    isPrivatePath(url.pathname)
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/offline.html")));
    return;
  }

  if (!isCacheableStaticRequest(request, url)) {
    return;
  }
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request, { redirect: "error" }).then((response) => {
          if (isSafeCacheResponse(response)) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});

const CACHE_NAME = 'poker-with-friends-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

function isCacheableResponse(request, response) {
  if (!response.ok) return false;
  const contentType = response.headers.get('content-type') || '';
  if (request.destination === 'script') return contentType.includes('javascript');
  if (request.destination === 'style') return contentType.includes('text/css');
  return true;
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
        ),
      self.clients.claim(),
    ]),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io/') ||
    url.pathname.startsWith('/health/')
  ) {
    return;
  }

  const isNavigation = event.request.mode === 'navigate';
  const isStaticAsset =
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/manifest.webmanifest' ||
    url.pathname === '/icon.svg' ||
    url.pathname.startsWith('/assets/');
  if (!isNavigation && !isStaticAsset) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (isCacheableResponse(event.request, response)) {
          const copy = response.clone();
          const cacheKey = isNavigation ? '/index.html' : event.request;
          event.waitUntil(
            caches
              .open(CACHE_NAME)
              .then((cache) => cache.put(cacheKey, copy))
              .catch(() => undefined),
          );
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          const shell = await caches.match('/index.html');
          if (shell) return shell;
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      }),
  );
});

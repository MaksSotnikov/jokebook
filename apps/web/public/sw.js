/* Joke book service worker — makes the app installable on Android and lets the
 * shell load offline. Network-first so a connected device always gets fresh
 * code & data; falls back to the cache (and the cached app shell for
 * navigations) when offline. */
const CACHE = 'jokebook-v2'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from older versions.
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {})
        return res
      })
      .catch(async () => {
        const cached = await caches.match(req)
        if (cached) return cached
        // For navigations that miss the cache, serve the app shell.
        if (req.mode === 'navigate') {
          const shell = await caches.match('./index.html')
          if (shell) return shell
        }
        return Response.error()
      }),
  )
})

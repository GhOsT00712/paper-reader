const cacheName = 'paper-reader-shell-v1';

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    const response = await fetch('/', { cache: 'reload' });
    if (!response.ok) throw new Error('App shell unavailable');
    const html = await response.clone().text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]);
    await cache.addAll([...assets, '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest']);
    await cache.put('/', response);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('paper-reader-shell-') && key !== cacheName) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    try {
      const response = await fetch(request);
      if (response.ok && (url.pathname.startsWith('/assets/') || request.mode === 'navigate' && url.pathname === '/')) {
        await cache.put(request.mode === 'navigate' ? '/' : request, response.clone());
      }
      return response;
    } catch {
      return await cache.match(request.mode === 'navigate' ? '/' : request) ?? Response.error();
    }
  })());
});

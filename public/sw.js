// Pickett Pantry service worker: makes the app installable, keeps a copy for offline use,
// and receives things shared to the app from Android's Share menu.
const SHELL = 'pp-shell-v1';
const SHELL_FILES = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).catch(() => {}));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('pp-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function receiveShare(request) {
  const form = await request.formData();
  const box = await caches.open('pp-share');
  const meta = { title: form.get('title') || '', text: form.get('text') || '', url: form.get('url') || '', files: [] };
  const files = form.getAll('images').filter((f) => f && typeof f === 'object' && f.size);
  for (let i = 0; i < files.length && i < 5; i++) {
    const key = '/share-inbox/file-' + i;
    await box.put(key, new Response(files[i], { headers: { 'content-type': files[i].type || 'image/jpeg' } }));
    meta.files.push(key);
  }
  await box.put('/share-inbox/meta', new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
  return Response.redirect('/?shared=1', 303);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.method === 'POST' && url.pathname === '/share-target') { e.respondWith(receiveShare(e.request)); return; }
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put('/', copy)); }
      return r;
    }).catch(() => caches.match('/')));
    return;
  }
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});

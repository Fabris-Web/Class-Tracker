/* sw.js */
const CACHE_NAME = 'unit-timetable-cache-v3';

const ASSETS = [
  '/',
  '/index.html',

  // Add both HTML and extensionless routes
  '/add',
  '/add.html',
  '/timetable',
  '/timetable.html',
  '/courses',
  '/courses.html',
  '/notes',
  '/notes.html',

  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .catch(() => {})
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

/* ===============================
   FETCH HANDLER WITH FALLBACK FIX
   =============================== */
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // ✔ Handle navigation requests (when user clicks a link)
  if (req.mode === 'navigate') {
    // Try extensionless → html → network
    event.respondWith(
      caches.match(url.pathname).then(cached => {
        if (cached) return cached;

        // Try HTML fallback
        const htmlFallback = url.pathname.endsWith('.html')
          ? url.pathname
          : `${url.pathname}.html`;

        return caches.match(htmlFallback).then(foundHtml => {
          return foundHtml || fetch(req).catch(() => caches.match('/index.html'));
        });
      })
    );
    return;
  }

  // ✔ Normal GET requests (CSS, JS, images…)
  if (req.method === 'GET') {
    event.respondWith(
      caches.match(req).then(cached => {
        return cached ||
          fetch(req)
            .then(res => {
              if (res && res.status === 200) {
                caches.open(CACHE_NAME).then(cache =>
                  cache.put(req, res.clone())
                );
              }
              return res;
            })
            .catch(() => cached);
      })
    );
  }
});

/* ===============================
   BACKGROUND TIMETABLE LOGIC (UNCHANGED)
   =============================== */

async function fetchTimetableFromClients(){
  try {
    const all = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    for(const client of all){
      const channel = new MessageChannel();
      const resp = await new Promise(resolve => {
        channel.port1.onmessage = ev => resolve(ev.data);
        client.postMessage({cmd:'getTimetable'}, [channel.port2]);
        setTimeout(()=> resolve(null), 3000);
      });
      if(resp && Array.isArray(resp)) return resp;
    }
  } catch(e){ console.error(e); }
  return null;
}

self.addEventListener('periodicsync', event => {
  if(event.tag === 'timetable-check') event.waitUntil(backgroundCheck());
});
self.addEventListener('sync', event => {
  if(event.tag === 'timetable-check') event.waitUntil(backgroundCheck());
});
self.addEventListener('message', event => {});

async function backgroundCheck(){
  try {
    const data = await fetchTimetableFromClients();
    if(!data) return;
    const now = Date.now();
    for(const entry of data){
      const [hh, mm] = (entry.startTime || '00:00').split(':').map(Number);
      const candidate = nextOccurrence(entry, now);
      const remindAt = candidate - (Number(entry.reminder || 10) * 60 * 1000);
      const diff = remindAt - now;
      if(diff <= 30*60*1000 && diff >= -60*1000){
        await self.registration.showNotification(`${entry.unit} — starting soon`, {
          body: `${entry.unit} by ${entry.lecturer || 'Lecturer'} at ${entry.startTime} · ${entry.venue||''}`,
          tag: entry.id,
          data: { id: entry.id }
        });
      }
    }
  } catch(e){ console.error('bg check failed', e); }
}

function nextOccurrence(entry, fromTs = Date.now()){
  const now = new Date(fromTs);
  const today = now.getDay();
  const [hh, mm] = (entry.startTime||'00:00').split(':').map(Number);
  let daysAhead = (entry.day - today + 7) % 7;
  let candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  candidate.setDate(candidate.getDate() + daysAhead);
  if(candidate.getTime() <= fromTs) candidate.setDate(candidate.getDate() + 7);
  return candidate.getTime();
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientsArr => {
      if(clientsArr.length > 0){
        clientsArr[0].focus();
        clientsArr[0].navigate && clientsArr[0].navigate('/timetable.html');
      } else {
        self.clients.openWindow('/timetable.html');
      }
    })
  );
});

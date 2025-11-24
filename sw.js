/* sw.js */
const CACHE_NAME = 'unit-timetable-cache-v1';
const ASSETS = [
  '/',
  'index.html',
  'add.html',
  'timetable.html',
  'courses.html',
  'notes.html',
  'styles.css',
  'app.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)).catch(()=>{}));
});

self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', e => {
  const req = e.request;
  e.respondWith(
    caches.match(req).then(cached => {
      return cached || fetch(req).then(res=>{
        if(req.method === 'GET' && res && res.status === 200){
          caches.open(CACHE_NAME).then(cache => cache.put(req, res.clone()));
        }
        return res;
      }).catch(()=> cached);
    })
  );
});

// The SW cannot access localStorage; ask a client to provide timetable via MessageChannel
async function fetchTimetableFromClients(){
  try {
    const all = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    for(const client of all){
      const channel = new MessageChannel();
      const resp = await new Promise(resolve => {
        channel.port1.onmessage = ev => resolve(ev.data);
        client.postMessage({cmd:'getTimetable'}, [channel.port2]);
        // add timeout in case client doesn't respond
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

// fallback: when push-like message from page triggers 'timetable' message, we may skip
self.addEventListener('message', event => {
  // no-op; kept for compatibility
});

async function backgroundCheck(){
  try {
    const data = await fetchTimetableFromClients();
    if(!data) return;
    const now = Date.now();
    for(const entry of data){
      // compute next occurrence
      const [hh, mm] = (entry.startTime || '00:00').split(':').map(Number);
      const candidate = nextOccurrence(entry, now);
      const remindAt = candidate - (Number(entry.reminder || 10) * 60 * 1000);
      const diff = remindAt - now;
      // if within next 30 minutes (and not already triggered), show notification
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

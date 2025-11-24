/* app.js — shared for all pages */
const STORAGE_KEY = 'unit_timetable_v2';
let _classes = []; // in-memory
let _notes = {};   // per-unit notes stored separately inside classes but we keep helper

/* ---------- Utilities ---------- */
function uid(){ return 'id_' + Math.random().toString(36).slice(2,9); }
function nowTs(){ return Date.now(); }
function dayShort(d){ return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]; }
function niceTime(t){
  if(!t) return '';
  const [hh,mm] = t.split(':').map(Number);
  const suffix = hh >= 12 ? 'PM' : 'AM';
  const hh12 = ((hh + 11) %12) + 1;
  return `${String(hh12).padStart(2,'0')}:${String(mm).padStart(2,'0')} ${suffix}`;
}
function escapeHtml(s){ return (s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }

/* ---------- Storage API ---------- */
function loadStorage(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    _classes = raw ? JSON.parse(raw) : [];
  } catch(e){ console.error('load failed', e); _classes = []; }
}
function saveStorage(){
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_classes));
    if(navigator.serviceWorker && navigator.serviceWorker.controller){
      navigator.serviceWorker.controller.postMessage({cmd:'timetable', data:_classes});
    }
  } catch(e){ console.error('save failed', e); }
}

/* ---------- Public API used by pages ---------- */
async function appInit(){
  loadStorage();
  registerServiceWorker();
  scheduleAllInPageReminders();
  if('Notification' in window && Notification.permission === 'default'){
    setTimeout(()=> Notification.requestPermission().catch(()=>{}), 2000);
  }
}

/* classes manipulation */
function appGetAllClasses(){ return _classes.slice(); }
function appGetAllClassesSorted(){
  return _classes.slice().sort((a,b)=>{
    if(a.day !== b.day) return a.day - b.day;
    if(a.startTime !== b.startTime) return a.startTime.localeCompare(b.startTime);
    return a.unit.localeCompare(b.unit);
  });
}
function appAddClass(payload){
  const entry = Object.assign({}, payload, { id: uid() });
  _classes.push(entry);
  saveStorage();
  scheduleReminderForEntry(entry);
}
function appUpdateClass(id, payload){
  const idx = _classes.findIndex(x=>x.id===id);
  if(idx === -1) return;
  _classes[idx] = Object.assign({}, _classes[idx], payload);
  saveStorage();
  scheduleReminderForEntry(_classes[idx]);
}
function appDeleteClass(id){
  _classes = _classes.filter(x=>x.id!==id);
  saveStorage();
}
function appGetClassById(id){ return _classes.find(x=>x.id===id); }

/* Notes helpers */
function appGetUniqueUnits(){
  const map = {};
  for(const c of _classes){
    const key = c.unit.trim();
    if(!map[key]) map[key] = { unit: key, lecturer: c.lecturer || '', count:0 };
    map[key].count++;
  }
  return Object.values(map).sort((a,b)=> a.unit.localeCompare(b.unit));
}
function appGetNotesForUnit(unit){
  try { return localStorage.getItem('NOTES::' + unit) || ''; } catch(e){ return ''; }
}
function appSaveNotesForUnit(unit, text){
  localStorage.setItem('NOTES::' + unit, text);
}
function appUpdateNotes(id, text){
  const entry = appGetClassById(id);
  if(!entry) return;
  entry.notes = text;
  saveStorage();
}
function appGetClassesForUnit(unit){
  return _classes.filter(x => x.unit.trim() === unit.trim()).sort((a,b)=>{
    if(a.day !== b.day) return a.day - b.day;
    return a.startTime.localeCompare(b.startTime);
  });
}

/* ---------- Timers & Reminders ---------- */
const inPageTimers = {};
function nextOccurrenceTs(entry, fromTs = Date.now()){
  const now = new Date(fromTs);
  const today = now.getDay();
  const [hh, mm] = (entry.startTime||'00:00').split(':').map(Number);
  let daysAhead = (entry.day - today + 7) % 7;
  let candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  candidate.setDate(candidate.getDate() + daysAhead);
  if(candidate.getTime() <= fromTs) candidate.setDate(candidate.getDate() + 7);
  return candidate.getTime();
}
function scheduleReminderForEntry(entry){
  if(inPageTimers[entry.id]) { clearTimeout(inPageTimers[entry.id]); delete inPageTimers[entry.id]; }
  try {
    const nextTs = nextOccurrenceTs(entry);
    const remindAt = nextTs - (Number(entry.reminder||10) * 60 * 1000);
    const delay = Math.max(0, remindAt - Date.now());
    inPageTimers[entry.id] = setTimeout(()=> {
      showNotificationForEntry(entry);
      scheduleReminderForEntry(entry);
    }, delay);
  } catch(e){ console.error('schedule fail', e); }
}
function scheduleAllInPageReminders(){
  for(const k in inPageTimers){ clearTimeout(inPageTimers[k]); }
  Object.keys(inPageTimers).forEach(k=>delete inPageTimers[k]);
  for(const e of _classes) scheduleReminderForEntry(e);
}
function showNotificationForEntry(entry){
  const title = `${entry.unit} — starting soon`;
  const body = `${entry.unit} by ${entry.lecturer || 'Lecturer'} at ${niceTime(entry.startTime)} ${entry.venue? '· ' + entry.venue : ''}`;
  if(navigator.serviceWorker && navigator.serviceWorker.ready){
    navigator.serviceWorker.ready.then(reg => {
      reg.showNotification(title, { body, tag: entry.id, data:{id:entry.id}, renotify:true });
    }).catch(()=> { if(Notification.permission === 'granted') new Notification(title, { body }); });
  } else { if(Notification.permission === 'granted') new Notification(title, { body }); }
}
function getNextClass(){
  let best = null; let bestDelta = Infinity; const now = Date.now();
  for(const c of _classes){
    const ts = nextOccurrenceTs(c);
    const delta = ts - now;
    if(delta >= 0 && delta < bestDelta){ bestDelta = delta; best = {entry:c, when:ts}; }
  }
  return best;
}

/* ---------- Render functions ---------- */
function renderToday(){
  const root = document.getElementById('today-list');
  const noToday = document.getElementById('no-today');
  if(!root) return;
  root.innerHTML = '';
  const today = new Date().getDay();
  const todayClasses = _classes.filter(x => Number(x.day) === today).sort((a,b)=> a.startTime.localeCompare(b.startTime));
  if(todayClasses.length === 0){
    noToday.style.display = 'block';
  } else {
    noToday.style.display = 'none';
    todayClasses.forEach(c=>{
      const el = document.createElement('div');
      el.className = 'class-card';
      el.innerHTML = `<div>
        <div class="class-title">${escapeHtml(c.unit)}</div>
        <div class="class-meta">${niceTime(c.startTime)} — ${niceTime(c.endTime)}</div>
        <div class="small-text">${escapeHtml(c.lecturer || '')} ${c.venue? ' · ' + escapeHtml(c.venue) : ''}</div>
      </div>
      <div class="actions-col">
        <a class="btn small" href="add.html?id=${c.id}">Edit</a>
        <a class="btn small" href="notes.html?unit=${encodeURIComponent(c.unit)}">Notes</a>
        <button class="btn small danger" data-id="${c.id}">Delete</button>
      </div>`;
      root.appendChild(el);
      el.querySelector('button[data-id]')?.addEventListener('click', ()=>{
        if(confirm('Delete this class?')){ appDeleteClass(c.id); renderToday(); }
      });
    });
  }
  const next = getNextClass();
  const nextInfo = document.getElementById('next-info');
  if(next){
    const mins = Math.round((next.when - Date.now())/60000);
    nextInfo.textContent = `${next.entry.unit} in ${mins} min (${dayShort(next.entry.day)} ${niceTime(next.entry.startTime)})`;
  } else { nextInfo.textContent = 'No upcoming classes'; }
}

/* ---------- Service Worker ---------- */
async function registerServiceWorker(){
  if('serviceWorker' in navigator){
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      console.log('SW registered', reg);
      navigator.serviceWorker.addEventListener('message', ev => {
        if(ev.data && ev.data.cmd === 'getTimetable' && ev.ports && ev.ports[0]){
          ev.ports[0].postMessage(_classes);
        }
      });
      if(reg.periodicSync && 'periodicSync' in reg){
        try { await reg.periodicSync.register('timetable-check', { minInterval: 15*60*1000 }); } catch(e){ }
      }
    } catch(e){ console.warn('SW reg failed', e); }
  }
}

/* ---------- Global exposure ---------- */
window.appInit = appInit;
window.appGetClassById = appGetClassById;
window.appGetAllClassesSorted = appGetAllClassesSorted;
window.appAddClass = appAddClass;
window.appUpdateClass = appUpdateClass;
window.appDeleteClass = appDeleteClass;
window.appGetUniqueUnits = appGetUniqueUnits;
window.appGetClassesForUnit = appGetClassesForUnit;
window.appGetNotesForUnit = appGetNotesForUnit;
window.appSaveNotesForUnit = appSaveNotesForUnit;
window.appUpdateNotes = appUpdateNotes;
window.escapeHtml = escapeHtml;
window.niceTime = niceTime;
window.dayShort = dayShort;
window.scheduleAllInPageReminders = scheduleAllInPageReminders;
window.appGetAllClasses = appGetAllClasses;

/* ---------- PWA INSTALL BUTTON & THANK YOU MESSAGE ---------- */
let deferredPromptInstall = null;

const installBtn = document.getElementById('installBtn');
const installMsg = document.getElementById('install-msg');

// Listen for beforeinstallprompt and save the event
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPromptInstall = e;
  if(installBtn) installBtn.style.display = 'block';
});

// Detect if app is already installed (standalone mode)
function handleAlreadyInstalled() {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if(isStandalone) {
    if(installMsg) installMsg.textContent = 'Thank you for installing this app!';
    if(installBtn) installBtn.style.display = 'none';
    return true; // already installed
  }
  return false;
}

// Handle button click to trigger install
function setupInstallButton() {
  if(!installBtn) return;
  installBtn.addEventListener('click', async () => {
    if(!deferredPromptInstall) return;
    deferredPromptInstall.prompt();
    const choice = await deferredPromptInstall.userChoice;
    if(choice.outcome === 'accepted') {
      if(installMsg) installMsg.textContent = 'Thank you for installing this app!';
      installBtn.style.display = 'none';
    }
    deferredPromptInstall = null;
  });
}

// Listen for appinstalled event (user installs from prompt)
window.addEventListener('appinstalled', () => {
  console.log('PWA installed');
  if(installMsg) installMsg.textContent = 'Thank you for installing this app!';
  if(installBtn) installBtn.style.display = 'none';
});

// Initialize on DOM ready
window.addEventListener('DOMContentLoaded', () => {
  if(!handleAlreadyInstalled()) setupInstallButton();
});

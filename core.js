/* ===== Fasti core =====
   Pure logic: no DOM, no storage, no network. Everything here is a function of
   its arguments, which is what lets tests/tests.js cover it without a browser.
   Loads as the global FastiCore in the page and as a module in Node, with no
   build step.

   Two conventions run through the whole file:
     - a day is a civil date string, "2026-10-27"; a time is minutes since
       midnight, 840. Both are UK wall-clock. Nothing that says when an event
       happens is ever a UTC instant, so the clocks changing cannot move it.
     - "now" is passed in as { date, min } (see londonNow). Nothing reads the
       clock by itself.
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FastiCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* ================= 1. Civil dates ================= */
const DAY_MS = 864e5;
const WD   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const WDL  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MON  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const pad2 = n => String(n).padStart(2, '0');

// Days since 1970-01-01, by pure calendar arithmetic. Date.UTC is used only as
// a calendar; no time zone is involved.
function dayNum(iso){ return Math.round(Date.UTC(+iso.slice(0,4), +iso.slice(5,7) - 1, +iso.slice(8,10)) / DAY_MS); }
function isoOf(n){ const d = new Date(n * DAY_MS); return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); }
function isDate(s){ return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && isoOf(dayNum(s)) === s; }
// A date from its parts, or null when there is no such day (31 Feb).
function makeDate(y, m, d){
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const iso = y + '-' + pad2(m) + '-' + pad2(d);
  return isDate(iso) ? iso : null;
}
const addDays  = (iso, n) => isoOf(dayNum(iso) + n);
const diffDays = (a, b) => dayNum(b) - dayNum(a);
const weekday  = iso => ((dayNum(iso) % 7) + 11) % 7;       // 0 = Sunday; 1 Jan 1970 was a Thursday
const sundayOf = iso => addDays(iso, -weekday(iso));
const partsOf  = iso => ({ y: +iso.slice(0,4), m: +iso.slice(5,7), d: +iso.slice(8,10) });

/* ----- the one place a clock is read: turning an instant into London time ----- */
let _london = null;
function londonParts(ms){
  if (!_london) _london = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {};
  for (const x of _london.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { date: p.year + '-' + p.month + '-' + p.day, min: (+p.hour % 24) * 60 + +p.minute, sec: +p.second };
}
// "Now" in London, whatever zone the device is in.
function londonNow(ms){ const p = londonParts(ms); return { date: p.date, min: p.min }; }
const londonDate = ms => londonParts(ms).date;
// The instant of a London wall-clock time. Used for bookkeeping only (when a
// ticked-off task stops showing, DTSTAMP-style fields), never to store an event.
function londonMs(iso, min){
  const wall = dayNum(iso) * DAY_MS + (min || 0) * 60000;     // the wall time, read as if London were UTC
  const off = ms => { const p = londonParts(ms); return dayNum(p.date) * DAY_MS + p.min * 60000 + p.sec * 1000 - Math.floor(ms / 1000) * 1000; };
  const t = wall - off(wall);
  return wall - off(t);
}

/* ================= 2. Oxford terms and weeks ================= */
// Sunday of 1st week. Through Trinity 2028; after that the table runs out and
// dates show the calendar date only.
const TERMS = [
  { id: 'MT26', code: 'MT', name: 'Michaelmas', start: '2026-10-11' },
  { id: 'HT27', code: 'HT', name: 'Hilary',     start: '2027-01-17' },
  { id: 'TT27', code: 'TT', name: 'Trinity',    start: '2027-04-25' },
  { id: 'MT27', code: 'MT', name: 'Michaelmas', start: '2027-10-10' },
  { id: 'HT28', code: 'HT', name: 'Hilary',     start: '2028-01-16' },
  { id: 'TT28', code: 'TT', name: 'Trinity',    start: '2028-04-23' },
];
const VAC_AFTER = { MT: 'Christmas vacation', HT: 'Easter vacation', TT: 'Long vacation' };
for (const t of TERMS) { t.first = addDays(t.start, -7); t.last = addDays(t.start, 62); t.year = +t.start.slice(0, 4); }
const TERMS_END = TERMS[TERMS.length - 1].last;

const termById = id => TERMS.find(t => t.id === id) || null;
// Sunday of week n. Any whole number works: 0 is the week before 1st, 10 the week after 9th.
function weekStart(termId, n){ const t = termById(termId); return t ? addDays(t.start, 7 * (n - 1)) : null; }

// Where a date falls: in a term (0th to 9th week), in a vacation between two
// terms, or outside the table altogether.
function where(iso){
  for (let i = 0; i < TERMS.length; i++) {
    const t = TERMS[i];
    if (iso < t.first) {
      if (i === 0) return { kind: 'out' };
      const p = TERMS[i - 1];
      return { kind: 'vac', id: 'vac:' + p.id, name: VAC_AFTER[p.code], after: p, before: t, first: addDays(p.last, 1), last: addDays(t.first, -1) };
    }
    if (iso <= t.last) return { kind: 'term', term: t, week: Math.floor(diffDays(t.start, iso) / 7) + 1 };
  }
  return { kind: 'out' };
}
// Every term and vacation in order, each a whole number of Sunday-to-Saturday
// weeks. This is what the Term page steps through.
function periods(){
  const out = [];
  TERMS.forEach((t, i) => {
    out.push({ kind: 'term', id: t.id, name: t.name + ' ' + t.year, term: t, first: t.first, last: t.last, weeks: 10 });
    const n = TERMS[i + 1];
    if (n) { const first = addDays(t.last, 1), last = addDays(n.first, -1);
      out.push({ kind: 'vac', id: 'vac:' + t.id, name: VAC_AFTER[t.code], first, last, weeks: (diffDays(first, last) + 1) / 7 }); }
  });
  return out;
}
function periodOf(iso){
  const ps = periods();
  if (iso < ps[0].first) return ps[0];
  return ps.find(p => iso >= p.first && iso <= p.last) || ps[ps.length - 1];
}
// The term a bare "4th wk" means: the one we are in, or the next one if today
// is in a vacation. Null once the table has run out.
function currentTerm(today){
  const w = where(today);
  if (w.kind === 'term') return w.term;
  if (w.kind === 'vac') return w.before;
  return today < TERMS[0].first ? TERMS[0] : null;
}
// "HT" on its own: this Hilary if it is not yet over, otherwise the next.
function termFor(code, today){ return TERMS.find(t => t.code === code && t.last >= today) || null; }

/* ----- labels ----- */
function ord(n){ const a = Math.abs(n); const s = (a % 100 >= 11 && a % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[a % 10] || 'th'); return n + s; }
function weekLabel(iso){ const w = where(iso); return w.kind === 'term' ? ord(w.week) + ' wk' : w.kind === 'vac' ? w.name : ''; }
function weekTitle(iso){ const w = where(iso); return w.kind === 'term' ? ord(w.week) + ' week' : w.kind === 'vac' ? w.name : ''; }
// "Tue 27 Oct · 3rd wk". The year appears only when leaving it out could
// mislead: outside the term table, or more than 300 days from today.
function dateLabel(iso, o){
  o = o || {};
  const p = partsOf(iso);
  let s = (o.weekday === false ? '' : WD[weekday(iso)] + ' ') + p.d + ' ' + MON[p.m - 1];
  const wl = weekLabel(iso);
  if (where(iso).kind === 'out' || (o.today && Math.abs(diffDays(o.today, iso)) > 300)) s += ' ' + p.y;
  return (o.week === false || !wl) ? s : s + ' · ' + wl;
}
// "25–31 Oct", or "29 Nov – 5 Dec" across a month end.
function weekRange(sunday){
  const a = partsOf(sunday), b = partsOf(addDays(sunday, 6));
  return a.m === b.m ? a.d + '–' + b.d + ' ' + MON[b.m - 1] : a.d + ' ' + MON[a.m - 1] + ' – ' + b.d + ' ' + MON[b.m - 1];
}
const fmtTime = min => pad2(Math.floor(min / 60)) + ':' + pad2(min % 60);
function fmtDur(min){ const h = Math.floor(min / 60), m = min % 60; return h ? (m ? h + 'h ' + m + 'm' : h + 'h') : m + 'm'; }

/* ----- what the editor's boxes are read with ----- */
// A length of time as he might type it: "90", "90m", "1h", "1h30", "1h 30m", "1.5h".
// Minutes; 0 for an empty box; null if it cannot be read.
function readDuration(text){
  const s = String(text == null ? '' : text).trim().toLowerCase().replace(/^~\s*/, '');
  if (!s) return 0;
  let m;
  if ((m = /^(\d+)\s*h\s*(\d{1,2})\s*m?$/.exec(s))) return +m[1] * 60 + +m[2];
  if ((m = /^(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)$/.exec(s))) return Math.round(parseFloat(m[1]) * 60);
  if ((m = /^(\d+)\s*(?:m|mins?|minutes?)?$/.exec(s))) return +m[1];
  return null;
}
// A clock time from a time box ("14:30"): minutes since midnight, or null.
function readClock(text){
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text == null ? '' : text).trim());
  return (m && +m[1] <= 23 && +m[2] <= 59) ? +m[1] * 60 + +m[2] : null;
}
// Weeks as he might type them: "1-8", "0-8", "1, 2, 4-6". A sorted list, or null if it cannot be read.
function readWeeks(text){
  const out = [];
  for (const part of String(text == null ? '' : text).split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d{1,2})(?:(?:-|–)(\d{1,2}))?$/.exec(part);
    if (!m) return null;
    const a = +m[1], b = m[2] === undefined ? a : +m[2];
    if (b < a || b > 20) return null;
    for (let n = a; n <= b; n++) out.push(n);
  }
  return out.length ? uniqSorted(out) : null;
}
// And back: [1,2,4,5,6] as "1-2, 4-6".
function weeksText(weeks){
  const w = uniqSorted(weeks || []), parts = [];
  for (let i = 0; i < w.length; i++) { let j = i; while (j + 1 < w.length && w[j + 1] === w[j] + 1) j++; parts.push(j > i ? w[i] + '-' + w[j] : String(w[i])); i = j; }
  return parts.join(', ');
}

/* ================= 3. The state and its items ================= */
const DEFAULT_MOTTO = 'The system is not the work.';
const AREA_COLOURS = ['lec', 'lang', 'tut', 'read', 'choir', 'pers'];
function defaultAreas(){
  const rows = [['lec', 'Lectures', true], ['lang', 'Language', true], ['tut', 'Tutorials & essays', true],
                ['read', 'Reading', true], ['choir', 'Choir', false], ['pers', 'Personal', false]];
  const out = {};
  // updatedAt 0, so a rename made on either device always beats a fresh install's copy.
  rows.forEach((r, i) => { out[r[0]] = { id: r[0], name: r[1], colour: r[0], order: i, work: r[2], updatedAt: 0 }; });
  return out;
}
const DEFAULT_AREA_LIST = Object.keys(defaultAreas()).map(k => defaultAreas()[k]);
function newState(nowMs){
  return { app: 'fasti', v: 1, items: {}, areas: defaultAreas(),
    settings: { theme: 'glass', size: 'standard', weeklyTargetMin: 35 * 60, motto: DEFAULT_MOTTO, stamps: {} },
    imports: {}, created: nowMs };
}
// 12 random base-36 characters.
function newId(){
  const A = '0123456789abcdefghijklmnopqrstuvwxyz';
  const c = (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues) ? globalThis.crypto : null;
  let s = '';
  if (c) {
    const buf = new Uint8Array(24); c.getRandomValues(buf);
    for (let i = 0; i < buf.length && s.length < 12; i++) if (buf[i] < 252) s += A[buf[i] % 36];   // 252 = 7 × 36: no modulo bias
  }
  while (s.length < 12) s += A[Math.floor(Math.random() * 36)];
  return s;
}
// The three shapes of section 5.2 of BUILD.md. Every stored item goes through
// one of these, so no field is ever missing. The field names are a contract
// with whatever has already been synced: do not rename them.
function makeEvent(f){
  return { id: f.id, kind: 'event', title: f.title || '', area: f.area || 'pers', date: f.date, start: f.start, end: f.end,
    allDay: !!f.allDay, place: f.place || '', notes: f.notes || '', routine: !!f.routine, source: f.source || null, updatedAt: f.updatedAt || 0 };
}
function makeSeries(f){
  return { id: f.id, kind: 'series', title: f.title || '', area: f.area || 'pers', days: (f.days || []).slice().sort((a, b) => a - b),
    start: f.start, end: f.end, place: f.place || '', term: f.term, weeks: uniqSorted(f.weeks || []), routine: f.routine !== false,
    notes: f.notes || '', exceptions: f.exceptions || {}, updatedAt: f.updatedAt || 0 };
}
function makeTask(f){
  return { id: f.id, kind: 'task', title: f.title || '', area: f.area || 'pers', plan: f.plan || null, block: f.block || null,
    due: f.due || null, est: f.est || 0, important: !!f.important, someday: !!f.someday, done: f.done || null, dropped: f.dropped || null,
    moved: f.moved || 0, notes: f.notes || '', group: f.group || null, source: f.source || null, updatedAt: f.updatedAt || 0 };
}
function uniqSorted(a){ return Array.from(new Set(a)).sort((x, y) => x - y); }
// Can the pages safely draw this? Asked of anything that arrives from outside
// (an import batch, a backup file): one malformed item must not stop every
// page from drawing, on both devices, once it has synced.
const isInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
const okSpan = (s, e) => isInt(s, 0, 1439) && isInt(e, 1, 1440) && s < e;
const okWhen = v => v == null || Number.isFinite(v);
function validItem(it){
  if (!isObj(it) || typeof it.id !== 'string' || !it.id || !Number.isFinite(it.updatedAt)) return false;
  if (it.deleted && it.kind === undefined) return true;         // a bare deletion marker
  if (typeof it.title !== 'string') return false;
  if (it.kind === 'event') return isDate(it.date) && (!!it.allDay || okSpan(it.start, it.end));
  if (it.kind === 'series') {
    const ex = it.exceptions == null ? {} : it.exceptions;
    return typeof it.term === 'string' && Array.isArray(it.days) && it.days.length > 0 && it.days.every(d => isInt(d, 0, 6))
      && Array.isArray(it.weeks) && it.weeks.every(w => isInt(w, -9, 20)) && okSpan(it.start, it.end)
      && isObj(ex) && Object.keys(ex).every(d => isDate(d) && isObj(ex[d]) && (ex[d].date === undefined || isDate(ex[d].date))
        && (ex[d].start === undefined || isInt(ex[d].start, 0, 1439)) && (ex[d].end === undefined || isInt(ex[d].end, 1, 1440)));
  }
  if (it.kind === 'task') return (it.plan == null || isDate(it.plan))
    && (it.due == null || (isObj(it.due) && isDate(it.due.date) && (it.due.time == null || isInt(it.due.time, 0, 1439))))
    && (it.block == null || (isObj(it.block) && okSpan(it.block.start, it.block.end)))
    && okWhen(it.done) && okWhen(it.dropped) && (it.est == null || (Number.isFinite(it.est) && it.est >= 0));
  return false;
}

/* ----- repeats ----- */
// Every date a series falls on by its own rule, before any exception.
function seriesDates(s){
  const t = termById(s.term);
  if (!t) return [];
  const out = [];
  for (const w of s.weeks || []) for (const d of s.days || []) out.push(addDays(t.start, 7 * (w - 1) + d));
  return out.sort();
}
// One occurrence, with its exception applied; null if that one was cancelled.
// `orig` is the date the rule gives, and stays its name even if it was moved.
const OCC_FIELDS = ['date', 'start', 'end', 'title', 'place', 'notes', 'area'];
function occurrence(s, orig){
  const ex = s.exceptions && s.exceptions[orig];
  if (ex && ex.cancelled) return null;
  const o = { id: s.id + '@' + orig, kind: 'event', series: s.id, orig, title: s.title, area: s.area, date: orig, start: s.start, end: s.end,
    allDay: false, place: s.place || '', notes: s.notes || '', routine: !!s.routine, changed: false };
  if (ex) { for (const k of OCC_FIELDS) if (ex[k] !== undefined) o[k] = ex[k]; o.changed = true; }
  return o;
}
function seriesOccurrences(s){ const out = []; for (const d of seriesDates(s)) { const o = occurrence(s, d); if (o) out.push(o); } return out; }

// Change or cancel one occurrence. `change` is { cancelled: true } or any of
// date, start, end, title, place, notes, area.
function withException(s, orig, change, nowMs){
  const ex = Object.assign({}, s.exceptions);
  ex[orig] = change.cancelled ? { cancelled: true } : Object.assign({}, ex[orig] && !ex[orig].cancelled ? ex[orig] : {}, change);
  return Object.assign({}, s, { exceptions: ex, updatedAt: nowMs });
}
// "All future": the old series loses everything from `from` on, and a new
// series takes it, with `change` applied to its rule. Returns [old, new]; new
// is null when `change.cancelled` (the later ones are simply dropped), and old
// comes back deleted when nothing of it is left.
// A series cannot store "weeks 5 to 8 but not the Monday of week 5", so where
// a week is shared the unwanted days are cancelled in each.
function splitSeries(s, from, change, newIdValue, nowMs){
  change = change || {};
  const t = termById(s.term);
  if (!t) return [s, null];                                    // no term, so no dates: nothing to split
  const weekOf = d => Math.floor(diffDays(t.start, d) / 7) + 1;
  const all = seriesDates(s), keep = all.filter(d => d < from), later = all.filter(d => d >= from);
  const oldWeeks = uniqSorted(keep.map(weekOf)), oldEx = {};
  for (const d of Object.keys(s.exceptions || {})) if (d < from) oldEx[d] = s.exceptions[d];
  for (const d of later) if (oldWeeks.includes(weekOf(d))) oldEx[d] = { cancelled: true };
  let old = Object.assign({}, s, { weeks: oldWeeks, updatedAt: nowMs });
  old.exceptions = pruneExceptions(oldEx, old);
  if (!keep.length) old = remove(old, nowMs);
  if (change.cancelled || !later.length) return [old, null];
  // Every later date moves as the split one did: by the same number of weeks,
  // and onto the new weekday if it was on the old one.
  const a = weekday(from), b = change.date ? weekday(change.date) : a;
  const shift = change.date ? weekOf(change.date) - weekOf(from) : 0;
  const moved = d => addDays(d, 7 * shift + (weekday(d) === a ? b - a : 0));
  const next = Object.assign({}, s, { id: newIdValue, days: uniqSorted(s.days.map(d => d === a ? b : d)), weeks: uniqSorted(later.map(d => weekOf(d) + shift)), updatedAt: nowMs });
  for (const k of ['start', 'end', 'title', 'place', 'notes', 'area']) if (change[k] !== undefined) next[k] = change[k];
  const wanted = new Set(later.map(moved)), newEx = {};
  for (const d of seriesDates(next)) if (!wanted.has(d)) newEx[d] = { cancelled: true };
  // One-off changes to later occurrences travel with them. The split one's own is now the rule.
  for (const d of later) { const ex = s.exceptions && s.exceptions[d]; if (ex && d !== from) newEx[moved(d)] = ex; }
  next.exceptions = pruneExceptions(newEx, next);
  return [old, next];
}
// Exceptions only make sense for dates the rule still produces.
function pruneExceptions(ex, s){ const ok = new Set(seriesDates(s)); const out = {}; for (const d of Object.keys(ex).sort()) if (ok.has(d)) out[d] = ex[d]; return out; }

/* ----- tasks ----- */
const taskOpen = t => !!t && t.kind === 'task' && !t.deleted && !t.done && !t.dropped;
// Carry-forward. An undone task planned for an earlier day belongs to today: it
// loses its time block and counts the days it skipped. This is a view, not a
// write: the stored task is left alone, so a device that has not yet synced
// cannot overwrite an edit made elsewhere just by being opened, and both
// devices get the same answer from the same state.
function effective(t, today){
  if (!taskOpen(t) || t.someday || !t.plan || t.plan >= today) return t;
  return Object.assign({}, t, { plan: today, block: null, moved: (t.moved || 0) + diffDays(t.plan, today) });
}
function carryForward(state, today){
  const items = {};
  for (const id of Object.keys(state.items || {})) items[id] = effective(state.items[id], today);
  return Object.assign({}, state, { items });
}
// Has a deadline gone by? One with no time lasts until the end of its day.
function duePassed(due, now){
  if (!due) return false;
  if (due.date !== now.date) return due.date < now.date;
  return due.time != null && due.time < now.min;
}
const isMissed = (t, now) => taskOpen(t) && !t.someday && !!t.due && duePassed(t.due, now);
// The wording and weight of a deadline. `inDay` is true when the row already
// sits under its own day's heading, so the date need not be repeated.
function urgency(due, now, inDay){
  const days = diffDays(now.date, due.date);
  const at = due.time != null ? ' ' + fmtTime(due.time) : '';
  if (duePassed(due, now)) return { level: 'past', text: 'missed ' + dateLabel(due.date, { week: false, today: now.date }) };
  if (inDay) return { level: days <= 1 ? 'soon' : 'near', text: 'due' + at };
  if (days === 0) return { level: 'soon', text: 'due today' + at };
  if (days === 1) return { level: 'soon', text: 'due tomorrow' + at };
  if (days <= 14) return { level: 'near', text: 'due in ' + days + ' days' };
  return { level: 'far', text: 'due ' + dateLabel(due.date, { today: now.date }) };
}
// What a task adds to a day's load: its estimate, or failing that its block.
const taskLoad = t => t.est || (t.block ? t.block.end - t.block.start : 0);

/* ----- edits. Each returns a new copy stamped `nowMs`; none changes its argument. ----- */
// Before any edit to a carried task, make the carry real, so the edit starts
// from what he was looking at.
function settle(t, today){ return effective(t, today); }
function tick(t, nowMs){ return Object.assign({}, settle(t, londonDate(nowMs)), { done: nowMs, updatedAt: nowMs }); }
function untick(t, nowMs){ return Object.assign({}, t, { done: null, updatedAt: nowMs }); }
function drop(t, nowMs){ return Object.assign({}, settle(t, londonDate(nowMs)), { dropped: nowMs, updatedAt: nowMs }); }
function undrop(t, nowMs){ return Object.assign({}, t, { dropped: null, updatedAt: nowMs }); }
// `by` records a deletion made by the app itself ("undo:<batch>"), as against one he made.
function remove(item, nowMs, by){ const o = Object.assign({}, item, { deleted: true, deletedAt: nowMs, updatedAt: nowMs }); if (by) o.deletedBy = by; return o; }
function restore(item, nowMs){ const o = Object.assign({}, item, { updatedAt: nowMs }); delete o.deleted; delete o.deletedAt; delete o.deletedBy; return o; }

const TRASH_DAYS = 30, MARKER_DAYS = 90;
// A deleted item keeps its fields for 30 days, then shrinks to a marker, which
// lasts until day 90 so the other device does not bring the item back. The
// marker of an imported item keeps where it came from, so a later import can
// still tell that he deleted it.
function compact(state, nowMs){
  const items = {};
  for (const id of Object.keys(state.items || {})) {
    const it = state.items[id];
    if (it && it.deleted) {
      if (nowMs - (it.updatedAt || 0) > MARKER_DAYS * DAY_MS) continue;
      if (it.deletedAt != null && nowMs - it.deletedAt > TRASH_DAYS * DAY_MS) { const m = { id: it.id, deleted: true, updatedAt: it.updatedAt }; if (it.source) m.source = it.source; if (it.deletedBy) m.deletedBy = it.deletedBy; items[id] = m; continue; }
    }
    items[id] = it;
  }
  return Object.assign({}, state, { items });
}
// What Settings lists under "Recently deleted", newest first.
function recentlyDeleted(state){
  return Object.keys(state.items || {}).map(id => state.items[id]).filter(it => it && it.deleted && it.deletedAt != null && it.kind)
    .sort((a, b) => b.deletedAt - a.deletedAt);
}

/* ================= 4. Reading the state: what is on a day ================= */
const byTime = (a, b) => (a.allDay ? 0 : 1) - (b.allDay ? 0 : 1) || (a.start || 0) - (b.start || 0) || (a.end || 0) - (b.end || 0)
  || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// Two timed events clash when each starts before the other ends. All-day
// events, cancelled occurrences and tasks' time blocks never count.
const overlap = (a, b) => !a.allDay && !b.allDay && a.start < b.end && b.start < a.end;
function markClashes(list){
  return list.map(e => { const o = list.find(x => x !== e && overlap(e, x)); return Object.assign({}, e, { clash: o ? (o.title || 'another event') : null }); });
}
// Long gaps between a day's events. Sort by start and track the latest end so
// far; when the next event starts 90 minutes or more after it, that is a gap.
// Nothing before the first event or after the last. On today, a gap that has
// already ended is left out, and one that has begun says so (`until`).
const GAP_MIN = 90;
function freeGaps(events, o){
  o = o || {};
  const timed = events.filter(e => !e.allDay).slice().sort(byTime), out = [];
  let end = null, after = null;
  for (const e of timed) {
    if (end !== null && e.start - end >= GAP_MIN && !(o.isToday && e.start <= o.nowMin))
      out.push({ from: end, to: e.start, after, until: !!(o.isToday && end < o.nowMin) });
    if (end === null || e.end > end) { end = e.end; after = e.id; }
  }
  return out;
}
const freeText = g => g.until ? 'free until ' + fmtTime(g.to) : 'free ' + fmtTime(g.from) + '–' + fmtTime(g.to);

// The read model. Built once per render from the state and "now", it answers
// every question a page asks: what is on a day, what is late, how full a week is.
function view(state, now){
  const today = now.date, areas = state.areas || {};
  const isWork = id => { const a = own(areas, id); return !!(a && !a.deleted && a.work); };
  const events = new Map(), planned = new Map(), due = new Map(), tasks = [], sortedEvents = new Map();
  const push = (m, k, v) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
  for (const id of Object.keys(state.items || {})) {
    const it = state.items[id];
    if (!it || it.deleted) continue;
    if (it.kind === 'event') push(events, it.date, it);
    else if (it.kind === 'series') { for (const o of seriesOccurrences(it)) push(events, o.date, o); }
    else if (it.kind === 'task' && !it.dropped) {
      const t = effective(it, today);
      tasks.push(t);
      // A done task belongs to the day it was ticked off, not the day it was planned for.
      const day = t.done ? londonDate(t.done) : (t.someday ? null : t.plan);
      if (day) push(planned, day, t);
      if (t.due && !t.someday) push(due, t.due.date, t);
    }
  }
  const taskOrder = (a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || (a.block ? a.block.start : 1e4) - (b.block ? b.block.start : 1e4)
    || (b.important ? 1 : 0) - (a.important ? 1 : 0) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) || (a.id < b.id ? -1 : 1);
  const dueOrder = (a, b) => (a.due.date < b.due.date ? -1 : a.due.date > b.due.date ? 1 : 0)
    || (a.due.time == null ? 1e4 : a.due.time) - (b.due.time == null ? 1e4 : b.due.time) || (a.id < b.id ? -1 : 1);
  function eventsOn(date){
    let l = sortedEvents.get(date);
    if (!l) { l = markClashes((events.get(date) || []).slice().sort(byTime)); sortedEvents.set(date, l); }
    return l;
  }
  const tasksOn = date => (planned.get(date) || []).slice().sort(taskOrder);
  const dueOn = date => (due.get(date) || []).slice().sort(dueOrder);
  function dayLoad(date){
    let m = 0;
    for (const e of eventsOn(date)) if (!e.allDay) m += e.end - e.start;
    for (const t of planned.get(date) || []) m += taskLoad(t);
    return m;
  }
  // The ring: this week's time in areas marked as work, done or not.
  function workMinutes(sunday){
    let m = 0;
    for (let i = 0; i < 7; i++) {
      const d = addDays(sunday, i);
      for (const e of eventsOn(d)) if (!e.allDay && isWork(e.area)) m += e.end - e.start;
      for (const t of planned.get(d) || []) if (isWork(t.area)) m += taskLoad(t);
    }
    return m;
  }
  // A week's heading: "9 tasks · 9h 50m planned · 3 deadlines". Open tasks only.
  function weekStats(sunday){
    const last = addDays(sunday, 6);
    let n = 0, mins = 0, deadlines = 0;
    for (const t of tasks) {
      if (t.done || t.someday) continue;
      if (t.plan && t.plan >= sunday && t.plan <= last) { n++; mins += taskLoad(t); }
      if (t.due && t.due.date >= sunday && t.due.date <= last) deadlines++;
    }
    return { tasks: n, mins, deadlines };
  }
  return { now, today, tasks, eventsOn, tasksOn, dueOn, dayLoad, workMinutes, weekStats,
    missed: () => tasks.filter(t => isMissed(t, now)).sort(dueOrder),
    undated: () => tasks.filter(t => taskOpen(t) && !t.plan && !t.due && !t.someday).sort(taskOrder),
    someday: () => tasks.filter(t => taskOpen(t) && t.someday).sort(taskOrder),
    eventDates: () => Array.from(events.keys()).sort() };
}
// What a new event would clash with: [{ date, with }]. For the add bar's preview.
function clashesWith(state, now, candidates){
  const v = view(state, now), out = [];
  for (const c of candidates) {
    const occ = c.kind === 'series' ? seriesOccurrences(c) : c.kind === 'event' ? [c] : [];
    for (const o of occ) { const hit = v.eventsOn(o.date).find(e => e.id !== o.id && overlap(e, o)); if (hit) out.push({ date: o.date, with: hit.title || 'another event' }); }
  }
  return out;
}

/* ----- what the pages show: the same model for the phone and the Mac ----- */
// One day as rows, in the order the list shows them: all-day entries, then
// events and deadlines by time with a "free" line after a long gap, then the
// tasks planned for the day. `all` is a day opened from Term: every event,
// routine ones included. Without it, lectures and classes show only for today
// and tomorrow. A missed deadline is never here: it lives in the Pending chip.
function dayRows(v, date, o){
  const now = v.now, rel = diffDays(v.today, date), all = !!(o && o.all);
  const evs = v.eventsOn(date).filter(e => all || !e.routine || rel === 0 || rel === 1);
  const timed = evs.filter(e => !e.allDay);
  const planned = v.tasksOn(date).filter(t => t.done || !isMissed(t, now));
  const dls = v.dueOn(date).filter(t => !t.done && !isMissed(t, now) && t.plan !== date);
  const line = timed.map(e => ({ type: 'event', at: e.start, event: e, past: rel < 0 || (rel === 0 && e.end <= now.min) }))
    .concat(dls.map(t => ({ type: 'task', at: t.due.time == null ? 1440 : t.due.time, task: t, inDay: true })))
    .sort((a, b) => a.at - b.at || (a.type === 'event' ? -1 : 1));
  const gaps = (rel >= 0 && (all || rel <= 1)) ? freeGaps(timed, { isToday: rel === 0, nowMin: now.min }) : [];
  const rows = evs.filter(e => e.allDay).map(e => ({ type: 'allday', event: e }));
  for (const r of line) {
    rows.push(r);
    if (r.type === 'event') { const g = gaps.find(x => x.after === r.event.id); if (g) rows.push({ type: 'free', text: freeText(g) }); }
  }
  for (const t of planned) rows.push({ type: 'task', task: t, inDay: !!(t.due && t.due.date === date) });
  const open = planned.filter(t => !t.done);
  return { date, rows, mins: open.reduce((m, t) => m + taskLoad(t), 0), empty: rows.length === 0,
    // Everything planned for today is ticked off: the heading shows the reminder line instead of the hours.
    allDone: rel === 0 && planned.length > 0 && open.length === 0 };
}
// Deadlines and one-off events between two dates, in order, for the parts of the list that look further ahead.
function aheadRows(v, from, to){
  const rows = [];
  for (const t of v.tasks) if (taskOpen(t) && !t.someday && t.due && t.due.date >= from && t.due.date <= to)
    rows.push({ type: 'task', date: t.due.date, at: t.due.time == null ? 1440 : t.due.time, task: t, when: true });
  for (const d of v.eventDates()) if (d >= from && d <= to) for (const e of v.eventsOn(d)) if (!e.routine)
    rows.push({ type: e.allDay ? 'allday' : 'event', date: d, at: e.allDay ? -1 : e.start, event: e, when: true, past: false });
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || a.at - b.at);
}
function weekHead(v, sunday){
  const w = where(sunday);
  return { sunday, title: w.kind === 'term' ? ord(w.week) + ' week' : w.kind === 'vac' ? w.name : 'Week of ' + dateLabel(sunday, { weekday: false, week: false }),
    range: weekRange(sunday), stats: v.weekStats(sunday) };
}
// The Everything list, top to bottom.
function everything(state, now){
  const v = view(state, now), today = v.today, sun = sundayOf(today), per = periodOf(today);
  const thisWeek = Object.assign(weekHead(v, sun), { days: [] });
  // Every remaining day of this week keeps its heading, even with nothing on it.
  for (let d = today; d <= addDays(sun, 6); d = addDays(d, 1)) thisWeek.days.push(dayRows(v, d));
  const nsun = addDays(sun, 7), nextWeek = Object.assign(weekHead(v, nsun), { days: [] });
  for (let i = 0; i < 7; i++) { const r = dayRows(v, addDays(nsun, i)); if (!r.empty) nextWeek.days.push(r); }
  // Later in this term (or this vacation): a group a week, deadlines and one-off events, then how many tasks are planned.
  const later = []; let shown = addDays(nsun, 6);
  for (let s = addDays(nsun, 7); s <= per.last; s = addDays(s, 7)) {
    const rows = aheadRows(v, s, addDays(s, 6)), st = v.weekStats(s);
    if (rows.length || st.tasks) later.push(Object.assign(weekHead(v, s), { rows, more: st.tasks ? { tasks: st.tasks, mins: st.mins } : null }));
    shown = addDays(s, 6);
  }
  // After that: deadlines and one-off events only, under a heading for each vacation or term.
  const after = [], ps = periods();
  for (const p of ps) {
    const rows = aheadRows(v, p.first > shown ? p.first : addDays(shown, 1), p.last);
    if (rows.length) after.push({ id: p.id, name: p.name, rows });
  }
  const beyond = aheadRows(v, addDays(TERMS_END > shown ? TERMS_END : shown, 1), '9999-12-31');
  if (beyond.length) after.push({ id: 'beyond', name: 'Later', rows: beyond });
  return { view: v, today, period: per, pending: v.missed(), thisWeek, nextWeek, later, after, undated: v.undated(), someday: v.someday(),
    ring: { mins: v.workMinutes(sun), target: (state.settings && state.settings.weeklyTargetMin) || 0 } };
}
// The Area lens: open tasks grouped by area, each sorted by its day.
function byArea(state, now){
  const v = view(state, now), areas = Object.keys(state.areas || {}).map(k => state.areas[k]).filter(a => a && !a.deleted).sort((a, b) => a.order - b.order);
  const day = t => t.plan || (t.due ? t.due.date : '9999-99-99');
  const out = [];
  for (const a of areas) {
    const rows = v.tasks.filter(t => taskOpen(t) && !t.someday && t.area === a.id).sort((x, y) => (day(x) < day(y) ? -1 : day(x) > day(y) ? 1 : 0) || (x.title < y.title ? -1 : 1))
      .map(t => ({ type: 'task', task: t, when: true }));
    if (rows.length) out.push({ area: a, rows });
  }
  return { view: v, groups: out };
}
// Search: every word must be found in the title, place, note or area name. Past, future and timetable alike.
function searchItems(state, now, q){
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const v = view(state, now), areas = state.areas || {};
  const hay = it => [it.title, it.place, it.notes, (own(areas, it.area) || {}).name].join(' ').toLowerCase();
  const hit = it => { const h = hay(it); return words.every(w => h.indexOf(w) >= 0); };
  const rows = [];
  for (const id of Object.keys(state.items || {})) {
    const it = state.items[id];
    if (!it || it.deleted || !it.kind || !hit(it)) continue;
    if (it.kind === 'event') rows.push({ type: it.allDay ? 'allday' : 'event', date: it.date, event: it, when: true, past: it.date < v.today });
    else if (it.kind === 'series') { const d = seriesDates(it); rows.push({ type: 'series', date: d.find(x => x >= v.today) || d[d.length - 1] || '', series: it, count: seriesOccurrences(it).length }); }
    else if (it.kind === 'task' && !it.dropped) { const t = effective(it, v.today); rows.push({ type: 'task', date: t.done ? londonDate(t.done) : (t.plan || (t.due ? t.due.date : '9999-99-99')), task: t, when: true }); }
  }
  return { view: v, rows: rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)) };
}
// The Term page: one term or vacation as a grid of weeks. For each day: how
// full it is, whether an undone deadline falls on it, and its one-off events.
function termGrid(state, now, periodId){
  const v = view(state, now), ps = periods(), here = periodOf(v.today).id;
  const per = ps.find(p => p.id === periodId) || ps.find(p => p.id === here), at = ps.indexOf(per), weeks = [];
  for (let k = 0; k < per.weeks; k++) {
    const sunday = addDays(per.first, 7 * k), days = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(sunday, d), open = v.dueOn(date).filter(t => !t.done), rel = diffDays(v.today, date);
      days.push(Object.assign({ date, day: +date.slice(8), today: rel === 0, past: rel < 0,
        tint: Math.round(Math.min(1, v.dayLoad(date) / 540) * 22),                       // a nine-hour day is as dark as it gets
        fill: Math.round(Math.min(1, v.dayLoad(date) / 540) * 100),                      // the same, as the length of the Mac's bar
        due: !open.length ? null : open.some(t => isMissed(t, now)) ? 'past' : rel <= 1 ? 'soon' : 'ahead',
        dots: v.eventsOn(date).filter(e => !e.routine).slice(0, 3).map(e => e.area) }, termCell(v, date)));
    }
    weeks.push({ n: per.kind === 'term' ? k : null, sunday, days });
  }
  return { view: v, period: per, prev: at > 0 ? ps[at - 1].id : null, next: at < ps.length - 1 ? ps[at + 1].id : null, weeks };
}

/* ----- the Mac pages: the term page's cells, the week grid, and the arithmetic of dragging ----- */
// What a day's cell on the Mac's term page says, in at most three lines.
// Deadlines come first, with their times (undone before met), then one-off
// events, then all-day entries. When there are more than three, two are named
// and the rest counted: "+2 more". Lectures and classes are not listed,
// because they are the same every week.
const CELL_LINES = 3;
function termCell(v, date){
  const now = v.now, dls = v.dueOn(date), evs = v.eventsOn(date).filter(e => !e.routine), all = [];
  for (const t of dls) if (!t.done) all.push({ kind: 'due', id: t.id, text: t.title, time: t.due.time, level: urgency(t.due, now, true).level, done: false });
  for (const t of dls) if (t.done) all.push({ kind: 'due', id: t.id, text: t.title, time: t.due.time, level: 'near', done: true });
  for (const e of evs) if (!e.allDay) all.push({ kind: 'event', id: e.id, text: e.title, time: e.start });
  for (const e of evs) if (e.allDay) all.push({ kind: 'allday', id: e.id, text: e.title, time: null });
  const lines = all.length > CELL_LINES ? all.slice(0, CELL_LINES - 1) : all;
  return { lines, more: all.length - lines.length };
}
// Everything on one day as short lines, for when a day on the Mac's term page
// is hovered: all-day entries, then every event (lectures and classes too) and
// every deadline by time, then the tasks planned for the day.
function dayTip(v, date){
  const now = v.now, evs = v.eventsOn(date), dls = v.dueOn(date), seen = new Set(dls.map(t => t.id));
  const top = evs.filter(e => e.allDay).map(e => ({ lead: 'all day', text: e.title }));
  const line = evs.filter(e => !e.allDay).map(e => ({ at: e.start, lead: fmtTime(e.start) + '–' + fmtTime(e.end), text: e.title, clash: !!e.clash }))
    .concat(dls.map(t => ({ at: t.due.time == null ? 1440 : t.due.time, text: t.title, done: !!t.done, level: t.done ? 'near' : urgency(t.due, now, true).level,
      lead: (t.done ? 'handed in' : isMissed(t, now) ? 'missed' : 'due') + (t.due.time != null && !t.done ? ' ' + fmtTime(t.due.time) : '') })))
    .sort((a, b) => a.at - b.at);
  const tasks = v.tasksOn(date).filter(t => !seen.has(t.id)).map(t => ({ text: t.title, done: !!t.done,
    lead: t.done ? 'done' : t.block ? fmtTime(t.block.start) + '–' + fmtTime(t.block.end) : 'to do' }));
  return top.concat(line, tasks);
}

// Timed things that overlap are drawn side by side. Each box gets a lane, and
// `lanes`: how many lanes its group needs, which is what the page sizes it by.
function lanes(list){
  const out = list.map(x => Object.assign({}, x)).sort((a, b) => a.start - b.start || b.end - a.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let group = [], groupEnd = 0;
  const close = () => { const n = group.reduce((m, x) => Math.max(m, x.lane + 1), 0); for (const x of group) x.lanes = n; group = []; };
  for (const x of out) {
    if (group.length && x.start >= groupEnd) close();
    const taken = group.filter(y => y.end > x.start).map(y => y.lane);
    let lane = 0; while (taken.includes(lane)) lane++;
    x.lane = lane;
    groupEnd = group.length ? Math.max(groupEnd, x.end) : x.end;
    group.push(x);
  }
  close();
  return out;
}
// One week of the Mac's grid, Sunday to Saturday. For each day: its deadlines
// (the Due row), its all-day entries, and its boxes: every timed event and
// every task with a time block, in lanes. Then the panel beside the grid: the
// week's planned tasks that have no block yet, and the undated ones.
function weekGrid(state, now, sunday){
  const v = view(state, now), sun = sundayOf(isDate(sunday) ? sunday : v.today), last = addDays(sun, 6), days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(sun, i), rel = diffDays(v.today, date), evs = v.eventsOn(date);
    const boxes = evs.filter(e => !e.allDay).map(e => ({ kind: 'event', id: e.id, start: e.start, end: e.end, event: e, past: rel < 0 || (rel === 0 && e.end <= now.min) }))
      // A task ticked off on some other day than the one it was planned for has no place on the grid.
      .concat(v.tasksOn(date).filter(t => t.block && t.plan === date).map(t => ({ kind: 'task', id: t.id, start: t.block.start, end: t.block.end, task: t })));
    days.push({ date, day: +date.slice(8), today: rel === 0, past: rel < 0,
      due: v.dueOn(date).map(t => ({ task: t, level: t.done ? 'done' : urgency(t.due, now, true).level })),
      allDay: evs.filter(e => e.allDay), boxes: lanes(boxes) });
  }
  const order = (a, b) => (a.plan < b.plan ? -1 : a.plan > b.plan ? 1 : 0) || (b.important ? 1 : 0) - (a.important ? 1 : 0)
    || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) || (a.id < b.id ? -1 : 1);
  const w = where(sun);
  return Object.assign(weekHead(v, sun), { view: v, prev: addDays(sun, -7), next: addDays(sun, 7), current: sun === sundayOf(v.today),
    termName: w.kind === 'term' ? w.term.name + ' ' + w.term.year : '', days,
    toSchedule: v.tasks.filter(t => taskOpen(t) && !t.someday && !t.block && t.plan && t.plan >= sun && t.plan <= last).sort(order),
    undated: v.undated() });
}

/* ----- dragging on the week grid. Everything snaps to a quarter of an hour. ----- */
const SNAP_MIN = 15;
const snapMin = m => Math.round(m / SNAP_MIN) * SNAP_MIN;
// A box moved so that it starts at `start`: the same length, and kept inside the day.
function moveBlock(block, start){
  const len = Math.min(1440, block.end - block.start), s = Math.max(0, Math.min(1440 - len, snapMin(start)));
  return { start: s, end: s + len };
}
// A box whose lower edge is dragged to `end`: never shorter than a quarter of an hour, never past midnight.
function resizeBlock(block, end){ return { start: block.start, end: Math.min(1440, Math.max(block.start + SNAP_MIN, snapMin(end))) }; }
// The block a task gets when it is dropped on the grid at `start`: as long as
// its estimate, or an hour if it has none, rounded up to a quarter of an hour.
function dropBlock(task, start){
  const len = Math.max(SNAP_MIN, Math.ceil((task.est || 60) / SNAP_MIN) * SNAP_MIN);
  return moveBlock({ start: 0, end: len }, start);       // which also keeps it to a day at most
}
// What a drop writes. A task takes the day and the block; a carried task is
// settled first, so the edit starts from what he was looking at. With no
// block, it only goes back to its day's list.
function blockTask(task, date, block, today, nowMs){ return Object.assign({}, settle(task, today), { plan: date, block, updatedAt: nowMs }); }
function unblockTask(task, today, nowMs){ return Object.assign({}, settle(task, today), { block: null, updatedAt: nowMs }); }
function moveEvent(e, date, block, nowMs){ return Object.assign({}, e, { date, start: block.start, end: block.end, updatedAt: nowMs }); }
// One time of a repeat, moved or stretched: only what actually changed is
// recorded, so later changes to the whole repeat still reach it. This is the
// `change` that withException and splitSeries take.
function occurrenceChange(o, date, block){
  const ch = {};
  if (date !== o.date) ch.date = date;
  if (block.start !== o.start || block.end !== o.end) { ch.start = block.start; ch.end = block.end; }
  return ch;
}

/* ================= 5. The add bar's reader ================= */
// A small hand-written grammar, ported from the demo and extended. It returns
// what it understood and which characters it read as what (`marks`), so the
// preview can show both and a misread word can be tapped back into the title.
//
// One rule keeps it from eating the numbers a classicist types all day
// ("Iliad 9-10", "Thuc. 2.35", "ch. 3-4"): a number is a clock time only if it
// says so (am, pm, a colon, or a range with minutes) or comes straight after
// the day. So "Mon 9-10" and "3 Nov 11" are times, and "Iliad 9-10" is a title.
const DAYMAP = Object.assign(Object.create(null), { m:1, mo:1, mon:1, monday:1, t:2, tu:2, tue:2, tues:2, tuesday:2, w:3, we:3, wed:3, weds:3, wednesday:3,
  th:4, thu:4, thur:4, thurs:4, thursday:4, f:5, fr:5, fri:5, friday:5, s:6, sa:6, sat:6, saturday:6, su:0, sun:0, sunday:0 });
const MONTH_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTH3 = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const AREA_WORDS = [
  ['lec', /lecture/], ['tut', /tutorial|essay|collection/], ['choir', /choir|evensong|chapel|rehearsal/],
  ['lang', /\bclass(?:es)?\b|greek|latin|prose|vocab|grammar/], ['read', /\bread\b|\breading\b|chapter/] ];

function clock(h, m, ap){ h = +h; m = +(m || 0); if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; return h * 60 + m; }
// A bare hour from 1 to 7 means the afternoon, as in the lecture list. A
// leading zero ("07.30") says the writer meant it literally.
const afternoon = raw => +raw >= 1 && +raw <= 7 && raw[0] !== '0';

function parseAdd(src, ctx){
  src = String(src == null ? '' : src);
  ctx = ctx || {};
  const today = ctx.today, nowMin = ctx.nowMin == null ? 0 : ctx.nowMin;
  const areas = ctx.areas || DEFAULT_AREA_LIST;
  const low = src.replace(/[A-Z]/g, c => c.toLowerCase());     // ASCII only, so every index still lines up with src
  const marks = [], lits = [];
  const R = { days: [], weeks: null, week: null, termCode: null, termId: null, date: null, s: null, e: null, range: false,
    due: false, est: null, imp: false, place: null, area: null };
  const overlaps = (i, j) => marks.some(k => i < k.j && j > k.i) || lits.some(k => i < k.j && j > k.i);
  function take(re, type, fn){
    re.lastIndex = 0; let m;
    while ((m = re.exec(low))) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      const i = m.index, j = i + m[0].length;
      if (overlaps(i, j)) continue;
      if (fn(m, i, j) === false) continue;
      marks.push({ i, j, type });
    }
  }
  const setTime = (s, e, range) => { R.s = s; R.e = Math.min(e, 1440); R.range = !!range; };

  /* --- words he has protected: un-read by a tap, or typed in quotes --- */
  for (const u of ctx.unread || []) if (u && u.j > u.i) lits.push({ i: u.i, j: u.j, text: src.slice(u.i, u.j) });
  take(/(?<![^\s(])@"([^"]+)"/g, 'place', (m, i) => { if (R.place) return false; R.place = src.slice(i + 2, i + 2 + m[1].length).trim(); });
  { const q = /"([^"]*)"|“([^”]*)”/g; let m;
    while ((m = q.exec(low))) { const i = m.index, j = i + m[0].length; if (!overlaps(i, j)) lits.push({ i, j, text: src.slice(i + 1, j - 1) }); } }
  take(/(?<![^\s(])@([^\s@"]+)/g, 'place', (m, i) => {
    if (R.place) return false;
    const w = m[1].replace(/[.,;:)]+$/, ''); if (!w) return false;
    R.place = src.slice(i + 1, i + 1 + w.length);
  });
  take(/(?<![^\s(])#([a-z][a-z0-9&-]*)/g, 'area', m => {
    if (R.area) return false;
    const tag = m[1];
    const hit = areas.find(a => a.id === tag) || areas.find(a => String(a.name).toLowerCase().split(/[^a-z0-9]+/).some(w => w && w.startsWith(tag)));
    if (!hit) return false;
    R.area = hit.id;
  });

  /* --- weeks and terms --- */
  const okWeek = n => n >= -9 && n <= 20;
  take(/\b(?:wks?|weeks?)\.?\s*(-?\d{1,2})\s*(?:-|–|to)\s*(-?\d{1,2})\b/g, 'wk', m => {
    if (R.weeks || +m[1] > +m[2] || !okWeek(+m[1]) || !okWeek(+m[2])) return false; R.weeks = { from: +m[1], to: +m[2] }; });
  take(/\b(?:wks?|weeks?)\.?\s*(\d{1,2}(?:\s*,\s*\d{1,2})+)\b/g, 'wk', m => {
    if (R.weeks) return false; const list = m[1].split(/\s*,\s*/).map(Number); if (!list.every(okWeek)) return false; R.weeks = { list }; });
  take(/(?<![\w.-])(-?\d{1,2})(?:st|nd|rd|th)\s*(?:wk|week)\b/g, 'wk', m => { if (R.week !== null || R.weeks || !okWeek(+m[1])) return false; R.week = +m[1]; });
  take(/\b(?:wks?|weeks?)\.?\s*(-?\d{1,2})\b/g, 'wk', m => { if (R.week !== null || R.weeks || !okWeek(+m[1])) return false; R.week = +m[1]; });
  // "TT5" is Trinity's 5th week; "HT27" is the term itself.
  take(/\b(mt|ht|tt)(\d{1,2})\b/g, 'term', m => {
    if (R.termCode || R.termId) return false;
    const code = m[1].toUpperCase(), n = +m[2];
    if (n >= 20) { if (!termById(code + m[2])) return false; R.termId = code + m[2]; return; }
    if (R.week !== null || R.weeks) return false;
    R.termCode = code; R.week = n;
  });
  // A bare "HT" names the term only beside a week: on its own it is just a word.
  take(/\b(mt|ht|tt)\b/g, 'term', m => { if (R.termCode || R.termId || (R.week === null && !R.weeks)) return false; R.termCode = m[1].toUpperCase(); });

  /* --- dates --- */
  // With no year given, take the nearest such date that is not long past.
  const nearest = (mo, d) => { const y = +today.slice(0, 4); for (let k = 0; k <= 8; k++) { const x = makeDate(y + k, mo, d); if (x && diffDays(today, x) >= -60) return x; } return null; };
  take(/\b(today|tomorrow|tmrw)\b/g, 'date', m => { if (R.date) return false; R.date = m[1] === 'today' ? today : addDays(today, 1); });
  take(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(' + MONTH_RE + ')\\.?(?:\\s+(\\d{4}))?(?=\\s|$|[,;)])', 'g'), 'date', m => {
    if (R.date) return false;
    const mo = MONTH3.indexOf(m[2].slice(0, 3)) + 1;
    const d = m[3] ? makeDate(+m[3], mo, +m[1]) : nearest(mo, +m[1]);
    if (!d) return false; R.date = d;
  });
  take(/(?<![\w./])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\w/])/g, 'date', m => {
    if (R.date) return false;
    const d = m[3] ? makeDate(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]) : nearest(+m[2], +m[1]);
    if (!d) return false; R.date = d;
  });

  /* --- estimates: ~1h, ~45m, ~1.5h, ~1h30, est 2h --- */
  take(/(?:~|\best\.?\s*)(\d+)\s*h\s*(\d{1,2})\s*m(?:ins?)?\b/g, 'est', m => { if (R.est !== null) return false; R.est = +m[1] * 60 + +m[2]; });
  take(/(?:~|\best\.?\s*)(\d+)h(\d{1,2})(?![\w.:\-–])/g, 'est', m => { if (R.est !== null) return false; R.est = +m[1] * 60 + +m[2]; });
  take(/(?:~|\best\.?\s*)(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/g, 'est', m => {
    if (R.est !== null) return false; const v = parseFloat(m[1]); R.est = /^h/.test(m[2]) ? Math.round(v * 60) : Math.round(v); });

  /* --- clock times that say they are clock times --- */
  // A range; `m` is [, hour, minutes, am/pm, hour, minutes, am/pm]. When only
  // one end says am or pm, the other takes whichever keeps the range shortest:
  // "12-2pm" starts at noon, "11am-1" ends at one in the afternoon.
  function readRange(m){
    if (+m[1] > 24 || +m[4] > 24 || +(m[2] || 0) > 59 || +(m[5] || 0) > 59) return null;
    if ((m[3] || m[6]) && (+m[1] < 1 || +m[1] > 12 || +m[4] < 1 || +m[4] > 12)) return null;
    let s, e;
    if (m[3] && m[6]) { s = clock(m[1], m[2], m[3]); e = clock(m[4], m[5], m[6]) || 1440; }
    else if (m[6]) {
      e = clock(m[4], m[5], m[6]) || 1440;
      const c = [clock(m[1], m[2], 'am'), clock(m[1], m[2], 'pm')].filter(x => x < e);
      if (!c.length) return null;
      s = Math.max.apply(null, c);
    } else if (m[3]) {
      s = clock(m[1], m[2], m[3]);
      const c = [clock(m[4], m[5], 'am') || 1440, clock(m[4], m[5], 'pm')].filter(x => x > s);
      if (!c.length) return null;
      e = Math.min.apply(null, c);
    } else {
      s = clock(m[1], m[2]) + (afternoon(m[1]) ? 720 : 0); e = clock(m[4], m[5]);
      if (afternoon(m[4]) || e <= s) e += 720;
    }
    return (e > s && e <= 1440) ? [s, e] : null;
  }
  // Read anywhere only if it carries am, pm or a colon; a bare "9-10" or a
  // dotted "2.35-2.46" waits to see whether it follows a day (below).
  take(/(?<![\w.:])(\d{1,2})(?:([:.])(\d{2}))?\s*(am|pm)?\s*(?:-|–|to)\s*(\d{1,2})(?:([:.])(\d{2}))?\s*(am|pm)?\b/g, 'time', m => {
    if (R.s !== null) return false;
    if (!m[4] && !m[8] && m[2] !== ':' && m[6] !== ':') return false;
    const r = readRange([null, m[1], m[3], m[4], m[5], m[7], m[8]]); if (!r) return false; setTime(r[0], r[1], true);
  });
  take(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/g, 'time', m => {
    if (R.s !== null || +m[1] < 1 || +m[1] > 12 || +(m[2] || 0) > 59) return false; const s = clock(m[1], m[2], m[3]); setTime(s, s + 60); });
  take(/\b(noon|midday)\b/g, 'time', () => { if (R.s !== null) return false; setTime(720, 780); });
  take(/(?<![\w.:])(\d{1,2}):([0-5]\d)(?![\w:])/g, 'time', m => {
    if (R.s !== null || +m[1] > 23) return false; const s = clock(m[1], m[2]) + (afternoon(m[1]) ? 720 : 0); setTime(s, s + 60); });

  /* --- flags --- */
  take(/\bdue\b/g, 'due', () => { R.due = true; });
  take(/!+/g, 'imp', () => { R.imp = true; });

  /* --- weekdays: full names alone; one- and two-letter forms only in a run of
         two or more, or directly before a number or a week --- */
  const toks = []; { const tre = /\S+/g; let tm; while ((tm = tre.exec(low))) { const w = tm[0].replace(/[.,;:]+$/, ''); toks.push({ i: tm.index, j: tm.index + tm[0].length, w, stop: /\.[,;:]*$/.test(tm[0]) }); } }
  for (let a = 0; a < toks.length; a++) {
    if (overlaps(toks[a].i, toks[a].j) || DAYMAP[toks[a].w] === undefined) continue;
    let b = a;
    while (b + 1 < toks.length && DAYMAP[toks[b + 1].w] !== undefined && !overlaps(toks[b + 1].i, toks[b + 1].j)) b++;
    const run = toks.slice(a, b + 1), next = toks[b + 1];
    const marked = next && marks.some(k => next.i < k.j && next.j > k.i && (k.type === 'time' || k.type === 'wk' || k.type === 'term'));
    // "fr. 1", "Sat. 3", "Th. 1-22": a short form with a full stop, in the middle of a line, is as likely a
    // fragment, a Satire or the Theogony as a day. It counts only in a run, or beside a week or a time that says so.
    const shy = a > 0 && toks[a].stop && (toks[a].w.length <= 2 || toks[a].w === 'sat');
    if (run.length >= 2 || (shy ? marked : (toks[a].w.length >= 3 || (next && /^\d/.test(next.w)) || marked))) {
      for (const t of run) { marks.push({ i: t.i, j: t.j, type: 'day' }); if (!R.days.includes(DAYMAP[t.w])) R.days.push(DAYMAP[t.w]); }
    }
    a = b;
  }

  /* --- a bare time straight after the day: "Mon 9", "3 Nov 11", "Sat 0th wk 9.30", "Thu 9-10" --- */
  if (R.s === null) {
    const anchors = marks.filter(k => k.type === 'day' || k.type === 'date' || k.type === 'wk' || k.type === 'term').map(k => k.j);
    { const at = /\bat\s/g; let m; while ((m = at.exec(low))) if (!overlaps(m.index, m.index + 2)) anchors.push(-(m.index + 2)); }   // negative: after "at", minutes are required
    const re = /^[\s,(]*(\d{1,2})(?:[.:](\d{2}))?(?:\s*(?:-|–|to)\s*(\d{1,2})(?:[.:](\d{2}))?)?(?![\w.:/])/;
    for (const an of anchors.sort((x, y) => Math.abs(x) - Math.abs(y))) {
      const j0 = Math.abs(an), m = re.exec(low.slice(j0));
      if (!m) continue;
      const lead = m[0].length - m[0].replace(/^[\s,(]*/, '').length, i = j0 + lead, j = j0 + m[0].length;
      if (overlaps(i, j) || (an < 0 && !m[2])) continue;
      if (m[3] !== undefined) {
        const r = readRange([null, m[1], m[2], undefined, m[3], m[4], undefined]); if (!r) continue;
        setTime(r[0], r[1], true);
      } else {
        if (+m[1] > 23 || +(m[2] || 0) > 59) continue;
        const s = clock(m[1], m[2]) + (afternoon(m[1]) ? 720 : 0); setTime(s, s + 60);
      }
      marks.push({ i, j, type: 'time' });
      break;
    }
  }

  /* --- which term the weeks belong to --- */
  let term = null; const needs = [];
  if (R.week !== null || R.weeks || R.termId) {
    term = R.termId ? termById(R.termId) : R.termCode ? termFor(R.termCode, today) : currentTerm(today);
    if (!term) {
      // No term dates to count from: hand the words back to the title.
      for (let k = marks.length - 1; k >= 0; k--) if (marks[k].type === 'wk' || marks[k].type === 'term') marks.splice(k, 1);
      R.week = null; R.weeks = null; needs.push('term');
    }
  }
  let weeks = R.weeks ? (R.weeks.list ? uniqSorted(R.weeks.list) : Array.from({ length: R.weeks.to - R.weeks.from + 1 }, (_, i) => R.weeks.from + i)) : null;

  /* --- the title is whatever was not understood as a date, time or flag --- */
  const spans = marks.map(k => ({ i: k.i, j: k.j, text: ' ' })).concat(lits.map(k => ({ i: k.i, j: k.j, text: k.text }))).sort((x, y) => x.i - y.i);
  let title = '', p = 0;
  for (const k of spans) { if (k.i < p) continue; title += src.slice(p, k.i) + k.text; p = k.j; }
  title += src.slice(p);
  title = title.replace(/\(\s*\)|\[\s*\]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s,\-–·]+|[\s,\-–·]+$/g, '').trim();
  // Capitalise a plain lower-case first word. Leave "iPhone" and Greek (λύω) exactly as typed.
  if (/^[a-z]+(?![A-Za-z])/.test(title)) title = title[0].toUpperCase() + title.slice(1);
  const tl = title.toLowerCase();
  const guess = AREA_WORDS.find(a => a[1].test(tl));
  const area = R.area || (guess ? guess[0] : 'pers');

  /* --- what kind of thing it is --- */
  const days = R.days.slice().sort((x, y) => x - y);
  const repeat = !!weeks || days.length > 1;
  let kind;
  if (R.due) kind = repeat ? 'deadlines' : 'deadline';
  else if (repeat) kind = 'series';
  else if (R.s !== null) kind = R.est ? 'planned' : 'event';          // a time and an estimate: a task with a time block
  else if (R.date || days.length === 1 || R.week !== null) kind = 'planned';
  else kind = 'task';

  let date = null, weekOnly = false, repDays = days, dates = null, count = null;
  if (repeat) {
    if (!repDays.length && R.date) repDays = [weekday(R.date)];
    if (!term) term = currentTerm(today);
    if (!weeks && term) {
      // No weeks given: from this week to 8th (from 1st, if this is 0th week), or weeks 1 to 8 of the term to come.
      // If this week's days have all gone by, start next week.
      const w = where(today); let from = 1;
      if (w.kind === 'term' && w.term.id === term.id) {
        from = Math.max(w.week, 1);
        const sunday = addDays(term.start, 7 * (from - 1));
        if (repDays.length && !repDays.some(d => addDays(sunday, d) >= today)) from++;
      }
      weeks = []; for (let n = from; n <= Math.max(8, from); n++) weeks.push(n);
    }
    if (!term && !needs.includes('term')) needs.push('term');
    if (!repDays.length) needs.push('day');
    if (kind === 'series' && R.s === null) needs.push('time');
    if (term && weeks) {
      dates = []; for (const w of weeks) for (const d of repDays) dates.push(addDays(term.start, 7 * (w - 1) + d));
      dates.sort(); count = dates.length;
    }
  } else {
    const passed = R.s !== null && R.s <= nowMin;
    if (R.date) date = R.date;
    else if (days.length === 1 && R.week !== null) date = addDays(term.start, 7 * (R.week - 1) + days[0]);
    else if (days.length === 1) { for (let i = 0; i < 8; i++) { const x = addDays(today, i); if (weekday(x) === days[0] && !(i === 0 && passed)) { date = x; break; } } }
    else if (R.week !== null) { date = weekStart(term.id, R.week); weekOnly = true; }
    else if (R.s !== null) date = passed ? addDays(today, 1) : today;
    // A week is enough for a task to be planned in, but an event or a deadline needs its day; and a
    // deadline with no date at all is not quietly set to today.
    if (weekOnly && (kind !== 'planned' || R.s !== null)) needs.push('day');
    if (kind === 'deadline' && !date) needs.push('date');
  }
  const block = (kind === 'planned' && R.s !== null) ? { start: R.s, end: R.range ? R.e : Math.min(1440, R.s + R.est) } : null;
  if (!title) needs.push('title');

  return { src, title, kind, area, date, weekOnly, days: repeat ? repDays : days, weeks, weeksSpec: R.weeks, week: R.week, term: term ? term.id : null,
    start: R.s, end: R.e, est: R.est, important: R.imp, place: R.place || '', block, dates, count, needs, marks: marks.slice().sort((x, y) => x.i - y.i) };
}

const KIND_WORDS = { deadline: 'Deadline', deadlines: 'Repeating deadline', series: 'Repeating event', event: 'Event', planned: 'Task for a day', task: 'Task, no date yet' };
const NEED_WORDS = { title: 'Give it a title.', date: 'Say when it is due, for example “Fri” or “3 Nov”.', day: 'Say which day, for example “Wed”.', time: 'Say what time, for example “9” after the day, or “2pm”.',
  term: 'The term dates end at Trinity 2028, so a week number cannot be read here.' };
function weeksWords(r){
  const w = r.weeks || [];
  if (!w.length) return '';
  const run = w.every((n, i) => i === 0 || n === w[i - 1] + 1);
  return w.length === 1 ? ord(w[0]) + ' wk' : run ? ord(w[0]) + '–' + ord(w[w.length - 1]) + ' wk' : 'wks ' + w.join(', ');
}
// The preview: what the bar understood, as labelled chips and one sentence.
// Plain text only; the page does the escaping and the bold.
function describe(r, ctx){
  ctx = ctx || {};
  const areas = ctx.areas || DEFAULT_AREA_LIST;
  const areaName = (areas.find(a => a.id === r.area) || { name: r.area }).name;
  const chips = [['What', KIND_WORDS[r.kind]], ['Title', r.title || '(none yet)']];
  const otherTerm = r.term && ctx.today && currentTerm(ctx.today) && currentTerm(ctx.today).id !== r.term ? ', ' + termById(r.term).name + ' ' + termById(r.term).year : '';
  const dayNames = r.days.map(d => WD[d]).join(', ');
  let when = '';
  if (r.kind === 'series') when = (dayNames || 'No day yet') + ' · ' + weeksWords(r) + otherTerm + (r.count ? ' · ' + r.count + ' times' : '');
  else if (r.kind === 'deadlines') when = (r.count || 0) + ' deadlines, ' + (dayNames || 'no day yet') + (r.start !== null ? ' ' + fmtTime(r.start) : '') + ', ' + weeksWords(r) + otherTerm;
  else if (r.weekOnly) when = ord(r.week) + ' week' + otherTerm + ' (no day given)';
  else if (r.date) when = dateLabel(r.date, { today: ctx.today });
  if (when) chips.push(['When', when]);
  if (r.start !== null && r.kind !== 'deadlines') chips.push(r.kind === 'deadline' ? ['Due at', fmtTime(r.start)]
    : [r.block ? 'Time block' : 'Time', fmtTime(r.block ? r.block.start : r.start) + '–' + fmtTime(r.block ? r.block.end : r.end)]);
  chips.push(['Area', areaName]);
  if (r.est && r.kind !== 'event' && r.kind !== 'series') chips.push(['Estimate', fmtDur(r.est)]);
  if (r.place) chips.push(['Place', r.place]);
  if (r.important) chips.push(['Marked', 'Important']);
  const t = r.title || 'Untitled';
  let will;
  if (r.kind === 'series') will = ['Will add ', t, ', ' + when + (r.start !== null ? ', ' + fmtTime(r.start) + '–' + fmtTime(r.end) : '') + '.'];
  else if (r.kind === 'deadlines') will = ['Will add ', t, ': ' + when + '.'];
  else if (r.kind === 'event') will = ['Will add ', t, ' on ' + when + ', ' + fmtTime(r.start) + '–' + fmtTime(r.end) + '.'];
  else if (r.kind === 'deadline') will = ['Will add a deadline: ', t, ', ' + (when || 'no date yet') + (r.start !== null ? ' at ' + fmtTime(r.start) : '') + '.'];
  else if (r.kind === 'planned') will = ['Will add ', t, ' to your list for ' + when + (r.block ? ', ' + fmtTime(r.block.start) + '–' + fmtTime(r.block.end) : '') + '.'];
  else will = ['Will add ', t, ' to Undated.'];
  return { chips, will, needs: r.needs.map(n => NEED_WORDS[n]) };
}
// The words the add bar opens with when an empty slot on the week grid is
// clicked: a day and a time that the reader above reads back exactly. The year
// is added only when the reader would otherwise pick another one.
function slotText(date, min, today){
  const p = partsOf(date), day = p.d + ' ' + MON[p.m - 1], time = fmtTime(min);
  return (parseAdd('x ' + day + ' ' + time, { today }).date === date ? day : day + ' ' + p.y) + ' ' + time;
}
// Turn what was read into the items to store. `mk` supplies { now, id() }.
// Returns [] while something is still missing (see `needs`).
function buildItems(r, mk){
  if (r.needs.length) return [];
  const now = mk.now, id = mk.id || newId;
  const base = { title: r.title, area: r.area, updatedAt: now };
  if (r.kind === 'event') return [makeEvent(Object.assign({ id: id(), date: r.date, start: r.start, end: r.end, place: r.place }, base))];
  // A repeat he types is timetable: it shows in the list for today and tomorrow only.
  if (r.kind === 'series') return [makeSeries(Object.assign({ id: id(), days: r.days, start: r.start, end: r.end, place: r.place, term: r.term, weeks: r.weeks, routine: true }, base))];
  const task = { est: r.est || 0, important: r.important, notes: r.place ? '@ ' + r.place : '' };
  if (r.kind === 'deadline') return [makeTask(Object.assign({ id: id(), due: { date: r.date, time: r.start } }, task, base))];
  // A deadline that repeats is not a series: one separate task a week, sharing a group id.
  if (r.kind === 'deadlines') { const group = id(); return r.dates.map(d => makeTask(Object.assign({ id: id(), due: { date: d, time: r.start }, group }, task, base))); }
  if (r.kind === 'planned') return [makeTask(Object.assign({ id: id(), plan: r.date, block: r.block }, task, base))];
  return [makeTask(Object.assign({ id: id() }, task, base))];
}

/* ================= 6. Merging two copies ================= */
// JSON with every object's keys sorted, so equal values always give equal text.
function canon(v){
  if (v === null || typeof v !== 'object') { const j = JSON.stringify(v); return j === undefined ? 'null' : j; }
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
// An object's own value for a key. Plain `o[k]` would also find the names every object inherits
// ("constructor", "toString"), which must behave like any other name here.
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
const stampOf = v => (isObj(v) && Number.isFinite(v.updatedAt)) ? v.updatedAt : 0;
// The later copy wins; on a tie, the one whose canonical JSON sorts later.
// Never "the local one": that is what makes the answer the same on both sides.
function pickLater(a, b){
  if (a === undefined) return b;
  if (b === undefined) return a;
  const ta = stampOf(a), tb = stampOf(b);
  if (ta !== tb) return ta > tb ? a : b;
  return canon(a) >= canon(b) ? a : b;
}
function mergeById(a, b){
  const A = isObj(a) ? a : {}, B = isObj(b) ? b : {}, out = {};
  for (const id of Array.from(new Set(Object.keys(A).concat(Object.keys(B)))).sort()) {
    if (id === '__proto__') continue;                       // never reparent the object being built
    out[id] = pickLater(own(A, id), own(B, id));
  }
  return out;
}
// Settings merge field by field, each by its own stamp.
function mergeSettings(a, b){
  const A = isObj(a) ? a : {}, B = isObj(b) ? b : {}, sa = isObj(A.stamps) ? A.stamps : {}, sb = isObj(B.stamps) ? B.stamps : {};
  const out = {}, stamps = {};
  const t = (s, k) => Number.isFinite(own(s, k)) ? s[k] : 0;
  for (const k of Array.from(new Set(Object.keys(A).concat(Object.keys(B)))).sort()) {
    if (k === 'stamps' || k === '__proto__') continue;
    const ta = t(sa, k), tb = t(sb, k), va = own(A, k), vb = own(B, k);
    let v;
    if (ta !== tb) v = ta > tb ? va : vb;
    else if (va === undefined || vb === undefined) v = va === undefined ? vb : va;
    else v = canon(va) >= canon(vb) ? va : vb;
    if (v !== undefined) out[k] = v;
  }
  for (const k of Array.from(new Set(Object.keys(sa).concat(Object.keys(sb)))).sort()) { if (k !== '__proto__' && Math.max(t(sa, k), t(sb, k)) > 0) stamps[k] = Math.max(t(sa, k), t(sb, k)); }
  out.stamps = stamps;
  return out;
}
const STATE_FIELDS = ['app', 'v', 'items', 'areas', 'settings', 'imports', 'created'];
// Pure, and the same answer whichever side is "local": mergeStates(a, b) and
// mergeStates(b, a) are equal, key for key.
function mergeStates(a, b){
  const A = isObj(a) ? a : {}, B = isObj(b) ? b : {}, out = {};
  // Fields this version does not know are kept, not dropped.
  for (const k of Array.from(new Set(Object.keys(A).concat(Object.keys(B)))).sort()) {
    if (STATE_FIELDS.indexOf(k) >= 0 || k === '__proto__') continue;
    const va = own(A, k), vb = own(B, k);
    out[k] = va === undefined ? vb : vb === undefined ? va : (canon(va) >= canon(vb) ? va : vb);
  }
  out.app = 'fasti';
  out.v = Math.max(A.v | 0, B.v | 0) || 1;
  out.items = mergeById(A.items, B.items);
  out.areas = mergeById(A.areas, B.areas);
  out.settings = mergeSettings(A.settings, B.settings);
  out.imports = mergeById(A.imports, B.imports);
  const created = [A.created, B.created].filter(Number.isFinite);
  if (created.length) out.created = Math.min.apply(null, created);
  return out;
}
// Set one setting, with its stamp.
function withSetting(state, key, value, nowMs){
  const s = Object.assign({}, state.settings), stamps = Object.assign({}, s.stamps);
  s[key] = value; stamps[key] = nowMs; s.stamps = stamps;
  return Object.assign({}, state, { settings: s });
}

/* ----- the inbox: batches the import tools leave for the app to collect ----- */
// What an import says about an item, as text: the fields the source supplies.
// It is stored with the item (source.sig), so the next import can tell what
// has changed at the source from what he has changed himself.
const SOURCE_FIELDS = {
  event:  ['title', 'area', 'date', 'start', 'end', 'allDay', 'place', 'notes', 'routine'],
  series: ['title', 'area', 'days', 'start', 'end', 'place', 'term', 'weeks', 'notes', 'routine'],
  task:   ['title', 'area', 'plan', 'due', 'est', 'important', 'notes'] };
function sourceSig(it){ return canon((SOURCE_FIELDS[it.kind] || []).map(k => it[k] === undefined ? null : it[k])); }
function withSourceSig(it){ return Object.assign({}, it, { source: Object.assign({}, it.source, { sig: sourceSig(it) }) }); }
// An imported item meeting the copy already on the device. His own changes
// survive a second import of the same thing:
//   - nothing changed at the source: his copy stands, edits, deletion and all;
//   - something changed at the source: each field he has not touched takes the
//     new value, each field he has changed keeps his; a deleted one stays deleted
//     (the copy is his, deletion mark and all, with the untouched fields updated);
//   - it was removed by Undo: a fresh import brings it back.
function mergeImport(local, inc){
  if (local === undefined) return inc;
  const later = Math.max(stampOf(local), stampOf(inc)) + 1;
  // Stamped to win over every older copy of the item; one more again if it carries a change of his,
  // so that it also wins over the plain new version a device without that change will make.
  const plain = Math.max(stampOf(inc), stampOf(local) + 1);
  if (local.deleted && typeof local.deletedBy === 'string' && local.deletedBy.indexOf('undo:') === 0) return Object.assign({}, inc, { updatedAt: plain });
  const was = isObj(local.source) ? local.source.sig : undefined, now = isObj(inc.source) ? inc.source.sig : undefined;
  // A marker is all that is left of something he deleted more than 30 days ago. It stays deleted,
  // whatever the source now says; only its note of what the source says is brought up to date.
  if (local.deleted && local.kind === undefined) return was === now ? local : Object.assign({}, local, { source: inc.source, updatedAt: plain });
  if (typeof was !== 'string' || typeof now !== 'string') return pickLater(local, inc);     // not tracked: the later copy wins
  if (was === now) return local;
  let old = null; try { old = JSON.parse(was); } catch (e) {}
  const fields = SOURCE_FIELDS[inc.kind];
  if (!Array.isArray(old) || !fields || local.kind !== inc.kind) return pickLater(local, inc);
  const out = Object.assign({}, local); let his = false;
  fields.forEach((k, n) => { if (canon(local[k] === undefined ? null : local[k]) === canon(old[n] === undefined ? null : old[n])) out[k] = inc[k]; else his = true; });
  out.source = inc.source; out.updatedAt = his ? later : plain;
  return out;
}
// Takes every batch the state has not yet recorded. The record is stamped with
// the batch's own time, not the clock, so two devices that collect the same
// batch end up with the same state. It also keeps what Undo will need: which
// items the batch added, and the copy of each item it replaced.
function collectInbox(state, inbox){
  const batches = (isObj(inbox) && Array.isArray(inbox.batches)) ? inbox.batches : [];
  const have = isObj(state.imports) ? state.imports : {};
  let items = null, imports = null; const added = [];
  for (const b of batches) {
    if (!isObj(b) || typeof b.id !== 'string' || b.id === '__proto__' || own(have, b.id) || (imports && own(imports, b.id))) continue;
    if (!items) { items = Object.assign({}, state.items); imports = Object.assign({}, have); }
    const ids = [], fresh = [], replaced = {};
    for (const it of Array.isArray(b.items) ? b.items : []) {
      if (!validItem(it) || it.id === '__proto__') continue;      // a malformed item is left out, not stored
      const local = own(items, it.id), next = mergeImport(local, it);
      ids.push(it.id);
      if (next === local) continue;
      if (local === undefined) fresh.push(it.id); else replaced[it.id] = local;
      items[it.id] = next;
    }
    imports[b.id] = { at: b.at, label: b.label || '', ids, added: fresh, replaced, undone: false, updatedAt: Number.isFinite(b.at) ? b.at : 0 };
    added.push(b.id);
  }
  return { state: items ? Object.assign({}, state, { items, imports }) : state, added };
}
// Undo removes what that import added and puts back what it replaced. Nothing
// from an earlier import is touched.
function undoImport(state, batchId, nowMs){
  const rec = isObj(state.imports) ? own(state.imports, batchId) : undefined;
  if (!rec || rec.undone) return state;
  const items = Object.assign({}, state.items);
  // A record written before `added` existed lists only ids: treat them all as added.
  for (const id of rec.added || rec.ids || []) { const it = own(items, id); if (it && !it.deleted) items[id] = remove(it, nowMs, 'undo:' + batchId); }
  for (const id of Object.keys(rec.replaced || {})) if (id !== '__proto__') items[id] = Object.assign({}, rec.replaced[id], { updatedAt: nowMs });
  const imports = Object.assign({}, state.imports);
  imports[batchId] = Object.assign({}, rec, { replaced: {}, undone: true, updatedAt: nowMs });
  return Object.assign({}, state, { items, imports });
}

/* ----- for the import tools (tools/): a batch to leave in the inbox, and what the app will make of it ----- */
// A batch. Every item is completed (no field missing), marked as an import, given
// the record of what its source says, and checked. An item with no id takes one
// from where it came from, "src:<feed>:<uid>", so importing the same thing again
// updates it and never makes a second copy. Anything that cannot be stored
// safely is left out and handed back in `rejected`.
// o: { id, at, label, feed }
const MAKERS = { event: makeEvent, series: makeSeries, task: makeTask };
function makeBatch(list, o){
  const items = [], rejected = [], seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const mk = isObj(raw) ? MAKERS[raw.kind] : null, src = isObj(raw) && isObj(raw.source) ? raw.source : {};
    const feed = src.feed || o.feed || null, uid = src.uid == null ? null : String(src.uid);
    const id = isObj(raw) && typeof raw.id === 'string' && raw.id ? raw.id : (feed && uid ? 'src:' + feed + ':' + uid : null);
    if (!mk || !id || seen.has(id)) { rejected.push(raw); continue; }
    let it; try { it = mk(Object.assign({}, raw, { id, updatedAt: o.at })); } catch (e) { rejected.push(raw); continue; }
    it = withSourceSig(Object.assign(it, { source: { via: 'claude', batch: o.id, uid, feed } }));
    if (!validItem(it)) { rejected.push(raw); continue; }
    seen.add(id); items.push(it);
  }
  return { batch: { id: o.id, at: o.at, label: o.label || '', items }, rejected };
}
// What the app will do with each item of a batch when it collects it: the same
// comparison as mergeImport, said in words.
//   new        not in the app (or taken out by Undo): it will be added;
//   unchanged  the source says what it said last time: his copy stands, whatever he has done to it;
//   changed    the source says something new. `fields` are what it changed; `kept` are those of them
//              he has changed himself, which keep his value. The rest take the new one;
//   deleted    he deleted it. It stays deleted, whatever the source now says.
// And `gone`: things in the app from this feed that the source no longer lists
// (given `ids`, everything it lists now). An import never removes them.
function importPlan(state, items, o){
  o = o || {};
  const have = isObj(state && state.items) ? state.items : {}, rows = [];
  const val = (x, k) => canon(x[k] === undefined ? null : x[k]);
  for (const it of items) {
    // The merge itself is run, so the preview cannot say one thing and the app do another.
    const local = own(have, it.id), next = mergeImport(local, it), row = { id: it.id, item: it, status: 'new', fields: [], kept: [] };
    rows.push(row);
    if (local === undefined) continue;
    if (next === local) { row.status = local.deleted ? 'deleted' : 'unchanged'; continue; }
    if (local.deleted) { row.status = next.deleted ? 'deleted' : 'new'; continue; }      // "new" here: Undo had taken it out, and it comes back
    for (const k of SOURCE_FIELDS[it.kind] || []) {
      if (val(next, k) !== val(local, k)) row.fields.push(k);                             // the source changed it, and the app will take the change
      else if (val(it, k) !== val(local, k)) { row.fields.push(k); row.kept.push(k); }    // the source changed it, but so had he: his stays
    }
    row.status = 'changed';
  }
  const gone = [];
  if (o.feed && Array.isArray(o.ids)) {
    const all = new Set(o.ids);
    for (const id of Object.keys(have)) { const it = have[id]; if (it && !it.deleted && isObj(it.source) && it.source.feed === o.feed && !all.has(id)) gone.push(it); }
  }
  return { rows, gone };
}
// A list of items in Oxford terms, for the preview. Events at the same time on
// the same weekday through a term are one line with their weeks ("Mon
// 11:00–12:00 · wks 1-8 · MT26"); anything else is a line by itself.
function previewRows(items, today){
  const rows = [], groups = new Map(), span = (a, z) => fmtTime(a) + '–' + fmtTime(z);
  for (const it of items) {
    if (it.kind === 'event' && !it.allDay && where(it.date).kind === 'term') {
      const w = where(it.date), key = canon([it.title, weekday(it.date), it.start, it.end, it.place, w.term.id]);
      let g = groups.get(key);
      if (!g) { g = { first: it.date, at: it.start, title: it.title, place: it.place || '', count: 0, weeks: [], term: w.term.id, lead: WD[weekday(it.date)] + ' ' + span(it.start, it.end) }; groups.set(key, g); rows.push(g); }
      g.weeks.push(w.week); g.count++; if (it.date < g.first) g.first = it.date;
    }
    else if (it.kind === 'event') rows.push({ first: it.date, at: it.allDay ? -1 : it.start, title: it.title, place: it.place || '', count: 1, when: dateLabel(it.date, { today }) + (it.allDay ? ' · all day' : ' · ' + span(it.start, it.end)) });
    else if (it.kind === 'series') rows.push({ first: seriesDates(it)[0] || '', at: it.start, title: it.title, place: it.place || '', count: seriesOccurrences(it).length,
      when: it.days.map(d => WD[d]).join(' ') + ' ' + span(it.start, it.end) + ' · wks ' + weeksText(it.weeks) + ' · ' + it.term });
    else rows.push({ first: (it.due ? it.due.date : it.plan) || '9999-99-99', at: it.due && it.due.time != null ? it.due.time : 1440, title: it.title, place: '', count: 1,
      when: it.due ? 'due ' + dateLabel(it.due.date, { today }) + (it.due.time != null ? ' ' + fmtTime(it.due.time) : '') : it.plan ? 'for ' + dateLabel(it.plan, { today }) : 'no date' });
  }
  for (const g of groups.values()) { const w = uniqSorted(g.weeks); g.when = g.lead + ' · ' + (w.length === 1 ? ord(w[0]) + ' wk' : 'wks ' + weeksText(w)) + ' · ' + g.term; }
  return rows.sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0) || a.at - b.at || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))
    .map(r => ({ when: r.when, title: r.title, place: r.place, count: r.count }));
}
// The inbox with one more batch in it. A batch is cleared out once it is more
// than 30 days old and the state records it: by then every device has it,
// through the state itself. One the app has not yet collected is kept, however old.
const INBOX_DAYS = 30;
function inboxWith(inbox, batch, state, nowMs){
  const old = (isObj(inbox) && Array.isArray(inbox.batches)) ? inbox.batches : [], have = isObj(state && state.imports) ? state.imports : {};
  const keep = old.filter(b => isObj(b) && typeof b.id === 'string' && b.id !== batch.id && !(own(have, b.id) !== undefined && Number.isFinite(b.at) && nowMs - b.at > INBOX_DAYS * DAY_MS));
  return { app: 'fasti-inbox', v: 1, batches: keep.concat([batch]) };
}

// "Added 32 from Claude: lectures and Greek classes". Null when the batch changed nothing.
function importSummary(rec){
  const n = (rec.added || rec.ids || []).length, c = Object.keys(rec.replaced || {}).length;
  if (!n && !c) return null;
  const what = n && c ? 'Added ' + n + ' and updated ' + c : n ? 'Added ' + n : 'Updated ' + c;
  return what + ' from Claude' + (rec.label ? ': ' + rec.label : '');
}

/* ----- backups: everything as one file, and reading one back ----- */
// The file's shape is a contract (BUILD.md section 5.4): { app, format, exportedAt, state }.
const BACKUP_FORMAT = 1;
function makeBackup(state, nowMs){ return { app: 'fasti', format: BACKUP_FORMAT, exportedAt: nowMs, state }; }
// A backup file's text, checked before anything is done with it. Whatever could
// not be drawn safely is left out and counted (`left`): one bad entry must not
// stop every page from drawing, on both devices, once it has synced.
function readBackup(text){
  let j = null; try { j = JSON.parse(text); } catch (e) {}
  if (!isObj(j) || j.app !== 'fasti' || !isObj(j.state) || j.state.app !== 'fasti' || !isObj(j.state.items)) return { ok: false, error: 'That is not a Fasti backup file.' };
  if (j.format !== BACKUP_FORMAT) return { ok: false, error: 'That backup is in a form this version of Fasti does not read. Update Fasti and try again.' };
  const s = j.state, items = {}, areas = {}, imports = {}; let left = 0, live = 0;
  for (const id of Object.keys(s.items)) { const it = s.items[id]; if (id !== '__proto__' && validItem(it) && it.id === id) { items[id] = it; if (!it.deleted) live++; } else left++; }
  for (const id of Object.keys(isObj(s.areas) ? s.areas : {})) { const a = s.areas[id];
    if (id !== '__proto__' && isObj(a) && a.id === id && typeof a.name === 'string' && AREA_COLOURS.indexOf(a.colour) >= 0 && Number.isFinite(a.order) && Number.isFinite(a.updatedAt)) areas[id] = a; else left++; }
  for (const id of Object.keys(isObj(s.imports) ? s.imports : {})) if (id !== '__proto__' && isObj(s.imports[id])) imports[id] = s.imports[id];
  return { ok: true, exportedAt: Number.isFinite(j.exportedAt) ? j.exportedAt : null, items: live, left,
    state: Object.assign({}, s, { items, areas, imports, settings: isObj(s.settings) ? s.settings : {} }) };
}
// Bringing a backup in is a merge, exactly as with another device: of two
// copies of a thing, the one changed later is kept. So an old backup cannot
// undo what has been done since, and a backup brought into an empty app gives
// the backup itself. `fresh` is how many of its items were not here at all.
function importBackup(state, backup){
  const have = isObj(state && state.items) ? state.items : {};
  return { state: mergeStates(state, backup), fresh: Object.keys(backup.items).filter(id => own(have, id) === undefined && !backup.items[id].deleted).length };
}

/* ================= 7. Calendar files ================= */
/* ----- writing ----- */
const icsEsc = s => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/([,;])/g, '\\$1');
const icsDay = iso => iso.replace(/-/g, '');
const icsLocal = (iso, min) => icsDay(iso) + 'T' + pad2(Math.floor(min / 60)) + pad2(min % 60) + '00';
function icsUtc(ms){ const d = new Date(ms); return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + 'T' + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z'; }
// Lines are at most 75 bytes; a longer one continues on the next, after a space.
function icsFold(line){
  const enc = s => { let n = 0; for (const ch of s) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; } return n; };
  if (enc(line) <= 75) return line;
  const out = []; let cur = '', n = 0;
  for (const ch of line) {
    const w = enc(ch), limit = out.length ? 74 : 75;
    if (n + w > limit) { out.push(cur); cur = ''; n = 0; }
    cur += ch; n += w;
  }
  out.push(cur);
  return out.join('\r\n ');
}
// Times are written as London wall-clock with the zone named, never as UTC, so
// they read the same on either side of a clock change.
const ICS_ZONE = ['BEGIN:VTIMEZONE', 'TZID:Europe/London',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0000', 'TZOFFSETTO:+0100', 'TZNAME:BST', 'DTSTART:19700329T010000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0000', 'TZNAME:GMT', 'DTSTART:19701025T020000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE'];
// Events (every occurrence of a repeat as its own entry) and tasks that have a
// deadline, as a standard calendar file.
function toICS(state, nowMs){
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Fasti//Fasti 1//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Fasti', 'X-WR-TIMEZONE:Europe/London'].concat(ICS_ZONE);
  const stamp = icsUtc(nowMs), areas = state.areas || {};
  const cat = id => (areas[id] && areas[id].name) ? ['CATEGORIES:' + icsEsc(areas[id].name)] : [];
  const text = (k, v) => v ? [k + ':' + icsEsc(v)] : [];
  const event = e => {
    L.push('BEGIN:VEVENT', 'UID:' + icsEsc(e.id) + '@fasti', 'DTSTAMP:' + stamp);
    if (e.allDay) L.push('DTSTART;VALUE=DATE:' + icsDay(e.date), 'DTEND;VALUE=DATE:' + icsDay(addDays(e.date, 1)));
    else L.push('DTSTART;TZID=Europe/London:' + icsLocal(e.date, e.start), e.end >= 1440 ? 'DTEND;TZID=Europe/London:' + icsLocal(addDays(e.date, 1), 0) : 'DTEND;TZID=Europe/London:' + icsLocal(e.date, e.end));
    L.push('SUMMARY:' + icsEsc(e.title));
    L.push.apply(L, text('LOCATION', e.place).concat(text('DESCRIPTION', e.notes), cat(e.area)));
    L.push('END:VEVENT');
  };
  const ids = Object.keys(state.items || {}).sort();
  for (const id of ids) {
    const it = state.items[id];
    if (!it || it.deleted) continue;
    if (it.kind === 'event') event(it);
    else if (it.kind === 'series') seriesOccurrences(it).forEach(event);
  }
  for (const id of ids) {
    const t = state.items[id];
    if (!t || t.deleted || t.kind !== 'task' || t.dropped || !t.due) continue;
    L.push('BEGIN:VTODO', 'UID:' + icsEsc(t.id) + '@fasti', 'DTSTAMP:' + stamp);
    L.push(t.due.time != null ? 'DUE;TZID=Europe/London:' + icsLocal(t.due.date, t.due.time) : 'DUE;VALUE=DATE:' + icsDay(t.due.date));
    L.push('SUMMARY:' + icsEsc(t.title));
    L.push.apply(L, text('DESCRIPTION', t.notes).concat(cat(t.area)));
    if (t.important) L.push('PRIORITY:1');
    L.push.apply(L, t.done ? ['STATUS:COMPLETED', 'COMPLETED:' + icsUtc(t.done)] : ['STATUS:NEEDS-ACTION']);
    L.push('END:VTODO');
  }
  L.push('END:VCALENDAR');
  return L.map(icsFold).join('\r\n') + '\r\n';
}

/* ----- reading ----- */
const icsUnesc = s => String(s).replace(/\\([\\,;nN])/g, (_, c) => (c === 'n' || c === 'N') ? '\n' : c);
// Split a list value on the commas that are not escaped.
function icsList(s){ const out = []; let cur = ''; for (let i = 0; i < s.length; i++) { if (s[i] === '\\' && i + 1 < s.length) { cur += s[i] + s[i + 1]; i++; } else if (s[i] === ',') { out.push(cur); cur = ''; } else cur += s[i]; } out.push(cur); return out.map(x => icsUnesc(x).trim()).filter(Boolean); }
// The digits of a date-time, exactly as written. Whether they are followed by
// "Z" is reported and otherwise ignored: what the digits mean is the caller's call.
function icsWhen(v){
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(v).trim());
  if (!m) return null;
  const date = makeDate(+m[1], +m[2], +m[3]);
  if (!date || (m[4] !== undefined && (+m[4] > 23 || +m[5] > 59))) return null;
  return m[4] === undefined ? { date, min: null, allDay: true, z: false } : { date, min: +m[4] * 60 + +m[5], allDay: false, z: !!m[7] };
}
// A calendar file as a list of its entries: { type, props: { NAME: { value, params } } }.
function parseICS(text){
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out = []; let cur = null, depth = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let c = -1, q = false;
    for (let i = 0; i < line.length; i++) { if (line[i] === '"') q = !q; else if (line[i] === ':' && !q) { c = i; break; } }
    if (c < 0) continue;
    const head = line.slice(0, c).split(';'), name = head[0].toUpperCase(), value = line.slice(c + 1);
    if (name === 'BEGIN') { if (cur) depth++; else if (/^(VEVENT|VTODO)$/i.test(value.trim())) { cur = { type: value.trim().toUpperCase(), props: Object.create(null) }; depth = 0; } continue; }
    if (name === 'END') { if (cur && depth === 0) { out.push(cur); cur = null; } else if (cur) depth--; continue; }
    if (!cur || depth > 0) continue;
    const params = {};
    for (const p of head.slice(1)) { const e = p.indexOf('='); if (e > 0) params[p.slice(0, e).toUpperCase()] = p.slice(e + 1).replace(/^"|"$/g, ''); }
    if (!(name in cur.props)) cur.props[name] = { value, params };
  }
  return out;
}
// The Classics Faculty's lecture-list feeds, as items.
// Their times are wrong in a known way: each carries both a London zone and a
// trailing "Z". The digits are London clock time, so the digits are read and
// the "Z" ignored. Honouring it would put every lecture before the clocks go
// back an hour late.
// o: { feed (a short name for this feed, required), match, category, now, batch }
function feedToItems(text, o){
  o = o || {};
  const feed = o.feed || 'feed';
  const wants = v => (v == null ? [] : Array.isArray(v) ? v : [v]).map(s => String(s).toLowerCase()).filter(Boolean);
  const match = wants(o.match), category = wants(o.category);
  const items = [], seen = new Set(), ids = []; let skipped = 0;
  for (const ev of parseICS(text)) {
    if (ev.type !== 'VEVENT') continue;
    const P = ev.props, get = k => P[k] ? icsUnesc(P[k].value).trim() : '';
    const uid = get('UID'), title = get('SUMMARY'), s = P.DTSTART && icsWhen(P.DTSTART.value), e = P.DTEND && icsWhen(P.DTEND.value);
    const cats = P.CATEGORIES ? icsList(P.CATEGORIES.value) : [];
    if (!uid || !s) { skipped++; continue; }
    const id = 'src:' + feed + ':' + uid;
    if (seen.has(id)) continue;
    seen.add(id);
    // `ids` is everything the feed holds, whatever is being kept: it is how a later import
    // can tell that the Faculty has taken something off its list.
    ids.push(id);
    const tl = title.toLowerCase();
    if (match.length && !match.every(w => tl.includes(w))) continue;
    if (category.length && !category.every(w => cats.some(c => c.toLowerCase().includes(w)))) continue;
    const organiser = (/^Organiser:\s*(.+)$/m.exec(get('DESCRIPTION')) || [])[1] || '';
    const start = s.allDay ? 0 : s.min;
    let end = (e && !e.allDay && e.date === s.date && e.min > start) ? e.min : (e && !e.allDay && e.date === addDays(s.date, 1) && e.min === 0) ? 1440 : Math.min(1440, start + 60);
    if (s.allDay) end = 0;
    items.push(withSourceSig(makeEvent({ id, title, area: /^class$/i.test(cats[0] || '') ? 'lang' : 'lec', date: s.date, start, end, allDay: s.allDay,
      place: get('LOCATION'), notes: organiser.trim(), routine: true,
      source: { via: 'claude', batch: o.batch || null, uid, feed }, updatedAt: o.now || 0 })));
  }
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || byTime(a, b));
  return { items, skipped, ids };
}

/* ================= 8. Sync: the rules, and the sealed packet ================= */
// The page does the fetching and the saving. Everything it has to decide is
// decided here, so the rules can be tested without a browser or a server.
const SYNC_MAIN = 'fasti.main.v1', SYNC_INBOX = 'fasti.inbox.v1';
const SYNC_ENDPOINT = 'https://vocabula-sync.karsten-vun.workers.dev';
const SYNC_RULES = {
  gapMs: 60000,                         // while the app is open, never push within a minute of the last push
  quietMs: 30000,                       // and wait for a pause in the editing first, so a short visit sends once, as he leaves
  resumeMs: 1000,                       // a request fired the instant the app reappears can hang on iOS
  timeoutMs: 8000,                      // every request gives up after this
  backoffMs: [60000, 120000, 300000],   // after a failure wait 1, 2, then 5 minutes
  skewWarnMs: 300000,                   // say so when the device clock is more than 5 minutes out
  dayCap: 200 };                        // a ceiling on pushes per device per day. An ordinary day is about 35; the allowance
                                        // shared with his other apps is 1,000, so a fault here must not be able to use it up

/* ----- the code ----- */
// Ten characters, A to Z and 2 to 9 without I and O, shown as XXXXX-XXXXX.
// Exactly as vocabula does it; the code is always hashed in this dashed form.
function normaliseSyncCode(raw){
  const s = String(raw || '').toUpperCase().replace(/[^A-Z2-9]/g, '');
  if (s.length !== 10 || /[01IO]/.test(s)) return null;
  return s.slice(0, 5) + '-' + s.slice(5);
}
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// From ten random bytes. 32 characters, so no byte value is favoured.
function syncCodeFrom(bytes){ let s = ''; for (let i = 0; i < 10; i++) { s += CODE_CHARS[bytes[i] % 32]; if (i === 4) s += '-'; } return s; }
function syncKeyMaterial(code, deckKey){ return { kvInput: 'kv:' + code + ':' + deckKey, encInput: 'enc:' + code + ':' + deckKey }; }

/* ----- the sealed packet. Ported from vocabula's deck.html; do not redesign. -----
   Two independent hashes of the code: one is only ever the lookup key sent to
   the server, the other only ever the encryption key, which never leaves the
   device. The server sees an opaque key and ciphertext. Web Crypto is in every
   browser Fasti runs in and in Node, so the page and the tools share this. */
async function syncKeys(code, deckKey){
  const enc = new TextEncoder(), mat = syncKeyMaterial(code, deckKey);
  const kv = await crypto.subtle.digest('SHA-256', enc.encode(mat.kvInput));
  const ek = await crypto.subtle.digest('SHA-256', enc.encode(mat.encInput));
  const kvKey = Array.from(new Uint8Array(kv)).map(b => b.toString(16).padStart(2, '0')).join('');
  const cryptoKey = await crypto.subtle.importKey('raw', ek, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { kvKey, cryptoKey };
}
// Chunked: String.fromCharCode.apply on a whole large buffer blows the argument limit on Safari.
function b64(buf){ const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s){ return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
async function gzipBytes(bytes){
  if (typeof CompressionStream === 'undefined') return null;
  const cs = new CompressionStream('gzip'), w = cs.writable.getWriter(); w.write(bytes); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
async function gunzipBytes(bytes){
  const ds = new DecompressionStream('gzip'), w = ds.writable.getWriter(); w.write(bytes); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}
// { v: 1, iv, data, z }: z is 1 when the plaintext was gzipped before it was encrypted.
async function encryptPayload(obj, cryptoKey){
  let plain = new TextEncoder().encode(JSON.stringify(obj)), z = 0;
  const gz = await gzipBytes(plain);
  if (gz && gz.length < plain.length) { plain = gz; z = 1; }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plain);
  return { v: 1, iv: b64(iv), data: b64(data), z };
}
async function decryptPayload(pkt, cryptoKey){
  if (!pkt || typeof pkt.iv !== 'string' || typeof pkt.data !== 'string') throw new Error('bad packet');
  let buf = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(pkt.iv) }, cryptoKey, unb64(pkt.data)));
  if (pkt.z) buf = await gunzipBytes(buf);
  return JSON.parse(new TextDecoder().decode(buf));
}
// A push that may outlive the page (the app is closing) must be small: browsers
// refuse a "keepalive" request over about 64 KiB outright.
const KEEPALIVE_MAX = 64 * 1024;
const shouldKeepalive = bytes => bytes <= KEEPALIVE_MAX;

/* ----- when to fetch and when to push ----- */
// What the device remembers about syncing. Kept beside the state, so that if
// the storage is ever wiped this goes with it and the device starts again from
// "never seen the server": it will fetch and merge before it pushes anything.
function newSyncState(){
  return { dirty: false, changedAt: 0, lastPushAt: 0, lastSeenAt: null, lastSyncAt: 0, failures: 0, retryAt: 0, needFetch: true, fetchAt: 0, skewMs: null, pushDay: '', pushCount: 0 };
}
const utcDay = ms => new Date(ms).toISOString().slice(0, 10);
// Has this device used up its pushes for today? (Days are counted as the server counts them.)
const pushCapped = (s, now) => s.pushDay === utcDay(now) && s.pushCount >= SYNC_RULES.dayCap;
// What to do at `now`: { action: 'fetch' | 'push' | null, at }, where `at` is
// when to look again (null: nothing is waiting on the clock).
// env: { hasCode, visible }.
function syncPlan(s, now, env){
  if (!env.hasCode) return { action: null, at: null };
  const gapOver = s.lastPushAt + SYNC_RULES.gapMs, mayPush = s.dirty && !pushCapped(s, now);
  if (!env.visible) {
    // Leaving the app: one chance and no timers afterwards. Whatever is unsent goes now, minute or no minute
    // ("at most once a minute while you edit, and once when you leave it"), unless a failure is being waited out.
    return { action: (mayPush && now >= s.retryAt) ? 'push' : null, at: null };
  }
  if (now < s.retryAt) return { action: null, at: s.retryAt };
  if (s.needFetch) return now >= s.fetchAt ? { action: 'fetch', at: null } : { action: null, at: s.fetchAt };
  if (mayPush) { const due = Math.max(gapOver, s.changedAt + SYNC_RULES.quietMs); return now >= due ? { action: 'push', at: null } : { action: null, at: due }; }
  return { action: null, at: null };
}
// Each returns the new sync state; none changes the one it is given.
const syncOn = {
  changed: (s, now) => Object.assign({}, s, { dirty: true, changedAt: now }),
  // Opened, brought to the front, or the network came back: fetch, after a breath, and stop waiting out a failure.
  shown:   (s, now) => Object.assign({}, s, { needFetch: true, fetchAt: now + SYNC_RULES.resumeMs, retryAt: 0 }),
  // A fetch succeeded. remoteAt is the server's stamp on what it holds (0: nothing there yet).
  // `ahead` is true when this device now holds something the server does not, and so must push.
  fetched: (s, now, remoteAt, ahead) => Object.assign({}, s, { needFetch: false, failures: 0, retryAt: 0, lastSyncAt: now, lastSeenAt: remoteAt,
    dirty: s.dirty || !!ahead, changedAt: (ahead && !s.dirty) ? now - SYNC_RULES.quietMs : s.changedAt }),
  // A push succeeded. Anything changed after it started is still unsent.
  pushed:  (s, now, serverAt, startedAt) => Object.assign({}, s, { lastPushAt: now, lastSeenAt: serverAt, lastSyncAt: now, failures: 0, retryAt: 0, needFetch: false, dirty: s.changedAt > startedAt,
    pushDay: utcDay(now), pushCount: (s.pushDay === utcDay(now) ? s.pushCount : 0) + 1 }),
  failed:  (s, now) => { const n = s.failures + 1; return Object.assign({}, s, { failures: n, retryAt: now + SYNC_RULES.backoffMs[Math.min(n, SYNC_RULES.backoffMs.length) - 1] }); },
  // A code was entered or changed: forget what was known of the old server copy.
  codeSet: (s, now) => Object.assign(newSyncState(), { dirty: s.dirty, changedAt: s.changedAt, fetchAt: now }),
  skew:    (s, skewMs) => Object.assign({}, s, { skewMs }),
};
// There is no compare-and-swap on the server, so before a push the device looks
// at what is there: if it is newer than the last copy this device saw, merge first.
function pushRace(remoteAt, lastSeenAt){ return (Number.isFinite(remoteAt) && remoteAt > (lastSeenAt || 0)) ? 'merge-first' : 'push'; }
// Does this device hold anything the server's copy lacks? Compared after
// compacting both, so tidying old deletions never causes a push by itself.
function aheadOf(local, remote, nowMs){ return canon(compact(local, nowMs)) !== canon(compact(remote, nowMs)); }

/* ----- what the status line says. Never an error dialog. ----- */
function agoText(ms){
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' h ago';
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : d + ' days ago';
}
function syncStatus(s, now, env){
  if (!env.hasCode) return 'Not syncing: saved on this device only';
  if (s.failures > 0) return 'Offline: saved on this device';
  if (s.dirty && pushCapped(s, now)) return 'Saved on this device. Sync has reached today’s limit and carries on tomorrow';
  if (!s.lastSyncAt) return 'Not synced yet: saved on this device';
  return 'Synced ' + agoText(now - s.lastSyncAt);
}
function clockSkewMessage(skewMs){
  if (!Number.isFinite(skewMs) || Math.abs(skewMs) <= SYNC_RULES.skewWarnMs) return '';
  const m = Math.round(Math.abs(skewMs) / 60000);
  return 'This device’s clock is ' + m + ' minutes ' + (skewMs > 0 ? 'ahead of' : 'behind') + ' the sync server. Changes are ordered by the clock, so check the time setting.';
}

return {
  // dates
  WD, WDL, MON, MONL, DAY_MS, isDate, makeDate, dayNum, isoOf, addDays, diffDays, weekday, sundayOf, partsOf, londonNow, londonDate, londonMs,
  // terms and labels
  TERMS, TERMS_END, termById, weekStart, where, periods, periodOf, currentTerm, termFor, ord, weekLabel, weekTitle, dateLabel, weekRange, fmtTime, fmtDur,
  // state and items
  readDuration, readClock, readWeeks, weeksText,
  DEFAULT_MOTTO, AREA_COLOURS, defaultAreas, newState, newId, makeEvent, makeSeries, makeTask, validItem,
  seriesDates, occurrence, seriesOccurrences, withException, splitSeries,
  taskOpen, effective, carryForward, duePassed, isMissed, urgency, taskLoad, settle, tick, untick, drop, undrop, remove, restore, compact, recentlyDeleted,
  TRASH_DAYS, MARKER_DAYS,
  // reading the state
  markClashes, freeGaps, freeText, GAP_MIN, view, clashesWith, dayRows, aheadRows, everything, byArea, searchItems, termGrid,
  // the Mac pages
  termCell, dayTip, lanes, weekGrid, SNAP_MIN, snapMin, moveBlock, resizeBlock, dropBlock, blockTask, unblockTask, moveEvent, occurrenceChange,
  // the reader
  parseAdd, describe, buildItems, slotText,
  // merging
  canon, pickLater, mergeStates, mergeSettings, withSetting, collectInbox, undoImport, importSummary, mergeImport, sourceSig, withSourceSig, SOURCE_FIELDS,
  // for the import tools
  makeBatch, importPlan, previewRows, inboxWith, INBOX_DAYS,
  // backups
  BACKUP_FORMAT, makeBackup, readBackup, importBackup,
  // sync
  SYNC_MAIN, SYNC_INBOX, SYNC_ENDPOINT, SYNC_RULES, normaliseSyncCode, syncCodeFrom, syncKeyMaterial, syncKeys, encryptPayload, decryptPayload, shouldKeepalive, KEEPALIVE_MAX,
  newSyncState, syncPlan, syncOn, pushRace, aheadOf, agoText, syncStatus, clockSkewMessage,
  // calendar files
  toICS, parseICS, icsWhen, feedToItems,
};
});

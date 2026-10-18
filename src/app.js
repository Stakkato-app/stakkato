/* Stakkato, the session page.
   The UI, audio engine and rendering are carried over from the original artifact.
   What changed: state comes from Supabase (see data.js) instead of living only in memory,
   every visitor has an identity, the original track's owner is the creator (host), and
   the project votes for real.

   Shape of the code:
   - S holds UI state plus the latest snapshot of the session.
   - TAKES caches take objects by database id, so decoded audio and mixer settings survive refreshes.
   - refresh() refetches the snapshot; realtime events call it (debounced).
   - render() redraws from S. Nothing renders from the database directly.

   The song, left to right: kept new parts before, the original track (the seed) with its
   layers, kept new parts after. Layers can also sit on a kept part; t.sec is that part's
   id, or null for the original track. arrangement() works out where everything starts. */

import './styles.css';
import './theme.js';
import { configured } from './supabase.js';
import * as db from './data.js';
import { AMPS, ampLabel, renderAmp, liveAmp, dropAmp, preloadAmp } from './amp.js';
import { analyse, sureness, PCS } from './analysis.js';
import { ico } from './icons.js';
import { zip } from './zip.js';
import { ROLES, role, col, cvar } from './roles.js';
import { requireAccount, onAccount, postingAs, setToast, profileHref } from './auth.js';
import { stackTree, viewToggle, savedView, rememberView } from './stacktree.js';
import { AMP_ROLES, savedMic, rememberMic, savedAmp, rememberAmp, savedMon, rememberMon, recAmpFor, recWorklet, openMic, listMics, capture, newContext, rateTip, monitorOn, armMonitor, disarmMonitor, inputLatency, blockPeaks,
         beatInfoFor, clickSamples as clickRaw, assembleTake, bleedNote, quietNote, micError, encodeWav } from './rec.js';

var TOL = 0.6;           // seconds a layer may differ from the length of its section

/* ---------- small helpers ---------- */
function vizMarkup(n) {
  var out = '';
  for (var i = 0; i < n; i++) out += '<i style="height:14%"></i>';
  return out;
}
function fmt(sec){ sec = Math.round(sec || 0); return Math.floor(sec/60) + ':' + ('0'+(sec%60)).slice(-2); }
function clockMs(sec) {
  sec = Math.max(0, sec || 0);
  var m = Math.floor(sec / 60), s = Math.floor(sec % 60), t = Math.floor((sec % 1) * 10);
  return m + ':' + ('0'+s).slice(-2) + '.' + t;
}
function el(id){ return document.getElementById(id); }
function esc(t){ return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function flash(m) {
  var t = el('proto-hint');
  t.textContent = m; t.classList.add('on');
  clearTimeout(flash.tm);
  flash.tm = setTimeout(function () { t.classList.remove('on'); }, 4200);
}
/* ---------- the "⋯" menus: secondary actions per take, opened one at a time ----------
   The menu items reuse the ordinary data-* actions, so the click handler below runs them. */
function menuBtn(key, items, label, cls) {
  var open = S.menu === key;
  return '<span class="menu-wrap">' +
    '<button class="' + (cls || 'tbtn more') + (open ? ' on' : '') + '" type="button" data-menu="' + key + '" aria-haspopup="true" aria-expanded="' + open + '"' +
      (label ? '' : ' aria-label="More"') + '>' + (label || '&#8943;') + '</button>' +
    (open ? '<div class="menu-pop" role="menu">' + items + '</div>' : '') + '</span>';
}
/* menus float above everything (the DAW clips its overflow), next to their button */
function placeMenus() {
  [].forEach.call(document.querySelectorAll('.menu-wrap > .menu-pop'), function (pop) {
    var r = pop.previousElementSibling.getBoundingClientRect();
    pop.style.position = 'fixed';
    var w = pop.offsetWidth, h = pop.offsetHeight;
    var left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
    pop.style.left = left + 'px'; pop.style.top = top + 'px'; pop.style.right = 'auto';
  });
}
window.addEventListener('scroll', function () {
  if (!S.menu) { placeMenus.y = window.scrollY; return; }
  if (Math.abs(window.scrollY - (placeMenus.y || 0)) > 60) { S.menu = null; render(); } else placeMenus();
}, { passive:true });
window.addEventListener('resize', placeMenus);
function mi(attr, label) { return '<button class="mi" type="button" role="menuitem" ' + attr + '>' + label + '</button>'; }
/* the creator deletes any take but the original track while the song is open; whoever
   recorded an own take (for their own version) can delete that one, also after release */
function canDelete(t) {
  if (!t || t.id === 'seed') return false;
  if (isOwn(t) && mine(t)) return true;
  return isHost() && isOpen();
}
function miDel(id) {
  if (!canDelete(findTake(id))) return '';
  var armed = armedFor(id);
  return '<button class="mi mi-del' + (armed ? ' armed' : '') + '" type="button" role="menuitem" data-del="' + id + '">' +
    (armed ? 'Click again to delete it for good' : 'Delete this take') + '</button>';
}
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-menu]');
  if (b) {
    e.stopPropagation();
    S.menu = S.menu === b.dataset.menu ? null : b.dataset.menu;
    placeMenus.y = window.scrollY;
    render();
    return;
  }
  if (!S.menu) return;
  var inside = e.target.closest('.menu-pop');
  if (inside && (!e.target.closest('button') || e.target.closest('[data-del]'))) return;  // selects stay open, delete asks twice
  S.menu = null;
  if (inside) setTimeout(render, 0); else render();
}, true);
function oops(e) {
  console.error(e);
  var msg = (e && (e.message || e.error_description)) || 'Something went wrong.';
  if (/anonymous/i.test(msg)) msg = 'Anonymous sign-ins are off in Supabase. Turn them on under Authentication, Sign In / Providers.';
  flash(msg);
}
/* a database change this page relies on isn't applied yet: say so instead of a raw error */
function needsUpdate(e, file) {
  var m = String((e && (e.message || e.details)) || '');
  if (/row-level security|status_check|violates check constraint|could not find the function|schema cache/i.test(m))
    return new Error('This needs a database update that is not applied yet (' + file + '). Ask whoever runs the database to apply it, then try again.');
  return null;
}
/* the account's name, as the credits show it (the database fills it in from the profile too) */
function myName() { return db.accountName(me) || ''; }
/* every write needs an account: asks for one (sign up, sign in or pick a name), then resolves with the user */
function need(why) { return requireAccount(why).then(function (u) { me = u; return u; }); }
function extOf(name) { return (name && name.indexOf('.') > -1) ? name.split('.').pop().toLowerCase() : 'wav'; }
function typeFor(file) {
  if (file.type) return file.type;
  var map = { wav:'audio/wav', mp3:'audio/mpeg', m4a:'audio/mp4', aac:'audio/aac', ogg:'audio/ogg', flac:'audio/flac', aif:'audio/aiff', aiff:'audio/aiff', webm:'audio/webm' };
  return map[extOf(file.name)] || 'audio/wav';
}

/* ---------- state ---------- */
var me = null;           // the signed-in user with an account, or null (listening needs none)
var unwatch = null;      // realtime unsubscribe
var TAKES = {};          // db id -> take object

function placeholderSeed() {
  return { id:'seed', dbId:null, by:'', roleId:'seed', note:'', len:0, vol:1, mute:false, solo:false, votes:{}, fin:0, fout:0, xfade:0 };
}
function blank() {
  return { session:null, seed:placeholderSeed(), members:[], applicants:[], archive:[], own:[], trial:null, title:'Untitled', mix:null,
           view:'lineup', build:{ picks:[], ctl:{} }, versions:[], override:null, myVotes:{},
           pitches:[], parts:[], trialPitch:null, countIn:2, recRole:null,
           comments:[], cmAvailable:true, cmDraft:null, cmOpen:null,
           words:[], tVotes:{}, myTVote:{}, tFilter:'all', tView:savedView(), wAt:null, wErr:'',
           reactions:{ banger:0, mess:0, again:0 }, reacted:{}, seedBusy:false, phaseSeen:null,
           meta:{ bpm:null, key:null, alt:null, time:'4/4', from:'none', sure:null, seedRole:null, busy:false } };
}
var S = blank();

function isHost() { return !!(S.session && me && S.session.host_id === me.id); }
function isOpen() { return !S.session || S.session.status === 'open'; }
/* whoever is looking at a page without a session is about to start one */
function asCreator() { return !S.session || isHost(); }
/* the instrument the creator says the original track is, or null when not set */
function seedInstr() { return S.meta.seedRole ? role(S.meta.seedRole) || null : null; }
function labelOf(t) {
  var ri = t.id === 'seed' ? seedInstr() : null;
  return ri ? 'Original track, ' + ri.label.toLowerCase() : role(t.roleId).label;
}
function seedRoleOptions(sel, none) {
  return '<option value=""' + (sel ? '' : ' selected') + '>' + none + '</option>' +
    ROLES.map(function (r) { return '<option value="' + r.id + '"' + (r.id === sel ? ' selected' : '') + '>' + r.label + '</option>'; }).join('');
}
function hasSeed() { return !!S.seed.dbId; }

/* layers of a role in the project, on one section ('core' is the original track) or on all of them */
function inSong(id, sec){ return S.members.filter(function (m) { return m.roleId === id && (!sec || secOf(m) === sec); }); }
/* slots left for layers in a role on a section; on the original track its own instrument
   takes one (mirrors public.section_cap()) */
function cap(id, sec) { return role(id).slots - ((sec || 'core') === 'core' && S.meta.seedRole === id ? 1 : 0); }
function seedHolds(id, sec) { return cap(id, sec) < 1; }
function waitingFor(id){ return S.applicants.filter(function (a) { return a.roleId === id; }); }
function findTake(id) {
  if (id === 'seed') return S.seed;
  if (TAKES[id]) return TAKES[id];
  var d = (S.drafts || []).filter(function (x) { return x.t.id === id; })[0];
  return d ? d.t : undefined;
}
function live(t) { return t && t.status !== 'deleted'; }
function trialTake() {
  return S.trial ? S.applicants.filter(function (t) { return t.id === S.trial; })[0] : null;
}
/* takes you can pick for your own version: everything sent to the project, plus what
   you recorded for your own versions (other people's own takes stay in their versions) */
function pool() {
  return S.members.concat(S.applicants, S.archive.map(function (a) { return a.take; }), S.own.filter(mine))
    .filter(function (t) { return t && t.buf; });
}
function mine(t) { return !!(t && me && t.authorId === me.id); }
function isOwn(t) { return !!(t && t.status === 'own'); }
/* where a take stands, as shown in your version */
function standing(t) {
  if (S.members.indexOf(t) > -1) return 'in the creation';
  if (t.on) return t.on.length ? 'on ' + onOf(t).map(function (u) { return u.by; }).join(', ') : 'on the original';
  if (S.applicants.indexOf(t) > -1) return 'waiting';
  if (isOwn(t)) return mine(t) ? 'your own take' : 'own take';
  return 'unused';
}
/* is this take used by a saved version or the one you are building? */
/* ---------- stacks: one jam, every branch of the thread ----------
   Every take remembers the takes it was played on (on_takes). Following them gives a path from the
   original track to that take; a path nobody played on yet is a stack. The author's creation is the
   line-up (the takes "in" the song). Without one, the stack with the most instruments plays first. */
var WANT = (function () { try { return new URLSearchParams(location.search).get('stack'); } catch (e) { return null; } })();
window.__stackId = function () { return S.stack || null; };
/* wait until the audio is in and the page has its final height, then show the tracks */
/* jump to a new part in the tracks: the song plays from where the part starts */
function goPart(pid, n, gesture) {
  n = n || 0;
  if ((loadingCount() || !tracks().length) && n < 60) return setTimeout(function () { goPart(pid, n + 1, gesture); }, 150);
  var p = TAKES[pid]; if (!p) return;
  stopAll(true); S.override = null; S.trial = null; S.view = 'lineup'; S.stack = null; refreshGains(); render();
  var at = startOf(p); offset = at; render();
  setTimeout(function () { var h = el('mix-head'); if (h) h.scrollIntoView({ block:'start', behavior: gesture ? 'smooth' : 'auto' }); }, 80);
  if (gesture) { play(at); return; }
  try { ac().resume(); } catch (e) {}
  setTimeout(function () {
    if (ac().state === 'running') play(at);
    else flash('Press Play to hear ' + p.by + '’s new part. The song starts where the part begins.');
  }, 250);
}
function scrollToMix(n) {
  if ((loadingCount() || !tracks().length) && n < 60) return setTimeout(function () { scrollToMix(n + 1); }, 150);
  setTimeout(function () { var h = el('mix-head'); if (h) h.scrollIntoView({ block:'start' }); }, 120);
}
function threadTakes() {
  return Object.keys(TAKES).map(function (k) { return TAKES[k]; }).filter(function (t) {
    return live(t) && t.id !== 'seed' && t.roleId !== 'part' && t.roleId !== 'mix' && !t.sec &&
      ['waiting','in','archived'].indexOf(t.status) > -1;
  });
}
function onOf(t) { return (t.on || []).map(function (id) { return TAKES[id]; }).filter(live); }
function groupOf(t) {
  if (!t.group) return [t];
  return threadTakes().filter(function (x) { return x.group === t.group; }).sort(function (a, b) { return String(a.created).localeCompare(String(b.created)) || String(a.dbId).localeCompare(String(b.dbId)); });
}
function lead(t) { return groupOf(t)[0] || t; }   /* the take that stands for its reply */
function isLead(t) { return lead(t) === t; }
function pathOf(t) { return onOf(t).concat(groupOf(t)); }
function keyOf(list) { return list.map(function (t) { return t.dbId; }).sort().join(','); }
function onKey(t) { return (t.on || []).slice().sort().join(','); }
function parentOf(t) {
  var k = onKey(t); if (!k) return null;
  var hit = threadTakes().filter(function (p) { return keyOf(pathOf(p)) === k; })[0];
  if (hit) return lead(hit);
  if (nodeKeySet()[k]) return null;   /* played on the song: hangs under the song update */
  /* played on part of a branch (some tracks left out): hang under the deepest take that was kept */
  var best = null;
  onOf(t).forEach(function (u) { if (!best || pathOf(u).length > pathOf(best).length) best = u; });
  return best ? lead(best) : null;
}
function instCount(list) {
  var seen = {}; seen[S.meta.seedRole || 'seed'] = 1;
  list.forEach(function (t) { seen[t.roleId] = 1; });
  return Object.keys(seen).length;
}
function likesOf(list) { return (S.stackLikes || {})[keyOf(list)] || 0; }
function likedStack(list) { return !!(S.stackLiked || {})[keyOf(list)]; }
function stackList() {
  var all = threadTakes(), used = {};
  all.forEach(function (t) { var k = onKey(t); if (k) used[k] = 1; });
  var out = all.filter(function (t) { return isLead(t) && !used[keyOf(pathOf(t))]; }).map(function (t) {
    var p = pathOf(t);
    return { id:t.dbId, takes:p, inst:instCount(p), name:t.by + '’s stack', last:t, created:t.created || '', likes:likesOf(p) };
  });
  /* stacks people put together from every branch ("Create your own"), saved as versions */
  (S.versions || []).forEach(function (v) {
    var tk = byIds(v.picks).filter(function (t) { return live(t) && t.roleId !== 'part'; });
    if (!tk.length) return;
    out.push({ id:'v-' + v.id, takes:tk, inst:instCount(tk), name:v.name || (v.by + '’s stack'), mixed:true, by:v.by, created:v.created || '', likes:likesOf(tk) });
  });
  var made = S.members.filter(onKeptSection);
  if (made.length) {
    var mk = keyOf(made);
    out = out.filter(function (x) { return keyOf(x.takes) !== mk; });
    out.sort(function (a, b) { return b.inst - a.inst || b.likes - a.likes || b.takes.length - a.takes.length || String(b.created).localeCompare(String(a.created)); });
    out.unshift({ id:'main', takes:made, inst:instCount(made), name:'Author’s creation', creation:true, likes:likesOf(made) });
  } else {
    out.sort(function (a, b) { return b.inst - a.inst || b.likes - a.likes || b.takes.length - a.takes.length || String(b.created).localeCompare(String(a.created)); });
    if (out[0]) out[0].largest = true;
  }
  return out;
}
function currentStack() {
  var list = stackList();
  /* tab 2: the original track on its own, to build on from scratch */
  if (S.stack === '__seed') return { id:'__seed', takes:[], inst:instCount([]), name:(S.seed.by ? S.seed.by + '’s original track' : 'The original track'), partial:true, pure:true };
  /* tab 2: a take you picked in the thread, with everything it was played on */
  if (S.stack && TAKES[S.stack] && live(TAKES[S.stack])) {
    var t0 = lead(TAKES[S.stack]), p0 = pathOf(t0);
    return { id:t0.dbId, takes:p0, inst:instCount(p0), name:t0.by + '’s ' + groupOf(t0).map(function (g) { return role(g.roleId).label.toLowerCase(); }).join(' + '), partial:true, last:t0 };
  }
  return list[0] || null;  /* tab 1: the song, the author's creation, or the room's suggestion until there is one */
  if (S.stack && S.stack !== 'main') {
    var hit = list.filter(function (x) { return x.id === S.stack; })[0];
    if (hit) return hit;
    var t = TAKES[S.stack];
    if (t && live(t)) { var p = pathOf(t); return { id:t.dbId, takes:p, inst:instCount(p), name:'Up to ' + t.by + '’s ' + role(t.roleId).label.toLowerCase(), partial:true, last:t }; }
  }
  return list[0] || null;
}
function isMainStack(st) { var l = stackList(); return !!(st && l[0] && l[0].id === st.id); }
/* takes someone played on top of the author's creation, still waiting for the author */
function onCreation() {
  var made = S.members.filter(onKeptSection); if (!made.length) return [];
  var mk = keyOf(made);
  return threadTakes().filter(function (t) { return t.status !== 'in' && onKey(t) === mk; });
}
function makeCreation(list) {
  var ids = list.map(function (t) { return t.dbId; });
  var ins = list.filter(function (t) { return t.status !== 'in'; }), outs = S.members.filter(function (t) { return ids.indexOf(t.dbId) < 0; });
  return Promise.all(ins.map(function (t) { return db.letIn(t.dbId); }).concat(outs.map(function (t) { return db.takeOutLayer(t.dbId); })))
    .then(function () { S.stack = null; S.override = null; S.view = 'lineup'; return refresh(); })
    .then(function () { flash('This is the Author’s creation now. It plays first, for everyone.'); }, oops);
}
function stacksBar() {
  var song = stackList()[0], pure = S.sel === '__seed', sel = !pure && S.sel && TAKES[S.sel] && live(TAKES[S.sel]) ? lead(TAKES[S.sel]) : null, onSel = !!(S.stack && (sel || pure));
  var tab = function (id, on, title, small, lanes) {
    return '<button type="button" role="tab" data-stack="' + id + '" aria-selected="' + on + '">' +
      '<span class="m-ico st-ico" aria-hidden="true">' + [S.seed].concat(lanes).map(function (t) {
        return '<i style="background:' + (t.id === 'seed' ? (seedInstr() ? col(seedInstr()) : 'var(--muted)') : col(role(t.roleId))) + '"></i>'; }).join('') + '</span>' +
      '<span class="m-txt"><b>' + title + '</b><small>' + small + '</small></span></button>';
  };
  return '<div class="dawtabs modes stacktabs" role="tablist" aria-label="What you hear">' +
    tab('main', !onSel, 'The song so far', song && song.creation ? 'picked by the author' : 'the room’s suggestion', song ? song.takes : []) +
    (pure ? tab('seed', onSel, esc((S.seed.by ? S.seed.by + '’s original track' : 'The original track')), 'the first clip on its own, build on it from scratch', [])
    : sel ? tab(sel.dbId, onSel, esc(sel.by) + '’s ' + esc(groupOf(sel).map(function (g) { return role(g.roleId).label.toLowerCase(); }).join(' + ')), 'from the thread, with what it was played on', pathOf(sel))
         : '<div class="st-hint">Pick any take in the thread below to hear it here, and to play on it.</div>') +
  '</div>';
  var building = S.view === 'build' && !S.override, cur = currentStack();
  return '<div class="dawtabs modes stacktabs" role="tablist" aria-label="Stacks">' + stackList().map(function (x) {
    var sel = !building && !S.override && cur && cur.id === x.id;
    return '<button type="button" role="tab" data-stack="' + x.id + '" aria-selected="' + sel + '">' +
      '<span class="m-ico st-ico" aria-hidden="true">' + [S.seed].concat(x.takes).map(function (t) {
        return '<i style="background:' + (t.id === 'seed' ? (seedInstr() ? col(seedInstr()) : 'var(--muted)') : col(role(t.roleId))) + '"></i>'; }).join('') + '</span>' +
      '<span class="m-txt"><b>' + esc(x.name) + '</b><small>' + (x.creation ? '' : x.largest ? '<em class="st-tag big">Largest stack</em>' : '') +
        x.inst + ' instruments' + (x.likes ? ' &middot; &#9829; ' + x.likes : '') + '</small></span></button>';
  }).join('') +
  (isHost() && isOpen() ? '<button type="button" role="tab" class="mode-own" data-view="build" aria-selected="' + building + '">' +
    '<span class="m-ico">+</span><span class="m-txt"><b>Compose the song</b><small>pick takes from every branch</small></span></button>' : '') +
  '</div>';
}
/* ---------- the thread: takes and words, as replies at any depth ----------
   Takes hang under the take they were played on (parentOf); written replies (thread_comments,
   the same ones the homepage shows) hang under the take, the new part or the reply they answer,
   or under the jam itself. The filters show the takes on their own, every written reply as a
   list, or what waits for the creator. */
function tFilter() { return S.tFilter || 'all'; }
/* where a written reply hangs: 'w:<reply>', 't:<lead take>', 'p:<new part>' or 'jam' */
function wordTarget(w) {
  if (w.toWord) return S.words.some(function (x) { return x.id === w.toWord; }) ? 'w:' + w.toWord : 'jam';
  var t = w.toTake && TAKES[w.toTake];
  if (t && live(t) && t.roleId === 'part' && t.status === 'in') return 'p:' + t.dbId;
  if (t && live(t) && threadTakes().indexOf(t) > -1) return 't:' + lead(t).dbId;
  return 'jam';
}
/* a deleted reply only stays as a placeholder while someone answered it */
function wordShown(w) { return !w.deleted || S.words.some(function (x) { return x.toWord === w.id && wordShown(x); }); }
function wordKids(key) {
  if (tFilter() === 'takes') return [];
  return S.words.filter(function (w) { return wordTarget(w) === key && wordShown(w); })
    .sort(function (a, b) { return String(a.created).localeCompare(String(b.created)); });
}
function takeKids(t) {
  return threadTakes().filter(function (k) { var p = parentOf(k); return isLead(k) && p && p.dbId === t.dbId; })
    .sort(function (a, b) { return String(a.created).localeCompare(String(b.created)); });
}
function countUnder(key) {
  var ws = wordKids(key), n = ws.length;
  ws.forEach(function (w) { n += countUnder('w:' + w.id); });
  if (key.indexOf('t:') === 0) takeKids(TAKES[key.slice(2)]).forEach(function (k) { n += 1 + countUnder('t:' + k.dbId); });
  return n;
}
/* thread votes, the same as on the homepage: everyone else's plus yours */
function tVote(id, kind) {
  var v = (S.myTVote || {})[id] || 0, n = ((S.tVotes || {})[id] || 0) + v;
  return '<span class="vote" role="group" aria-label="Vote">' +
    '<button type="button" class="up" data-tvote="' + id + '" data-kind="' + kind + '" data-dir="1" aria-pressed="' + (v === 1) + '" aria-label="Upvote">&#9650;</button>' +
    '<b>' + n + '</b>' +
    '<button type="button" class="down" data-tvote="' + id + '" data-kind="' + kind + '" data-dir="-1" aria-pressed="' + (v === -1) + '" aria-label="Downvote">&#9660;</button></span>';
}
function avaOf(name, color) {
  return '<span class="ava' + (color ? '' : ' words') + '"' + (color ? ' style="background:' + color + '"' : '') + ' aria-hidden="true">' + esc(String(name || '?').charAt(0).toUpperCase()) + '</span>';
}
function youOr(name, uid) { return me && uid === me.id ? 'You' : name; }
/* a name in the markup, linked to its profile once we know the author has one (askProfiles) */
var PROF = {}, PROF_ASKED = {};
function nameOf(text, uid) {
  return uid && PROF[uid] ? '<a class="pf-name" href="' + profileHref(PROF[uid]) + '">' + esc(text) + '</a>' : esc(text);
}
function askProfiles() {
  var ids = [S.session && S.session.host_id];
  Object.keys(TAKES).forEach(function (k) { ids.push(TAKES[k].authorId); });
  (S.versions || []).concat(S.comments || [], S.words || []).forEach(function (x) { ids.push(x.authorId); });
  ids = ids.filter(function (id) { return id && !PROF_ASKED[id]; });
  if (!ids.length) return;
  ids.forEach(function (id) { PROF_ASKED[id] = true; });
  db.profilesFor(ids).then(function (names) {
    var any = false;
    Object.keys(names).forEach(function (id) { if (PROF[id] !== names[id]) { PROF[id] = names[id]; any = true; } });
    if (any) renderAll();
  }).catch(function (e) { console.warn('Could not load the profile names', e); ids.forEach(function (id) { delete PROF_ASKED[id]; }); });
}
function whenOf(iso) { return iso ? '<span class="muted">· ' + esc(agoOf(iso)) + '</span>' : ''; }
function agoOf(iso) {
  var m = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return Math.round(m) + ' minute' + (Math.round(m) > 1 ? 's' : '') + ' ago';
  var h = m / 60; if (h < 24) return Math.round(h) + ' hour' + (Math.round(h) > 1 ? 's' : '') + ' ago';
  var d = h / 24; if (d < 2) return 'yesterday';
  if (d < 7) return Math.round(d) + ' days ago';
  if (d < 14) return 'last week';
  return new Date(iso).toLocaleDateString(undefined, { day:'numeric', month:'short' });
}
/* the box to reply with words, under what it answers */
function wordBox(at) {
  if (S.wAt !== at) return '';
  return '<div class="wbox">' +
    '<textarea id="w-text" maxlength="500" rows="2" placeholder="Say something" aria-label="Your reply"></textarea>' +
    '<div class="wrow">' + postingAs() +
      '<span class="grow"></span><button class="btn btn-sm" type="button" data-wcancel="1">Cancel</button>' +
      '<button class="btn btn-sm btn-main" type="button" data-wpost="1">Post reply</button></div>' +
    (S.wErr ? '<p class="rec-err">' + esc(S.wErr) + '</p>' : '') + '</div>';
}
function foldOf(key, n, open) {
  return '<button class="fold' + (open ? ' open' : '') + '" type="button" data-ttoggle="' + key + '" aria-expanded="' + open + '">' +
    (open ? 'Hide replies' : 'Show ' + n + (n > 1 ? ' replies' : ' reply')) + '</button>';
}
function kidsBlock(key, items, open) {
  if (!items.length) return '';
  var n = /^[tw]:/.test(key) ? countUnder(key) : items.length;
  items.sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
  return foldOf(key, n, open) + (open ? '<div class="kids">' + items.map(function (x) { return x.html; }).join('') + '</div>' : '');
}
/* a written reply */
function wordNode(w, flat) {
  var key = 'w:' + w.id, kids = flat ? [] : wordKids(key).map(function (k) { return { at:k.created, html:wordNode(k) }; });
  var open = !(S.tClosed || {})[key];
  if (w.deleted) return '<div class="node gone" id="tw-' + w.id + '"><span class="ava words" aria-hidden="true"></span><div class="nbody"><p class="gone-txt">This reply was deleted.</p>' + kidsBlock(key, kids, open) + '</div></div>';
  var mine = !!(me && w.authorId === me.id), admin = db.isAdmin(me), ctx = '';
  if (flat) {
    var tg = wordTarget(w), tt = tg.indexOf('t:') === 0 ? TAKES[tg.slice(2)] : null, ww = tg.indexOf('w:') === 0 ? S.words.filter(function (x) { return x.id === tg.slice(2); })[0] : null;
    ctx = '<span class="muted">' + (tt ? 'on ' + esc(youOr(tt.by, tt.authorId)) + '’s ' + esc(groupOf(tt).map(function (g) { return role(g.roleId).label.toLowerCase(); }).join(' + '))
      : ww ? 'replying to ' + esc(youOr(ww.by, ww.authorId)) : tg.indexOf('p:') === 0 ? 'on the new part' : 'on the jam') + '</span>';
  }
  return '<div class="node" id="tw-' + w.id + '">' + avaOf(youOr(w.by, w.authorId)) + '<div class="nbody">' +
    '<div class="meta"><b>' + nameOf(youOr(w.by, w.authorId), w.authorId) + '</b>' + ctx + whenOf(w.created) + '</div>' +
    '<p class="bubble">' + esc(w.body) + '</p>' +
    '<div class="acts"><button class="tlink" type="button" data-wopen="word:' + w.id + '">Reply</button>' + tVote(w.id, 'comment') +
      (isHost() && !mine ? '<button class="tlink" type="button" data-whide="' + w.id + '">Hide</button>' : '') +
      (mine || admin ? '<button class="tlink del' + (S.wSure === w.id ? ' sure' : '') + '" type="button" data-wdel="' + w.id + '">' + (S.wSure === w.id ? 'Click again to delete' : 'Delete') + '</button>' : '') + '</div>' +
    wordBox('word:' + w.id) + kidsBlock(key, kids, open) + '</div></div>';
}
/* a take: who added what, their words, the take you can hear, and what you can do with it */
function takeNode(t, flat) {
  var r = role(t.roleId), cur = S.view !== 'build' && !S.override ? currentStack() : null, on = running && cur && cur.id === t.dbId;
  var under = onOf(t), here = !!herePath()[t.dbId], last = !!(S.stack && cur && cur.id === t.dbId);
  var grp = groupOf(t), inSongAll = grp.every(function (g) { return S.members.indexOf(g) > -1; }), waiting = grp.some(function (g) { return g.status === 'waiting'; });
  var key = 't:' + t.dbId, kids = flat ? [] : takeKids(t).map(function (k) { return { at:k.created, html:takeNode(k) }; })
    .concat(wordKids(key).map(function (w) { return { at:w.created, html:wordNode(w) }; }));
  var open = !!kids.length && (here && !last || !!(S.tOpen || {})[t.dbId]);
  var boss = isHost() && isOpen();
  return '<div class="node tn' + (here ? ' here' : '') + (last ? ' last' : '') + '" id="tp-' + t.dbId + '">' + avaOf(t.by, col(r)) + '<div class="nbody">' +
    '<div class="meta"><b>' + nameOf(youOr(t.by, t.authorId), t.authorId) + '</b><span class="muted">added</span>' +
      grp.map(function (g) { var gr = role(g.roleId); return '<b class="lyr" style="color:' + col(gr) + '">' + esc(gr.label.toLowerCase()) + '</b>'; }).join(' + ') +
      (inSongAll ? '<span class="badge">In the song</span>' : waiting ? '<span class="badge wait">To review</span>' : '') +
      (last ? '<span class="badge ink">In the tracks above</span>' : '') + whenOf(t.created) + '</div>' +
    (t.note ? '<p class="bubble">' + esc(t.note) + '</p>' : '') +
    '<div class="twell' + (on && S.stack ? ' on' : '') + '" data-tsel="' + t.dbId + '">' +
      '<div class="take-row"><button class="play sm' + (on && S.stack ? ' on' : '') + '" type="button" data-tplay="' + t.dbId + '" aria-label="Play ' + esc(t.by) + '’s take with everything under it">' + (on && S.stack ? I_PAUSE : I_PLAY) + '</button>' +
        '<div class="twaves">' + grp.map(function (g) { return '<canvas data-tw="' + g.dbId + '" data-c="' + role(g.roleId).color + '"></canvas>'; }).join('') + '</div></div>' +
      '<div class="chain">on top of <span class="chip"><i style="background:' + (seedInstr() ? col(seedInstr()) : 'var(--seed)') + '"></i>' + (isHost() ? 'your' : esc(S.seed.by || 'the') + '’s') + ' original track</span>' +
        under.map(function (u) { var ur = role(u.roleId); return '<span class="chip"><i style="background:' + col(ur) + '"></i>' + esc(youOr(u.by, u.authorId)) + '’s ' + esc(ur.label.toLowerCase()) + '</span>'; }).join('') +
        leftOut(t) + '</div></div>' +
    '<div class="acts">' +
      (boss && !inSongAll ? '<button class="btn btn-sm btn-main" type="button" data-yesg="' + t.dbId + '">Add to song</button>' : '') +
      (boss && waiting && !inSongAll ? '<button class="btn btn-sm" type="button" data-nog="' + t.dbId + '">Pass</button>' : '') +
      (isOpen() ? (last ? '' : '<button class="tlink" type="button" data-tstack="' + t.dbId + '">Play on this</button>') +
        '<button class="tlink" type="button" data-treply="' + t.dbId + '">Reply with audio</button>' : '') +
      '<button class="tlink" type="button" data-wopen="take:' + t.dbId + '">Reply</button>' + tVote(t.dbId, 'take') + '</div>' +
    wordBox('take:' + t.dbId) + kidsBlock('t:' + t.dbId, kids, open) + '</div></div>';
}
/* the takes on the thread path of the stack you hear (none for a stack that was put together) */
function herePath() {
  var c = S.view !== 'build' && !S.override && S.stack ? currentStack() : null, set = {};
  for (var t = c && c.last; t; t = parentOf(t)) set[t.dbId] = 1;
  return set;
}
function nodeKeySet() {
  var set = {}, made = S.members.filter(onKeptSection);
  if (made.length) set[keyOf(made)] = 1;
  (S.versions || []).forEach(function (v) { set[keyOf(byIds(v.picks).filter(live))] = 1; });
  return set;
}
function onNode(key) {
  /* takes played on a saved stack or on the author's creation hang under that update */
  return threadTakes().filter(function (k) { return isLead(k) && !parentOf(k) && onKey(k) === key; })
    .sort(function (a, b) { return String(a.created).localeCompare(String(b.created)); });
}
/* updates in the thread: the creator made the song or extended it, someone made a stack */
function updatePost(o) {
  var cur = S.view !== 'build' && !S.override ? currentStack() : null, last = !!(cur && cur.id === o.id), on = running && last;
  var takes = o.key ? onNode(o.key) : [], hp = herePath(), inner = takes.some(function (k) { return hp[k.dbId]; });
  var kids = takes.map(function (k) { return { at:k.created, html:takeNode(k) }; })
    .concat(o.part ? wordKids('p:' + o.part).map(function (w) { return { at:w.created, html:wordNode(w) }; }) : []);
  var open = !!kids.length && (last || inner || !!(S.tOpen || {})[o.id]);
  return '<div class="node tn upd' + (last ? ' here last' : inner ? ' here' : '') + '" id="tp-' + o.id + '"><span class="ava upd-ava" aria-hidden="true">' + o.icon + '</span><div class="nbody">' +
    '<div class="meta"><b>' + nameOf(o.by, o.uid) + '</b><span class="muted">' + o.what + '</span>' + (o.tag || '') + whenOf(o.at) + '</div>' +
    (o.note ? '<p class="bubble">' + o.note + '</p>' : '') +
    '<div class="twell"' + (o.stack ? ' data-tsel="' + o.id + '"' : o.part ? ' data-tpart="' + o.part + '"' : '') + '><div class="take-row">' +
      '<button class="play sm' + (on ? ' on' : '') + '" type="button" ' + (o.stack ? 'data-tplay="' + o.id + '"' : o.part ? 'data-tpart="' + o.part + '"' : 'data-playmain="1"') + ' aria-label="Play">' + (on ? I_PAUSE : I_PLAY) + '</button>' +
      (o.takes ? '<div class="chain flat">' + o.takes.map(function (u) { var ur = role(u.roleId); return '<span class="chip"><i style="background:' + col(ur) + '"></i>' + esc(youOr(u.by, u.authorId)) + '’s ' + esc(ur.label.toLowerCase()) + '</span>'; }).join('') + '</div>'
        : '<span class="tiny muted">' + (o.part ? 'Plays where it sits in the song' : '') + '</span>') + '</div></div>' +
    '<div class="acts">' + (isOpen() ? '<button class="tlink" type="button" data-treply="' + o.reply + '">Reply with audio</button>' : '') +
      (o.stack ? (last ? '' : '<button class="tlink" type="button" data-tstack="' + o.id + '">Show in the tracks</button>') : '') +
      (o.part ? '<button class="tlink" type="button" data-tpart="' + o.part + '">Show in the tracks</button><button class="tlink" type="button" data-wopen="part:' + o.part + '">Reply</button>' : '') + '</div>' +
    (o.part ? wordBox('part:' + o.part) : '') + kidsBlock(o.id, kids, open) + '</div></div>';
}
function threadUpdates() {
  var list = [];
  S.parts.forEach(function (p) {
    list.push({ at:p.joinedAt || p.created || '', html:updatePost({ id:'part-' + p.id, at:p.joinedAt || p.created, by:S.seed.by || 'The author', uid:S.session && S.session.host_id, icon:'&#8596;',
      what:'extended the track', note:'A new part ' + (p.pos === 'before' ? 'before' : 'after') + ' the original clip, ' + fmt(p.len) + ' long' +
        (carryNames(p).length ? ', with ' + esc(carryNames(p).join(', ')) + ' playing on' : '') + '. Play on it, it’s part of the song now.',
      reply:'part:' + p.id, part:p.id }) });
  });
  var made = S.members.filter(onKeptSection);
  if (made.length) {
    var at = made.reduce(function (m, t) { return String(t.joinedAt) > m ? String(t.joinedAt) : m; }, '');
    list.push({ at:at, html:updatePost({ id:'main', at:at, key:keyOf(made), stack:true, by:S.seed.by || 'The author', uid:S.session && S.session.host_id, icon:'&#9733;',
      what:'made the Author’s creation', tag:'<span class="badge ink">Plays first</span>', takes:made, reply:'main' }) });
  }
  (S.versions || []).forEach(function (v) {
    var tk = byIds(v.picks).filter(live); if (!tk.length) return;
    list.push({ at:v.created || '', html:updatePost({ id:'v-' + v.id, at:v.created, key:keyOf(tk), stack:true, by:v.by, uid:v.authorId, icon:'&#9776;',
      what:'made a stack: <b>' + esc(v.name) + '</b>', takes:tk, reply:'v-' + v.id }) });
  });
  return list;
}
/* tracks of the branch that were muted when the take was played: "without Tom's drums" */
function leftOut(t) {
  var par = parentOf(t); if (!par) return '';
  var on = t.on || [], miss = pathOf(par).filter(function (x) { return on.indexOf(x.dbId) < 0; });
  return miss.length ? ' <span class="tp-without">without ' + miss.map(function (x) { return esc(x.by) + '’s ' + esc(role(x.roleId).label.toLowerCase()); }).join(', ') + '</span>' : '';
}
function reviewLeads() {
  return threadTakes().filter(function (t) { return isLead(t) && groupOf(t).some(function (g) { return g.status === 'waiting'; }); })
    .sort(function (a, b) { return String(b.created).localeCompare(String(a.created)); });
}
function liveWords() { return S.words.filter(function (w) { return !w.deleted; }); }
function renderTFilter() {
  var box = el('tfilter'); if (!box) return;
  var nT = threadTakes().filter(isLead).length, nW = liveWords().length, nR = isOpen() ? reviewLeads().length : 0, f = tFilter();
  var tabs = [['all', 'All', nT + nW], ['takes', 'Takes', nT], ['words', 'Words', nW]].concat(nR || f === 'review' ? [['review', 'To review', nR]] : []);
  box.innerHTML = tabs.map(function (x) {
    return '<button type="button" role="tab" data-tfilter="' + x[0] + '" aria-selected="' + (f === x[0]) + '">' + x[1] + ' <span>' + x[2] + '</span></button>';
  }).join('');
}
function threadHtml() {
  var f = tFilter(), si = seedInstr();
  var seedHere = S.stack === '__seed' && !S.override && S.view !== 'build';
  var op = '<div class="t-op' + (seedHere ? ' here' : '') + '">' + avaOf(S.seed.by || 'C', si ? col(si) : 'var(--seed)') +
    '<div class="t-op-txt"><b>' + nameOf(isHost() ? 'You' : S.seed.by || 'The creator', S.session && S.session.host_id) + '</b> <span class="muted">started the jam' + (S.session ? ' · ' + esc(agoOf(S.session.created_at)) : '') + '</span>' +
      '<small>' + esc(projName()) + (si ? ' · ' + esc(si.label.toLowerCase()) : '') + '</small></div>' +
    '<div class="t-op-acts">' + (seedHere ? '<span class="badge ink">In the tracks above</span>' : '<button class="tlink" type="button" data-tstack="seed">Play on this</button>') +
      '<button class="tlink" type="button" data-wopen="jam">Reply</button>' +
      (isOpen() ? '<button class="btn btn-sm" type="button" data-treply="seed">+ Reply with audio</button>' : '') + '</div></div>' + wordBox('jam');
  var body;
  if (f === 'words') {
    var ws = liveWords().slice().sort(function (a, b) { return String(b.created).localeCompare(String(a.created)); });
    body = ws.length ? ws.map(function (w) { return wordNode(w, true); }).join('') : '<p class="tiny muted">No written replies yet. Say something with “Reply”.</p>';
  } else if (f === 'review') {
    var rv = reviewLeads();
    body = rv.length ? rv.map(function (t) { return takeNode(t, true); }).join('') : '<p class="tiny muted">Nothing waits for the creator right now.</p>';
  } else {
    var nodeKeys = nodeKeySet();
    var roots = threadTakes().filter(function (t) { return isLead(t) && !parentOf(t) && !nodeKeys[onKey(t)]; }).map(function (t) { return { at:String(t.created), html:takeNode(t) }; })
      .concat(threadUpdates()).concat(wordKids('jam').map(function (w) { return { at:String(w.created), html:wordNode(w) }; }))
      .sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
    body = roots.length ? roots.map(function (r) { return r.html; }).join('') : '<p class="tiny muted">Nobody played along yet.</p>';
  }
  return op + '<div class="t-list">' + body + '</div>';
}
/* ---------- the stack view: the same thread, as a tree of stacks (src/stacktree.js) ---------- */
function stacksHtml() {
  var cur = S.view !== 'build' && !S.override ? currentStack() : null, hp = herePath(), si = seedInstr();
  var seedCol = si ? col(si) : 'var(--seed)';
  function dotsOf(list) { return [seedCol].concat(list.map(function (u) { return col(role(u.roleId)); })); }
  function nodeOf(t) {
    var grp = groupOf(t), inSong = grp.every(function (g) { return S.members.indexOf(g) > -1; });
    return { title:esc(youOr(t.by, t.authorId)), sub:esc(grp.map(function (g) { return role(g.roleId).label.toLowerCase(); }).join(' + ')) + (t.created ? ' · ' + esc(agoOf(t.created)) : ''),
      dots:dotsOf(pathOf(t)), attrs:'data-tplay="' + t.dbId + '"', on:!!(running && S.stack && cur && cur.id === t.dbId), here:!!hp[t.dbId],
      song:inSong, wait:isOpen() && !inSong && grp.some(function (g) { return g.status === 'waiting'; }), kids:takeKids(t).map(nodeOf) };
  }
  var nodeKeys = nodeKeySet();
  var firsts = threadTakes().filter(function (t) { return isLead(t) && !parentOf(t) && !nodeKeys[onKey(t)]; })
    .sort(function (a, b) { return String(a.created).localeCompare(String(b.created)); });
  var roots = [{ root:true, title:esc(isHost() ? 'Your original track' : (S.seed.by || 'The') + '’s original track'), sub:'where every stack starts', dots:[seedCol],
    attrs:'data-tplay="seed"', on:!!(running && S.stack === '__seed'), here:S.stack === '__seed' || firsts.some(function (t) { return hp[t.dbId]; }), kids:firsts.map(nodeOf) }];
  var made = S.members.filter(onKeptSection);
  if (made.length) roots.push({ root:true, title:'The song so far', sub:'picked by the author', dots:dotsOf(made), attrs:'data-tplay="main"',
    on:!!(running && !S.stack && cur && cur.creation), song:true, kids:onNode(keyOf(made)).map(nodeOf) });
  (S.versions || []).forEach(function (v) {
    var tk = byIds(v.picks).filter(live); if (!tk.length) return;
    roots.push({ root:true, title:esc(v.name || (v.by + '’s stack')), sub:'put together by ' + esc(v.by), dots:dotsOf(tk.filter(function (x) { return x.id !== 'seed'; })),
      attrs:'data-tplay="v-' + v.id + '"', kids:onNode(keyOf(tk)).map(nodeOf) });
  });
  S.parts.forEach(function (p) {
    roots.push({ root:true, title:'New part', sub:'plays ' + (p.pos === 'before' ? 'before' : 'after') + ' the original track · ' + fmt(p.len),
      dots:['var(--part)'].concat(carryOf(p).map(function (c) { return c === S.seed ? seedCol : col(role(c.roleId)); })), attrs:'data-tpart="' + p.id + '"' });
  });
  return stackTree(roots, 'Every path from the left is a stack. Click one to hear it in the tracks above; switch to Thread to reply or add a take.');
}
/* the small waveforms of the takes in the thread */
function drawThreadWaves() {
  [].forEach.call(document.querySelectorAll('canvas[data-tw]'), function (c) {
    var t = TAKES[c.dataset.tw]; if (!t || !t.buf) return;
    if (!t.mm) t.mm = minMaxOf(t.buf, 2400);
    var dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    c.width = w * dpr; c.height = h * dpr;
    var g = c.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
    /* in its instrument's colour, green while its stack plays */
    g.fillStyle = cvar(c.closest('.twell.on') ? '--sound' : c.dataset.c || '--wave');
    waveShape(g, t.mm, 0, w, h);
  });
}
/* replying with words from the song view: the same written replies as on the homepage */
function openWords(at) {
  if (S.wAt === at) { S.wAt = null; renderBoards(); return; }
  if (!S.session) return;
  S.wAt = at; S.wErr = '';
  if (at.indexOf('take:') === 0) { S.tOpen = S.tOpen || {}; }
  renderBoards();
  var b = el('w-text'); if (b) b.focus();
}
function postWords() {
  var body = ((el('w-text') && el('w-text').value) || '').trim();
  if (!body) { S.wErr = 'Write something first.'; renderBoards(); if (el('w-text')) el('w-text').focus(); return; }
  if (!me) { need('reply').then(postWords); return; }
  var name = myName().slice(0, 60);
  var at = S.wAt, kind = at.split(':')[0], id = at.slice(kind.length + 1);
  var row = { session_id:S.session.id, author_id:me.id, author_name:name, body:body.slice(0, 500),
    reply_to_take:kind === 'take' || kind === 'part' ? id : null, reply_to_comment:kind === 'word' ? id : null };
  var btn = document.querySelector('[data-wpost]'); if (btn) btn.disabled = true;
  db.addThreadComment(row).then(function (w) {
    S.wAt = null; S.wErr = '';
    if (kind === 'take') { S.tOpen = S.tOpen || {}; S.tOpen[id] = true; }
    if (kind === 'word') { S.tClosed = S.tClosed || {}; S.tClosed['w:' + id] = false; }
    if (S.tFilter === 'takes' || S.tFilter === 'review') S.tFilter = 'all';
    return refresh().then(function () {
      var n = el('tw-' + w.id); if (n) { n.scrollIntoView({ behavior:'smooth', block:'center' }); n.classList.add('hl'); }
      flash('Your reply is posted. Everyone sees it here and on the homepage.');
    });
  }).catch(function (x) { if (btn) btn.disabled = false; S.wErr = (x && x.message) || 'That didn’t work, try again.'; renderBoards(); });
}
function tVoteCast(id, kind, dir) {
  if (!S.session) return;
  if (!me) { need('vote').then(function () { tVoteCast(id, kind, dir); }); return; }
  S.myTVote = S.myTVote || {};
  var before = S.myTVote[id] || 0, value = before === dir ? 0 : dir;
  S.myTVote[id] = value; renderBoards();
  db.voteInThread({ targetId:id, targetKind:kind, sessionId:S.session.id, voterId:me.id, value:value })
    .catch(function (x) { S.myTVote[id] = before; renderBoards(); oops(x); });
}
function picked(id) {
  return S.build.picks.indexOf(id) > -1 || S.versions.some(function (v) { return v.picks.indexOf(id) > -1; });
}
function byIds(ids) {
  return ids.map(function (id) { return findTake(id); }).filter(function (t) { return live(t) && t.buf; });
}
function livePicks(ids) { return ids.filter(function (id) { return live(findTake(id)); }); }
function trialPitchTake() {
  if (!S.trialPitch || S.override || S.view !== 'lineup') return null;
  return S.pitches.filter(function (t) { return t.id === S.trialPitch; })[0] || null;
}
function partTakes() { return S.parts; }
/* ---------- tracks carried into a new part (takes.carry) ----------
   A new part can keep tracks of the original track playing under it: the original track itself
   or takes on it. They play again from the part's start, repeated to fill the part and cut at
   its end, through their own mixer strip (so muting the drums mutes them under the part too). */
function carryOf(p) {
  return (p && p.carry || []).map(function (id) { return S.seed && S.seed.dbId === id ? S.seed : TAKES[id]; })
    .filter(function (t) { return live(t) && t.buf && t.roleId !== 'part' && t.roleId !== 'mix'; });
}
function carryNames(p) {
  return (p && p.carry || []).map(function (id) { return S.seed && S.seed.dbId === id ? S.seed : TAKES[id]; }).filter(live).map(function (t) {
    return t === S.seed ? (S.seed.by ? S.seed.by + '’s original track' : 'the original track') : t.by + '’s ' + role(t.roleId).label.toLowerCase();
  });
}
/* what can be carried into a new part: the original track and the takes you hear on it now */
function carryChoices() {
  return tracks().filter(function (t) { return t.id === 'seed' || (t.roleId !== 'part' && secOf(t) === 'core' && t.dbId); });
}
/* the song, left to right: parts before, the original track (with every layer on it), parts after.
   The newest part before plays first, the newest part after plays last. */
function arrangement() {
  var before = S.parts.filter(function (p) { return p.pos === 'before'; }).reverse();
  var after = S.parts.filter(function (p) { return p.pos === 'after'; });
  var tp = trialPitchTake();
  if (tp) { if (tp.pos === 'before') before.unshift(tp); else after.push(tp); }
  var t = 0, starts = {}, joins = {}, core = { i:0, o:0 };
  before.forEach(function (p, i) {
    starts[p.id] = t;
    joins[p.id] = { i: i ? xf(before[i - 1]) : 0, o: xf(p) };
    t += p.len - xf(p);
  });
  var lead = t;
  if (before.length) core.i = xf(before[before.length - 1]);
  t += S.seed.len || 0;
  after.forEach(function (p, i) {
    t -= xf(p);
    starts[p.id] = t;
    joins[p.id] = { i: xf(p), o: after[i + 1] ? xf(after[i + 1]) : 0 };
    t += p.len;
  });
  if (after.length) core.o = xf(after[0]);
  return { starts:starts, lead:lead, total:t, joins:joins, core:core };
}
/* crossfade of a new part: how far it overlaps its neighbour, never more than half of either side */
function xfMax(p) { return Math.max(0, Math.min(8, p.len / 2, (S.seed.len || 0) / 2)); }
function xf(p) { return Math.max(0, Math.min(p.xfade || 0, xfMax(p))); }
/* the fades that actually play: what the creator set, or longer where a crossfade needs it */
function envOf(t) {
  var a = arrangement();
  var j = a.joins[t.id] || (t.roleId === 'part' ? { i:0, o:0 } : (secOf(t) !== 'core' && a.joins[t.sec]) || a.core);
  var fi = Math.max(t.fin || 0, j.i), fo = Math.max(t.fout || 0, j.o), L = t.len || 0;
  if (L && fi + fo > L) { var k = L / (fi + fo); fi *= k; fo *= k; }
  return { fi:fi, fo:fo };
}
function envAt(x, L, e) {
  var v = 1;
  if (e.fi > 0 && x < e.fi) v = Math.min(v, x / e.fi);
  if (e.fo > 0 && x > L - e.fo) v = Math.min(v, (L - x) / e.fo);
  return Math.max(0, Math.min(1, v));
}
/* clip time x0 starts sounding at audio time T */
function scheduleEnv(g, t, T, x0) {
  var e = envOf(t), L = t.len;
  var pts = [x0, e.fi, L - e.fo, L].filter(function (x) { return x >= x0 && x <= L; }).sort(function (a, b) { return a - b; });
  g.gain.cancelScheduledValues(0);
  g.gain.setValueAtTime(envAt(x0, L, e), T);
  pts.forEach(function (x) { if (x > x0) g.gain.linearRampToValueAtTime(envAt(x, L, e), T + (x - x0)); });
}
function startOf(tk) {
  var a = arrangement();
  if (a.starts[tk.id] !== undefined) return a.starts[tk.id];
  if (tk.sec && a.starts[tk.sec] !== undefined) return a.starts[tk.sec];
  return a.lead;
}
function tracks() {
  var extra = S.stack === '__seed' && !S.override && S.view !== 'build' ? [] : partTakes().slice(), tp = trialPitchTake();
  if (tp) extra.push(tp);
  var core;
  if (S.override) core = [S.seed].concat(byIds(S.override.picks));
  else if (S.view === 'build') core = [S.seed].concat(byIds(S.build.picks));
  else { var tr = trialTake(), cs = currentStack(); core = [S.seed].concat(cs ? cs.takes : [], tr ? [tr] : []); }
  if (!S.override && S.view !== 'build') core = core.concat((S.drafts || []).map(function (d) { return d.t; }));
  return core.concat(extra).filter(function (t) { return t && t.buf && (t.roleId === 'part' || t.id === 'seed' || onKeptSection(t)); });
}
/* per-context mixer settings: the project uses the take itself, a version keeps its own */
function mixCtx() {
  if (S.override) return S.override.ctl;
  if (S.view === 'build') return S.build.ctl;
  return null;
}
function ctl(t) {
  var c = mixCtx();
  if (!c) return t;
  if (!c[t.id]) c[t.id] = { vol:1, mute:false, solo:false };
  return c[t.id];
}
function volOf(t){ var v = ctl(t).vol; return v === undefined ? 1 : v; }
/* filter cutoffs in Hz. Fully open (hp at the bottom, lp at the top) means the filter does nothing. */
var F_MIN = 20, F_MAX = 20000;
function cutOf(t, kind) {
  var v = ctl(t)[kind];
  return typeof v === 'number' ? v : (kind === 'hp' ? F_MIN : F_MAX);
}
/* the amp a take plays through: a version keeps its own choice, otherwise the take's own
   (set by its author when sending, or by the creator). '' = off, the take as recorded. */
function ampOf(t) {
  var c = ctl(t);
  if (c !== t && typeof c.amp === 'string') return c.amp;
  return t.amp || '';
}
function hzToKnob(hz){ return Math.log(hz / F_MIN) / Math.log(F_MAX / F_MIN); }
function knobToHz(k){ return Math.round(F_MIN * Math.pow(F_MAX / F_MIN, Math.max(0, Math.min(1, k)))); }
function fmtHz(hz){ return hz >= 1000 ? (Math.round(hz / 100) / 10) + ' kHz' : hz + ' Hz'; }
function inVersions(id) {
  return S.versions.filter(function (v) { return v.picks.indexOf(id) > -1; }).length;
}
function verTag(id) {
  var n = inVersions(id);
  return n ? '<span class="vtag">in ' + n + ' version' + (n > 1 ? 's' : '') + '</span>' : '';
}

/* ---------- snapshot from the database ---------- */
function applySnapshot(sess, snap) {
  S.session = sess;
  S.title = sess.title;
  S.meta.bpm = sess.bpm; S.meta.key = sess.music_key; S.meta.alt = sess.key_alt;
  S.meta.time = sess.time_sig; S.meta.from = sess.meta_from; S.meta.sure = sess.meta_sure;
  S.meta.seedRole = sess.seed_role || null;

  snap.takes.forEach(function (row) {
    var t = TAKES[row.id];
    if (!t) t = TAKES[row.id] = { id:row.id, dbId:row.id, vol:1, mute:false, solo:false, votes:{} };
    t.by = row.author_name; t.authorId = row.author_id; t.roleId = row.role_id; t.note = row.note;
    t.status = row.status; t.why = row.archive_reason; t.fileName = row.file_name; t.path = row.storage_path;
    t.url = db.publicUrl(row.storage_path); t.joinedAt = row.joined_at; t.created = row.created_at;
    t.pos = row.part_pos || null; t.sec = row.section_id || null; t.on = row.on_takes || null; t.group = row.group_id || null;
    t.carry = row.carry || null;
    /* keep what the creator is dragging or saving right now */
    if (!t.fadeBusy && !(drag && drag.t === t)) { t.fin = row.fade_in || 0; t.fout = row.fade_out || 0; t.xfade = row.xfade || 0; }
    if (!t.buf) t.len = row.duration_sec;
    if (!t.ampSaving) t.amp = row.amp || '';
    if (row.an_bpm || row.an_key) t.an = { bpm:row.an_bpm, key:row.an_key || '?' };
  });

  /* the current seed is always addressed as 'seed' in the UI */
  var seed = sess.seed_take_id ? TAKES[sess.seed_take_id] : null;
  var prevSeed = S.seed;
  Object.keys(TAKES).forEach(function (k) { if (TAKES[k] !== seed && TAKES[k].id === 'seed') TAKES[k].id = k; });
  if (seed) seed.id = 'seed';
  S.seed = seed || (prevSeed.dbId ? placeholderSeed() : prevSeed);
  if (S.seed !== prevSeed) delete gains.seed;

  var list = snap.takes.map(function (r) { return TAKES[r.id]; }).filter(live);
  var layers = list.filter(function (t) { return t.roleId !== 'part'; });
  var parts = list.filter(function (t) { return t.roleId === 'part'; });
  function byJoin(a, b) { return String(a.joinedAt).localeCompare(String(b.joinedAt)); }
  S.members = layers.filter(function (t) { return t.status === 'in'; }).sort(byJoin);
  S.applicants = layers.filter(function (t) { return t.status === 'waiting'; });
  S.own = layers.filter(function (t) { return t.status === 'own'; });
  S.archive = layers.filter(function (t) { return t.status === 'archived'; }).map(function (t) {
    return { take:t, why: t.why === 'vetoed' ? (isHost() ? 'vetoed by you' : 'vetoed by the creator')
                        : t.why === 'removed' ? (isHost() ? 'taken out by you' : 'taken out by the creator') : (t.why || 'archived') };
  });
  S.pitches = parts.filter(function (t) { return t.status === 'waiting'; });
  S.parts = parts.filter(function (t) { return t.status === 'in'; }).sort(byJoin);
  var mixes = list.filter(function (t) { return t.status === 'mix'; });
  S.mix = mixes.length ? mixes[mixes.length - 1] : null;
  if (S.trial && !S.applicants.some(function (t) { return t.id === S.trial; })) S.trial = null;
  if (S.trialPitch && !S.pitches.some(function (t) { return t.id === S.trialPitch; })) S.trialPitch = null;
  S.build.picks = S.build.picks.filter(function (id) { return live(findTake(id)); });

  /* votes are cast by people; show them against each voter's layer in the project */
  list.forEach(function (t) { t.votes = {}; });
  S.myVotes = {};
  snap.votes.forEach(function (v) {
    var t = TAKES[v.take_id];
    if (!t) return;
    S.members.forEach(function (m) { if (m.authorId === v.voter_id) t.votes[m.id] = v.value; });
    if (me && v.voter_id === me.id) S.myVotes[v.take_id] = v.value;
  });

  var likeCount = {}, liked = {};
  snap.likes.forEach(function (l) {
    likeCount[l.version_id] = (likeCount[l.version_id] || 0) + 1;
    if (me && l.user_id === me.id) liked[l.version_id] = true;
  });
  S.versions = snap.versions.map(function (v) {
    return { id:v.id, name:v.name, by:v.by_name, authorId:v.author_id, picks:v.picks || [], ctl:v.ctl || {}, likes:likeCount[v.id] || 0, liked:!!liked[v.id], created:v.created_at };
  });

  /* timeline comments (null when their migration isn't applied yet) */
  /* a link from the feed (?stack=<take>) opens the mix view on that take's stack */
  if (WANT && TAKES[WANT] && TAKES[WANT].roleId === 'part') { var wp = WANT; WANT = null; goPart(wp); }  /* a new part is part of the song: open the song on it */
  else if (WANT && TAKES[WANT]) { S.stack = lead(TAKES[WANT]).dbId; S.sel = S.stack; WANT = null; scrollToMix(0); }
  else if (WANT === 'seed') { WANT = null; S.stack = '__seed'; S.sel = '__seed'; scrollToMix(0); }  /* the first clip on its own */
  else if (WANT === 'song') { WANT = null; S.stack = null; scrollToMix(0); }  /* the song itself: the first tab */
  S.stackLikes = {}; S.stackLiked = {};
  (snap.stackLikes || []).forEach(function (l) {
    S.stackLikes[l.stack_key] = (S.stackLikes[l.stack_key] || 0) + 1;
    if (me && l.user_id === me.id) S.stackLiked[l.stack_key] = true;
  });
  S.cmAvailable = snap.comments !== null && snap.comments !== undefined;
  S.comments = (snap.comments || []).filter(function (c) { return !c.hidden; }).map(function (c) {
    return { id:c.id, by:c.author_name, authorId:c.author_id, body:c.body, at:c.at_sec, created:c.created_at };
  });
  if (S.cmOpen && !S.comments.some(function (c) { return c.id === S.cmOpen; })) S.cmOpen = null;
  /* the thread's written replies and their votes (shared with the homepage) */
  S.words = (snap.words || []).map(function (c) {
    return { id:c.id, by:c.author_name, authorId:c.author_id, body:c.body, created:c.created_at, toTake:c.reply_to_take || null, toWord:c.reply_to_comment || null, deleted:!!c.deleted_at };
  });
  S.tVotes = {}; S.myTVote = {};
  (snap.tvotes || []).forEach(function (v) {
    if (me && v.voter_id === me.id) S.myTVote[v.target_id] = v.value;
    else S.tVotes[v.target_id] = (S.tVotes[v.target_id] || 0) + v.value;
  });

  S.reactions = { banger:0, mess:0, again:0 }; S.reacted = {};
  snap.reactions.forEach(function (r) {
    S.reactions[r.kind] = (S.reactions[r.kind] || 0) + 1;
    if (me && r.user_id === me.id) S.reacted[r.kind] = true;
  });

  loadMissingAudio();
}

var refreshTimer = 0;
function refresh() {
  if (!S.session) return Promise.resolve();
  var id = S.session.id;
  return Promise.all([db.loadSessionById(id), db.loadSnapshot(id)]).then(function (r) {
    if (!S.session || S.session.id !== id) return;
    applySnapshot(r[0], r[1]);
    askProfiles();
    syncPhase();
    if (AC) refreshGains(); /* an amp someone else changed is heard right away */
    renderAll();
  }).catch(oops);
}
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 250);
}
function watch(sessionId) {
  if (unwatch) unwatch();
  unwatch = db.subscribe(sessionId, refreshSoon);
}

/* ---------- audio loading (from storage, a few at a time) ---------- */
var loadQueue = [], loadingNow = 0, LOAD_LIMIT = 3;
function loadMissingAudio() {
  Object.keys(TAKES).forEach(function (k) {
    var t = TAKES[k];
    if (t.status === 'mix' || t.status === 'deleted' || t.buf || t.loading || t.failed || !t.url) return;
    if (t.roleId === 'seed' && t !== S.seed) return;              // an old, replaced seed
    if (t.roleId === 'part' && t.status === 'archived') return;   // a part nobody hears any more
    if (isOwn(t) && !mine(t) && !picked(t.id)) return;            // someone's own take no version uses
    t.loading = true;
    loadQueue.push(t);
  });
  pump();
}
function pump() {
  while (loadingNow < LOAD_LIMIT && loadQueue.length) {
    var t = loadQueue.shift();
    loadingNow++;
    loadOne(t).then(function () { loadingNow--; renderSoon(); pump(); });
  }
}
function loadOne(t) {
  return fetch(t.url).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.arrayBuffer();
  }).then(function (ab) {
    t.bytes = new Uint8Array(ab.slice(0));
    return ac().decodeAudioData(ab);
  }).then(function (buf) {
    setBuffer(t, buf);
    t.loading = false;
  }).catch(function (e) {
    console.error('Could not load audio for', t.fileName, e);
    t.loading = false; t.failed = true;
  });
}
function loadingCount() {
  return Object.keys(TAKES).filter(function (k) { return TAKES[k].loading; }).length;
}

/* ---------- project votes ---------- */
function atStake(t) {
  var here = inSong(t.roleId, secOf(t));
  return here.length && here.length >= cap(t.roleId, secOf(t)) ? here[0] : null;
}
function tallyOf(t) {
  var stake = atStake(t), up = 0, down = 0, voters = 0, seen = {};
  S.members.forEach(function (m) {
    if (stake && m.id === stake.id) return;
    if (seen[m.authorId]) return;   // one person, one vote, even with two layers in
    seen[m.authorId] = true; voters++;
    if (t.votes[m.id] === 'up') up++;
    if (t.votes[m.id] === 'down') down++;
  });
  return { up:up, down:down, voters:voters };
}
/* mirrors public.can_vote() in the database */
function canVote(t) {
  if (!me || !isOpen() || t.status !== 'waiting' || t.roleId === 'part' || seedHolds(t.roleId, secOf(t))) return false;
  var stake = atStake(t);
  return S.members.some(function (m) { return m.authorId === me.id && !(stake && stake.id === m.id); });
}
function voteBlock(t) {
  if (seedHolds(t.roleId, secOf(t))) return '<div class="lvotes"><span class="tiny muted">The original track plays this part, so this take can only go in versions.</span></div>';
  if (!S.members.length) return '<div class="lvotes"><span class="tiny muted">Nobody in the stack yet to weigh in.</span></div>';
  var stake = atStake(t), tl = tallyOf(t);
  var chips = S.members.map(function (m) {
    var v = t.votes[m.id], r = role(m.roleId), isStake = stake && stake.id === m.id;
    return '<span class="lv' + (v ? ' ' + v : ' none') + (isStake ? ' stake' : '') + '" style="--c:' + col(r) + '" title="' +
      esc(m.by) + (isStake ? ' holds this spot, so their vote does not count' : '') + '">' +
      '<i></i>' + esc(m.by) + '<em>' + (v === 'up' ? '&#8593;' : v === 'down' ? '&#8595;' : '&middot;') + '</em></span>';
  }).join('');
  var mine = S.myVotes[t.id];
  var myButtons = canVote(t)
    ? '<div class="lv-mine"><span class="tiny muted">Your vote</span>' +
      '<button class="btn btn-sm' + (mine === 'up' ? ' on' : '') + '" type="button" data-vote="up" data-take="' + t.id + '" aria-pressed="' + (mine === 'up') + '">&#8593; For</button>' +
      '<button class="btn btn-sm' + (mine === 'down' ? ' on' : '') + '" type="button" data-vote="down" data-take="' + t.id + '" aria-pressed="' + (mine === 'down') + '">&#8595; Against</button></div>'
    : '';
  return '<div class="lvotes"><div class="lv-sum"><b>The stack</b> ' + tl.up + ' for, ' + tl.down + ' against' +
    (tl.voters - tl.up - tl.down > 0 ? ', ' + (tl.voters - tl.up - tl.down) + ' quiet' : '') + '</div>' +
    '<div class="lv-chips">' + chips + '</div>' + myButtons + '</div>';
}
function target(){ return hasSeed() ? S.seed.len : 0; }
/* sections you can layer on: the original track, and every new part that was kept */
function sections() {
  if (!hasSeed()) return [];
  var a = arrangement(), out = [{ id:'core', label:'the original track', start:a.lead, len:S.seed.len }];
  S.parts.forEach(function (p) {
    out.push({ id:p.id, label:p.by + '\'s part', start:a.starts[p.id], len:p.len, pos:p.pos });
  });
  return out.sort(function (x, y) { return x.start - y.start; });
}
function section(id) { return sections().filter(function (s) { return s.id === (id || 'core'); })[0] || null; }
function secLen(id) { var s = section(id); return s ? s.len : target(); }
function secOf(t) { return t.sec || 'core'; }
function onKeptSection(t) { return secOf(t) === 'core' || S.parts.some(function (p) { return p.id === t.sec; }); }
function secTag(t) {
  if (secOf(t) === 'core' || t.roleId === 'part') return '';
  var p = findTake(t.sec);
  return '<span class="sectag">on ' + esc(p ? p.by + '\'s part' : 'a new part') + '</span>';
}
function duration(){ return tracks().reduce(function (a, t) { return Math.max(a, startOf(t) + t.len); }, 0); }

/* ---------- web audio engine ---------- */
var AC = null, master = null, analyser = null, freq = null;
var gains = {}, sources = {}, startedAt = 0, offset = 0, running = false, only = null, raf = 0;
function ac() {
  if (!AC) {
    AC = newContext();
    master = AC.createGain();
    analyser = AC.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
    freq = new Uint8Array(analyser.frequencyBinCount);
    master.connect(analyser);
    analyser.connect(AC.destination);
  }
  return AC;
}
function anySolo(){ return tracks().some(function (t) { return ctl(t).solo; }); }
function audible(t) {
  if (only && only.indexOf('pair:') === 0) return t.id === 'seed' || t.id === only.slice(5);
  if (only) return t.id === only;
  if (ctl(t).mute) return false;
  if (anySolo() && !ctl(t).solo) return false;
  return true;
}
/* Each track runs source -> fade envelope -> high-pass -> low-pass -> gain -> master (a take
   with an amp plays its rendered buffer, see playBuf()). Returns the input of the chain. */
function gainFor(t) {
  var ch = gains[t.id];
  if (!ch) {
    var inp = ac().createGain(), hp = ac().createBiquadFilter(), lp = ac().createBiquadFilter(), g = ac().createGain();
    hp.type = 'highpass'; lp.type = 'lowpass';
    hp.Q.value = lp.Q.value = Math.SQRT1_2;
    hp.frequency.value = cutOf(t, 'hp');
    lp.frequency.value = cutOf(t, 'lp');
    inp.connect(hp); hp.connect(lp); lp.connect(g); g.connect(master);
    ch = gains[t.id] = { inp:inp, hp:hp, lp:lp, g:g };
  }
  ch.g.gain.value = audible(t) ? volOf(t) : 0;
  setCut(ch.hp, cutOf(t, 'hp'));
  setCut(ch.lp, cutOf(t, 'lp'));
  return ch.inp;
}
/* What a take plays: its own audio, or that audio rendered through its amp. A render is made
   once per take and amp, in the background, and kept on the take (t.amped[id]). Until it is
   ready the take is silent (never the raw DI in the mix), and when it arrives during
   playback the song picks up from where it is. */
function playBuf(t) {
  var id = ampOf(t);
  if (!id || !t.buf) return t.buf;
  var r = wantAmp(t, id);
  return r.buf || null;
}
function wantAmp(t, id) {
  t.amped = t.amped || {};
  var r = t.amped[id];
  if (r && (r.buf || r.busy || r.failed)) return r;
  r = t.amped[id] = { busy:true };
  var src = t.buf;
  renderAmp(src, id).then(function (buf) {
    r.busy = false;
    if (t.buf !== src) return;
    r.buf = buf;
    if (running && !only && tracks().indexOf(t) > -1 && ampOf(t) === id) play(position());
    else render();
  }, function (e) {
    console.error(e);
    r.busy = false; r.failed = true;
    flash('The ' + ampLabel(id).toLowerCase() + ' amp could not load, so ' + (t.by || 'that take') + ' plays as it was recorded. Reload the page to try again.');
    render();
  });
  return r;
}
/* an amp failed to load: play the take as recorded rather than not at all */
function ampFailed(t) { var id = ampOf(t); return !!(id && t.amped && t.amped[id] && t.amped[id].failed); }
function ampBusy(t) { var id = ampOf(t); return !!(id && t.buf && !ampFailed(t) && !(t.amped && t.amped[id] && t.amped[id].buf)); }
/* an amp running live, for hearing yourself and your fresh take; returns its input. Its nodes
   go in `keep` (as one entry) so recCleanup() takes the whole thing down. */
function ampInto(id, peak, dest, keep) {
  var a = liveAmp(ac(), id, peak);
  if (!a) return dest;
  a.output.connect(dest);
  keep.push({ disconnect:function () { dropAmp(a); } });
  return a.input;
}
/* glide to the new cutoff so turning a knob during playback doesn't click */
function setCut(node, hz) {
  if (Math.abs(node.frequency.value - hz) < .5) return;
  node.frequency.setTargetAtTime(hz, ac().currentTime, .015);
}
function refreshGains() {
  tracks().forEach(function (t) { gainFor(t); if (ampOf(t)) playBuf(t); });
}
function position() {
  if (!running) return offset;
  return Math.min(duration(), ac().currentTime - startedAt);
}
function stopAll(keep) {
  Object.keys(sources).forEach(function (k) {
    try { sources[k].stop(); } catch (e) {}
  });
  sources = {};
  if (running) offset = keep ? position() : 0;
  running = false; only = null;
  cancelAnimationFrame(raf);
  raf = 0;
  bindViz(); drawViz(false);
  render();
}
function play(from, soloId) {
  if (REC.state === 'recording' || REC.state === 'asking') return;
  if (REC.pv) recStopPlayers();
  var list = tracks();
  if (!list.length) return;
  stopAll(true);
  only = soloId || null;
  var at = Math.max(0, Math.min(from === undefined ? offset : from, duration() - .05));
  ac().resume();
  startedAt = ac().currentTime - at;
  var now = ac().currentTime;
  list.forEach(function (t) {
    if (!audible(t)) return;
    var st = startOf(t), b = ampFailed(t) ? t.buf : playBuf(t);
    if (at >= st + t.len || !b) return;
    var s = ac().createBufferSource(), env = ac().createGain();
    s.buffer = b;
    s.connect(env); env.connect(gainFor(t));
    var T = at >= st ? now : now + (st - at), x0 = at >= st ? at - st : 0;
    scheduleEnv(env, t, T, x0);
    s.start(T, x0);
    sources[t.id] = s;
  });
  /* tracks carried into a part play again under it, repeated to fill it */
  list.forEach(function (p) {
    if (p.roleId !== 'part') return;
    var st = startOf(p);
    carryOf(p).forEach(function (src) {
      if (!audible(src)) return;
      var b = ampFailed(src) ? src.buf : playBuf(src), seg = src.len || (b && b.duration) || 0;
      if (!b || seg < 0.25) return;
      for (var k = 0; k * seg < p.len; k++) {
        var s0 = st + k * seg, dur = Math.min(seg, p.len - k * seg);
        if (at >= s0 + dur) continue;
        var cs = ac().createBufferSource(), cenv = ac().createGain();
        cs.buffer = b; cs.connect(cenv); cenv.connect(gainFor(src));
        var cT = at >= s0 ? now : now + (s0 - at), cx = at >= s0 ? at - s0 : 0;
        scheduleEnv(cenv, p, cT, k * seg + cx);   /* the part's own fades and crossfades */
        cs.start(cT, cx, dur - cx);
        sources['c:' + p.id + ':' + src.id + ':' + k] = cs;
      }
    });
  });
  offset = at; running = true;
  startLoop();
  render();
}
/* play/pause for a take or part that is being heard in the mix */
function mixToggle(what) {
  var on = running && !only;
  return '<button class="btn btn-sm mixtgl' + (on ? ' on' : '') + '" type="button" data-mixtgl="1" aria-label="' +
    (on ? 'Pause' : 'Play') + ' the stack with ' + what + '">' + (on ? I_PAUSE + ' Pause' : I_PLAY + ' Play') + '</button>';
}
function toggleTransport(){ running ? stopAll(true) : play(); }
function preview(t) {
  if (!t || !t.buf) { if (t && t.loading) flash('Still loading that take.'); return; }
  if (only === t.id) { stopAll(); return; }
  var b = ampFailed(t) ? t.buf : playBuf(t);
  if (!b) { flash('Putting that take through the ' + ampLabel(ampOf(t)).toLowerCase() + ' amp. Press play again in a moment.'); return; }
  stopAll();
  only = t.id;
  var s = ac().createBufferSource(), env = ac().createGain();
  s.buffer = b;
  s.connect(env); env.connect(gainFor(t));
  ac().resume();
  var T = ac().currentTime + 0.02;
  scheduleEnv(env, t, T, 0);
  s.start(T);
  onlyAt = T;
  sources[t.id] = s;
  s.onended = function () { delete sources[t.id]; if (only === t.id) { only = null; render(); } };
  startLoop();
  render();
}
/* a reply on its own, every instrument in it together, nothing else */
function previewGroup(t) {
  var key = 'grp:' + t.id, list = groupOf(t).filter(function (g) { return g.buf; });
  if (only === key) { stopAll(); return; }
  if (!list.length) { flash('Still loading that take.'); return; }
  if (list.some(ampBusy)) { list.forEach(playBuf); flash('Putting it through the amp. Press play again in a moment.'); return; }
  stopAll(); only = key; ac().resume();
  var T = ac().currentTime + 0.02, left = list.length;
  list.forEach(function (g) {
    var s2 = ac().createBufferSource(), env = ac().createGain();
    s2.buffer = ampFailed(g) ? g.buf : playBuf(g); s2.connect(env); env.connect(gainFor(g));
    scheduleEnv(env, g, T, 0); s2.start(T); sources[g.id] = s2;
    s2.onended = function () { delete sources[g.id]; if (--left <= 0 && only === key) { only = null; render(); } };
  });
  onlyAt = T; startLoop(); render();
}
/* a take together with the original track, from the own-version block */
function pairPreview(t) {
  var key = 'pair:' + t.id;
  if (only === key) { stopAll(); return; }
  if (!t || !t.buf || !S.seed.buf) { flash('Still loading the audio.'); return; }
  if (ampBusy(t) || ampBusy(S.seed)) { playBuf(t); playBuf(S.seed); flash('Putting it through the amp. Press play again in a moment.'); return; }
  stopAll();
  only = key;
  ac().resume();
  var T = ac().currentTime + 0.02, left = 2;
  [S.seed, t].forEach(function (x) {
    var s = ac().createBufferSource(), env = ac().createGain();
    s.buffer = ampFailed(x) ? x.buf : playBuf(x);
    s.connect(env); env.connect(gainFor(x));
    scheduleEnv(env, x, T, 0);
    s.start(T);
    sources[x.id] = s;
    s.onended = function () { delete sources[x.id]; if (--left === 0 && only === key) { only = null; render(); } };
  });
  onlyAt = T;
  startLoop();
  render();
}
/* The original track's waveform at the top: real peaks, with the part already played
   coloured in while the original track sounds (on its own or in the mix). */
var onlyAt = 0, SEED_BARS = 160;
function seedWaveBars() {
  var pk = S.seed.peaks;
  if (!pk || !pk.length) return '';
  var step = pk.length / SEED_BARS, vals = [], max = 0;
  for (var i = 0; i < SEED_BARS; i++) {
    var m = 0;
    for (var j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) if (pk[j] > m) m = pk[j];
    vals.push(m); if (m > max) max = m;
  }
  return vals.map(function (v) { return '<i style="height:' + Math.max(4, Math.round((max ? v / max : 0) * 100)) + '%"></i>'; }).join('');
}
function seedWave() {
  var bars = seedWaveBars();
  if (!bars) return '<div class="seedwave loading" id="seed-viz" aria-hidden="true">' + vizMarkup(SEED_BARS) + '</div>';
  return '<div class="seedwave real" id="seed-viz" aria-hidden="true"><canvas class="sw-c" data-seedwave="base"></canvas>' +
    '<div class="sw-prog" id="seed-prog"><canvas class="sw-c" data-seedwave="prog"></canvas></div></div>';
}
function seedProgress() {
  var L = S.seed.len || 0;
  if (!L) return 0;
  if (only === 'seed' && sources.seed) return (ac().currentTime - onlyAt) / L;
  if (running && !only) return (position() - startOf(S.seed)) / L;
  return 0;
}
function drawViz() {
  var pr = el('seed-prog');
  if (!pr) return;
  var f = Math.max(0, Math.min(1, seedProgress()));
  pr.style.clipPath = 'inset(0 ' + ((1 - f) * 100).toFixed(2) + '% 0 0)';
}
function bindViz() {}
function frame() {
  var dawRec = REC.where === 'daw' && REC.state === 'recording';
  var seedRec = REC.where === 'seed' && REC.state === 'recording';
  var busy = running || Object.keys(sources).length > 0 || dawRec || seedRec;
  if (seedRec) drawSeedRec();
  var p = dawRec ? Math.max(0, startOf(S.seed) + ac().currentTime - REC.songStart) : position(), d = duration();
  if (dawRec) drawRecLane();
  var marks = document.querySelectorAll('.cm-mark[data-at]');
  for (var mi = 0; mi < marks.length; mi++) {
    var at = +marks[mi].dataset.at;
    marks[mi].classList.toggle('near', running && !only && p >= at - 0.05 && p < at + 2.5);
  }
  if (el('stage-released') && el('stage-released').classList.contains('on')) drawRelWave();
  var ph = el('playhead'), rd = el('readout');
  var lane = document.querySelector('.t-lane'), daw = el('daw');
  if (ph && d && lane && daw) {
    var lr = lane.getBoundingClientRect(), dr = daw.getBoundingClientRect();
    var ru = daw.querySelector('.ruler');
    ph.style.left = (lr.left - dr.left + (p / d) * lr.width) + 'px';
    if (ru) ph.style.top = (ru.getBoundingClientRect().top - dr.top) + 'px';
  }
  if (rd) rd.textContent = clockMs(p) + ' / ' + clockMs(d);
  drawViz(busy);
  if (running && p >= d - .02) { stopAll(); return; }
  if (busy) raf = requestAnimationFrame(frame);
  else { raf = 0; drawViz(false); }
}
function startLoop(){ if (!raf) raf = requestAnimationFrame(frame); }
function tick(){ startLoop(); }

/* ---------- files ---------- */
function decode(file) {
  return file.arrayBuffer().then(function (b) { return ac().decodeAudioData(b); });
}
function peaksOf(buf, n) {
  var ch = buf.getChannelData(0), step = Math.floor(ch.length / n) || 1, out = new Float32Array(n);
  for (var i = 0; i < n; i++) {
    var s = i * step, e = Math.min(ch.length, s + step), m = 0;
    for (var j = s; j < e; j += 2) { var v = Math.abs(ch[j]); if (v > m) m = v; }
    out[i] = m;
  }
  return out;
}
/* the highest and lowest sample per column: drawn as one shape, it looks like a real waveform */
function minMaxOf(buf, n) {
  var d = buf.getChannelData(0), step = d.length / n, hi = new Float32Array(n), lo = new Float32Array(n), peak = 0;
  for (var x = 0; x < n; x++) {
    var a = Math.floor(x * step), z = Math.min(d.length, Math.floor((x + 1) * step)), mx = 0, mn = 0;
    for (var i = a; i < z; i++) { var v = d[i]; if (v > mx) mx = v; else if (v < mn) mn = v; }
    hi[x] = mx; lo[x] = mn; if (mx > peak) peak = mx; if (-mn > peak) peak = -mn;
  }
  return { hi:hi, lo:lo, peak:peak || 1 };
}
function waveShape(g, mm, x0, cw, h, amp) {
  var n = mm.hi.length, mid = h / 2, k = (mid - 2) / mm.peak, x, j, a;
  g.beginPath(); g.moveTo(x0, mid);
  for (x = 0; x < cw; x++) { j = Math.floor(x / cw * n); a = amp ? amp(x / cw) : 1; g.lineTo(x0 + x, mid - Math.max(.6, mm.hi[j] * k * a)); }
  for (x = cw - 1; x >= 0; x--) { j = Math.floor(x / cw * n); a = amp ? amp(x / cw) : 1; g.lineTo(x0 + x, mid - Math.min(-.6, mm.lo[j] * k * a)); }
  g.closePath(); g.fill();
}
function drawSeedWave() {
  [].forEach.call(document.querySelectorAll('canvas[data-seedwave]'), function (c) {
    var t = S.seed; if (!t.buf) return;
    if (!t.mm) t.mm = minMaxOf(t.buf, 2400);
    var dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    c.width = w * dpr; c.height = h * dpr;
    var g = c.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
    /* the original track's waveform is green (sound): faint where it hasn't played yet, full where it has */
    g.fillStyle = cvar('--sound'); g.globalAlpha = c.dataset.seedwave === 'prog' ? 1 : .32;
    waveShape(g, t.mm, 0, w, h);
    g.globalAlpha = 1;
  });
}
function setBuffer(t, buf) {
  t.buf = buf;
  t.len = buf.duration;
  t.peaks = peaksOf(buf, 1200);
  t.mm = minMaxOf(buf, 2400);
  t.amped = {};
  delete gains[t.id];
  if (ampOf(t)) playBuf(t); /* start its amp render now, so it is ready by the time it plays */
}

/* Upload the audio, analyse it in parallel, then record the take. The decoded buffer is
   cached right away so the uploader never downloads their own file again. */
function uploadTake(file, buf, o) {
  var sid = S.session.id;
  var path = sid + '/' + me.id + '/' + crypto.randomUUID() + '.' + extOf(file.name);
  var type = typeFor(file);
  return Promise.all([
    db.uploadAudio(path, file, type),
    o.analyse ? analyse(file).catch(function () { return null; }) : Promise.resolve(null)
  ]).then(function (r) {
    var an = r[1];
    var row = {
      session_id: sid, author_id: me.id, author_name: o.name, role_id: o.role, note: o.note || '',
      status: o.status, storage_path: path, file_name: file.name, mime_type: type, duration_sec: buf.duration,
      part_pos: o.pos || null, section_id: o.sec || null,
      on_takes: o.on ? o.on : o.status === 'waiting' && o.role !== 'part' && !o.sec ? (currentStack() || { takes:[] }).takes.filter(function (x) { return !x.mute; }).map(function (x) { return x.dbId; }) : null,
      group_id: o.group || null,
      an_bpm: an && an.tempo ? an.tempo.bpm : null, an_key: an && an.key ? an.key.key : null
    };
    if (o.amp) row.amp = o.amp;
    if (o.carry && o.carry.length) row.carry = o.carry;
    /* without the amp migration the take still goes in, just without its amp */
    return db.insertTake(row).catch(function (e) {
      if (row.carry && /carry/.test(String(e && (e.message || e.details))) && !/only carry|at most/.test(String(e && e.message)))
        throw new Error('Carrying tracks into a new part needs a database update that is not applied yet (20261018230000_carry_into_parts.sql). Untick them, or try again once it is applied.');
      if (!row.amp || !/amp/.test(String(e && (e.message || e.details)))) throw e;
      delete row.amp;
      return db.insertTake(row);
    }).then(function (row) {
      var t = TAKES[row.id] = { id:row.id, dbId:row.id, vol:1, mute:false, solo:false, votes:{},
                                roleId:row.role_id, status:row.status, by:row.author_name, authorId:row.author_id,
                                note:row.note, sec:row.section_id || null, pos:row.part_pos || null, fin:0, fout:0, xfade:0, on:row.on_takes || null, group:row.group_id || null, created:row.created_at, amp:row.amp || '', carry:row.carry || null };
      if (row.status === 'waiting' && row.role_id !== 'part' && !o.group) { S.stack = row.id; S.sel = row.id; }
      setBuffer(t, buf);
      file.arrayBuffer().then(function (ab) { t.bytes = new Uint8Array(ab); });
      return { row:row, analysis:an };
    });
  });
}

/* ---------- downloads ---------- */
function clean(s){ return String(s || 'take').replace(/[^\w\- ]+/g, '').trim() || 'take'; }
function fileName(t, i) {
  return (i !== undefined ? ('0' + (i + 1)).slice(-2) + ' ' : '') + clean(labelOf(t)) + ' - ' + clean(t.by || 'you') + '.' + extOf(t.fileName);
}
function sheet(list) {
  return 'Stakkato session sheet\r\n\r\n' +
    'Tempo: ' + (S.meta.bpm || '?') + ' bpm\r\nKey: ' + (S.meta.key || '?') + '\r\nTime: ' + S.meta.time +
    '\r\nLength of the original track: ' + fmt(target()) + '\r\n\r\nEvery file starts at the time listed below. Takes on the original track start at its first beat, takes on a new part start with that part.\r\n\r\n' +
    list.map(function (t, i) {
      var e = envOf(t);
      return fileName(t, i) + '   (' + labelOf(t) + ', ' + (t.by || 'you') + ', starts at ' + clockMs(startOf(t)) +
        (e.fi > 0.01 ? ', fade in ' + e.fi.toFixed(1) + ' s' : '') + (e.fo > 0.01 ? ', fade out ' + e.fo.toFixed(1) + ' s' : '') + (ampOf(t) ? ', ' + ampLabel(ampOf(t)).toLowerCase() + ' amp in the app, the file is dry' : '') + ')';
    }).join('\r\n') + '\r\n';
}
function hand(filename, blob) {
  var url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  flash('Downloading ' + filename + '.');
}
function bytes(t) {
  if (t.bytes) return Promise.resolve(t.bytes);
  return fetch(t.url).then(function (r) { return r.arrayBuffer(); }).then(function (ab) { return (t.bytes = new Uint8Array(ab)); });
}
function download(t) {
  if (!t || !t.url) return;
  bytes(t).then(function (u) {
    hand(clean(t.by || 'you') + ' - ' + clean(role(t.roleId).label) + '.zip', zip([{ name:fileName(t), data:u }]));
  }).catch(oops);
}
function downloadAll() {
  var list = tracks().filter(function (t) { return t.url; });
  if (!list.length) return;
  flash('Packing ' + list.length + ' file(s)...');
  Promise.all(list.map(bytes)).then(function (arr) {
    var files = arr.map(function (u, i) { return { name:fileName(list[i], i), data:u }; });
    files.push({ name:'session sheet.txt', data:new TextEncoder().encode(sheet(list)) });
    var title = (S.override ? S.override.name : (S.view === 'build' ? 'my version' : 'the stack'));
    hand('Stakkato - ' + clean(title) + ' stems.zip', zip(files));
  }).catch(oops);
}

/* ---------- wav, click, count-in ---------- */
function trimStart(buf, sec) {
  var cut = Math.min(buf.length - 1, Math.round(sec * buf.sampleRate));
  var out = ac().createBuffer(buf.numberOfChannels, buf.length - cut, buf.sampleRate);
  for (var c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(cut), c);
  return out;
}
function beatInfo() { return beatInfoFor(S.meta.bpm, S.meta.time); }
/* click samples: count-in bars first, then the song, accent on every bar's first beat (rec.js) */
function clickSamples(sr, countBars, songSec) { return clickRaw(sr, countBars, songSec, beatInfo()); }
function clickBuffer(countBars, songSec) {
  var sr = ac().sampleRate, data = clickSamples(sr, countBars, songSec);
  var b = ac().createBuffer(1, data.length, sr);
  b.copyToChannel(data, 0);
  return b;
}
function downloadClick() {
  if (!hasSeed()) return;
  var b = beatInfo(), n = S.countIn, sec = target();
  var bpm = S.meta.bpm || 120, sig = S.meta.time === 'odd' ? '4/4' : S.meta.time;
  var name = 'click ' + bpm + ' bpm ' + sig.replace('/', '-') + (n ? ' with ' + n + ' bar count-in' : '');
  var readme = 'Stakkato click track\r\n\r\n' + bpm + ' bpm, ' + sig + ', ' + fmt(sec) + ' of song' +
    (n ? ', plus ' + n + ' bar' + (n > 1 ? 's' : '') + ' of count-in (' + (n * b.bar).toFixed(2) + ' s)' : '') + '.\r\n\r\n' +
    (n ? 'Bar 1 of the song starts right after the count-in. When you upload, either cut the count-in off your take, ' +
         'or tick "my file starts with the count-in" and Stakkato cuts it for you.\r\n'
       : 'Bar 1 of the song is the very start of the file.\r\n') +
    (S.meta.bpm ? '' : '\r\nNo tempo was detected for this session, so this click runs at 120 bpm. Ask the creator to set the tempo, then download again.\r\n');
  encodeWav(clickBuffer(n, sec)).arrayBuffer().then(function (ab) {
    hand('Stakkato ' + name + '.zip', zip([
      { name: name + '.wav', data: new Uint8Array(ab) },
      { name: 'read me.txt', data: new TextEncoder().encode(readme) }
    ]));
  });
}

/* ---------- recorder: plays the chosen tracks and the click, cuts the take to bar 1 ---------- */
var REC = { state:'idle', buf:null, file:null, stream:null, nodes:[], timer:0, player:[] };
function recStopPlayers() {
  /* stopping a draft take's preview keeps where it was, so play goes on from there */
  if (REC.pv) { REC.pvAt = recPvPos(); REC.pv = null; cancelAnimationFrame(REC.pvRaf); }
  REC.player.forEach(function (s) { try { s.stop(); } catch (e) {} });
  REC.player = [];
  recPvButton();
}
function recCleanup() {
  clearTimeout(REC.timer); clearInterval(REC.tick);
  recStopPlayers();
  REC.nodes.forEach(function (n) { try { n.disconnect(); } catch (e) {} });
  REC.nodes = [];
  if (REC.stream) REC.stream.getTracks().forEach(function (tr) { tr.stop(); });
  REC.stream = null;
}
function recReset() { recCleanup(); REC.state = 'idle'; REC.buf = null; REC.file = null; REC.err = ''; REC.warn = ''; REC.info = ''; REC.partial = 0; REC.peaks = null; REC.pvAt = 0; }
function recBacking() {
  return hearable().filter(function (t) { return REC.hear[t.id] !== false && (REC.where !== 'daw' || audible(t)); });
}
/* what can play under a recording: the project, or for your own version the takes you picked */
function hearable() {
  var layers = M.mode === 'own' ? byIds(S.build.picks) : S.members;
  return [S.seed].concat(layers.filter(onKeptSection), partTakes()).filter(function (t) { return t.buf; });
}
/* play backing so that the chosen section starts at audio time T */
function playBacking(list, T, into, from) {
  var a = ac(), s0 = (section(M.sec) || section('core')).start + (from || 0);
  list.forEach(function (t) {
    var rel = startOf(t) - s0, off = rel < 0 ? -rel : 0;
    if (off >= t.len) return;
    var b = ampFailed(t) ? t.buf : playBuf(t);
    if (!b) return;
    var s = a.createBufferSource(), g = a.createGain();
    s.buffer = b; g.gain.value = volOf(t);
    s.connect(g); g.connect(master); s.start(T + Math.max(0, rel), off);
    into.push(s); REC.nodes.push(g);
  });
  /* tracks carried into a part play under it here too, so a layer on the part hears them */
  list.forEach(function (p) {
    if (p.roleId !== 'part') return;
    var st = startOf(p);
    carryOf(p).forEach(function (src) {
      var b = ampFailed(src) ? src.buf : playBuf(src), seg = src.len || 0;
      if (!b || seg < 0.25) return;
      for (var k = 0; k * seg < p.len; k++) {
        var rel = st + k * seg - s0, dur = Math.min(seg, p.len - k * seg), off = rel < 0 ? -rel : 0;
        if (off >= dur) continue;
        var cs = a.createBufferSource(), cg = a.createGain();
        cs.buffer = b; cg.gain.value = volOf(src);
        cs.connect(cg); cg.connect(master); cs.start(T + Math.max(0, rel), off, dur - off);
        into.push(cs); REC.nodes.push(cg);
      }
    });
  });
}
/* ---------- which input to record from ---------- */
S.mics = [];
function micOptions() {
  var cur = savedMic();
  return '<option value="">Default input</option>' + S.mics.map(function (m, i) {
    return '<option value="' + esc(m.id) + '"' + (m.id === cur ? ' selected' : '') + '>' + esc(m.label || ('Input ' + (i + 1))) + '</option>';
  }).join('');
}
/* ---------- the amp you record through: remembered per browser. The take is stored dry
   and keeps this amp as its setting, so it can be changed later. ---------- */
/* the amp a recording for this layer gets: only guitar-like layers use one */
/* the layer being recorded: the grey track's, the send window's, none for the original track */
function recRoleId() { return REC.where === 'daw' ? S.recRole || ROLES[0].id : REC.where === 'seed' ? '' : el('take-role').value; }
function ampPicker(rid) {
  var cur = savedAmp(), on = AMP_ROLES.indexOf(rid) > -1;
  if (on && cur) preloadAmp(cur);
  return '<label class="mini amp-mini"' + (on ? '' : ' hidden') + ' title="Recorded dry, heard through this amp. You can change it later."><span>amp</span><select class="amp-pick">' +
    '<option value="">Off, as it comes in</option>' + AMPS.map(function (a) {
      return '<option value="' + a.id + '"' + (a.id === cur ? ' selected' : '') + '>' + a.label + '</option>';
    }).join('') + '</select></label>';
}
function showAmpPick(rid) {
  [].forEach.call(document.querySelectorAll('.amp-mini, .rate-tip'), function (l) { l.hidden = AMP_ROLES.indexOf(rid) < 0; });
}
/* "Hear yourself" arms the input: you hear it right away, through the amp for this layer */
function monRole() { return el('scrim').classList.contains('on') ? el('take-role').value : REC.where === 'seed' ? '' : (S.recRole || ROLES[0].id); }
function arm() {
  armMonitor(ac(), recAmpFor(monRole()), master).then(refreshMics, function (err) {
    rememberMon(false);
    [].forEach.call(document.querySelectorAll('.mon-pick'), function (c) { c.checked = false; });
    flash(micError(err));
  });
}
function rearm() { if (monitorOn()) arm(); }
function monPicker() {
  return '<label class="rec-opt mon-opt" title="Hear your input in the headphones right away, through the amp if you picked one. Leave it off if your interface already lets you hear yourself.">' +
    '<input type="checkbox" class="mon-pick"' + (savedMon() ? ' checked' : '') + '><span>Hear yourself</span></label>';
}
function micPicker() { return '<label class="mini mic"><span>input</span><select class="mic-pick">' + micOptions() + '</select></label>'; }
/* labels only show once the browser has been allowed to use a microphone */
function refreshMics() {
  listMics().then(function (list) {
    S.mics = list;
    [].forEach.call(document.querySelectorAll('.mic-pick'), function (sel) { sel.innerHTML = micOptions(); });
  });
}
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', refreshMics);
function recStart() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    REC.err = 'This browser does not give pages access to a microphone.'; renderRec(); return;
  }
  stopAll();
  REC.err = ''; REC.warn = ''; REC.info = ''; REC.state = 'asking'; renderRec();
  var a = ac(); a.resume();
  openMic().then(function (stream) {
    REC.stream = stream;
    refreshMics();
    return recWorklet(a).then(function () { return { stream:stream, worklet:true }; }, function () { return { stream:stream, worklet:false }; });
  }).then(function (got) {
    if (REC.state !== 'asking') { got.stream.getTracks().forEach(function (tr) { tr.stop(); }); return; }
    var chunks = [], bar = barSeconds(), extend = M.mode === 'extend';
    var countIn = S.countIn, t0 = a.currentTime + 0.4, songStart = t0 + countIn * bar;
    var fixed = extend ? 0 : secLen(M.sec);
    REC.songStart = songStart; REC.t0 = t0; REC.countIn = countIn; REC.fixed = fixed; REC.level = 0; REC.peak = 0;
    /* the input's own delay, where the browser reports it */
    REC.inLat = inputLatency(got.stream);
    function onChunk(d, t, sr) {
      var bp = blockPeaks(d);
      REC.level = Math.max(bp.peak, REC.level * 0.85);
      if (t >= songStart && bp.peak > REC.peak) REC.peak = bp.peak;
      /* eight sub-peaks per chunk, so the take can be drawn finely while it comes in */
      chunks.push({ t:t, d:d, pks:bp.pks, dur:d.length / sr });
    }
    var cap = capture(a, got.stream, got.worklet, onChunk), src = cap.src;
    REC.nodes = cap.nodes;
    /* hearing yourself, through the amp if one is picked (the take itself stays dry); when the
       input is already armed it keeps playing as it is */
    if (savedMon() && !monitorOn()) arm();
    /* what you hear: the click and, for a layer, the chosen tracks from bar 1 */
    if (REC.click) {
      var cs = a.createBufferSource();
      cs.buffer = clickBuffer(countIn, fixed || 180);
      cs.connect(master); cs.start(t0);
      REC.player.push(cs);
    }
    if (!extend) playBacking(recBacking(), songStart, REC.player);
    REC.chunks = chunks; REC.state = 'recording'; REC.stopAt = fixed ? songStart + fixed : 0;
    REC.lat = (a.outputLatency || 0) + (a.baseLatency || 0);
    if (REC.where === 'daw' || REC.where === 'seed') startLoop();
    REC.tick = setInterval(renderRecStatus, 100);
    if (fixed) REC.timer = setTimeout(recFinish, (songStart + fixed - a.currentTime + 0.25) * 1000);
    renderRec();
  }).catch(function (err) {
    recCleanup();
    REC.state = 'idle';
    REC.err = micError(err);
    renderRec();
  });
}
/* Stopping a fixed-length layer early keeps what was played: the take still runs the full
   length of its section, and everything after the stop is silence. */
function recFinish() {
  if (REC.state !== 'recording') return;
  var a = ac(), sr = a.sampleRate;
  var lat = (a.outputLatency || 0) + (a.baseLatency || 0) + (REC.inLat || 0);
  var played = Math.max(0, a.currentTime - REC.songStart);
  var len = REC.fixed || played;
  recCleanup();
  if (played < 0.5) {
    REC.state = 'idle';
    REC.err = REC.fixed && played === 0 ? 'Nothing was recorded yet, the count-in was still running.' : 'That was too short to keep.';
    renderRec(); return;
  }
  REC.partial = REC.fixed && played < REC.fixed - 0.25 ? played : 0;
  /* the blocks laid back to back, lined up by the click if it got into the recording (rec.js) */
  var made = assembleTake({ chunks:REC.chunks, sr:sr, t0:REC.t0, songStart:REC.songStart, lat:lat, len:len, countIn:REC.countIn, click:REC.click, beat:beatInfo() });
  var bleed = made.bleed, out = made.out;
  /* A take of free length (the original track, a new part) ends on the bar where the playing
     stops, not where you pressed stop: the silence after it would become part of the song. */
  if (!REC.fixed) {
    var pk = 0, i2;
    for (i2 = 0; i2 < out.length; i2++) { var av = Math.abs(out[i2]); if (av > pk) pk = av; }
    var thr = Math.max(0.003, pk * 0.01), last = -1;   // 40 dB under the loudest moment
    for (i2 = out.length - 1; i2 >= 0; i2--) if (Math.abs(out[i2]) > thr) { last = i2; break; }
    var barS = barSeconds(), bars = Math.max(1, Math.ceil((last / sr - 0.03) / barS));
    var keep = Math.round(bars * barS * sr);
    if (last >= 0 && keep < out.length - Math.round(0.05 * sr)) {
      var cutSec = (out.length - keep) / sr;
      out = out.slice(0, keep);
      var fade = Math.min(keep, Math.round(0.01 * sr));
      for (i2 = 0; i2 < fade; i2++) out[keep - fade + i2] *= 1 - (i2 + 1) / fade;
      REC.info = 'Cut to ' + bars + ' bar' + (bars > 1 ? 's' : '') + ' (' + clockMs(keep / sr) + '): the ' + cutSec.toFixed(1) + ' s of silence before you pressed stop is left out.';
    }
  }
  if (bleed) REC.warn = bleedNote(bleed);
  /* a very quiet take usually means the wrong input or channel (a DI channel, for one) */
  /* (a dry guitar through one of our amps is fine quiet: the amp brings it up) */
  var quiet = quietNote(REC.peak, !!recAmpFor(recRoleId()), recRoleId());
  if (quiet) REC.warn = quiet;
  var buf = a.createBuffer(1, out.length, sr);
  buf.copyToChannel(out, 0);
  REC.buf = buf; REC.peakOf = minMaxOf(buf, 64).peak; REC.pvAt = 0;
  REC.file = new File([encodeWav(buf)], REC.where === 'seed' ? 'recorded track.wav' : 'recorded take.wav', { type:'audio/wav' });
  /* a first track recorded on the session page waits to start the session, like a chosen file */
  if (REC.where === 'seed') S.seedRecMeta = { bpm:S.meta.bpm, time:S.meta.time };
  REC.chunks = null;
  REC.state = 'done';
  renderRec();
}
function recCancel() {
  recCleanup();
  REC.state = 'idle'; REC.chunks = null;
  renderRec();
}
/* ---------- recording straight onto the grey track in the DAW, like a real DAW:
   the playhead runs over the other tracks and the take is drawn as it comes in ---------- */
function dawRecMode() { return S.view === 'build' && !S.override ? 'own' : 'layer'; }
function dawRecStart() {
  if (!hasSeed()) return;
  var own = dawRecMode() === 'own';
  if (!own && !isOpen()) { flash('This song is released, so the stack is final.'); return; }
  if (el('scrim').classList.contains('on')) return;
  M.mode = own ? 'own' : 'layer'; M.sec = 'core';
  recReset(); REC.where = 'daw'; REC.hear = {}; if (REC.click === undefined) REC.click = true;
  recStart();
}
/* the finished take goes into the send window, already loaded: add a name and send */
function dawRecSend() {
  if (!REC.buf) return;
  var own = dawRecMode() === 'own';
  REC.where = 'modal'; REC.fromDaw = true;
  openModal(S.recRole || ROLES[0].id, null, own, true);
}
/* from the send-a-take window to the grey track: same instrument, right view, ready to record */
function recordInDaw() {
  var own = M.mode === 'own', rid = el('take-role').value;
  closeModal();
  S.recRole = rid;
  if (REC.state === 'recording' || REC.state === 'asking') recCancel();
  stopAll();
  S.override = null; S.trial = null; S.view = own ? 'build' : 'lineup';
  refreshGains(); render();
  var row = el('addrow');
  if (row) {
    row.scrollIntoView({ behavior:'smooth', block:'center' });
    row.classList.add('ready');
    setTimeout(function () { var r2 = el('addrow'); if (r2) r2.classList.remove('ready'); }, 2600);
  }
  flash('Record your ' + role(rid).label.toLowerCase() + ' right here on the grey track: press "Record here". Wear headphones.');
}
function dawRecDiscard() { recReset(); REC.where = null; REC.fromDaw = false; renderDaw(); }
function renderDawRec() {
  var row = el('addrow');
  if (row) {
    row.className = 'track addrow' + (REC.where === 'daw' && REC.state !== 'idle' ? ' rec-on' : '');
    row.innerHTML = addRowInner(S.view === 'build' && !S.override);
  }
  else renderDaw();
  drawRecLane();
}
/* x of song time sec on the DAW lanes (0..1) */
function laneX(sec) { var d = duration() || target() || 1; return sec / d; }
function drawRecLane() {
  var c = el('rec-canvas');
  if (!c) return;
  var dpr = window.devicePixelRatio || 1, w = c.clientWidth || 600, h = c.clientHeight || 72;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  var g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  var s0 = startOf(S.seed), L = S.seed.len || 1, mid = h / 2;
  var r = role(S.recRole || ROLES[0].id), color = cvar(r.color);
  /* the stretch you are recording over */
  g.fillStyle = color; g.globalAlpha = .08;
  g.fillRect(laneX(s0) * w, 2, laneX(L) * w, h - 4);
  g.globalAlpha = .9;
  if (REC.state === 'recording' && REC.chunks) {
    REC.chunks.forEach(function (ch) {
      var sub = ch.dur / ch.pks.length;
      ch.pks.forEach(function (pk, q) {
        var at = ch.t - REC.songStart - REC.lat + q * sub;
        if (at + sub < 0 || at > L) return;
        var x0 = laneX(s0 + Math.max(0, at)) * w, x1 = laneX(s0 + Math.min(L, at + sub)) * w;
        var bar = Math.max(1, Math.min(1, pk) * (h - 6));
        g.fillRect(x0, mid - bar / 2, Math.max(1, x1 - x0 + .5), bar);
      });
    });
  } else if (REC.state === 'done' && REC.buf) {
    var pk = REC.peaks || (REC.peaks = peaksOf(REC.buf, 1200)), n = pk.length;
    var x0 = laneX(s0) * w, cw = Math.max(1, laneX(REC.buf.duration) * w);
    for (var x = 0; x < cw; x++) {
      var bar2 = Math.max(1, (pk[Math.floor(x / cw * n)] || 0) * (h - 6));
      g.fillRect(x0 + x, mid - bar2 / 2, 1, bar2);
    }
    /* where the preview is, or where it paused */
    var pos = recPvPos();
    if (REC.pv || pos > 0) {
      g.globalAlpha = 1; g.fillStyle = cvar('--sound');
      g.fillRect(Math.round(laneX(s0 + pos) * w) - 1, 0, 2, h);
    }
  }
  g.globalAlpha = 1;
}
function recListen(withBacking, from) {
  recStopPlayers();
  if (!REC.buf) return null;
  from = Math.max(0, Math.min(from || 0, REC.buf.duration - .05));
  var a = ac(); a.resume();
  var at = a.currentTime + 0.05;
  var s = a.createBufferSource();
  s.buffer = REC.buf; s.connect(ampInto(recAmpFor(recRoleId()), REC.peakOf || 0, master, REC.nodes)); s.start(at, from);
  REC.player.push(s);
  if (withBacking && M.mode !== 'extend') playBacking(recBacking(), at, REC.player, from);
  return { s:s, at:at, from:from };
}
/* The draft take on the grey track: play/pause it with the rest, and click (or drag over) its
   waveform to hear it from that moment. REC.pv is the running preview, REC.pvAt where it paused. */
function recPvPos() {
  if (!REC.pv) return REC.pvAt || 0;
  return Math.max(0, Math.min(REC.buf ? REC.buf.duration : 0, REC.pv.from + ac().currentTime - REC.pv.at));
}
function recPvPlay(from) {
  if (running) stopAll(true);
  var p = recListen(true, from);
  if (!p) return;
  var pv = REC.pv = { at:p.at, from:p.from };
  p.s.onended = function () {
    if (REC.pv !== pv) return;
    REC.pv = null; REC.pvAt = 0; cancelAnimationFrame(REC.pvRaf);
    recPvButton(); drawRecLane();
  };
  recPvButton(); recPvTick();
}
function recPvTick() {
  cancelAnimationFrame(REC.pvRaf);
  if (!REC.pv) return;
  drawRecLane();
  REC.pvRaf = requestAnimationFrame(recPvTick);
}
function recPvBtnInner() { return REC.pv ? I_PAUSE + ' Pause' : I_PLAY + ' Play'; }
function recPvButton() {
  var b = el('rec-pp');
  if (!b) return;
  b.innerHTML = recPvBtnInner();
  b.setAttribute('aria-label', REC.pv ? 'Pause your take' : 'Play your take with the rest');
  b.classList.toggle('on', !!REC.pv);
}
var recSeek = null;
function recSeekTo(e) {
  var r = recSeek.rect, d = duration() || target() || 1;
  var sec = (e.clientX - r.left) / (r.width || 1) * d - startOf(S.seed);
  REC.pvAt = Math.max(0, Math.min(REC.buf.duration - .05, sec));
  drawRecLane();
}
document.addEventListener('pointerdown', function (e) {
  var c = e.target.closest && e.target.closest('#rec-canvas');
  if (!c || REC.state !== 'done' || REC.where !== 'daw' || !REC.buf) return;
  e.preventDefault();
  recStopPlayers();
  recSeek = { rect:c.getBoundingClientRect() };
  try { c.setPointerCapture(e.pointerId); } catch (x) {}
  recSeekTo(e);
});
document.addEventListener('pointermove', function (e) { if (recSeek) recSeekTo(e); });
function recSeekEnd() {
  if (!recSeek) return;
  recSeek = null;
  if (REC.state === 'done' && REC.buf) recPvPlay(REC.pvAt);
}
document.addEventListener('pointerup', recSeekEnd);
document.addEventListener('pointercancel', recSeekEnd);
function renderRecStatus() {
  var st = el('rec-status'), meter = el('rec-meter');
  if (!st || REC.state !== 'recording') return;
  var a = ac(), now = a.currentTime;
  if (now < REC.songStart) {
    var bar = barSeconds(), t0 = REC.songStart - S.countIn * bar;
    if (now < t0) { st.textContent = 'Get ready'; st.className = 'rec-status counting'; }
    else {
      var left = S.countIn - Math.floor((now - t0) / bar);
      st.textContent = 'Count-in, ' + left + ' bar' + (left > 1 ? 's' : '') + ' to go';
      st.className = 'rec-status counting';
    }
  } else {
    var p = now - REC.songStart;
    st.textContent = 'Recording ' + clockMs(p) + (REC.fixed ? ' / ' + clockMs(REC.fixed) : '');
    st.className = 'rec-status live';
  }
  if (meter) meter.style.width = Math.min(100, REC.level * 140) + '%';
}
function countInOptions() {
  return [0,1,2,4].map(function (n) { return '<option value="' + n + '"' + (n === S.countIn ? ' selected' : '') + '>' + n + ' bar' + (n === 1 ? '' : 's') + '</option>'; }).join('');
}
function renderRec() {
  if (REC.where === 'daw') { renderDawRec(); return; }
  if (REC.where === 'seed') { renderSeedPop(); return; }
  var box = el('rec-box');
  if (!box) return;
  var extend = M.mode === 'extend';
  if (REC.hear === undefined) REC.hear = {};
  if (REC.click === undefined) REC.click = true;
  var err = REC.err ? '<p class="rec-err">' + esc(REC.err) + '</p>' : '';
  if (REC.state === 'recording' || REC.state === 'asking') {
    box.innerHTML = '<div class="rec-live"><div class="rec-status" id="rec-status">' +
      (REC.state === 'asking' ? 'Waiting for the microphone...' : '') + '</div>' +
      '<div class="rec-meterwrap"><i id="rec-meter"></i></div>' +
      '<div class="rec-acts">' + (REC.fixed
        ? '<button class="btn btn-main" type="button" data-rec="finish">Stop and keep it</button>' +
          '<button class="btn btn-sm" type="button" data-rec="cancel">Stop and throw away</button>'
        : '<button class="btn btn-main" type="button" data-rec="finish">Stop recording</button>' +
          '<button class="btn btn-sm" type="button" data-rec="cancel">Throw away</button>') +
      '</div>' + (REC.fixed ? '<p class="tiny muted">It stops by itself at the end of the track. Stop earlier and you keep what you played; the rest of the take is silence.</p>' : '') + '</div>';
    renderRecStatus();
    return;
  }
  if (REC.state === 'done') {
    box.innerHTML = '<div class="rec-done"><b>Recorded ' + (REC.partial ? clockMs(REC.partial) + ' of ' + clockMs(REC.fixed) : clockMs(REC.buf.duration)) + '</b>' +
      '<span class="tiny muted">' + (REC.partial
        ? 'You stopped early. The rest of the take is silence, so it still lines up with the track.'
        : 'Cut to start exactly at bar 1' + (REC.fixed ? ' and end with the track' : '') + '.') + '</span>' +
      '<div class="rec-acts">' +
        '<button class="btn btn-sm" type="button" data-rec="listen">Hear your take</button>' +
        (extend ? '' : '<button class="btn btn-sm" type="button" data-rec="listenmix">Hear it with the backing</button>') +
        '<button class="btn btn-sm" type="button" data-rec="again">Record again</button>' +
      '</div></div>' + (REC.info && REC.state === 'done' ? '<p class="rec-info">' + esc(REC.info) + '</p>' : '') + (REC.warn ? '<p class="rec-warn">' + esc(REC.warn) + '</p>' : '') + err;
    return;
  }
  var list = extend ? '' : '<div class="rec-hear"><span class="rec-lbl">What you hear while recording</span>' +
    hearable().map(function (t) {
      var r = role(t.roleId), on = REC.hear[t.id] !== false;
      return '<label class="rec-opt"><input type="checkbox" data-hear="' + t.id + '"' + (on ? ' checked' : '') + '>' +
        ico(r.icon, col(r)) + '<span>' + esc(t.by || 'you') + ' <em>' + esc(labelOf(t)) + '</em></span></label>';
    }).join('') + '</div>';
  box.innerHTML = list +
    '<div class="rec-row">' +
      '<label class="rec-opt"><input type="checkbox" data-hear="click"' + (REC.click ? ' checked' : '') + '><span>Click</span></label>' +
      '<label class="mini"><span>count-in</span><select data-countin="1">' + countInOptions() + '</select></label>' +
      micPicker() + ampPicker(el('take-role').value) + monPicker() +
    '</div>' +
    '<p class="tiny muted">Wear headphones, otherwise the backing ends up in your take. ' +
      (extend ? 'Stop whenever your part is done.' : 'Recording starts on the first beat of ' + esc((section(M.sec) || section('core')).label) +
        ' and stops by itself after ' + fmt(secLen(M.sec)) + '.') + '</p>' +
    (rateTip(ac()) ? '<p class="tiny muted rate-tip"' + (AMP_ROLES.indexOf(el('take-role').value) > -1 ? '' : ' hidden') + '>' + esc(rateTip(ac())) + '</p>' : '') +
    '<button class="btn btn-main rec-go" type="button" data-rec="start"><span class="rec-dot"></span> Start recording</button>' + err;
}

/* ---------- floor logic (creator only, enforced by the database) ---------- */
function letIn(t) {
  if (!t || !isHost()) return;
  var r = role(t.roleId), sec = secOf(t), here = inSong(t.roleId, sec);
  if (seedHolds(t.roleId, sec)) { flash('The original track plays ' + r.label.toLowerCase() + ', so there is no room for another take on that layer.'); return; }
  var msg = here.length >= cap(t.roleId, sec)
    ? t.by + ' takes over on ' + r.label.toLowerCase() + '. ' + here[0].by + '’s take is back in the review list.'
    : t.by + '’s take is in the stack on ' + r.label.toLowerCase() + '.';
  if (S.trial === t.id) S.trial = null;
  S.override = null;
  stopAll();
  db.letIn(t.dbId).then(function () { flash(msg); return refresh(); }).catch(oops);
}
function veto(t) {
  if (!t || !isHost()) return;
  if (S.trial === t.id) S.trial = null;
  db.veto(t.dbId).then(function () { flash(t.by + '’s take was vetoed. It stays in the unused takes.'); return refresh(); }).catch(oops);
}
function keepPart(t) {
  if (!t || !isHost()) return;
  stopAll();
  if (S.trialPitch === t.id) S.trialPitch = null;
  db.letIn(t.dbId).then(function () {
    flash('The song just got longer. It’s in the thread too, so people can play on the new part.');
    return refresh();
  }).catch(oops);
}
function passPart(t) {
  if (!t || !isHost()) return;
  if (S.trialPitch === t.id) { stopAll(); S.trialPitch = null; }
  db.veto(t.dbId).then(function () { flash('Passed on ' + t.by + '\'s part.'); return refresh(); }).catch(oops);
}
function dropPart(t) {
  if (!t || !isHost()) return;
  stopAll();
  db.dropPart(t.dbId).then(function () { flash('That part is out of the song again.'); return refresh(); }).catch(oops);
}
/* Deleting takes two clicks. The first click is remembered here, not on the button, so a
   re-render in between (audio arriving, a realtime refresh) doesn't forget it. */
var ARMED = { id:null, until:0, timer:0 };
function armedFor(id) { return ARMED.id === id && Date.now() < ARMED.until; }
function delBtn(id, small) {
  if (!isHost() || !isOpen()) return '';
  var armed = armedFor(id);
  return '<button class="' + (small ? 'tbtn' : 'btn btn-sm icobtn') + ' del' + (armed ? ' armed' : '') + '" type="button" data-del="' + id + '" ' +
    'title="' + (armed ? 'Click again to delete it for good' : 'Delete this take') + '" aria-label="' + (armed ? 'Click again to delete this take for good' : 'Delete this take') + '">' +
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"/></svg>' +
    (armed ? '<span>Delete?</span>' : '') + '</button>';
}
function deleteTake(id) {
  var t = findTake(id);
  if (!canDelete(t)) return;
  var layers = t.roleId === 'part' ? S.members.concat(S.applicants).filter(function (m) { return m.sec === id; }).length : 0;
  stopAll();
  S.build.picks = S.build.picks.filter(function (p) { return p !== id; });
  db.deleteTake(t.dbId).then(function () {
    flash('Deleted ' + (t.by || 'the take') + '\'s ' + role(t.roleId).label.toLowerCase() +
      (layers ? ', and the ' + layers + ' take' + (layers > 1 ? 's' : '') + ' on it' : '') + '.');
    return refresh();
  }).catch(oops);
}
/* the creator sets fades and crossfades; everyone hears them */
function saveFades(t) {
  if (!t || !t.dbId || !isHost()) return;
  t.fadeBusy = true;
  db.setFades(t.dbId, { fadeIn:t.fin || 0, fadeOut:t.fout || 0, xfade:t.xfade || 0 })
    .catch(oops)
    .then(function () { t.fadeBusy = false; return refresh(); });
}

/* ---------- original track + session sheet ---------- */
var KEYS = (function () { var o = []; PCS.forEach(function (p) { o.push(p + ' maj'); o.push(p + ' min'); }); return o; })();
var TIMES = ['4/4','3/4','6/8','5/4','7/8','12/8','odd'];
var I_DL = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 1v9M4.5 6.5 8 10l3.5-3.5M2 13h12"/></svg>';
var I_PLAY  = '<svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><path d="M2 1l6 4-6 4z"/></svg>';
var I_PAUSE = '<svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><path d="M2 1h2.6v8H2zM5.4 1H8v8H5.4z"/></svg>';
var I_SEND = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></svg>';
var I_UP = '<svg class="db-ico" width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>';

var STEPS = {
  creator: {
    lead: 'Your clip, strangers’ instruments. Everything people play lands in the thread; you pick what becomes the song.',
    steps: [
      ['Drop your clip', 'It sets the tempo, key and length for everyone. Every take on top is exactly as long.'],
      ['Strangers play along', 'On your clip, on each other’s takes or on the song. Every take is a reply in the thread.'],
      ['You pick the takes', 'Press “Add to song” on any take in the thread. Until you do, the room’s suggestion plays: the stack with the most instruments.'],
      ['Release it when it’s ready', 'Shape the song here: fades, new parts, and the release. Every other take stays in the thread.']
    ]
  },
  musician: {
    lead: 'Someone dropped a clip and wants strangers to play on it. Play along on the song; the author decides what goes in.',
    steps: [
      ['Listen to the song', 'This is what the author picked so far, or the room’s suggestion when nothing is picked yet.'],
      ['Add your instruments', 'Record right here or upload up to four files, on the song or on any take you pick in the thread. They go out as one reply.'],
      ['Your take is a reply', 'It shows up in the thread with your comment, and it remembers exactly what you played on.'],
      ['The author decides', 'If it fits, the author adds it to the song. If not, it stays in the thread, and anyone can play on it.']
    ]
  }
};
function renderHow() {
  var s = STEPS[asCreator() ? 'creator' : 'musician'];
  el('intro-p').textContent = s.lead;
  el('howsum').innerHTML = '<b class="how-lbl">How it works</b>' + s.steps.map(function (x, i) {
    return '<span class="how-t"><i>' + (i + 1) + '</i>' + x[0] + '</span>';
  }).join('');
  el('howsteps').innerHTML = s.steps.map(function (x, i) {
    return '<div class="step"><span class="n">' + (i + 1) + '</span><b>' + x[0] + '</b><p>' + x[1] + '</p></div>';
  }).join('');
  document.body.classList.toggle('has-track', hasSeed());
  /* the steps are open on an empty session and on your first visit to one; after that they fold
     away (people can open and close them themselves) */
  var seen = false;
  try { seen = localStorage.getItem('stackato:seen-how') === '1'; } catch (e) {}
  var want = hasSeed() && !!S.session;
  if (S.howFor !== want) { S.howFor = want; el('howbox').open = !want || !seen; }
  if (want && !seen) { try { localStorage.setItem('stackato:seen-how', '1'); } catch (e) {} }
}
function renderInstruments() {
  var box = el('instruments');
  if (!hasSeed()) { box.innerHTML = ''; return; }
  var inSongNow = S.members.filter(onKeptSection), ri = seedInstr();
  var chips = ROLES.map(function (r) {
    var n = inSongNow.filter(function (m) { return m.roleId === r.id; }).length;
    return n ? '<span class="ichip" style="--c:' + col(r) + '">' + ico(r.icon, col(r)) + r.label + (n > 1 ? ' <b>&times;' + n + '</b>' : '') + '</span>' : '';
  }).join('');
  box.innerHTML = '<span class="i-lbl">Layers in the stack</span>' +
    '<span class="ichip">' + ico('seed', 'var(--seed)') + 'Original track' + (ri ? ' <b>' + ri.label.toLowerCase() + '</b>' : '') + '</span>' +
    (partTakes().length ? '<span class="ichip">' + ico('part', 'var(--part)') + 'New parts <b>&times;' + partTakes().length + '</b></span>' : '') +
    (chips || '<span class="tiny muted">Nothing on top yet.</span>');
}
/* ---------- recording the first track right on the session page ----------
   The same recorder musicians use: a count-in and a click at the tempo you pick, then it
   records until you stop. The result waits on the drop panel like a chosen file, so you
   still say what it is before the session starts. */
var SEED_TIMES = ['4/4','3/4','6/8','5/4','7/8','12/8'];
function openSeedRec() {
  if (!canDropSeed() || el('scrim').classList.contains('on')) return;
  lastFocus = document.activeElement;
  var panelRole = (el('seed-role') && el('seed-role').value) || '';
  el('sr-as').innerHTML = postingAs();
  el('sr-role').innerHTML = '<option value=""' + (panelRole ? '' : ' selected') + ' disabled>Pick one</option>' +
    '<option value="none"' + (panelRole === 'none' ? ' selected' : '') + '>Not one instrument</option>' +
    ROLES.map(function (r) { return '<option value="' + r.id + '"' + (r.id === panelRole ? ' selected' : '') + '>' + r.label + '</option>'; }).join('');
  el('sr-bpm').value = S.seedBpm || 100;
  el('sr-time').innerHTML = SEED_TIMES.map(function (t) { return '<option' + (t === (S.seedTime || '4/4') ? ' selected' : '') + '>' + t + '</option>'; }).join('');
  el('sr-countin').innerHTML = countInOptions();
  el('sr-click').checked = REC.click !== false;
  el('sr-mic').innerHTML = micOptions();
  refreshMics();
  el('sr-err').classList.remove('on');
  recReset(); REC.where = 'seed'; REC.hear = {}; if (REC.click === undefined) REC.click = true;
  renderSeedPop();
  el('sr-scrim').classList.add('on');
  el('sr-role').focus();
}
function closeSeedRec() {
  if (REC.state === 'recording' || REC.state === 'asking') recCancel();
  recStopPlayers();
  recReset(); REC.where = null; S.seedRecMeta = null;
  el('sr-scrim').classList.remove('on');
  if (lastFocus) lastFocus.focus();
}
function seedRecStart() {
  var bpm = Math.max(40, Math.min(240, parseInt(el('sr-bpm').value, 10) || 100));
  var sig = el('sr-time').value || '4/4';
  S.seedBpm = bpm; S.seedTime = sig;
  S.meta.bpm = bpm; S.meta.time = sig;
  M.mode = 'extend'; M.sec = 'core';          /* open length, nothing underneath */
  el('sr-err').classList.remove('on');
  recReset(); REC.where = 'seed'; REC.hear = {}; REC.click = el('sr-click').checked;
  recStart();
}
/* start the session with the recording, once the instrument is in (and you have an account) */
function seedRecUse() {
  if (!REC.buf || !REC.file) return;
  var rl = el('sr-role').value;
  if (!rl) { el('sr-err').textContent = 'Say what the track is: pick an instrument, or "Not one instrument".'; el('sr-err').classList.add('on'); el('sr-role').focus(); return; }
  if (!me) { need('start').then(function () { el('sr-as').innerHTML = postingAs(); seedRecUse(); }); return; }
  /* the drop panel holds the instrument the upload reads */
  if (el('seed-role')) el('seed-role').value = rl;
  var file = REC.file, meta = S.seedRecMeta;
  el('sr-scrim').classList.remove('on');
  recStopPlayers();
  S.seedRecMeta = meta;
  loadSeed(file, true);
}
function renderSeedPop() {
  var box = el('sr-rec');
  if (!box) return;
  var st = REC.where === 'seed' ? REC.state : 'idle';
  var err = REC.err ? '<p class="rec-err">' + esc(REC.err) + '</p>' : '';
  if (st === 'recording' || st === 'asking') {
    box.className = 'seed-rec live';
    box.innerHTML = '<div class="rec-status" id="rec-status">' + (st === 'asking' ? 'Waiting for the microphone...' : '') + '</div>' +
      '<canvas id="seed-canvas"></canvas>' +
      '<div class="rec-meterwrap"><i id="rec-meter"></i></div>' +
      '<div class="rec-acts"><button class="btn btn-main" type="button" data-rec="finish">Stop recording</button>' +
      '<button class="btn btn-sm" type="button" data-rec="cancel">Throw away</button></div>';
  } else if (st === 'done') {
    box.className = 'seed-rec done';
    box.innerHTML = '<b>Recorded ' + clockMs(REC.buf.duration) + ' at ' + S.seedBpm + ' bpm, ' + esc(S.seedTime) + '</b>' +
      '<canvas id="seed-canvas"></canvas>' +
      '<div class="rec-acts"><button class="btn btn-sm" type="button" data-rec="listen">' + I_PLAY + ' Hear it</button>' +
      '<button class="btn btn-sm" type="button" data-seedrec="1">Record again</button></div>' +
      (REC.info && REC.state === 'done' ? '<p class="rec-info">' + esc(REC.info) + '</p>' : '') + (REC.warn ? '<p class="rec-warn">' + esc(REC.warn) + '</p>' : '') + err;
  } else {
    box.className = 'seed-rec';
    box.innerHTML = '<button class="btn btn-main rec-go" type="button" data-seedrec="1"><span class="rec-dot"></span> Start recording</button>' +
      '<span class="tiny muted">Wear headphones, so the click stays out of your recording.</span>' + err;
  }
  el('sr-start').disabled = st !== 'done';
  [].forEach.call(document.querySelectorAll('#sr-scrim .sr-set input, #sr-scrim .sr-set select'), function (f) { f.disabled = st === 'recording' || st === 'asking'; });
  drawSeedRec();
}
/* the first track as it comes in, on a timeline that grows with it */
function drawSeedRec() {
  var c = el('seed-canvas');
  if (!c) return;
  var dpr = window.devicePixelRatio || 1, w = c.clientWidth || 500, h = c.clientHeight || 64;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  var g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = cvar('--sound');
  var mid = h / 2;
  if (REC.state === 'recording' && REC.chunks) {
    var a = ac(), now = Math.max(0, a.currentTime - REC.songStart), total = Math.max(8 * barSeconds(), now + 1);
    REC.chunks.forEach(function (ch) {
      var sub = ch.dur / ch.pks.length;
      ch.pks.forEach(function (pk, q) {
        var at = ch.t - REC.songStart - REC.lat + q * sub;
        if (at + sub < 0) return;
        var x0 = Math.max(0, at) / total * w, bar = Math.max(1, Math.min(1, pk) * (h - 6));
        g.fillRect(x0, mid - bar / 2, Math.max(1, sub / total * w + .5), bar);
      });
    });
    g.fillStyle = cvar('--live'); g.fillRect(now / total * w, 0, 2, h);
  } else if (REC.state === 'done' && REC.buf) {
    var pk2 = REC.peaks || (REC.peaks = peaksOf(REC.buf, 1200)), n = pk2.length;
    for (var x = 0; x < w; x++) {
      var b2 = Math.max(1, (pk2[Math.floor(x / w * n)] || 0) * (h - 6));
      g.fillRect(x, mid - b2 / 2, 1, b2);
    }
  }
}
function canDropSeed() { return asCreator() && isOpen() && !S.seedBusy; }
/* the project's name: what the creator called it, or "<name>'s track" until they do */
function projName() {
  if (S.title && S.title !== 'Untitled') return S.title;
  return S.seed.by ? S.seed.by + '’s track' : 'Untitled';
}
/* the creator names (and renames) the project here; everyone else sees the name */
function renderProjTitle() {
  var box = el('projtitle');
  if (!box) return;
  box.style.display = hasSeed() && S.session ? '' : 'none';
  if (!hasSeed() || !S.session) { box.innerHTML = ''; return; }
  if (isHost()) {
    if (!el('proj-title')) {
      box.innerHTML = '<label class="pt-lbl" for="proj-title">Song name</label>' +
        '<input class="projname" id="proj-title" maxlength="120" autocomplete="off" placeholder="Name your song" aria-describedby="proj-hint">' +
        '<span class="tiny muted" id="proj-hint">Click to rename. Everyone sees the new name right away.</span>';
    }
    var f = el('proj-title');
    if (document.activeElement !== f) f.value = S.title && S.title !== 'Untitled' ? S.title : '';
    f.placeholder = 'Name your song, e.g. ' + projName();
  } else {
    box.innerHTML = '<div class="pt-lbl">Song</div><h2 class="projname">' + esc(projName()) + '</h2>';
  }
}
/* the big invitation to make your own version: most people start by playing with the takes */
function renderOwnCta() {
  var box = el('owncta');
  if (!box) return;
  box.style.display = hasSeed() && S.session ? '' : 'none';
  if (!hasSeed() || !S.session) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="oc-copy"><div class="kicker">Got an idea of your own?</div>' +
      '<h2>Start your own song</h2>' +
      '<p>Drop a riff, a groove or a vocal line, or record one right here. Strangers stack their instruments on top, and you decide what becomes the song.</p></div>' +
    '<div class="oc-acts">' +
      '<button class="btn btn-main btn-lg" type="button" data-newsong="1">Start your own song</button>' +
    '</div>';
}
/* every take you can build with, inside the "make your own version" block: the ones the
   song uses and the ones it doesn't (vetoed, or taken out by the creator) */
function ocTake(t, extra) {
  var r = role(t.roleId), core = secOf(t) === 'core', key = core ? 'pair:' + t.id : t.id, on = only === key;
  return '<li class="oc-take">' +
    '<button class="play sm' + (on ? ' on' : '') + '" type="button" ' + (core ? 'data-pair' : 'data-prev') + '="' + t.id + '" aria-label="Hear the take by ' + esc(t.by) +
      (core ? ' with the original track' : '') + '"' + (t.buf && S.seed.buf ? '' : ' disabled') + '>' + (on ? I_PAUSE : I_PLAY) + '</button>' +
    ico(r.icon, col(r)) +
    '<div class="oc-who"><b>' + nameOf(t.by, t.authorId) + '</b><span>' + esc(r.label) + (extra ? ', ' + extra : '') + ' ' + secTag(t) + verTag(t.id) + '</span></div>' +
    menuBtn('o:' + t.id,
      (core ? mi('data-prev="' + t.id + '"', only === t.id ? 'Stop' : 'Play on its own') : '') +
      mi('data-dl="' + t.id + '"', 'Download') + (extra ? miDel(t.id) : '')) + '</li>';
}
/* the takes stay folded away until you open one of the two lists */
function ocTakes() {
  var used = S.members.filter(onKeptSection), unused = S.archive.slice().reverse();
  S.ocOpen = S.ocOpen || {};
  function col(key, title, sub, items, empty, id) {
    var open = !!S.ocOpen[key];
    return '<div class="oc-col' + (open ? ' open' : '') + '"' + (id ? ' id="' + id + '"' : '') + '>' +
      '<button class="oc-h" type="button" data-ocopen="' + key + '" aria-expanded="' + open + '">' +
        '<b>' + title + '</b><span class="count">' + items.length + '</span><span class="oc-chev" aria-hidden="true">&#9662;</span></button>' +
      '<p class="oc-sub">' + sub + '</p>' +
      (open ? (items.length ? '<ul>' + items.join('') + '</ul>' : '<p class="oc-empty">' + empty + '</p>') : '') + '</div>';
  }
  return '<div class="oc-takes">' +
    col('used', 'Used takes', 'In the song right now. Play shows how each one sounds with the original track.',
      used.map(function (t) { return ocTake(t, ''); }), 'No takes in the song yet.') +
    col('unused', 'Unused takes', 'Nothing gets wasted. Use them in your own version.',
      unused.map(function (a) { return ocTake(a.take, a.why); }), 'Every take made it into the song so far.', 'archive-head') +
    '</div>';
}
/* the breadcrumbs back to this jam's thread on the homepage; "back" opens the take whose stack is open */
function renderCrumbs() {
  var nav = el('crumbs'); if (!nav) return;
  nav.hidden = !(S.session && hasSeed());
  if (nav.hidden) return;
  var href = '/?open=' + encodeURIComponent(S.session.id), tk = S.stack && TAKES[S.stack];
  el('crumb-jam').textContent = S.seed.by ? (isHost() ? 'Your jam' : S.seed.by + '’s jam') : 'The jam';
  el('crumb-jam').title = 'Back to the thread of ' + projName();
  el('crumb-jam').href = href + (tk && tk.dbId && tk.roleId !== 'seed' ? '&tid=' + encodeURIComponent(tk.dbId) : '');
}
function renderSeed() {
  var s = S.seed, host = isHost(), loading = loadingCount(), ri = seedInstr();
  renderCrumbs();
  el('session-info').hidden = !el('crumbs').hidden;
  el('creator-badge').hidden = !(S.session && host);
  el('songtop').classList.toggle('empty', !hasSeed());
  el('session-name').textContent = S.session ? projName() : 'New session';
  el('session-sub').textContent = (hasSeed() ? 'track loaded, ' + fmt(s.len) : 'no track yet') +
    (loading ? ', loading ' + loading + ' take(s)' : '') + (S.session && !isOpen() ? ', released' : '');
  el('seedpanel').className = 'seed' + (hasSeed() ? '' : ' empty');
  el('metabar').style.display = hasSeed() && host && isOpen() && S.metaOpen ? '' : 'none';
  el('metabar').classList.toggle('readonly', !host);

  if (hasSeed()) {
    el('seedpanel').innerHTML =
      '<div class="seed-head"><span class="kicker">The original track' + (ri ? ' · ' + ri.label.toLowerCase() : '') + '</span>' +
        '<span class="tiny muted">by ' + (host ? 'you' : nameOf(s.by, S.session && S.session.host_id)) + (s.buf ? '' : ', loading') + '</span></div>' +
      '<div class="seed-well"><button class="play' + (only === 'seed' ? ' on' : '') + '" type="button" data-prev="seed" aria-label="Play the original track"' + (s.buf ? '' : ' disabled') + '>' +
        (only === 'seed' ? I_PAUSE : I_PLAY) + '</button>' + seedWave() + '</div>';
  } else if (asCreator()) {
    el('seedpanel').innerHTML = '<div class="dropbig">' + I_UP +
      '<h2>Drop an audio track</h2>' +
      '<p>A riff, a groove or a vocal. Drag it in, and other musicians add their takes on top until the stack sounds right to you. ' +
      'You get a link to share.</p>' +
      '<div class="db-fields">' +
        '<label class="field seed-name"><span>What is it</span><select id="seed-role">' +
          '<option value="" selected disabled>Pick one</option><option value="none">Not one instrument</option>' +
          ROLES.map(function (r) { return '<option value="' + r.id + '">' + r.label + '</option>'; }).join('') + '</select></label>' +
      '</div>' +
      (S.pendingSeed && !S.seedBusy
        ? '<div class="db-pending"><span class="tiny"><b>' + esc(S.pendingSeed.name) + '</b> is ready. Say what it is, then start.</span>' +
          (S.seedErr ? '<p class="db-err" role="alert">' + esc(S.seedErr) + '</p>' : '') +
          '<button class="btn btn-main" type="button" data-seedgo="1">Start the session with this track</button>' +
          '<button class="btn btn-sm" type="button" data-attach="seed">Choose another file</button></div>'
        : '<div class="db-acts"><button class="btn btn-main" type="button" data-attach="seed"' + (S.seedBusy ? ' disabled' : '') + '>' +
            (S.seedBusy ? 'Uploading...' : 'Choose a file') + '</button>' +
            (S.seedBusy ? '' : '<button class="btn db-rec" type="button" data-seedpop="1"><span class="rec-dot"></span> Record right here</button>') + '</div>' +
          '<span class="tiny muted">wav, mp3 or m4a, or record it with a click</span>') +
    '</div>';
  } else {
    el('seedpanel').innerHTML = '<div class="dropbig wait">' + I_UP +
      '<h2>Waiting for the track</h2>' +
      '<p>The creator has not dropped a track yet. This page updates by itself when they do.</p></div>';
  }

  if (hasSeed()) {
    var m = S.meta;
    var bars = s.len && m.bpm ? Math.max(1, Math.round(s.len / barSeconds())) : 0;
    el('facts').innerHTML =
      '<div class="stat"><b>' + (m.bpm || '?') + '</b><small>bpm</small></div>' +
      '<div class="stat"><b>' + esc(m.key || '?') + '</b><small>key</small></div>' +
      '<div class="stat"><b>' + esc(m.time) + '</b><small>time</small></div>' +
      '<div class="stat"><b>' + fmt(s.len) + '</b><small>' + (bars ? bars + (bars > 1 ? ' bars' : ' bar') : 'length') + '</small></div>' +
      (host && isOpen() ? '<button class="btn btn-sm' + (S.metaOpen ? ' on' : '') + '" type="button" data-metaedit="1" aria-expanded="' + !!S.metaOpen + '">' +
        (S.metaOpen ? 'Done' : 'Edit') + '</button>' : '');
  } else {
    el('facts').innerHTML = '';
    bindViz(); drawViz(running || Object.keys(sources).length > 0);
  }

  var note;
  if (!hasSeed()) note = 'Drop a track and the tempo and key get read from the audio.';
  else if (S.meta.busy) note = 'Listening to your file, one moment.';
  else if (!host) note = 'Set by the creator. Play to this tempo and key.';
  else if (S.meta.from === 'detected') note = 'Read from your audio, ' + (S.meta.sure || 'not certain') + '.' +
    (S.meta.alt ? ' Could also be ' + S.meta.alt + '.' : '') + ' Time signature is your call.';
  else note = 'Set by you.';

  var off = host ? '' : ' disabled';
  el('metabar').innerHTML = hasSeed()
    ? '<label class="mini"><span>bpm</span><input type="number" id="meta-bpm" min="40" max="240" value="' + (S.meta.bpm || '') + '"' + off + '></label>' +
      '<label class="mini"><span>key</span><select id="meta-key"' + off + '>' +
        KEYS.map(function (k) { return '<option' + (k === S.meta.key ? ' selected' : '') + '>' + k + '</option>'; }).join('') +
      '</select></label>' +
      '<label class="mini"><span>time</span><select id="meta-time"' + off + '>' +
        TIMES.map(function (t) { return '<option' + (t === S.meta.time ? ' selected' : '') + '>' + t + '</option>'; }).join('') +
      '</select></label>' +
      '<label class="mini"><span>track is</span><select id="meta-seedrole"' + (host && isOpen() ? '' : ' disabled') + '>' + seedRoleOptions(S.meta.seedRole, 'not one instrument') + '</select></label>' +
      '<span class="tiny muted">' + note + '</span>' +
      (host && isOpen() ? '<button class="btn btn-sm meta-replace" type="button" data-attach="seed"' + (S.seedBusy ? ' disabled' : '') + '>' +
        (S.seedBusy ? 'Uploading...' : 'Replace the track') + '</button>' : '')
    : '<span class="tiny muted">' + note + '</span>';
  drawSeedWave();
}

/* ---------- the DAW view ---------- */
function barSeconds() {
  var bpm = S.meta.bpm || 120, t = S.meta.time === 'odd' ? '4/4' : S.meta.time;
  var p = t.split('/'), beats = +p[0] || 4, unit = +p[1] || 4;
  return beats * (60 / bpm) * (4 / unit);
}
/* the two ways to look at the song, as a big switch on top of the DAW */
function dawTabs() {
  var building = S.view === 'build' && !S.override, main = !building && !S.override;
  return '<div class="dawtabs modes" role="tablist" aria-label="What plays">' +
    '<button type="button" role="tab" data-view="lineup" aria-selected="' + main + '">' +
      '<span class="m-ico">' + I_PLAY + '</span><span class="m-txt"><b>The song so far</b><small>the takes the creator chose</small></span></button>' +
    '<button type="button" role="tab" class="mode-own" data-view="build" aria-selected="' + building + '">' +
      '<span class="m-ico">+</span><span class="m-txt"><b>Your version</b><small>any take, plus your own takes</small></span></button>' +
    '</div>';
}
/* the amp and filter knobs show when you ask for them, or when one is already doing something */
function fxOpen(t) {
  return !!(S.fxOpen && S.fxOpen[t.id]) || !!ampOf(t) || cutOf(t, 'hp') > F_MIN || cutOf(t, 'lp') < F_MAX;
}
/* Who can change a take's amp here: anyone in a version (it is saved with the version); on the
   song the creator, or the take's author while it waits for the creator or is their own. */
function canAmp(t) {
  if (mixCtx() || t.status === 'draft') return true;
  if (isHost() && isOpen()) return true;
  return !!(me && t.authorId === me.id && (t.status === 'waiting' || t.status === 'own'));
}
function ampChips(t) {
  var cur = ampOf(t), ok = canAmp(t);
  var why = ok ? '' : ' disabled title="Only the creator can change the amp on the song. Try other amps in your version."';
  return '<div class="t-amp" role="group" aria-label="Amp for ' + esc(t.by || 'you') + '"><span class="kn-l"><b>Amp</b></span>' +
    [{ id:'', label:'Off', long:'Off: the take as it was recorded' }].concat(AMPS).map(function (a) {
      return '<button class="ampchip' + (a.id === cur ? ' on' : '') + '" type="button" data-amp="' + a.id + '" data-take="' + t.id + '"' +
        ' aria-pressed="' + (a.id === cur) + '"' + (ok ? ' title="' + esc(a.long) + '"' : why) + '>' + a.label + '</button>';
    }).join('') + '</div>';
}
function setAmp(t, id) {
  if (!t || !canAmp(t) || ampOf(t) === id) return;
  if (mixCtx()) {
    ctl(t).amp = id;
    if (S.view === 'build' && !S.override) S.buildDirty = true;
  } else {
    t.amp = id;
    if (t.status !== 'draft') {
      t.ampSaving = true;
      db.setAmp(t.dbId, id || null).then(function () {
        t.ampSaving = false;
        flash(id ? (t.by || 'This take') + ' plays through the ' + ampLabel(id).toLowerCase() + ' amp now, for everyone.' : 'The amp is off, everyone hears the take as it was recorded.');
        return refresh();
      }).catch(function (e) { t.ampSaving = false; oops(needsUpdate(e, '20261012090000_take_amps.sql') || e); refresh(); });
    }
  }
  refreshGains(); render();
}
function renderDaw() {
  var list = tracks(), d = duration(), own = S.view === 'build' && !S.override;
  el('daw').classList.toggle('own', own);
  if (el('mix-title')) {
    var cs0 = currentStack();
    el('mix-title').textContent = cs0 && cs0.partial ? cs0.name : 'The song so far';
    el('mix-kicker').textContent = cs0 && cs0.partial ? 'From the thread' : cs0 && !cs0.creation ? 'Suggested by the room' : 'Author’s creation';
  }
  /* the stack's instrument chips belong to the stack, not to your version */
  el('instruments').style.display = 'none';  /* the chips repeated the tracks right below them */
  if (own && el('lineup-sub')) el('lineup-sub').textContent = 'Pick takes in the columns below. Nothing changes for anyone else until you make it the Author’s creation.';
  var banner = '';
  if (S.override) {
    banner = '<div class="listening"><span>Listening to <b>' + esc(S.override.name) + '</b> by ' + esc(S.override.by) + '</span>' +
      '<button class="btn btn-sm" type="button" data-fork="' + S.override.id + '">Build on this one</button>' +
      '<button class="btn btn-sm" type="button" data-view="lineup">Back to the stack</button></div>';
  } else if (S.view === 'build' && isHost()) {
    banner = '<div class="listening build"><span><b>Compose the song.</b> Pick takes from every branch of the thread. ' +
      'Make it the Author’s creation and it plays first, for everyone. It shows up in the thread too.</span>' +
      '<button class="btn btn-sm btn-main" type="button" data-makecreation="build"' + (S.build.picks.length ? '' : ' disabled') + '>Make this the Author’s creation</button></div>';
  } else if (S.view === 'build') {
    var mineOwn = S.own.filter(mine).length;
    banner = '<div class="listening build"><span><b>Create your own stack.</b> Pick takes from every branch of the thread, name it and save it. ' +
      'It shows up with the stacks and in the thread, and anyone can play on it.</span></div>';
  }
  if (!S.override && S.view !== 'build' && S.stack === '__seed') {
    banner = '<div class="listening build"><span>You hear <b>' + esc((S.seed.by ? S.seed.by + '’s original track' : 'The original track')) + '</b> on its own, the way it was first posted. ' +
      'Record or upload below to start a new branch from scratch, with whatever instruments you like.</span></div>';
  } else if (!S.override && S.view !== 'build' && S.stack && currentStack() && currentStack().partial) {
    var cp = currentStack(), lt = cp.last, grp = groupOf(lt), picked = grp.every(function (g) { return S.members.indexOf(g) > -1; });
    banner = '<div class="listening build"><span>You hear <b>' + esc(cp.name) + '</b> with everything it was played on. ' +
      'Record below to play on this. Mute a track to leave it out of what you play on.</span>' +
      (isHost() && isOpen() && !picked ? '<button class="btn btn-sm btn-main" type="button" data-yesg="' + lt.dbId + '">Add to song</button>' : '') +
      (picked ? '<span class="tp-in">In the song</span>' : '') + '</div>';
  } else if (!S.override && S.view !== 'build') {
    var cs = currentStack(), ups = onCreation();
    if (cs && isHost() && isOpen() && !cs.creation)
      banner = '<div class="listening"><span><b>Nothing picked yet.</b> This is the room’s suggestion: the stack from the thread with the most instruments. ' +
        'Use it as the song, or pick takes with “Add to song” in the thread.</span>' +
        '<button class="btn btn-sm btn-main" type="button" data-makecreation="' + cs.id + '">Use this as the song</button></div>';
    else if (cs && cs.creation && isHost() && isOpen() && ups.length)
      banner = '<div class="listening"><span><b>' + ups.map(function (t) { return esc(t.by) + '’s ' + esc(role(t.roleId).label.toLowerCase()); }).join(', ') +
        '</b> ' + (ups.length > 1 ? 'were' : 'was') + ' played on the song. It stays out until you add it.</span>' +
        ups.map(function (t) { return '<button class="btn btn-sm" type="button" data-try="' + t.id + '">Hear it with the song</button><button class="btn btn-sm btn-main" type="button" data-yes="' + t.id + '">Add to song</button>'; }).join('') + '</div>';
    else if (cs && cs.largest && !isHost())
      banner = '<div class="listening build"><span><b>The author hasn’t picked takes yet.</b> Until then you hear the room’s suggestion: the stack from the thread with the most instruments.</span></div>';
  }
  if (!list.length) {
    el('daw').innerHTML = stacksBar() + banner + '<div class="empty-state"><b>' + (hasSeed() ? 'Loading audio' : 'No audio yet') + '</b>' +
      '<p class="tiny muted">' + (hasSeed() ? 'The takes are coming down from storage.' : 'Drop an audio track, then add takes to the stack. They stack up here like tracks in a DAW.') + '</p></div>';
    renderPicker();
    renderPitches();
    return;
  }
  var bs = barSeconds(), barCount = Math.max(1, Math.ceil(d / bs));
  var ticks = '';
  for (var i = 0; i < barCount; i++) {
    ticks += '<span class="tick' + (i % 4 === 0 ? ' major' : '') + '" style="left:' + (i * bs / d * 100) + '%">' +
      (i % 4 === 0 || barCount < 17 ? (i + 1) : '') + '</span>';
  }

  var building = S.view === 'build' && !S.override, host = isHost();
  var lineupView = !S.override && !building, curSt = lineupView ? currentStack() : null, boss = lineupView && host && isOpen() && !!(curSt && curSt.creation);
  var rows = list.map(function (t) {
    var r = role(t.roleId), c = ctl(t), v = volOf(t);
    var isTrial = lineupView && S.trial === t.id;
    var isPart = t.roleId === 'part', isPitch = isPart && S.pitches.indexOf(t) > -1;
    var status = '';
    if (isPart) status = isPitch ? 'pitch, ' + t.pos : t.pos;
    else if (!lineupView) {
      if (t.id !== 'seed' && S.members.indexOf(t) < 0) status = isOwn(t) ? 'own' : standing(t);
    }
    return '<div class="track' + (c.mute ? ' muted-t' : '') + (c.solo ? ' solo-t' : '') + (isTrial || isPitch ? ' trial' : '') + (isPart ? ' part' : '') + '">' +
      '<div class="t-head">' +
        '<div class="t-name">' + ico(r.icon, col(r)) +
          '<div><b>' + esc(t.by || 'you') + (isTrial ? ' <span class="trybadge">trying out</span>' : '') +
          (status ? ' <span class="stag">' + status + '</span>' : '') + '</b>' +
          '<span class="tiny muted">' + esc(labelOf(t)) + (ampOf(t) ? ' <span class="amptag' + (ampBusy(t) ? ' busy' : '') + '"' + (ampBusy(t) ? ' title="Putting the take through its amp. It plays as soon as that is done."' : '') + '>' + ampLabel(ampOf(t)).toLowerCase() + ' amp' + (ampBusy(t) ? ', loading' : '') + '</span>' : '') + (t.id !== 'seed' ? ' ' + secTag(t) + verTag(t.id) : '') + '</span></div>' +
        '</div>' +
        (isPitch && boss ? '<div class="t-try">' +
          '<button class="btn btn-sm btn-main" type="button" data-accpitch="' + t.id + '">Keep it</button>' +
          '<button class="btn btn-sm" type="button" data-untrialpitch="1">Take it out</button></div>' : '') +
        (isTrial ? '<div class="t-try">' +
          (host && isOpen() && !seedHolds(t.roleId, secOf(t)) ? '<button class="btn btn-sm btn-main" type="button" data-yes="' + t.id + '">Add to song</button>' : '') +
          '<button class="btn btn-sm" type="button" data-untrial="1">Take it out</button></div>' : '') +
        '<div class="t-ctrl">' +
          '<button class="tbtn' + (c.mute ? ' on' : '') + '" type="button" data-mute="' + t.id + '" aria-pressed="' + !!c.mute + '" title="Mute">M</button>' +
          '<button class="tbtn' + (c.solo ? ' on solo' : '') + '" type="button" data-solo="' + t.id + '" aria-pressed="' + !!c.solo + '" title="Solo">S</button>' +
          '<input type="range" min="0" max="1" step="0.02" value="' + v + '" data-vol="' + t.id + '" aria-label="Volume for ' + esc(t.by) + '">' +
          '<button class="tbtn eq' + (fxOpen(t) ? ' on' : '') + '" type="button" data-fx="' + t.id + '" aria-pressed="' + fxOpen(t) + '" title="Amp, low cut and high cut">FX</button>' +
          (t.status === 'draft' ? menuBtn('t:' + t.id, mi('data-prev="' + t.id + '"', only === t.id ? 'Stop' : 'Play on its own') + mi('data-draftdel="' + t.id + '"', 'Remove from your draft')) :
          menuBtn('t:' + t.id,
            mi('data-prev="' + t.id + '"', only === t.id ? 'Stop' : 'Play on its own') +
            mi('data-dl="' + t.id + '"', 'Download') +
            (building && t.id !== 'seed' && !isPart ? mi('data-pick="' + t.id + '"', 'Remove from your version') : '') +
            (boss && isPart && !isPitch ? mi('data-droppart="' + t.id + '"', 'Take this part out of the song') : '') +
            (boss && !isPart && t.id !== 'seed' && S.members.indexOf(t) > -1 ? mi('data-takeout="' + t.id + '"', 'Take out of the song') : '') +
            (t.id !== 'seed' && (lineupView ? boss : isOwn(t)) ? miDel(t.id) : ''))) +
        '</div>' +
        (fxOpen(t) ? '<div class="t-fx">' + ampChips(t) + knob(t, 'hp') + knob(t, 'lp') + '</div>' : '') +
        (boss && isPart ? '<label class="xf"><span>crossfade</span>' +
          '<input type="range" min="0" max="' + xfMax(t).toFixed(1) + '" step="0.1" value="' + xf(t) + '" data-xfade="' + t.id + '" aria-label="Crossfade for the part by ' + esc(t.by) + '">' +
          '<em>' + xf(t).toFixed(1) + ' s</em></label>' : '') +
      '</div>' +
      '<div class="t-lane" data-seek="1">' +
        '<canvas data-wave="' + t.id + '" height="72"></canvas>' +
        (boss ? '<span class="fh fh-in" data-fh="in" data-id="' + t.id + '" title="Drag to fade in" role="slider" aria-label="Fade in"></span>' +
                '<span class="fh fh-out" data-fh="out" data-id="' + t.id + '" title="Drag to fade out" role="slider" aria-label="Fade out"></span>' : '') +
        (t.id !== 'seed' && !isPart && t.len < secLen(secOf(t)) - .05 ? '<span class="short">shorter than its section</span>' : '') +
        (t.id === 'seed' && lineupView && S.session && isOpen() ? extendButtons() : '') +
      '</div></div>';
  }).join('');

  el('daw').innerHTML = stacksBar() + banner +
    '<div class="daw-bar">' +
      '<button class="btn btn-sound" type="button" id="transport">' + (running ? I_PAUSE + ' Stop' : I_PLAY + ' Play') + '</button>' +
      (building && !isHost() ? '<button class="btn btn-ink" type="button" id="ver-save-top"' + (S.build.picks.length && S.session ? '' : ' disabled') + '>Save your stack</button>' +
        (S.buildDirty && S.build.picks.length ? '<span class="unsaved">not saved yet</span>' : '') : '') +
      '<button class="btn btn-sm" type="button" id="rewind" title="Back to the start">&#9198;</button>' +
      '<span class="readout" id="readout">' + clockMs(position()) + ' / ' + clockMs(d) + '</span>' +
      (building ? '' : '<span class="tiny muted">' + list.length + ' track(s), ' + barCount + ' bars at ' + (S.meta.bpm || '?') + ' bpm ' + S.meta.time + '</span>') +
      '<span class="clickctl">' + menuBtn('tools',
        '<label class="mi-field"><span>Count-in</span><select data-countin="1">' + countInOptions() + '</select></label>' +
        '<button class="mi" type="button" id="dl-click">' + I_DL + ' Click track <small>at the session tempo, with the count-in</small></button>' +
        '<button class="mi" type="button" id="dl-all">' + I_DL + ' Download these takes <small>every track, plus a session sheet</small></button>',
        'Play along &#9662;', 'btn btn-sm') + '</span>' +
    '</div>' +
    '<div class="ruler"><span class="r-head"></span><span class="r-lane">' + ticks + '</span></div>' +
    cmRow() +
    '<div class="tracks">' + rows + moreRow(building) + addRow(building) + '</div>' + draftBar() +
    '<div class="playhead" id="playhead"></div>';

  list.forEach(function (t) { drawWave(t); });
  drawRecLane();
  placeFadeHandles();
  placeExtendButtons();
  renderPicker();
  renderPitches();
  tick();
}
/* ---------- comments on the timeline, SoundCloud style ----------
   A strip under the ruler with a dot per comment. Click the strip to comment on that moment
   (or "+ Comment here" for where the playhead is); hover or click a dot to read it. While the
   song plays, comments open up as the playhead passes them. at_sec counts from the start of
   the original track, so comments stay on the same music when parts are added before it. */
var I_CM = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12z"/></svg>';
/* who wrote it, in the song's terms */
function whoLabel(uid) {
  if (S.session && uid === S.session.host_id) return 'creator';
  var list = Object.keys(TAKES).map(function (k) { return TAKES[k]; })
    .filter(function (t) { return t.authorId === uid && live(t) && t.roleId !== 'seed' && t.roleId !== 'mix'; });
  function lbl(t) { return t.roleId === 'part' ? 'a new part' : role(t.roleId).label.toLowerCase(); }
  var inT = list.filter(function (t) { return t.status === 'in'; })[0];
  if (inT) return 'plays ' + lbl(inT);
  var w = list.filter(function (t) { return t.status !== 'own'; })[0];
  if (w) return 'sent ' + lbl(w);
  if (list.length || S.versions.some(function (v) { return v.authorId === uid; })) return 'made a version';
  return '';
}
function cmX(songSec) { var d = duration() || 1; return Math.max(0, Math.min(1, songSec / d)) * 100; }
/* a dot never hangs over the edge of the strip */
function cmLeft(x) { return 'left:clamp(12px,' + x.toFixed(2) + '%,calc(100% - 12px))'; }
function cmPos(x) { return 'left:' + x.toFixed(2) + '%;transform:translateX(-' + x.toFixed(2) + '%)'; }
function cmRow() {
  return '';  /* comments on the timeline are left out of this concept */
  if (!hasSeed() || !S.session || !S.cmAvailable || !duration()) return '';
  var s0 = startOf(S.seed), open = isOpen(), host = isHost();
  var marks = S.comments.map(function (c) {
    var t = s0 + c.at, x = cmX(t), who = whoLabel(c.authorId), on = S.cmOpen === c.id;
    return '<button type="button" class="cm-mark' + (on ? ' open' : '') + (who === 'creator' ? ' host' : '') + '" style="' + cmLeft(x) + '" ' +
        'data-cm="' + c.id + '" data-at="' + t.toFixed(3) + '" aria-label="Comment by ' + esc(c.by) + ' at ' + clockMs(c.at) + '">' + esc((c.by || '?').charAt(0).toUpperCase()) + '</button>' +
      '<div class="cm-pop' + (on ? ' open' : '') + '" style="' + cmPos(x) + '">' +
        '<div class="cm-meta"><b>' + nameOf(c.by, c.authorId) + '</b>' + (who ? '<span class="cm-who">' + esc(who) + '</span>' : '') + '<span class="cm-at">at ' + clockMs(Math.max(0, c.at)) + '</span></div>' +
        '<p>' + esc(c.body) + '</p>' +
        (on ? '<div class="cm-acts"><button class="btn btn-sm" type="button" data-cmplay="' + t.toFixed(3) + '">' + I_PLAY + ' Play from here</button>' +
          (host ? '<button class="btn btn-sm" type="button" data-cmhide="' + c.id + '">Hide</button>' : '') + '</div>' : '') +
      '</div>';
  }).join('');
  var draft = '';
  if (S.cmDraft && open) {
    var dx = cmX(s0 + S.cmDraft.at);
    draft = '<span class="cm-mark ghost" style="' + cmLeft(dx) + '" aria-hidden="true">+</span>' +
      '<div class="cm-pop cm-new open" style="' + cmPos(dx) + '">' +
        '<div class="cm-meta"><b>Comment at ' + clockMs(Math.max(0, S.cmDraft.at)) + '</b></div>' +
        '<textarea id="cm-body" maxlength="500" rows="2" placeholder="Say something about this moment"></textarea>' +
        (S.cmErr ? '<p class="cm-err">' + esc(S.cmErr) + '</p>' : '') +
        '<div class="cm-acts"><button class="btn btn-sm btn-main" type="button" data-cmpost="1">Post</button>' +
        '<button class="btn btn-sm" type="button" data-cmcancel="1">Cancel</button></div>' +
      '</div>';
  }
  var n = S.comments.length;
  return '<div class="track cmrow">' +
    '<div class="t-head"><div class="t-name"><span class="cm-ico">' + I_CM + '</span><div><b>Comments' + (n ? ' (' + n + ')' : '') + '</b>' +
      '<span class="tiny muted">' + (open ? 'click the strip to add one' : 'closed since the release') + '</span></div></div>' +
      '</div>' +
    '<div class="c-lane' + (open ? ' can' : '') + '" id="c-lane">' +
      (n || S.cmDraft ? '' : '<span class="cm-empty">' + (open ? 'No comments yet. Click anywhere on this strip to comment on that moment.' : 'No comments.') + '</span>') +
      marks + draft + '</div></div>';
}
function openComposer(songSec) {
  if (!isOpen() || !S.session) return;
  if (!me) { need('reply').then(function () { openComposer(songSec); }); return; }
  S.cmDraft = { at: songSec - startOf(S.seed) }; S.cmOpen = null; S.cmErr = '';
  render();
  var b = el('cm-body'); if (b) b.focus();
}
function postComment() {
  var body = ((el('cm-body') && el('cm-body').value) || '').trim();
  if (!body) { S.cmErr = 'Write something first.'; render(); if (el('cm-body')) el('cm-body').focus(); return; }
  if (!me) { need('reply').then(postComment); return; }
  var name = myName();
  var at = S.cmDraft.at;
  db.addComment({ session_id:S.session.id, author_id:me.id, author_name:name.slice(0, 60), body:body.slice(0, 500), at_sec:at })
    .then(function () {
      S.cmDraft = null; S.cmErr = '';
      if (el('cm-body')) el('cm-body').value = '';
      flash('Comment posted at ' + clockMs(Math.max(0, at)) + '.');
      return refresh();
    }).catch(function (err) { var nu = needsUpdate(err, '20261004140000_timeline_comments.sql'); S.cmErr = (nu || err).message || 'Could not post that. Try again.'; render(); });
}

/* an empty grey track under the others: record straight onto it (the playhead runs over the
   other tracks while you play), or upload a file. In the stack the take goes to the
   creator; in your own version it goes straight in. Not shown while listening to someone
   else's version. */
/* ---------- your draft: up to four tracks, posted as one reply ---------- */
var GUESS = [[/drum|kick|snare|hat|perc|beat/i,'drums'],[/bass/i,'bass'],[/voc|vox|sing|voice/i,'vocals'],[/lead|solo/i,'lead'],[/pad|key|synth|atmo|piano|organ/i,'atmos'],[/gtr|guit/i,'guitar']];
function guessRole(name) { for (var i = 0; i < GUESS.length; i++) if (GUESS[i][0].test(name || '')) return GUESS[i][1]; return S.recRole || ROLES[0].id; }
var DRAFT_N = 0;
function addDraft(file, buf, roleId) {
  S.drafts = S.drafts || [];
  if (S.drafts.length >= 4) { flash('A reply holds up to 4 instruments. Post this one first.'); return; }
  if (!S.drafts.length) { S.draftBase = (currentStack() || { takes:[] }).takes.filter(function (x) { return !x.mute; }); S.draftOn = currentStack() ? currentStack().name : 'the song'; }
  var t = { id:'draft-' + (++DRAFT_N), dbId:null, by:'Your draft', roleId:roleId, status:'draft', vol:1, mute:false, solo:false, votes:{}, fin:0, fout:0, xfade:0 };
  setBuffer(t, buf);
  S.drafts.push({ t:t, file:file });
  return t;
}
function draftBar() {
  var ds = S.drafts || [];
  if (!ds.length || S.override || S.view === 'build') return '';
  return '<div class="draftbar"><div class="db-head"><b>Your draft</b> · ' + ds.length + (ds.length > 1 ? ' tracks' : ' track') + ', played on ' + esc(S.draftOn || 'the song') +
      (S.draftBase && S.draftBase.length ? ' <span class="tiny muted">(' + S.draftBase.map(function (x) { return esc(x.by); }).join(', ') + ')</span>' : '') + '</div>' +
    '<div class="db-rows">' + ds.map(function (d) {
      return '<label class="db-row">' + ico(role(d.t.roleId).icon, col(role(d.t.roleId))) + '<select data-draftrole="' + d.t.id + '">' +
        ROLES.map(function (x) { return '<option value="' + x.id + '"' + (x.id === d.t.roleId ? ' selected' : '') + '>' + x.label + '</option>'; }).join('') + '</select>' +
        '<span class="tiny muted">' + esc(d.file.name) + ', ' + clockMs(d.t.len) + '</span><button class="ghost" type="button" data-draftdel="' + d.t.id + '">Remove</button></label>';
    }).join('') + '</div>' +
    '<div class="db-post"><label class="field"><span>Say something (optional)</span><input type="text" id="draft-note" maxlength="200" placeholder="what you were going for"></label>' +
      postingAs() +
      '<button class="btn btn-main" type="button" data-draftpost="1">Post my take →</button>' +
      '<button class="ghost" type="button" data-draftclear="1">Throw the draft away</button></div></div>';
}
function postDraft() {
  var ds = S.drafts || [], note = ((el('draft-note') && el('draft-note').value) || '').trim();
  if (!ds.length) return;
  if (!me) { need('play').then(function () { renderDaw(); postDraft(); }); return; }
  var name = myName();
  var gid = ds.length > 1 ? crypto.randomUUID() : null, on = (S.draftBase || []).map(function (x) { return x.dbId; }), first = null;
  stopAll(true);
  ds.reduce(function (pr, d, i) {
    return pr.then(function () {
      return uploadTake(d.file, d.t.buf, { role:d.t.roleId, status:'waiting', name:name, note:note, analyse:false, group:gid, on:on, amp:d.t.amp || '' }).then(function (res) { if (!first) first = res.row.id; });
    });
  }, Promise.resolve()).then(function () {
    S.drafts = []; S.draftBase = null;
    if (first) { S.sel = first; S.stack = first; }
    flash('Posted as one reply in the thread. The author decides if it goes in the song.');
    return refresh();
  }).catch(oops);
}
/* the author, on the song: every take from the thread that isn't in it yet, to add with one click */
function unusedTakes() {
  return threadTakes().filter(function (t) { return isLead(t) && t.status !== 'deleted' && groupOf(t).some(function (g) { return S.members.indexOf(g) < 0; }); })
    .sort(function (a, b) { return String(b.created).localeCompare(String(a.created)); });
}
function moreRow(building) {
  if (S.override || building || !isOpen() || !isHost() || S.stack) return '';
  var list = unusedTakes(); if (!list.length) return '';
  var open = !!S.moreOpen;
  var head = '<div class="t-head"><div class="t-name"><span class="add-ico" aria-hidden="true">+</span><div><b>Add another take</b>' +
    '<span class="tiny muted">' + list.length + ' unused in the thread</span></div></div></div>';
  var lane = '<div class="more-lane"><button class="btn btn-sm" type="button" data-moretoggle="1" aria-expanded="' + open + '">' +
    (open ? 'Hide the unused takes' : 'Show the unused takes (' + list.length + ')') + '</button>' +
    (open ? '<ul class="more-list">' + list.map(function (t) {
      var grp = groupOf(t), under = onOf(t), tr = grp.some(function (g) { return S.trial === g.id; });
      return '<li>' +
        (t.status === 'waiting' ? '<button class="play sm' + (tr ? ' on' : '') + '" type="button" data-try="' + t.id + '" aria-label="Hear it with the song" title="Hear it with the song">' + (tr ? I_PAUSE : I_PLAY) + '</button>' : '<span class="play-gap"></span>') +
        '<div class="more-who"><b>' + esc(t.by) + '</b> ' + grp.map(function (g) { var r = role(g.roleId); return '<span class="vchip">' + ico(r.icon, col(r)) + r.label.toLowerCase() + '</span>'; }).join('') +
          '<span class="tiny muted">on ' + (under.length ? under.map(function (u) { return esc(u.by) + '’s ' + role(u.roleId).label.toLowerCase(); }).join(', ') : 'the original track') + '</span>' +
          (t.note ? '<span class="tiny muted more-note">“' + esc(t.note) + '”</span>' : '') + '</div>' +
        '<div class="more-acts"><button class="btn btn-sm" type="button" data-alone="' + t.id + '" aria-pressed="' + (only === 'grp:' + t.id) + '">' + (only === 'grp:' + t.id ? I_PAUSE + ' Stop' : I_PLAY + ' On its own') + '</button>' +
        '<button class="btn btn-sm" type="button" data-yesg="' + t.dbId + '">Add to song</button></div></li>';
    }).join('') + '</ul>' : '') + '</div>';
  return '<div class="track morerow">' + head + lane + '</div>';
}
function addRow(building) {
  if (S.override || building || !isOpen()) return '';
  return '<div class="track addrow' + (REC.where === 'daw' && REC.state !== 'idle' ? ' rec-on' : '') + '" id="addrow">' + addRowInner(building) + '</div>';
}
function addRowInner(building) {
  var dawRec = REC.where === 'daw', st = dawRec ? REC.state : 'idle';
  var rid = S.recRole || ROLES[0].id, r = role(rid);
  var err = dawRec && REC.err ? '<span class="rec-err">' + esc(REC.err) + '</span>' : '';
  var head, lane;
  if (st === 'recording' || st === 'asking') {
    head = '<div class="t-name">' + ico(r.icon, col(r)) + '<div><b>Recording</b><span class="tiny muted">' + esc(r.label) + '</span></div></div>' +
      '<div class="rec-status" id="rec-status">' + (st === 'asking' ? 'Waiting for the microphone...' : '') + '</div>' +
      '<div class="rec-meterwrap"><i id="rec-meter"></i></div>';
    lane = '<canvas id="rec-canvas"></canvas><div class="rec-float">' +
      '<button class="btn btn-sm btn-main" type="button" data-rec="finish">Stop and keep it</button>' +
      '<button class="btn btn-sm" type="button" data-rec="cancel">Throw away</button></div>';
  } else if (st === 'done') {
    head = '<div class="t-name">' + ico(r.icon, col(r)) + '<div><b>Your take</b><span class="tiny muted">' + esc(r.label) + ', ' +
      (REC.partial ? clockMs(REC.partial) + ' played, rest silent' : clockMs(REC.buf.duration)) + '</span></div></div>';
    lane = '<canvas id="rec-canvas"></canvas><div class="rec-float">' +
      '<button class="btn btn-sm btn-main" type="button" data-draftkeep="1">Keep it as a track</button>' +
      '<button class="btn btn-sm btn-sound' + (REC.pv ? ' on' : '') + '" id="rec-pp" type="button" data-recpp="1" aria-label="' + (REC.pv ? 'Pause your take' : 'Play your take with the rest') + '" title="Hear it with the rest. Click the waveform to hear it from there.">' + recPvBtnInner() + '</button>' +
      '<button class="btn btn-sm" type="button" data-dawrec="1">Record again</button>' +
      '<button class="btn btn-sm" type="button" data-dawdrop="1">Throw away</button></div>' +
      (REC.warn ? '<p class="rec-warn lane-warn">' + esc(REC.warn) + '</p>' : '');
  } else {
    head = '<div class="t-name"><span class="add-ico" aria-hidden="true">+</span>' +
      '<div><b>Your take</b><span class="tiny muted">' + (building ? 'only in your version' : 'on what you hear') + '</span></div></div>' +
      '<select class="rec-role" id="daw-rec-role" aria-label="Which layer your take is for">' +
        ROLES.map(function (x) { return '<option value="' + x.id + '"' + (x.id === rid ? ' selected' : '') + '>' + x.label + '</option>'; }).join('') +
      '</select>';
    lane = '<div class="a-lane"><span><span class="a-long">' + (building
        ? 'Add a take on any layer to your version. Record it right here on this track, or upload a file.'
        : 'Record right here, or upload one or more files (up to 4 instruments). They stay a draft until you post them, as one reply in the thread.') +
      ' </span><em>Wear headphones.</em></span>' +
      '<button class="btn btn-main" type="button" data-dawrec="1"><span class="rec-dot"></span> Record here</button>' +
      '<button class="btn" type="button" data-draftup="1">Upload files</button>' +
      micPicker() + ampPicker(rid) + monPicker() + err + '</div>';
  }
  return '<div class="t-head">' + head + '</div>' + (st === 'idle' ? lane : '<div class="rec-lane' + (st === 'done' ? ' done' : '') + (st === 'done' && REC.warn ? ' has-warn' : '') + '">' + lane + '</div>');
}
function placeFadeHandles() {
  var d = duration(); if (!d) return;
  [].forEach.call(document.querySelectorAll('.fh'), function (h) {
    var t = findTake(h.dataset.id); if (!t) return;
    var st = startOf(t), e = envOf(t);
    var sec = h.dataset.fh === 'in' ? st + e.fi : st + t.len - e.fo;
    h.style.left = (sec / d * 100) + '%';
    h.setAttribute('aria-valuenow', (h.dataset.fh === 'in' ? e.fi : e.fo).toFixed(1));
    h.title = (h.dataset.fh === 'in' ? 'Fade in ' : 'Fade out ') + (h.dataset.fh === 'in' ? e.fi : e.fo).toFixed(1) + ' s, drag to change';
  });
}
/* dragging a fade handle */
var drag = null, justDragged = false;
document.addEventListener('pointerdown', function (e) {
  var h = e.target.closest('.fh');
  if (!h) return;
  e.preventDefault(); e.stopPropagation();
  var t = findTake(h.dataset.id), lane = h.parentNode;
  if (!t) return;
  drag = { h:h, t:t, rect:lane.getBoundingClientRect(), d:duration(), st:startOf(t), kind:h.dataset.fh };
  h.setPointerCapture(e.pointerId);
  h.classList.add('on');
});
document.addEventListener('pointermove', function (e) {
  if (!drag) return;
  var sec = (e.clientX - drag.rect.left) / drag.rect.width * drag.d, t = drag.t;
  if (drag.kind === 'in') t.fin = Math.max(0, Math.min(t.len / 2, sec - drag.st));
  else t.fout = Math.max(0, Math.min(t.len / 2, drag.st + t.len - sec));
  if ((drag.kind === 'in' ? t.fin : t.fout) < 0.05) { if (drag.kind === 'in') t.fin = 0; else t.fout = 0; }
  drawWave(t); placeFadeHandles();
  flash((drag.kind === 'in' ? 'Fade in ' : 'Fade out ') + (drag.kind === 'in' ? t.fin : t.fout).toFixed(1) + ' s on ' + (t.by || 'the original track') + '.');
});
function endDrag() {
  if (!drag) return;
  var t = drag.t;
  drag.h.classList.remove('on');
  drag = null; justDragged = true;
  setTimeout(function () { justDragged = false; }, 50);
  saveFades(t);
  if (running) play(position());
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);
function extendButtons() {
  return '<button class="extend ext-before" type="button" data-extend="before" title="Write a part before this" aria-label="Write a new part before the song">+</button>' +
    '<button class="extend ext-after" type="button" data-extend="after" title="Write a part after this" aria-label="Write a new part after the song">+</button>';
}
/* the + buttons sit on the edges of the song */
function placeExtendButtons() {
  var d = duration(); if (!d) return;
  var b = document.querySelector('.ext-before'), a = document.querySelector('.ext-after');
  if (b) b.style.left = 'calc(0% + 6px)';
  if (a) a.style.left = 'calc(100% - 34px)';
}
function renderPitches() {
  var box = el('pitches');
  if (!box) return;
  var show = S.pitches.length && !S.override && S.view === 'lineup';
  box.style.display = show ? '' : 'none';
  if (!show) { box.innerHTML = ''; return; }
  var boss = isHost() && isOpen();
  box.innerHTML = '<div class="pt-head"><b>New parts pitched</b><span class="tiny muted">Someone wants the song to go somewhere new. Hear it in place, then keep it or pass.</span></div>' +
    S.pitches.map(function (t) {
      var on = only === t.id, tr = S.trialPitch === t.id;
      return '<div class="pt-row">' +
        '<button class="play sm' + (on ? ' on' : '') + '" type="button" data-prev="' + t.id + '" aria-label="Hear the part by ' + esc(t.by) + ' on its own"' + (t.buf ? '' : ' disabled') + '>' + (on ? I_PAUSE : I_PLAY) + '</button>' +
        '<div class="pt-who"><b>' + esc(t.by) + '</b><span class="tiny muted">' + fmt(t.len) + ', ' + (t.pos === 'before' ? 'before' : 'after') + ' the track' +
          (carryNames(t).length ? ', with ' + esc(carryNames(t).join(', ')) : '') + '</span>' +
        (t.note ? '<span class="note">&ldquo;' + esc(t.note) + '&rdquo;</span>' : '') + '</div>' +
        (tr ? mixToggle('this part') : '') +
        '<button class="btn btn-sm' + (tr ? ' trybtn on' : '') + '" type="button" data-trypitch="' + t.id + '"' + (t.buf ? '' : ' disabled') + '>' + (tr ? 'Take it out' : 'Hear it in place') + '</button>' +
        delBtn(t.id) +
        (boss ? '<button class="btn btn-sm btn-main" type="button" data-accpitch="' + t.id + '">Keep it</button>' +
        '<button class="btn btn-sm btn-veto" type="button" data-passpitch="' + t.id + '">Pass</button>' : '<span class="tiny muted">The creator decides</span>') + '</div>';
    }).join('');
}

/* ---------- version builder ---------- */
function renderPicker() {
  var box = el('picker');
  if (!box) return;
  var building = S.view === 'build' && !S.override;
  box.style.display = building ? '' : 'none';
  if (!building) return;
  var all = pool();
  var cols = ROLES.map(function (r) {
    var takes = all.filter(function (t) { return t.roleId === r.id; });
    var items = takes.length ? takes.map(function (t) {
      var picked = S.build.picks.indexOf(t.id) > -1;
      var status = standing(t);
      var on = only === t.id, sendable = isOwn(t) && mine(t) && isOpen();
      return '<li class="pk' + (picked ? ' picked' : '') + (isOwn(t) ? ' own' : '') + '">' +
        '<button class="play sm' + (on ? ' on' : '') + '" type="button" data-prev="' + t.id + '" aria-label="Hear ' + esc(t.by) + ' on its own">' +
          (on ? I_PAUSE : I_PLAY) + '</button>' +
        '<div class="pk-who"><b>' + esc(t.by) + '</b><span>' + status + (secOf(t) !== 'core' ? ', ' + secTag(t) : '') + '</span></div>' +
        '<button class="btn btn-sm pk-btn' + (picked ? ' on' : '') + '" type="button" data-pick="' + t.id + '" aria-pressed="' + picked + '">' +
          (picked ? 'In' : 'Add') + '</button>' +
        (sendable ? '<button class="pk-send" type="button" data-sendown="' + t.id + '" title="The creator hears it and decides if it goes in the stack">Send to the creator</button>' : '') +
        (isOwn(t) && mine(t) ? menuBtn('p:' + t.id, miDel(t.id)) : '') +
        '</li>';
    }).join('') : '<li class="empty">No takes yet.</li>';
    return '<div class="pk-col' + (takes.length ? '' : ' none') + '" style="color:' + col(r) + '"><div class="pk-head">' + ico(r.icon, col(r)) + '<b>' + r.label + '</b></div>' +
      '<ul>' + items + '</ul>' +
      '</div>';
  }).join('');

  box.innerHTML =
    '<div class="pk-grid">' + cols + '</div>';
  if (isHost()) return;
  box.innerHTML +=
    '<div class="pk-save">' +
      '<label class="field"><span>Name your stack</span><input type="text" id="ver-name" maxlength="60" placeholder="e.g. Half-time with the lead"></label>' +
      postingAs() +
      '<button class="btn btn-main" type="button" id="ver-save"' + (S.build.picks.length && S.session ? '' : ' disabled') + '>Save this stack</button>' +
      '<span class="tiny muted">' + S.build.picks.length + ' take(s) on top of the original track. Only the choice is saved, nothing gets re-uploaded.</span>' +
    '</div>';
}
function versionCard(v) {
  var on = S.override && S.override.id === v.id && running;
  var chips = byIds(v.picks).map(function (t) {
    var r = role(t.roleId);
    return '<span class="vchip">' + ico(r.icon, col(r)) + esc(t.by) + '</span>';
  }).join('');
  return '<article class="vcard">' +
    '<div class="vc-top"><button class="play' + (on ? ' on' : '') + '" type="button" data-playver="' + v.id + '" aria-label="Play ' + esc(v.name) + '">' +
      (on ? I_PAUSE : I_PLAY) + '</button>' +
    '<div><b>' + esc(v.name) + '</b><span class="tiny muted">by ' + nameOf(v.by, v.authorId) + ', ' + livePicks(v.picks).length + ' take(s) on the original</span></div></div>' +
    '<div class="vc-chips">' + chips + '</div>' +
    '<div class="vc-foot"><button class="btn btn-sm' + (v.liked ? ' on' : '') + '" type="button" data-like="' + v.id + '"' +
      (v.liked ? ' disabled aria-label="You liked this"' : '') + '>&#9829; ' + v.likes + '</button>' +
    '<button class="btn btn-sm" type="button" data-fork="' + v.id + '">Build on this one</button></div></article>';
}
function officialCard() {
  var on = !S.override && S.view !== 'build' && running;
  return '<article class="vcard official">' +
    '<div class="vc-top"><button class="play' + (on ? ' on' : '') + '" type="button" data-playofficial="1" aria-label="Play ' + esc(projName()) + '">' +
      (on ? I_PAUSE : I_PLAY) + '</button>' +
    '<div><b>' + esc(projName()) + '</b><span class="tiny muted">official, chosen by the creator</span></div></div>' +
    '<div class="vc-chips">' + S.members.filter(onKeptSection).map(function (t) {
      var r = role(t.roleId);
      return '<span class="vchip">' + ico(r.icon, col(r)) + esc(t.by) + '</span>';
    }).join('') + '</div></article>';
}
function renderVersionLists() {
  var sorted = S.versions.slice().sort(function (a, b) { return b.likes - a.likes; });
  var html = officialCard() + sorted.map(versionCard).join('');
  ['fanmixes', 'rel-fanmixes'].forEach(function (id) { if (el(id)) el(id).innerHTML = html; });
  if (el('fan-sub')) el('fan-sub').textContent = S.versions.length
    ? S.versions.length + ' version(s) from the room, sorted by hearts. The stack stays on top.'
    : 'Nobody has built their own version yet. Switch to "Your version" above the tracks to make one.';
  if (el('play-raw')) { var pr = running && !S.override; el('play-raw').innerHTML = pr ? I_PAUSE : I_PLAY; el('play-raw').setAttribute('aria-label', pr ? 'Stop the song' : 'Play the song'); el('play-raw').classList.toggle('on', pr); }
}
function playVersion(v) {
  if (S.override && S.override.id === v.id && running) { stopAll(); return; }
  stopAll();
  S.override = { id:v.id, name:v.name, by:v.by, picks:v.picks.slice(), ctl:JSON.parse(JSON.stringify(v.ctl || {})) };
  S.trial = null;
  refreshGains();
  play(0);
  flash('Playing "' + v.name + '".');
}
function drawWave(t) {
  var c = document.querySelector('[data-wave="' + t.id + '"]');
  if (!c || !t.buf) return;
  if (!t.mm) t.mm = minMaxOf(t.buf, 2400);
  var dpr = window.devicePixelRatio || 1;
  var w = c.clientWidth || 600, h = 72;
  c.width = w * dpr; c.height = h * dpr;
  var g = c.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  var d = duration() || t.len, st = startOf(t);
  var x0 = Math.round(st / d * w), x1 = Math.round((st + t.len) / d * w), cw = Math.max(1, x1 - x0);
  var hearing = running && audible(t) && (!only || only === t.id);
  /* every clip in its instrument's colour (the original track in its own, new parts in slate):
     a soft tinted box with the waveform in it, full strength while you hear it */
  var si = seedInstr(), c0 = cvar(t.id === 'seed' ? (si ? si.color : '--seed') : t.roleId === 'part' ? '--part' : ((role(t.roleId) || {}).color || '--wave'));
  g.fillStyle = c0; g.globalAlpha = .12;
  if (g.roundRect) { g.beginPath(); g.roundRect(x0, 3, cw, h - 6, 12); g.fill(); } else g.fillRect(x0, 3, cw, h - 6);
  g.globalAlpha = ctl(t).mute ? .3 : hearing ? 1 : .62;
  var e = envOf(t);
  g.save(); g.translate(0, 6);
  waveShape(g, t.mm, x0 + 4, Math.max(1, cw - 8), h - 12, function (f) { return envAt(f * t.len, t.len, e); });
  g.restore();
  g.globalAlpha = .9;
  g.strokeStyle = cvar('--ink'); g.lineWidth = 1.25;
  if (e.fi > 0.01) { g.beginPath(); g.moveTo(x0, h - 3); g.lineTo(x0 + e.fi / t.len * cw, 3); g.stroke(); }
  if (e.fo > 0.01) { g.beginPath(); g.moveTo(x1 - e.fo / t.len * cw, 3); g.lineTo(x1, h - 3); g.stroke(); }
  g.globalAlpha = 1;
}

/* ---------- waiting board ---------- */
function anLine(t) {
  if (!t.an || !t.an.bpm) return '';
  var off = S.meta.bpm && Math.abs(t.an.bpm - S.meta.bpm) > 2;
  return '<div class="an' + (off ? ' off' : '') + '">' + t.an.bpm + ' bpm, ' + t.an.key + (off ? ' — off the session tempo' : '') + '</div>';
}
/* how the "Add …" button names an instrument where the plural reads better */
var ADD_AS = { guitar:'guitars', lead:'leads' };
function applyCard(r) {
  var list = waitingFor(r.id), host = isHost(), held = seedHolds(r.id), open = isOpen();
  var body = list.map(function (t) {
    var on = S.trial === t.id;
    return '<li class="app">' +
      '<div class="app-top">' +
        '<button class="play sm' + (on ? ' on' : '') + '" type="button" data-try="' + t.id + '" aria-label="' + (on ? 'Stop' : 'Hear the take by ' + esc(t.by) + ' in the mix') + '"' +
          ' title="' + (on ? 'Stop' : 'Hear it in the mix') + '">' + (on ? I_PAUSE : I_PLAY) + '</button>' +
        '<b>' + esc(t.by) + '</b><span class="len">' + fmt(t.len) + '</span>' +
        menuBtn('a:' + t.id, mi('data-prev="' + t.id + '"', only === t.id ? 'Stop' : 'Play on its own') +
          mi('data-dl="' + t.id + '"', 'Download') + miDel(t.id)) +
      '</div>' + (on ? '<div class="trying">Playing in the mix</div>' : '') + anLine(t) +
      (secTag(t) || inVersions(t.id) ? '<div class="vline">' + secTag(t) + verTag(t.id) + '</div>' : '') +
      (t.note ? '<div class="note">&ldquo;' + esc(t.note) + '&rdquo;</div>' : '') +
      (host && open
        ? '<div class="app-foot"><span class="acts">' +
          (seedHolds(t.roleId, secOf(t)) ? '' : '<button class="btn btn-sm btn-main" type="button" data-yes="' + t.id + '">Add to song</button>') +
          '<button class="btn btn-sm btn-veto" type="button" data-no="' + t.id + '">Veto</button></span></div>'
        : '<div class="app-foot"><span class="tiny muted">Waiting for the creator</span></div>') +
      '</li>';
  }).join('');
  var addTxt = 'Add ' + esc(ADD_AS[r.id] || r.label.toLowerCase());
  return '<article class="gate apply' + (list.length ? '' : ' none') + '" style="color:' + col(r) + '">' +
    '<div class="g-top"><div class="g-name">' + ico(r.icon, col(r)) + '<h3>' + r.label + '</h3>' +
    (list.length ? '<span class="count">' + list.length + '</span>' : '') + '</div>' +
    (held ? '<div class="tiny muted">The original track plays this part</div>' : '') + '</div>' +
    (list.length ? '<ul class="takes">' + body + '</ul>' : '') +
    (open ? '<button class="addlink" type="button" data-apply="' + r.id + '">' + (list.length ? '+ ' + addTxt : 'Nothing yet. <u>' + addTxt + '</u>') + '</button>'
          : (list.length ? '' : '<p class="tiny muted g-empty">No takes.</p>')) + '</article>';
}

/* every instrument with all its takes: pick the layer you want to play */
function layerCard(r) {
  var list = threadTakes().filter(function (t) { return t.roleId === r.id; })
    .sort(function (a, b) { return String(b.created).localeCompare(String(a.created)); });
  var held = seedHolds(r.id), open = isOpen(), cur = S.view !== 'build' && !S.override ? currentStack() : null;
  var body = list.map(function (t) {
    var on = running && cur && cur.id === t.dbId, made = S.members.indexOf(t) > -1, under = onOf(t);
    return '<li class="app">' +
      '<div class="app-top">' +
        '<button class="play sm' + (S.trial === t.id ? ' on' : '') + '" type="button" data-try="' + t.id + '" aria-label="Hear ' + esc(t.by) + ' with the song" title="Hear it with the song">' + (S.trial === t.id ? I_PAUSE : I_PLAY) + '</button>' +
        '<b>' + esc(t.by) + '</b><span class="len">' + fmt(t.len) + '</span>' +
        menuBtn('a:' + t.id, mi('data-prev="' + t.id + '"', only === t.id ? 'Stop' : 'Play on its own') +
          mi('data-dl="' + t.id + '"', 'Download') + (isHost() && open && !made ? mi('data-yesg="' + t.dbId + '"', 'Add take to song') : '')) +
      '</div>' +
      '<div class="vline">' + (made ? '<em class="st-tag auth">In Author’s creation</em>' : '') +
        '<span class="tiny muted">on ' + (under.length ? under.map(function (u) { return esc(u.by); }).join(', ') : 'the original track') + '</span></div>' +
      (t.note ? '<div class="note">&ldquo;' + esc(t.note) + '&rdquo;</div>' : '') +
      '</li>';
  }).join('');
  var addTxt = 'Add ' + esc(ADD_AS[r.id] || r.label.toLowerCase());
  var show = S.showLayers && list.length;
  return '<article class="gate apply' + (show ? '' : ' none') + '" style="color:' + col(r) + '">' +
    '<div class="g-top"><div class="g-name">' + ico(r.icon, col(r)) + '<h3>' + r.label + '</h3>' +
    (show ? '<span class="count">' + list.length + '</span>' : '') + '</div>' +
    (held ? '<div class="tiny muted">The original track plays this part</div>' : '') + '</div>' +
    (show ? '<ul class="takes">' + body + '</ul>' : '') +
    (open ? '<button class="addlink" type="button" data-apply="' + r.id + '">' + (list.length ? (show ? '+ ' : list.length + (list.length > 1 ? ' takes. ' : ' take. ')) : 'Nothing yet. ') + '<u>' + addTxt + '</u></button>'
          : (list.length ? '' : '<p class="tiny muted g-empty">No takes.</p>')) + '</article>';
}
function renderBoards() {
  /* every instrument keeps its card: it shows people straight away what they can add */
  if (el('applyboard')) el('applyboard').innerHTML = ROLES.map(layerCard).join('');
  var stacks = S.tView === 'stacks';
  if (el('tview')) el('tview').innerHTML = viewToggle(S.tView);
  if (el('tfilter')) el('tfilter').hidden = stacks;
  if (el('thread')) el('thread').innerHTML = stacks ? stacksHtml() : threadHtml();
  renderTFilter(); drawThreadWaves();
  var nAll = threadTakes().length;
  if (el('layer-toggle')) el('layer-toggle').innerHTML = nAll ? '<button class="btn btn-sm" type="button" data-showlayers="1" aria-expanded="' + !!S.showLayers + '">' +
    (S.showLayers ? 'Hide the takes' : 'Show the takes already in this session (' + nAll + ')') + '</button>' : '';
  var cs = currentStack();
  if (!(S.view === 'build' && !S.override)) el('lineup-sub').textContent = !cs ? 'Nobody played along yet. Add the first take.'
    : cs.creation ? 'Picked by the author, from takes in the thread.'
    : cs.largest ? 'Until the author picks takes, the room’s suggestion plays.'
    : 'One branch of the thread: every take in it was played on the ones before it.';
  if (el('apply-sub')) el('apply-sub').textContent = 'Pick what you play. You play along on the song above.';
}
function renderArchive() { /* the unused takes are listed in the "make your own version" block (ocTakes) */ }
/* next to the thread: what the creator decides, or what a reply is */
function renderThreadSide() {
  var box = el('thread-side'); if (!box) return;
  if (!hasSeed() || !S.session) { box.innerHTML = ''; return; }
  box.innerHTML = isHost()
    ? '<div class="side-card"><b class="side-h">You decide</b><p class="tiny muted">Takes marked <span class="badge wait">To review</span> wait for you. ' +
        'Add one to the song or pass; passed takes stay in the thread and anyone can still play on them.</p></div>'
    : '<div class="side-card"><b class="side-h">Your take is a reply</b><p class="tiny muted">Play on any take in the thread: yours plays on top of everything above it. ' +
        'Afterwards, anyone can stack on your take as well.</p>' +
        '<p class="side-hint"><span class="side-arr" aria-hidden="true">&larr;</span>Select which stack of replies you want to see in the mixer.</p></div>';
}
function renderLock() {
  var nIn = S.members.length;
  el('lock-status').innerHTML = '<b>' + nIn + (nIn === 1 ? ' take' : ' takes') + ' in the stack</b> <span class="muted">· ' + S.applicants.length + ' to review' +
    (hasSeed() ? '' : ', no track yet') + (S.session && !isOpen() ? ', song released' : '') + '</span>';
  var btn = el('lock-btn');
  btn.style.display = isHost() && isOpen() ? '' : 'none';
  el('lock-note').hidden = !(isHost() && isOpen());
  btn.disabled = !(hasSeed() && S.members.length);
}

/* Filter knobs. Drag up/down (or use the arrow keys) to turn, double-click to open the filter again. */
var KNOB = { hp:{ label:'Low cut', long:'Low cut (high-pass filter)' }, lp:{ label:'High cut', long:'High cut (low-pass filter)' } };
function knob(t, kind) {
  var hz = cutOf(t, kind), k = hzToKnob(hz), open = kind === 'hp' ? hz <= F_MIN : hz >= F_MAX;
  return '<div class="kn' + (open ? '' : ' act') + '">' +
    '<span class="knob" id="knob-' + kind + '-' + t.id + '" role="slider" tabindex="0" data-knob="' + kind + '" data-take="' + t.id + '"' +
      ' aria-label="' + KNOB[kind].long + ' for ' + esc(t.by || 'you') + '" aria-valuemin="' + F_MIN + '" aria-valuemax="' + F_MAX + '"' +
      ' aria-valuenow="' + hz + '" aria-valuetext="' + (open ? 'off' : fmtHz(hz)) + '" title="' + KNOB[kind].long + '. Double-click to reset."' +
      ' style="--a:' + (k * 270 - 135) + 'deg"><i></i></span>' +
    '<span class="kn-l"><b>' + KNOB[kind].label + '</b><span class="tiny muted" data-knobval="' + kind + '-' + t.id + '">' + (open ? 'off' : fmtHz(hz)) + '</span></span>' +
  '</div>';
}
function setKnob(t, kind, hz) {
  hz = Math.max(F_MIN, Math.min(F_MAX, Math.round(hz)));
  ctl(t)[kind] = hz;
  if (gains[t.id]) setCut(gains[t.id][kind], hz);
  var open = kind === 'hp' ? hz <= F_MIN : hz >= F_MAX, txt = open ? 'off' : fmtHz(hz);
  var kn = el('knob-' + kind + '-' + t.id), lab = document.querySelector('[data-knobval="' + kind + '-' + t.id + '"]');
  if (kn) {
    kn.style.setProperty('--a', (hzToKnob(hz) * 270 - 135) + 'deg');
    kn.setAttribute('aria-valuenow', hz);
    kn.setAttribute('aria-valuetext', txt);
    kn.parentNode.classList.toggle('act', !open);
  }
  if (lab) lab.textContent = txt;
}
var knobDrag = null;
document.addEventListener('pointerdown', function (e) {
  var kn = e.target.closest('[data-knob]');
  if (!kn || e.button !== 0) return;
  var t = findTake(kn.dataset.take);
  if (!t) return;
  e.preventDefault();
  kn.focus();
  knobDrag = { t:t, kind:kn.dataset.knob, y:e.clientY, k:hzToKnob(cutOf(t, kn.dataset.knob)) };
  document.body.classList.add('turning');
});
document.addEventListener('pointermove', function (e) {
  if (!knobDrag) return;
  var k = knobDrag.k + (knobDrag.y - e.clientY) / (e.shiftKey ? 600 : 150);
  setKnob(knobDrag.t, knobDrag.kind, knobToHz(k));
});
function endKnobDrag(){ if (knobDrag) { knobDrag = null; document.body.classList.remove('turning'); } }
document.addEventListener('pointerup', endKnobDrag);
document.addEventListener('pointercancel', endKnobDrag);
document.addEventListener('dblclick', function (e) {
  var kn = e.target.closest('[data-knob]');
  if (!kn) return;
  var t = findTake(kn.dataset.take);
  if (t) setKnob(t, kn.dataset.knob, kn.dataset.knob === 'hp' ? F_MIN : F_MAX);
});
document.addEventListener('keydown', function (e) {
  var kn = e.target.closest && e.target.closest('[data-knob]');
  if (!kn) return;
  var t = findTake(kn.dataset.take), kind = kn.dataset.knob;
  if (!t) return;
  var step = { ArrowUp:1, ArrowRight:1, ArrowDown:-1, ArrowLeft:-1, PageUp:5, PageDown:-5 }[e.key];
  var hz = null;
  if (step) hz = knobToHz(hzToKnob(cutOf(t, kind)) + step * (e.shiftKey ? .005 : .02));
  else if (e.key === 'Home') hz = F_MIN;
  else if (e.key === 'End') hz = F_MAX;
  if (hz === null) return;
  e.preventDefault();
  setKnob(t, kind, hz);
});

/* Realtime updates re-render while people type. Keep what they typed and where the cursor was. */
var KEEP = ['w-text', 'draft-note', 'ver-name', 'seed-role', 'meta-bpm', 'proj-title', 'cm-body', 'seed-bpm', 'seed-time'];
function keepInputs(fn) {
  var vals = {}, a = document.activeElement, aid = a && a.id, sel = null;
  KEEP.forEach(function (id) { var e = el(id); if (e) vals[id] = e.value; });
  try { if (a && a.selectionStart !== undefined) sel = [a.selectionStart, a.selectionEnd]; } catch (e) {}
  fn();
  KEEP.forEach(function (id) { var e = el(id); if (e && vals[id] !== undefined) e.value = vals[id]; });
  if (aid && el(aid) && el(aid) !== document.activeElement) {
    el(aid).focus();
    try { if (sel) el(aid).setSelectionRange(sel[0], sel[1]); } catch (e) {}
  }
}
/* canvases are drawn in the theme's colours: redraw everything when it changes */
window.addEventListener('stackato:theme', function () { render(); });
function render() {
  keepInputs(function () { renderHow(); renderSeed(); renderProjTitle(); renderOwnCta(); renderInstruments(); renderDaw(); renderBoards(); renderThreadSide(); renderArchive(); renderLock(); renderVersionLists(); });
  if (S.menu) placeMenus();
}
function renderAll() {
  render();
  if (el('stage-released').classList.contains('on')) keepInputs(renderRelease);
}
var renderQueued = false;
function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(function () { renderQueued = false; renderAll(); });
}

/* ---------- release ---------- */
var mixEl = null;
function renderRelease() {
  var list = tracks(), host = isHost();
  el('rel-kicker').textContent = S.session && !isOpen() ? 'Released' : 'Not released yet, this is a preview';
  var tf = el('song-title');
  if (document.activeElement !== tf) tf.value = S.title;
  tf.readOnly = !host;

  var nMus = {}; list.forEach(function (t) { nMus[t.by || ''] = 1; });
  var nm = Object.keys(nMus).length, pr = running && !S.override;
  el('rel-sub').textContent = (S.session && !isOpen() ? 'Released. ' : 'Not released yet. ') + nm + (nm === 1 ? ' musician is' : ' musicians are') + ' on the song.';
  el('raw-box').innerHTML =
    '<div class="rel-well"><button class="play rel-big' + (pr ? ' on' : '') + '" type="button" id="play-raw" aria-label="' + (pr ? 'Stop the song' : 'Play the song') + '">' + (pr ? I_PAUSE : I_PLAY) + '</button>' +
      '<div class="rel-wave" id="rel-wave-box"><canvas id="rel-wave"></canvas></div>' +
      '<span class="rel-time" id="rel-time">' + clockMs(pr ? position() : 0) + ' / ' + clockMs(duration()) + '</span></div>' +
    '<div class="rel-row"><span class="tiny muted">The song: every take in the stack, ' + list.length + ' tracks, mixed by the creator.</span>' +
      '<button class="btn btn-sm" type="button" id="dl-all2">' + I_DL + ' Stems</button></div>';
  drawRelWave();

  el('mix-box').innerHTML = '<span class="rel-ico" aria-hidden="true">' + ico('prod', 'var(--paper)') + '</span>' +
    '<div class="rel-mix-txt"><h2>The Mix <span class="muted">· optional</span></h2>' +
    (S.mix
      ? '<p class="tiny muted">A polished mix of the same song, by <b>' + esc(S.mix.by) + '</b>. It sits next to the song, it does not replace it.</p></div>' +
        '<button class="btn btn-sound" type="button" id="play-mix">' + I_PLAY + ' Play the Mix</button>'
      : isOpen()
        ? '<p class="tiny muted">A polished mix of the same song. Anyone can attach one once the creator releases it.</p></div>'
        : '<p class="tiny muted">A polished mix of the same song. Anyone can attach one now it’s released.</p>' +
          '</div>' +
          '<label class="btn btn-main mix-up" id="mixzone">Upload a mix<input type="file" id="mix-file" accept="audio/*" aria-label="Upload a Mix"></label>');

  function credit(name, color, what) {
    return '<div class="credit"><span class="ava" style="background:' + color + '" aria-hidden="true">' + esc(String(name || '?').charAt(0).toUpperCase()) + '</span>' +
      '<div><b>' + esc(name) + '</b><small style="color:' + color + '">' + esc(what) + '</small></div></div>';
  }
  var si = seedInstr();
  el('credits').innerHTML =
    (hasSeed() ? credit(host ? 'You' : S.seed.by, si ? col(si) : 'var(--seed)', (si ? si.label + ' · ' : '') + 'original track') : '') +
    partTakes().map(function (p) { return credit(p.by, 'var(--part)', 'New part ' + (p.pos === 'before' ? 'before' : 'after') + ' the track'); }).join('') +
    S.members.filter(onKeptSection).map(function (m) { var r = role(m.roleId); return credit(m.by, col(r), r.label); }).join('') +
    (S.mix ? credit(S.mix.by, 'var(--part)', 'Mix') : '');

  renderVersionLists();

  [].forEach.call(document.querySelectorAll('[data-react]'), function (b) {
    var k = b.dataset.react;
    b.querySelector('span').textContent = S.reactions[k] || 0;
    b.disabled = !!S.reacted[k] || !S.session;
    b.classList.toggle('on', !!S.reacted[k]);
  });
}
var RELWAVE = { key:'', peaks:null };
function relPeaks() {
  var list = tracks().filter(function (t) { return t.buf && audible(t); }), d = duration(), n = 900;
  var key = list.map(function (t) { return t.id + ':' + (ctl(t).vol == null ? 1 : ctl(t).vol) + ':' + startOf(t); }).join('|') + '|' + d;
  if (RELWAVE.key === key) return RELWAVE.peaks;
  var sr = 4000, N = Math.max(1, Math.ceil(d * sr)), mix = new Float32Array(N);
  list.forEach(function (t) {
    var ch = t.buf.getChannelData(0), step = t.buf.sampleRate / sr, at = Math.round(startOf(t) * sr), v = ctl(t).vol == null ? 1 : ctl(t).vol;
    for (var i = 0; i < t.buf.duration * sr && at + i < N; i++) mix[at + i] += ch[Math.floor(i * step)] * v;
  });
  var out = new Float32Array(n), per = N / n, mx = 0;
  for (var k = 0; k < n; k++) { var m = 0; for (var j = Math.floor(k * per); j < Math.floor((k + 1) * per); j++) { var a = Math.abs(mix[j]); if (a > m) m = a; } out[k] = m; if (m > mx) mx = m; }
  if (mx) for (k = 0; k < n; k++) out[k] /= mx;
  RELWAVE.key = key; RELWAVE.peaks = out;
  return out;
}
function drawRelWave() {
  var cv = el('rel-wave'); if (!cv || !cv.clientWidth) return;
  var w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1, pk = relPeaks();
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  var g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  var d = duration(), at = running && !S.override && d ? position() / d : 0, bars = Math.floor(w / 3), mid = h / 2;
  for (var i = 0; i < bars; i++) {
    var v = pk[Math.floor(i / bars * pk.length)] || 0, bh = Math.max(2, v * (h - 4));
    g.fillStyle = i / bars < at ? cvar('--sound') : cvar('--wave') || '#CDCAC2';
    g.fillRect(i * 3, mid - bh / 2, 2, bh);
  }
  var tm = el('rel-time'); if (tm) tm.textContent = clockMs(running && !S.override ? position() : 0) + ' / ' + clockMs(d);
}
function setPhase(p) {
  [].forEach.call(document.querySelectorAll('.phase'), function (b) {
    b.setAttribute('aria-selected', String(b.dataset.phase === p));
  });
  ['open','released'].forEach(function (k) { el('stage-' + k).classList.toggle('on', k === p); });
  if (p === 'released') renderRelease(); else render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
/* jump to the release page once, when the session gets closed */
function syncPhase() {
  var st = S.session ? S.session.status : null;
  if (st !== S.phaseSeen) {
    S.phaseSeen = st;
    if (st === 'released') setPhase('released');
  }
}

/* ---------- original track ---------- */
/* A new session never starts the moment a file is picked: the file waits on the drop panel
   ("<file> is ready") until you've said what the track is, then you
   start it. Replacing the track of a running session goes straight through. */
function loadSeed(file, confirmed) {
  var first = !hasSeed(), roleEl = el('seed-role');
  if (first && !confirmed) {
    S.pendingSeed = file; S.seedErr = '';
    render();
    flash('Got ' + file.name + '. Say what the track is, then start the session.');
    if (roleEl && !roleEl.value) roleEl.focus();
    return;
  }
  if (!me) { need('start').then(function () { loadSeed(file, confirmed); }); return; }
  var name = first ? myName() : (S.seed.by || myName());
  S.pendingSeed = null;
  if (REC.where === 'seed') { recReset(); REC.where = null; }
  var created = false;
  S.seedBusy = true; S.meta.busy = true; render();
  decode(file).then(function (buf) {
    var ready = S.session ? Promise.resolve(S.session) : db.createSession(me.id).then(function (sess) {
      created = true;
      S.session = sess;
      history.replaceState(null, '', '/s/' + sess.slug);
      watch(sess.id);
      return sess;
    });
    return ready.then(function () {
      return uploadTake(file, buf, { role:'seed', status:'seed', name:name, analyse:true });
    });
  }).then(function (res) {
    var an = res.analysis, patch = { seed_take_id: res.row.id };
    if (roleEl) patch.seed_role = roleEl.value && roleEl.value !== 'none' ? roleEl.value : null;
    if (an && (an.tempo || an.key)) {
      patch.bpm = an.tempo ? an.tempo.bpm : null;
      patch.music_key = an.key ? an.key.key : null;
      patch.key_alt = an.key ? an.key.runnerUp : null;
      patch.meta_from = 'detected';
      patch.meta_sure = sureness(Math.min(an.tempo ? an.tempo.conf : 0, an.key ? an.key.conf : 0));
    }
    /* recorded here: you played to a click, so its tempo and time are known, not guessed */
    if (S.seedRecMeta && first && file.name === 'recorded track.wav') {
      patch.bpm = S.seedRecMeta.bpm; patch.time_sig = S.seedRecMeta.time; patch.meta_from = 'you'; patch.meta_sure = null;
    }
    return db.updateSession(S.session.id, patch).then(function () {
      stopAll();
      flash((created ? 'Session started. Share the link from the bar below. ' : '') +
        (patch.bpm ? 'Heard about ' + patch.bpm + ' bpm in ' + patch.music_key + '. Correct it if it is off.' : 'Track loaded.'));
      return refresh();
    });
  }).catch(function (e) {
    oops(e);
  }).then(function () {
    S.seedBusy = false; S.meta.busy = false; render();
  });
}

/* start the session with the file waiting on the drop panel, once the instrument is in */
function startSeed() {
  if (!S.pendingSeed) return;
  var rl = el('seed-role');
  if (!(rl && rl.value)) {
    S.seedErr = 'Say what the track is: pick an instrument, or "Not one instrument".';
    render();
    flash(S.seedErr);
    if (el('seed-role')) el('seed-role').focus();
    return;
  }
  S.seedErr = '';
  loadSeed(S.pendingSeed, true);
}
el('sr-cancel').addEventListener('click', closeSeedRec);
el('sr-start').addEventListener('click', seedRecUse);
el('sr-scrim').addEventListener('click', function (e) { if (e.target === this) closeSeedRec(); });
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && el('sr-scrim').classList.contains('on')) closeSeedRec(); });
var pendingAttach = null;
el('attach-file').addEventListener('change', function () {
  var file = this.files[0];
  this.value = '';
  if (!file || pendingAttach !== 'seed') return;
  pendingAttach = null;
  if (REC.where === 'seed') { recReset(); REC.where = null; }
  S.seedRecMeta = null;
  loadSeed(file);
});
/* drag a file onto the drop zone (or onto the track panel to replace it) */
function dragsFiles(e) { return e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], 'Files') > -1; }
['dragenter', 'dragover'].forEach(function (ev) {
  el('seedpanel').addEventListener(ev, function (e) {
    if (!dragsFiles(e) || !canDropSeed()) return;
    e.preventDefault();
    el('seedpanel').classList.add('over');
  });
});
['dragleave', 'drop'].forEach(function (ev) {
  el('seedpanel').addEventListener(ev, function () { el('seedpanel').classList.remove('over'); });
});
el('seedpanel').addEventListener('drop', function (e) {
  e.preventDefault();
  var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f && canDropSeed()) loadSeed(f);
});

/* ---------- the add pop-up: a layer for the project, a new part to convince the creator,
   or a take of your own that goes straight into your version ('own') ---------- */
var lastFocus = null;
var M = { mode:'layer', pos:'after', src:'file', sec:'core' };
function fillRoles(sel) {
  el('take-role').innerHTML = ROLES.map(function (r) {
    return '<option value="' + r.id + '"' + (r.id === sel ? ' selected' : '') + '>' +
      r.label + (seedHolds(r.id, M.sec) ? ' (the original track)' : '') + '</option>';
  }).join('');
  roleHint();
}
function roleHint() {
  if (M.mode === 'extend') return;
  var id = el('take-role').value, r = role(id), free = cap(id, M.sec) - inSong(id, M.sec).length;
  showAmpPick(id);
  el('modal-ico').innerHTML = ico(r.icon, col(r));
  el('role-hint').textContent = M.mode === 'own'
    ? 'It goes straight into your version, nobody has to approve it. Add as many as you like.'
    : seedHolds(id, M.sec)
    ? 'The original track plays this layer, so this take cannot go in the stack. People can still use it in their own versions.'
    : free > 0
    ? 'There is room here. It goes to the takes to review for this layer.'
    : 'Taken right now. If the creator adds yours, the current take goes back to review.';
}
function fillSections() {
  var list = sections(), many = list.length > 1;
  el('sec-field').hidden = !many;
  el('take-sec').innerHTML = list.map(function (s) {
    return '<option value="' + s.id + '"' + (s.id === M.sec ? ' selected' : '') + '>' +
      esc(s.id === 'core' ? 'The original track' : s.label.charAt(0).toUpperCase() + s.label.slice(1)) +
      ' (' + clockMs(s.start) + ' to ' + clockMs(s.start + s.len) + ')</option>';
  }).join('');
  secHint();
}
function secHint() {
  var s = section(M.sec) || section('core');
  el('modal-sub').textContent = M.mode === 'own'
    ? 'Only in your own version. One layer, from the first beat of the original track, exactly ' + fmt(s.len) + ' long. You can send it to the creator later.'
    : 'One layer. Dry, from the first beat of ' + s.label + ', exactly ' + fmt(s.len) + ' long.';
  el('file-name').textContent = el('take-file').files.length ? el('take-file').files[0].name : 'wav or mp3, dry, ' + fmt(s.len) + ' long';
  if (REC.state === 'idle') renderRec();
}
function sendLabel() { return M.mode === 'extend' ? 'Pitch it to the creator' : M.mode === 'own' ? 'Add it to my version' : 'Add my take →'; }
function setSrc(src) {
  M.src = src;
  [].forEach.call(document.querySelectorAll('[data-src]'), function (b) {
    b.setAttribute('aria-selected', String(b.dataset.src === src));
  });
  el('src-file').hidden = src !== 'file';
  el('src-rec').hidden = src !== 'rec';
  el('modal-send').textContent = sendLabel();
  if (src === 'rec') renderRec(); else if (REC.state === 'recording') recCancel();
}
function countInLabel() {
  var n = S.countIn;
  el('countin-text').textContent = n
    ? 'My file starts with the ' + n + '-bar count-in from the click track. Cut it off for me.'
    : 'Set a count-in above the tracks to use this.';
  el('take-countin').disabled = !n;
  if (!n) el('take-countin').checked = false;
}
function openModal(roleId, extendPos, own, keepRec) {
  if (!hasSeed()) { flash('Drop an audio track first, it sets the length for everyone.'); return; }
  if (!own && !isOpen()) { flash('This song is released, so the stack is final.'); return; }
  lastFocus = document.activeElement;
  M.mode = extendPos ? 'extend' : own ? 'own' : 'layer';
  M.pos = extendPos || 'after';
  var ext = M.mode === 'extend';
  el('role-field').hidden = ext;
  el('carry-field').hidden = !ext;
  if (ext) fillCarry();
  if (ext) el('sec-field').hidden = true;
  el('countin-field').hidden = ext;
  if (ext) {
    el('modal-ico').innerHTML = ico('part', 'var(--part)');
    el('modal-head').textContent = 'Convince the creator';
    el('modal-sub').textContent = 'Write a new part that plays ' + (M.pos === 'before' ? 'before' : 'after') +
      ' the song. Any length. The creator hears it in place and decides whether the song gets longer.';
    el('note-label').textContent = 'Why the song needs this';
    el('take-note').placeholder = 'e.g. it needs a quiet intro before the riff kicks in';
  } else {
    el('modal-head').textContent = own ? 'Add your own take' : 'Add a take';
    M.sec = 'core';
    fillRoles(roleId || ROLES[0].id);
    fillSections();
    if (own) el('sec-field').hidden = true;
    el('note-label').textContent = own ? 'A note, for if you send it to the creator later (optional)' : 'Say something to the room (optional)';
    el('take-note').placeholder = 'what you were going for';
    countInLabel();
  }
  el('modal-err').classList.remove('on');
  el('take-file').value = ''; el('take-as').innerHTML = postingAs(); el('take-note').value = '';
  el('take-countin').checked = false;
  el('file-name').textContent = ext ? 'wav or mp3, any length' : 'wav or mp3, dry, starting at bar 1';
  el('modal-send').disabled = false;
  if (keepRec && REC.buf) { REC.where = 'modal'; setSrc('rec'); }
  else { recReset(); REC.where = null; REC.fromDaw = false; REC.hear = {}; REC.click = true; setSrc('file'); }
  if (!ext) secHint();
  el('scrim').classList.add('on');
  el('take-role').focus();
}
function closeModal() {
  if (REC.state === 'recording' || REC.state === 'asking') recCancel();
  recStopPlayers();
  el('scrim').classList.remove('on');
  /* a take recorded on the grey track goes back there if it wasn't sent */
  if (REC.fromDaw) { if (REC.buf) REC.where = 'daw'; else REC.fromDaw = false; renderDaw(); }
  if (lastFocus) lastFocus.focus();
}

el('take-role').addEventListener('change', function () { roleHint(); rearm(); });
el('take-sec').addEventListener('change', function () { M.sec = this.value; fillRoles(el('take-role').value); secHint(); });
el('take-file').addEventListener('change', function () {
  el('file-name').textContent = this.files.length ? this.files[0].name
    : (M.mode === 'extend' ? 'wav or mp3, any length' : 'wav or mp3, dry, starting at bar 1');
});
el('modal-cancel').addEventListener('click', closeModal);
el('scrim').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && el('scrim').classList.contains('on')) closeModal(); });
/* Enter posts a comment (Shift+Enter for a new line), Escape drops it */
document.addEventListener('keydown', function (e) {
  if (e.target.id !== 'cm-body') return;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); postComment(); }
  else if (e.key === 'Escape') { S.cmDraft = null; S.cmErr = ''; render(); }
});

/* the tracks you can keep playing under a new part, as tick boxes */
function fillCarry() {
  var list = carryChoices();
  el('carry-list').innerHTML = list.length ? list.map(function (t) {
    var r = t === S.seed ? seedInstr() : role(t.roleId);
    var label = t === S.seed ? (isHost() ? 'Your original track' : (S.seed.by || 'The') + '’s original track') : t.by + '’s ' + role(t.roleId).label.toLowerCase();
    return '<label class="rec-opt"><input type="checkbox" data-carry="' + esc(t.dbId) + '">' +
      (r ? ico(r.icon, col(r)) : '') + '<span>' + esc(label) + '</span></label>';
  }).join('') : '<span class="tiny muted">Nothing plays on the original track yet.</span>';
}
function carryPicked() {
  return [].map.call(document.querySelectorAll('#carry-list [data-carry]:checked'), function (c) { return c.dataset.carry; });
}
/* a part that only repeats tracks has no audio of its own: a silent file as long as the original track */
function silentPart() {
  var sr = 8000, len = S.seed.len || 0, b = ac().createBuffer(1, Math.max(1, Math.round(len * sr)), sr);
  return { file:new File([encodeWav(b)], 'repeat.wav', { type:'audio/wav' }), buf:b, silent:true };
}
function takeSource(fail) {
  if (M.src === 'rec') {
    if (!REC.buf) { fail(REC.state === 'recording' ? 'Finish recording first.' : 'Record a take first.'); return null; }
    return Promise.resolve({ file:REC.file, buf:REC.buf, rec:true });
  }
  var f = el('take-file').files[0];
  if (!f && M.mode === 'extend' && carryPicked().length) return Promise.resolve(silentPart());
  if (!f) { fail(M.mode === 'extend' ? 'Pick an audio file first, or tick tracks to repeat under the new part.' : 'Pick an audio file first.'); return null; }
  return decode(f).then(function (buf) {
    if (M.mode === 'layer' && el('take-countin').checked && S.countIn) {
      var trimmed = trimStart(buf, S.countIn * barSeconds());
      var base = f.name.replace(/\.[^.]+$/, '');
      return { file:new File([encodeWav(trimmed)], base + ' (count-in cut).wav', { type:'audio/wav' }), buf:trimmed };
    }
    return { file:f, buf:buf };
  });
}
el('modal-send').addEventListener('click', function () {
  var btn = this;
  function fail(m){ el('modal-err').textContent = m; el('modal-err').classList.add('on'); btn.disabled = false; btn.textContent = sendLabel(); }
  function upFail(e){
    console.error(e);
    var nu = M.mode === 'own' ? needsUpdate(e, '20261004120000_own_takes.sql') : null;
    fail((nu || e).message || 'The upload failed. Try again.');
  }
  if (!me) { need('play').then(function () { el('take-as').innerHTML = postingAs(); btn.click(); }); return; }
  var name = myName();
  var p = takeSource(fail);
  if (!p) return;
  btn.disabled = true; btn.textContent = 'Uploading...';
  p.then(function (src) {
    var len = src.buf.duration, note = el('take-note').value.trim();
    if (M.mode === 'extend') {
      if (len < 1) return fail('That is under a second. A new part needs a bit more.');
      if (len > 240) return fail('Keep a new part under four minutes.');
      var pos = M.pos, carry = carryPicked();
      return uploadTake(src.file, src.buf, { role:'part', status:'waiting', name:name, note:note, pos:pos, analyse:!src.silent, carry:carry })
        .then(function () {
          closeModal();
          flash('Pitched a new part ' + (pos === 'before' ? 'before' : 'after') + ' the track' + (carry.length ? ', with ' + carry.length + ' track' + (carry.length > 1 ? 's' : '') + ' carried into it' : '') + '. The creator decides.');
          return refresh();
        }, upFail);
    }
    var want = secLen(M.sec), own = M.mode === 'own';
    if (want && Math.abs(len - want) > TOL)
      return fail('Your file is ' + fmt(len) + ', ' + (M.sec === 'core' ? 'the track' : 'that part') + ' is ' + fmt(want) + '.' +
        (S.countIn && !el('take-countin').checked && Math.abs(len - want - S.countIn * barSeconds()) < TOL
          ? ' It looks like it still has the count-in: tick the box above.' : ' Trim or pad it to match.'));
    return uploadTake(src.file, src.buf, { role:el('take-role').value, status:own ? 'own' : 'waiting', name:name, note:note,
                                           sec:M.sec === 'core' ? null : M.sec, analyse:true, amp:src.rec ? recAmpFor(el('take-role').value) : '' })
      .then(function (res) {
        if (REC.fromDaw) { recReset(); REC.fromDaw = false; REC.where = null; }
        closeModal();
        if (own) {
          S.build.picks.push(res.row.id); S.buildDirty = true;
          S.override = null; S.view = 'build';
          refreshGains();
          flash('It is in your version. Save the version to keep it, or send the take to the creator from the list.');
        } else flash('Your take is in the thread, as a reply to the song. The author decides if it goes in.');
        return refresh();
      }, upFail);
  }).catch(function () { fail('That file could not be read.'); });
});

/* the original track takes a slot in its instrument; the database bumps the oldest layers if that overfills it */
function setSeedRole(id) {
  var here = id ? inSong(id, 'core') : [];
  var out = here.slice(0, Math.max(0, here.length - (id ? role(id).slots - 1 : 0)));
  S.meta.seedRole = id;
  render();
  patchSession({ seed_role:id }).then(function () {
    if (out.length && S.session.seed_role === id) flash(out.map(function (t) { return t.by; }).join(' and ') + (out.length > 1 ? ' are' : ' is') + ' back in the takes to review, the original track plays ' + role(id).label.toLowerCase() + '.');
    return refresh();
  });
}

/* ---------- events ---------- */
var titleTimer = 0, bpmTimer = 0;
function patchSession(patch) {
  if (!S.session || !isHost()) return Promise.resolve();
  return db.updateSession(S.session.id, patch).then(function (row) { S.session = row; }).catch(oops);
}

document.addEventListener('click', function (e) {
  if (e.target.closest('[data-playmain]')) { stopAll(true); S.stack = null; S.view = 'lineup'; S.override = null; refreshGains(); play(0); return; }
  var yg = e.target.closest('[data-yesg]');
  if (yg) {
    var gt = TAKES[yg.dataset.yesg]; if (!gt || !isHost()) return;
    var ins = groupOf(gt).filter(function (g) { return S.members.indexOf(g) < 0; });
    Promise.all(ins.map(function (g) { return db.letIn(g.dbId); })).then(function () { flash('In the song. Everyone hears it on the first tab now.'); return refresh(); }, oops);
    return;
  }
  if (e.target.closest('[data-draftkeep]')) {
    if (REC.buf && REC.file) { var dr = addDraft(REC.file, REC.buf, S.recRole || ROLES[0].id); if (dr) dr.amp = recAmpFor(S.recRole || ROLES[0].id); recReset(); REC.where = null; REC.fromDaw = false; refreshGains(); renderDaw(); }
    return;
  }
  if (e.target.closest('[data-draftup]')) { el('draft-files').click(); return; }
  var ddel = e.target.closest('[data-draftdel]');
  if (ddel) { S.drafts = (S.drafts || []).filter(function (d) { return d.t.id !== ddel.dataset.draftdel; }); if (!S.drafts.length) S.draftBase = null; stopAll(true); renderDaw(); return; }
  if (e.target.closest('[data-draftclear]')) { S.drafts = []; S.draftBase = null; stopAll(true); renderDaw(); return; }
  if (e.target.closest('[data-draftpost]')) { postDraft(); return; }
  var tt = e.target.closest('[data-ttoggle]');
  if (tt) {
    var tk = tt.dataset.ttoggle;
    if (tk.indexOf('w:') === 0) { S.tClosed = S.tClosed || {}; S.tClosed[tk] = !S.tClosed[tk]; }
    else { S.tOpen = S.tOpen || {}; tk = tk.indexOf('t:') === 0 ? tk.slice(2) : tk; S.tOpen[tk] = !S.tOpen[tk]; }
    renderBoards(); return;
  }
  var tvw = e.target.closest('[data-tview]');
  if (tvw) { S.tView = tvw.dataset.tview; rememberView(S.tView); renderBoards(); return; }
  var tf = e.target.closest('[data-tfilter]');
  if (tf) { S.tFilter = tf.dataset.tfilter; renderBoards(); return; }
  var wo = e.target.closest('[data-wopen]');
  if (wo) { openWords(wo.dataset.wopen); return; }
  if (e.target.closest('[data-wcancel]')) { S.wAt = null; S.wErr = ''; renderBoards(); return; }
  if (e.target.closest('[data-wpost]')) { postWords(); return; }
  var wh = e.target.closest('[data-whide]');
  if (wh) { wh.disabled = true; db.hideThreadComment(wh.dataset.whide).then(function () { flash('Hidden. Nobody sees that reply any more.'); return refresh(); }).catch(function (x) { wh.disabled = false; oops(x); }); return; }
  var wd = e.target.closest('[data-wdel]');
  if (wd) {
    var wid = wd.dataset.wdel;
    if (S.wSure !== wid) { S.wSure = wid; renderBoards(); setTimeout(function () { if (S.wSure === wid) { S.wSure = null; renderBoards(); } }, 4000); return; }
    S.wSure = null;
    db.deleteThreadComment(wid).then(function () { flash('Deleted. Replies to it stay in the thread.'); return refresh(); }).catch(oops);
    return;
  }
  var tv = e.target.closest('[data-tvote]');
  if (tv) { tVoteCast(tv.dataset.tvote, tv.dataset.kind, +tv.dataset.dir); return; }
  var ng = e.target.closest('[data-nog]');
  if (ng) {
    var nt = TAKES[ng.dataset.nog]; if (!nt || !isHost()) return;
    ng.disabled = true;
    Promise.all(groupOf(nt).filter(function (g) { return g.status === 'waiting'; }).map(function (g) { return db.veto(g.dbId); }))
      .then(function () { flash('Passed. It stays in the thread, and anyone can still play on it.'); return refresh(); }, function (x) { ng.disabled = false; oops(x); });
    return;
  }
  if (e.target.closest('[data-showlayers]')) { S.showLayers = !S.showLayers; renderBoards(); return; }
  var ns = e.target.closest('[data-newsong]');
  if (ns) { location.href = '/#start'; return; }
  var lk = e.target.closest('[data-likestack]');
  if (lk) {
    likeStack();
    return;
  }
  var tpt = e.target.closest('[data-tpart]'), tpb = e.target.closest('button, a, input, select');
  if (tpt && (!tpb || tpb.hasAttribute('data-tpart'))) { goPart(tpt.dataset.tpart, 0, true); return; }
  var stb = e.target.closest('[data-stack], [data-tplay], [data-tstack], [data-treply], [data-makecreation]');
  if (!stb) { var sel = e.target.closest('[data-tsel]'); if (sel && !e.target.closest('button, a, input, select')) stb = { dataset:{ tstack:sel.dataset.tsel } }; }
  if (stb) {
    var d = stb.dataset, was = running;
    if (d.makecreation) {
      if (d.makecreation === 'build') return makeCreation(byIds(S.build.picks));
      var st = currentStack(); return st ? makeCreation(st.takes) : null;
    }
    var id = d.stack || d.tplay || d.tstack || d.treply;
    if (d.tplay && running && currentStack() && currentStack().id === (id === 'seed' ? '__seed' : id) && S.view !== 'build' && !S.override) { stopAll(true); render(); return; }
    stopAll(true); S.override = null; S.trial = null; S.view = 'lineup';
    if (d.tplay || d.tstack || d.treply) offset = 0;  /* a take from the thread always starts at the top */
    if (/^part:/.test(id)) id = 'main';
    if ((S.drafts || []).length && id !== (S.stack || 'main')) flash('Your draft was played on ' + (S.draftOn || 'the song') + '. It still posts there.');
    S.stack = id === 'main' || id === 'seed' ? null : id;
    if (S.stack && TAKES[S.stack]) S.sel = lead(TAKES[S.stack]).dbId;
    if (id === 'seed') { S.stack = '__seed'; S.sel = '__seed'; }
    refreshGains(); render();
    if (d.tplay || d.tstack || (d.stack && was)) play(0);
    if (d.tstack || d.tplay) { var dw = el('mix-head'); if (dw && !(stb.closest && stb.closest('.stree')) && (d.tstack || stb.closest && stb.closest('#thread'))) dw.scrollIntoView({ behavior:'smooth', block:'start' }); }
    if (d.treply) {
      if (/^part:/.test(d.treply)) { S.stack = null; openModal(null); var sp = d.treply.slice(5); if (el('take-sec')) { el('take-sec').value = sp; el('take-sec').dispatchEvent(new Event('change')); } }
      else openModal(null);
    }
    return;
  }
  var dl2 = e.target.closest('[data-del]');
  if (dl2) {
    e.stopPropagation();
    var did = dl2.dataset.del;
    clearTimeout(ARMED.timer);
    if (armedFor(did)) { ARMED.id = null; deleteTake(did); return; }
    ARMED.id = did; ARMED.until = Date.now() + 5000;
    ARMED.timer = setTimeout(function () { ARMED.id = null; render(); }, 5000);
    render();
    flash('Click delete again to remove this take for good.');
    return;
  }
  var ex = e.target.closest('[data-extend]');
  if (ex) { e.stopPropagation(); openModal(null, ex.dataset.extend); return; }
  var sr = e.target.closest('[data-src]');
  if (sr) {
    /* a layer on the original track is recorded on the grey track in the DAW, like a real DAW */
    if (sr.dataset.src === 'rec' && (M.mode === 'layer' || M.mode === 'own') && M.sec === 'core') { recordInDaw(); return; }
    setSrc(sr.dataset.src); return;
  }
  if (e.target.closest('[data-dawrec]')) { dawRecStart(); return; }
  if (e.target.closest('[data-seedpop]')) { openSeedRec(); return; }
  if (e.target.closest('[data-seedrec]')) { seedRecStart(); return; }
  if (e.target.closest('[data-dawsend]')) { dawRecSend(); return; }
  if (e.target.closest('[data-dawdrop]')) { dawRecDiscard(); return; }
  var rc = e.target.closest('[data-rec]');
  if (rc) {
    var what = rc.dataset.rec;
    if (what === 'start') recStart();
    else if (what === 'finish') recFinish();
    else if (what === 'cancel') recCancel();
    else if (what === 'again') { recReset(); renderRec(); }
    else if (what === 'listen') recListen(false);
    else if (what === 'listenmix') recListen(true);
    return;
  }
  if (e.target.closest('[data-recpp]')) { if (REC.pv) recStopPlayers(); else recPvPlay(REC.pvAt); return; }
  if (e.target.closest('#dl-click')) { downloadClick(); return; }
  if (e.target.closest('[data-mixtgl]')) { toggleTransport(); return; }
  var tp = e.target.closest('[data-trypitch]');
  if (tp) {
    var pid2 = tp.dataset.trypitch;
    stopAll();
    S.trialPitch = S.trialPitch === pid2 ? null : pid2;
    S.override = null; S.view = 'lineup';
    render();
    if (S.trialPitch) {
      var pt = findTake(pid2);
      play(Math.max(0, startOf(pt) - (pt.pos === 'after' ? 4 : 0)));
      flash('Playing the new part where it would sit in the song.');
    }
    return;
  }
  if (e.target.closest('[data-untrialpitch]')) { stopAll(); S.trialPitch = null; render(); return; }
  var acp = e.target.closest('[data-accpitch]');
  if (acp) { keepPart(findTake(acp.dataset.accpitch)); return; }
  var psp = e.target.closest('[data-passpitch]');
  if (psp) { passPart(findTake(psp.dataset.passpitch)); return; }
  var to = e.target.closest('[data-takeout]');
  if (to) {
    var tt = findTake(to.dataset.takeout);
    if (!tt || !isHost()) return;
    stopAll();
    db.takeOutLayer(tt.dbId).then(function () {
      flash('Took ' + (tt.by || 'the') + '’s ' + role(tt.roleId).label.toLowerCase() + ' out of the stack. It is with the unused takes, and people can still use it in their versions.');
      return refresh();
    }).catch(function (err) { oops(needsUpdate(err, '20261004130000_take_out_layer.sql') || err); });
    return;
  }
  if (e.target.closest('[data-metaedit]')) { S.metaOpen = !S.metaOpen; render(); return; }
  var am = e.target.closest('[data-amp]');
  if (am) { setAmp(findTake(am.dataset.take), am.dataset.amp); return; }
  var fx = e.target.closest('[data-fx]');
  if (fx) { S.fxOpen = S.fxOpen || {}; var ft = findTake(fx.dataset.fx); S.fxOpen[fx.dataset.fx] = !fxOpen(ft); render(); return; }
  var oo = e.target.closest('[data-ocopen]');
  if (oo) { S.ocOpen = S.ocOpen || {}; S.ocOpen[oo.dataset.ocopen] = !S.ocOpen[oo.dataset.ocopen]; render(); return; }
  var pr = e.target.closest('[data-pair]');
  if (pr) { pairPreview(findTake(pr.dataset.pair)); return; }
  var dp = e.target.closest('[data-droppart]');
  if (dp) { dropPart(findTake(dp.dataset.droppart)); return; }
  if (e.target.closest('[data-seedgo]')) { startSeed(); return; }
  var at = e.target.closest('[data-attach]');
  if (at) { pendingAttach = at.dataset.attach; el('attach-file').click(); return; }
  var d = e.target.closest('[data-dl]');
  if (d) { download(findTake(d.dataset.dl)); return; }
  var pv = e.target.closest('[data-prev]');
  if (pv) { preview(findTake(pv.dataset.prev)); return; }
  var vw = e.target.closest('[data-view]');
  if (vw) {
    if (REC.state === 'recording' || REC.state === 'asking') recCancel();
    stopAll();
    S.override = null; S.view = vw.dataset.view;
    if (S.view === 'build') {
      S.trial = null;
      /* start from the stack that plays first, so the creator only changes what they want */
      if (isHost() && !S.build.picks.length) { var st0 = stackList()[0]; if (st0) S.build.picks = st0.takes.map(function (t) { return t.id; }); }
    }
    refreshGains(); render();
    flash(S.view === 'build' ? 'Start from the stack that plays first. Swap any take for one from another branch.' : 'Back to the stack.');
    return;
  }
  var pk = e.target.closest('[data-pick]');
  if (pk) {
    var pid = pk.dataset.pick, at2 = S.build.picks.indexOf(pid);
    if (at2 > -1) S.build.picks.splice(at2, 1); else S.build.picks.push(pid);
    S.buildDirty = true;
    stopAll(); refreshGains(); render();
    return;
  }
  if (e.target.closest('#ver-save') || e.target.closest('#ver-save-top')) { saveVersion(); return; }
  var pvr = e.target.closest('[data-playver]');
  if (pvr) {
    var ver = S.versions.filter(function (v) { return v.id === pvr.dataset.playver; })[0];
    if (ver) playVersion(ver);
    if (el('stage-released').classList.contains('on')) renderRelease();
    return;
  }
  if (e.target.closest('[data-playofficial]')) {
    var wasOfficial = !S.override && S.view !== 'build' && running;
    stopAll(); S.override = null; S.view = 'lineup'; refreshGains();
    if (!wasOfficial) play(0); else render();
    return;
  }
  var lk = e.target.closest('[data-like]');
  if (lk) {
    var lv = S.versions.filter(function (v) { return v.id === lk.dataset.like; })[0];
    if (lv && !me) { need('like').then(function () { likeVersion(lv.id); }); return; }
    if (lv) likeVersion(lv.id);
    return;
  }
  var fk = e.target.closest('[data-fork]');
  if (fk) {
    var src = S.versions.filter(function (v) { return v.id === fk.dataset.fork; })[0];
    if (src) {
      stopAll();
      S.build = { picks:livePicks(src.picks), ctl:JSON.parse(JSON.stringify(src.ctl || {})) };
      S.override = null; S.view = 'build';
      if (el('stage-released').classList.contains('on')) setPhase('open');
      refreshGains(); render();
      el('daw').scrollIntoView({ behavior:'smooth', block:'start' });
      flash('Loaded "' + src.name + '" into the builder. Change it and save it as your own.');
    }
    return;
  }
  if (e.target.closest('[data-moretoggle]')) { S.moreOpen = !S.moreOpen; renderDaw(); return; }
  var alone = e.target.closest('[data-alone]');
  if (alone) { if (S.trial) { S.trial = null; refreshGains(); } previewGroup(findTake(alone.dataset.alone)); return; }
  var tr = e.target.closest('[data-try]');
  if (tr) {
    var tid = tr.dataset.try;
    S.trial = (S.trial === tid) ? null : tid;
    S.override = null; S.view = 'lineup';
    stopAll(); render();
    if (S.trial) { play(0); flash('Playing the stack with this take on top.'); }
    else flash('Back to the stack as it stands.');
    return;
  }
  if (e.target.closest('[data-untrial]')) { S.trial = null; stopAll(); render(); return; }
  var vt = e.target.closest('[data-vote]');
  if (vt) {
    var vtake = findTake(vt.dataset.take);
    if (!vtake || !canVote(vtake)) return;
    db.castVote({ takeId:vtake.dbId, sessionId:S.session.id, voterId:me.id, value:vt.dataset.vote })
      .then(function () { flash('Vote counted. The creator still makes the call.'); return refresh(); })
      .catch(oops);
    return;
  }
  var mu = e.target.closest('[data-mute]');
  if (mu) { var mc = ctl(findTake(mu.dataset.mute)); mc.mute = !mc.mute; refreshGains(); render(); return; }
  var so = e.target.closest('[data-solo]');
  if (so) { var xc = ctl(findTake(so.dataset.solo)); xc.solo = !xc.solo; refreshGains(); render(); return; }
  if (e.target.closest('#transport')) { toggleTransport(); return; }
  if (e.target.closest('#rewind')) { stopAll(); offset = 0; render(); return; }
  if (e.target.closest('#play-raw')) {
    if (S.override || S.view === 'build') { stopAll(); S.override = null; S.view = 'lineup'; refreshGains(); play(0); }
    else toggleTransport();
    renderRelease(); return;
  }
  if (e.target.closest('#play-mix')) {
    if (!mixEl || mixEl.dataset.take !== S.mix.id) { mixEl = new Audio(S.mix.url); mixEl.dataset.take = S.mix.id; }
    if (mixEl.paused) { stopAll(); mixEl.currentTime = 0; mixEl.play(); } else mixEl.pause();
    return;
  }
  if (e.target.closest('#dl-all') || e.target.closest('#dl-all2')) { downloadAll(); return; }
  var cmk = e.target.closest('[data-cm]');
  if (cmk) { S.cmOpen = S.cmOpen === cmk.dataset.cm ? null : cmk.dataset.cm; S.cmDraft = null; render(); return; }
  var cpl = e.target.closest('[data-cmplay]');
  if (cpl) { play(Math.max(0, +cpl.dataset.cmplay - 2)); return; }
  var chd = e.target.closest('[data-cmhide]');
  if (chd) {
    var hid = chd.dataset.cmhide;
    db.hideComment(hid).then(function () { S.cmOpen = null; flash('Comment hidden.'); return refresh(); })
      .catch(function (err) { oops(needsUpdate(err, '20261004140000_timeline_comments.sql') || err); });
    return;
  }
  if (e.target.closest('[data-cmpost]')) { postComment(); return; }
  if (e.target.closest('[data-cmcancel]')) { S.cmDraft = null; S.cmErr = ''; render(); return; }
  if (e.target.closest('[data-cmhere]')) { openComposer(position()); return; }
  var clane = e.target.closest('.c-lane.can');
  if (clane && !e.target.closest('.cm-pop')) {
    var cr = clane.getBoundingClientRect();
    openComposer(Math.max(0, Math.min(1, (e.clientX - cr.left) / cr.width)) * duration());
    return;
  }
  if (e.target.closest('.c-lane') && !e.target.closest('.cm-pop') && S.cmOpen) { S.cmOpen = null; render(); return; }
  var lane = e.target.closest('.t-lane');
  if (lane && (justDragged || e.target.closest('.fh'))) return;
  if (lane) {
    var rect = lane.getBoundingClientRect();
    play(Math.max(0, (e.clientX - rect.left) / rect.width) * duration());
    return;
  }
  var y = e.target.closest('[data-yes]'), n = e.target.closest('[data-no]');
  if (y) { letIn(S.applicants.filter(function (t2) { return t2.id === y.dataset.yes; })[0]); return; }
  if (n) { veto(S.applicants.filter(function (t2) { return t2.id === n.dataset.no; })[0]); return; }
  var ap = e.target.closest('[data-apply]');
  if (ap) { openModal(ap.dataset.apply); return; }
  var ow = e.target.closest('[data-own]');
  if (ow) {
    if (S.view !== 'build' || S.override) { stopAll(); S.override = null; S.trial = null; S.view = 'build'; refreshGains(); render(); }
    openModal(ow.dataset.own, null, true);
    return;
  }
  if (e.target.closest('[data-ownstart]')) {
    if (S.view !== 'build' || S.override) {
      stopAll(); S.override = null; S.trial = null; S.view = 'build'; refreshGains(); render();
      flash('Your version. Pick takes from every instrument, record your own, then save it.');
    }
    el('daw').scrollIntoView({ behavior:'smooth', block:'start' });
    return;
  }
  var so2 = e.target.closest('[data-sendown]');
  if (so2) {
    var ot = findTake(so2.dataset.sendown);
    if (!ot || !isOwn(ot) || !mine(ot)) return;
    so2.disabled = true; so2.textContent = 'Sending...';
    db.sendOwnTake(ot.dbId).then(function () {
      flash('Sent. Your ' + role(ot.roleId).label.toLowerCase() + ' take is waiting for the creator, and stays in your version.');
      return refresh();
    }).catch(function (err) { so2.disabled = false; so2.textContent = 'Send to the creator'; oops(needsUpdate(err, '20261004120000_own_takes.sql') || err); });
    return;
  }
  var react = e.target.closest('[data-react]');
  if (react && S.session && !me) { var rk = react.dataset.react; need('like').then(function () { if (!S.reacted[rk]) { S.reacted[rk] = true; S.reactions[rk] = (S.reactions[rk] || 0) + 1; renderRelease(); db.react({ sessionId:S.session.id, userId:me.id, kind:rk }).then(refresh).catch(oops); } }); return; }
  if (react && S.session && !S.reacted[react.dataset.react]) {
    var kind = react.dataset.react;
    S.reacted[kind] = true; S.reactions[kind] = (S.reactions[kind] || 0) + 1; renderRelease();
    db.react({ sessionId:S.session.id, userId:me.id, kind:kind }).then(refresh).catch(oops);
    return;
  }
  if (e.target.closest('#copy-link')) {
    if (!S.session) { flash('Drop a track first, then you get a link to share.'); return; }
    var link = location.origin + '/s/' + S.session.slug;
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject())
      .then(function () { flash('Link copied. Anyone with it can add takes.'); },
            function () { flash('Share this link: ' + link); });
  }
});

document.addEventListener('input', function (e) {
  if (e.target.dataset.xfade) {
    var xt = findTake(e.target.dataset.xfade);
    if (xt) { xt.xfade = +e.target.value; var em = e.target.parentNode.querySelector('em'); if (em) em.textContent = xf(xt).toFixed(1) + ' s'; }
    return;
  }
  if (e.target.dataset.vol) {
    var t = findTake(e.target.dataset.vol);
    if (t) { ctl(t).vol = +e.target.value; refreshGains(); }
  }
  if (e.target.id === 'meta-bpm' && isHost()) {
    S.meta.bpm = +e.target.value || null; S.meta.from = 'you';
    clearTimeout(bpmTimer);
    bpmTimer = setTimeout(function () { patchSession({ bpm:S.meta.bpm, meta_from:'you' }); }, 600);
  }
  if ((e.target.id === 'song-title' || e.target.id === 'proj-title') && isHost()) {
    S.title = e.target.value.trim() || 'Untitled';
    el('session-name').textContent = projName();
    clearTimeout(titleTimer);
    titleTimer = setTimeout(function () { patchSession({ title:(S.title || 'Untitled').slice(0, 120) }); }, 600);
  }
});
document.addEventListener('change', function (e) {
  if (e.target.dataset.xfade) {
    var xt = findTake(e.target.dataset.xfade), wasRunning = running, pos = position();
    renderDaw();
    if (wasRunning) play(Math.min(pos, duration() - 0.1));
    saveFades(xt);
    return;
  }
  if (e.target.dataset.countin) {
    S.countIn = +e.target.value;
    [].forEach.call(document.querySelectorAll('select[data-countin]'), function (s) { s.value = String(S.countIn); });
    if (el('countin-text')) countInLabel();
    return;
  }
  if (e.target.id === 'daw-rec-role') { S.recRole = e.target.value; showAmpPick(e.target.value); rearm(); return; }
  if (e.target.classList.contains('amp-pick')) {
    rememberAmp(e.target.value);
    preloadAmp(e.target.value);
    [].forEach.call(document.querySelectorAll('.amp-pick'), function (sel) { sel.value = e.target.value; });
    rearm();
    return;
  }
  if (e.target.classList.contains('mon-pick')) {
    rememberMon(e.target.checked);
    [].forEach.call(document.querySelectorAll('.mon-pick'), function (c) { c.checked = e.target.checked; });
    if (e.target.checked) arm(); else disarmMonitor();
    return;
  }
  if (e.target.classList.contains('mic-pick')) {
    rememberMic(e.target.value);
    [].forEach.call(document.querySelectorAll('.mic-pick'), function (sel) { sel.value = e.target.value; });
    rearm();
    return;
  }
  if (e.target.dataset.hear) {
    if (e.target.dataset.hear === 'click') REC.click = e.target.checked;
    else REC.hear[e.target.dataset.hear] = e.target.checked;
    return;
  }
  if (e.target.id === 'meta-key' && isHost())  { S.meta.key = e.target.value; S.meta.from = 'you'; patchSession({ music_key:S.meta.key, meta_from:'you' }); renderSeed(); }
  if (e.target.id === 'meta-seedrole' && isHost()) setSeedRole(e.target.value || null);
  if (e.target.id === 'meta-time' && isHost()) { S.meta.time = e.target.value; patchSession({ time_sig:S.meta.time }); renderSeed(); renderDaw(); }
  if (e.target.id === 'mix-file' && e.target.files[0]) {
    uploadMix(e.target.files[0]);
  }
});
(function () {
  var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'audio/*'; inp.multiple = true; inp.id = 'draft-files'; inp.hidden = true;
  document.body.appendChild(inp);
  inp.addEventListener('change', function () {
    var files = [].slice.call(inp.files || []).slice(0, 4 - (S.drafts || []).length), want = secLen('core');
    Promise.all(files.map(function (f) { return decode(f).then(function (b) { return { f:f, b:b }; }); })).then(function (list) {
      var bad = list.filter(function (x) { return want && Math.abs(x.b.duration - want) > TOL; });
      list.filter(function (x) { return bad.indexOf(x) < 0; }).forEach(function (x) { addDraft(x.f, x.b, guessRole(x.f.name)); });
      if (bad.length) flash(bad.map(function (x) { return x.f.name; }).join(', ') + ': not ' + fmt(want) + ' long, so left out. Every track has to be as long as the clip.');
      inp.value = ''; refreshGains(); renderDaw();
    }).catch(function () { flash('One of those files could not be read. Try wav or mp3.'); inp.value = ''; });
  });
  document.addEventListener('change', function (e) {
    var sel = e.target.closest && e.target.closest('[data-draftrole]'); if (!sel) return;
    (S.drafts || []).forEach(function (d) { if (d.t.id === sel.dataset.draftrole) d.t.roleId = sel.value; });
    renderDaw();
  });
})();
window.addEventListener('resize', function () { tracks().forEach(drawWave); drawSeedWave(); placeFadeHandles(); });

[].forEach.call(document.querySelectorAll('.phase'), function (b) {
  b.addEventListener('click', function () { setPhase(b.dataset.phase); });
});
el('lock-btn').addEventListener('click', function () {
  if (!isHost()) return;
  stopAll();
  patchSession({ status:'released', released_at:new Date().toISOString() }).then(function () {
    flash('The song is released. It plays as it stands, and anyone can still add a Mix.');
    return refresh();
  });
});

render();

/* ---------- writes that wait for an account ---------- */
function likeStack() {
  var cst = currentStack(); if (!cst || !S.session) return;
  if (!me) { need('like').then(likeStack); return; }
  var k = keyOf(cst.takes);
  if (S.stackLiked[k]) return;
  S.stackLiked[k] = true; S.stackLikes[k] = (S.stackLikes[k] || 0) + 1; renderDaw();
  db.likeStack({ stackKey:k, sessionId:S.session.id, userId:me.id }).then(refresh, oops);
}
function likeVersion(id) {
  var lv = S.versions.filter(function (v) { return v.id === id; })[0];
  if (!lv || lv.liked) return;
  lv.liked = true; lv.likes++; renderVersionLists();
  db.likeVersion({ versionId:lv.id, sessionId:S.session.id, userId:me.id }).then(refresh).catch(oops);
}
function saveVersion() {
  if (!S.build.picks.length || !S.session) return;
  if (!me) { need('version').then(function () { renderPicker(); saveVersion(); }); return; }
  var who = myName() || 'someone';
  var nm = ((el('ver-name') && el('ver-name').value) || '').trim() || (who + '’s stack');
  db.saveVersion({ session_id:S.session.id, author_id:me.id, name:nm.slice(0, 60), by_name:who.slice(0, 60),
                   picks:S.build.picks.slice(), ctl:JSON.parse(JSON.stringify(S.build.ctl)) })
    .then(function (row) {
      if (el('ver-name')) el('ver-name').value = '';
      S.buildDirty = false; S.build.picks = [];
      var v = row && (row[0] || row);
      if (v && v.id) { S.stack = 'v-' + v.id; }
      S.view = 'lineup';
      flash('Saved "' + nm + '". It is with the stacks above the tracks, and in the thread.');
      return refresh();
    }).catch(oops);
}
function uploadMix(f) {
  if (!me) { need('mix').then(function () { uploadMix(f); }); return; }
  var by = myName();
  flash('Uploading the Mix...');
  decode(f).then(function (buf) {
    return uploadTake(f, buf, { role:'mix', status:'mix', name:by, analyse:false });
  }).then(function () {
    mixEl = null;
    flash('The Mix is added next to the song.');
    return refresh();
  }).catch(oops);
}

/* ---------- boot ---------- */
function boot() {
  if (!configured) {
    flash('Supabase is not configured. Copy .env.example to .env.local and fill it in.');
    return;
  }
  setToast(flash);
  /* listening needs no account: load the session once we know who is here (or that nobody is
     signed in), and refetch when someone signs in or out, so host controls and "mine" follow */
  var ready = new Promise(function (resolve) {
    onAccount(function (user) {
      var was = me && me.id;
      me = user;
      if (ready) { if (was !== (user && user.id) && S.session) refresh(); else render(); }
      resolve();
    });
  });
  ready.then(function () {
    var m = location.pathname.match(/^\/s\/([\w-]+)/);
    if (!m) { flash('Drop an audio track to start a session. You will get a link to share.'); render(); return; }
    return db.loadSessionBySlug(m[1]).then(function (sess) {
      if (!sess) { flash('That session does not exist. Drop a track to start a new one.'); history.replaceState(null, '', '/new'); render(); return; }
      S.session = sess;
      watch(sess.id);
      return refresh().then(function () {
        flash(isHost() ? 'You started this session. Copy the invite link to bring people in.' : 'You are in. Add a take on any layer, or pitch a new part.');
      });
    });
  }).catch(oops);
}
boot();
refreshMics();

/* The homepage (/): a grid of jams; each opens its wall (src/wall.js) in a panel.

   A jam is a session with an original track. Its thread holds the audio replies (takes;
   takes.reply_to says which take a reply was played on top of) and the written replies
   (thread_comments), and anyone can up- or downvote the jam, a take or a comment
   (thread_votes). Reading needs no sign-in; every write (a comment, a vote, a take, a new
   jam) asks for an account first (src/auth.js) and carries on once there is one. Playing a take plays it with the stack it was played on.

   The markup is built from strings like in app.js; render() redraws the whole page. */

import './theme.js';
import { configured } from './supabase.js';
import * as db from './data.js';
import { requireAccount, onAccount, postingAs, setToast, profileHref } from './auth.js';
import { analyse, sureness } from './analysis.js';
import { ROLES, role } from './roles.js';
import { glyph } from './icons.js';
import { peaksOfBuffer, decodePeaks, columns } from './peaks.js';
import { sendPlayCopy, encodeRender } from './playcopy.js';
import { initWall, wallHtml, wallTree, wallKey, wallWhose, wallSegs, wallPick, wallSeek, wallSolo, wallHead, wallScrolls, wallFit, wallFullId, ghostOff } from './wall.js';
import { AMPS, renderAmp, liveAmp, dropAmp, preloadAmp } from './amp.js';
import { AMP_ROLES, savedMic, rememberMic, savedAmp, rememberAmp, savedMon, rememberMon, recAmpFor, recWorklet, openMic, fadeIn, fadeOut, listMics, capture, newContext, wakeAudio, soundTip, rateTip, monitorOn, armMonitor, disarmMonitor, allowInputs, inputLatency, blockPeaks,
         beatInfoFor, clickSamples, assembleTake, bleedNote, quietNote, micError, encodeWav } from './rec.js';

var TOL = 0.6;                     /* seconds a take may differ from what it plays on (as in app.js) */

var LAYERS = { seed:{ label:'original track', c:'var(--seed)' }, part:{ label:'new part', c:'var(--part)' } };
ROLES.forEach(function (r) { LAYERS[r.id] = { label:r.label.toLowerCase(), c:'var(' + r.color + ')' }; });
function lay(id) { return LAYERS[id] || LAYERS.wild; }

var RIFFS = [];
var S = { tab:'fresh', expanded:{}, vote:{}, playing:null, loaded:false, failed:null, sure:null };
var KIND = {};                     /* target id -> { kind, sid } for votes */
var me = null;                     /* the signed-in account (src/auth.js), or null */
var AC = null, BUF = {}, SRC = [], FADE = null;

function el(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function extOf(name) { return (name && name.indexOf('.') > -1) ? name.split('.').pop().toLowerCase() : 'wav'; }
function typeFor(file) {
  if (file.type) return file.type;
  var map = { wav:'audio/wav', mp3:'audio/mpeg', m4a:'audio/mp4', aac:'audio/aac', ogg:'audio/ogg', flac:'audio/flac', aif:'audio/aiff', aiff:'audio/aiff', webm:'audio/webm' };
  return map[extOf(file.name)] || 'audio/wav';
}
function ago(iso) {
  var m = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return Math.round(m) + ' minute' + (Math.round(m) > 1 ? 's' : '') + ' ago';
  var h = m / 60; if (h < 24) return Math.round(h) + ' hour' + (Math.round(h) > 1 ? 's' : '') + ' ago';
  var d = h / 24; if (d < 2) return 'yesterday';
  if (d < 7) return Math.round(d) + ' days ago';
  if (d < 14) return 'last week';
  return new Date(iso).toLocaleDateString(undefined, { day:'numeric', month:'short' });
}
function mmss(t) { t = Math.max(0, t || 0); return Math.floor(t / 60) + ':' + ('0' + Math.floor(t % 60)).slice(-2); }
var toastT = 0;
function toast(m) { var t = el('toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('on'); }, 4500); }
function oops(e) { console.error(e); toast((e && e.message) || 'Something went wrong. Try again.'); }

/* every write needs an account with a name; this asks for one (sign up or sign in) and
   resolves once it's there, so the action carries on. why: a key of auth.js's reasons */
function ensureMe(why) {
  return requireAccount(why).then(function (u) { me = u; return u; });
}
function jamCard(r, why) {
  var a = { play:'Sign up to play along', reply:'Sign up to reply' }[why];
  var b = { play:'Every take carries your name and shows up on your profile. It takes a minute, and you can listen without an account.',
            reply:'Every reply carries your name. It takes a minute, and you can read and listen without an account.' }[why];
  return { heading:a, text:b, jam:{ title:r.title, meta:['by ' + r.by, r.bpm ? r.bpm + ' BPM' : '', r.key || ''].filter(Boolean).join(' · ') } };
}

/* ---------- data -> the feed ---------- */
function build(feed) {
  var votes = {}, mine = {};
  KIND = {};
  feed.votes.forEach(function (v) {
    if (me && v.voter_id === me.id) mine[v.target_id] = v.value;
    else votes[v.target_id] = (votes[v.target_id] || 0) + v.value;
  });
  S.vote = mine;
  RIFFS = feed.sessions.map(function (s) {
    var tk = feed.takes.filter(function (t) { return t.session_id === s.id; });
    var seed = tk.filter(function (t) { return t.id === s.seed_take_id; })[0];
    if (!seed) return null;
    var title = s.title && s.title !== 'Untitled' ? s.title : seed.author_name + '’s track';
    var posts = [], mix = null, rowOf = {};
    tk.forEach(function (t) { rowOf[t.id] = t; });
    /* tracks carried into a new part (takes.carry) play again under it */
    function carried(ids) {
      return (ids || []).map(function (id) {
        var c = rowOf[id]; if (!c || c.status === 'deleted' || c.role_id === 'part' || c.role_id === 'mix') return null;
        if (c.id === s.seed_take_id) return Object.assign({ id:'riff', isRiff:true, by:seed.author_name, layer:LAYERS[s.seed_role] ? s.seed_role : 'seed', dur:seed.duration_sec, peaks:seed.peaks || null }, sound(seed));
        return Object.assign({ id:c.id, by:c.author_name, uid:c.author_id, layer:LAYERS[c.role_id] ? c.role_id : 'wild', dur:c.duration_sec, peaks:c.peaks || null }, sound(c));
      }).filter(Boolean);
    }
    KIND[s.id] = { kind:'session', sid:s.id };
    tk.forEach(function (t) {
      if (t.id === s.seed_take_id || t.role_id === 'seed') return;
      if (t.role_id === 'mix') { if (t.status === 'mix') mix = { by:t.author_name, url:db.playUrl(t) }; return; }
      if (t.status === 'own') return;   /* own takes only live in someone's version */
      if (t.status === 'deleted') {
        /* a deleted take stays as an empty spot, so the replies played on it keep their place */
        if (t.role_id !== 'part') posts.push({ id:t.id, parent:t.reply_to || t.section_id || null, deleted:true, created:t.created_at, likes:0 });
        return;
      }
      var base = { id:t.id, by:t.author_name, uid:t.author_id, mine:!!(me && t.author_id === me.id), time:ago(t.created_at), created:t.created_at,
        text:t.note, path:t.storage_path, copy:t.play_path || null, dur:t.duration_sec, peaks:t.peaks || null, likes:votes[t.id] || 0, status:t.status };
      Object.assign(base, sound(t));
      KIND[t.id] = { kind:'take', sid:s.id };
      if (t.role_id === 'part') {
        if (t.status !== 'in' && t.status !== 'waiting') return;
        /* a new part is a reply on the stack it was made on (reply_to), or on the jam */
        posts.push(Object.assign(base, { parent:t.reply_to || null, kind:'part', layer:'part', pos:t.part_pos, carry:carried(t.carry) }));
        return;
      }
      posts.push(Object.assign(base, { parent:t.reply_to || t.section_id || null, section:t.section_id || null, group:t.group_id || null,
        layer:LAYERS[t.role_id] ? t.role_id : 'wild' }));
    });
    feed.comments.filter(function (c) { return c.session_id === s.id; }).forEach(function (c) {
      KIND[c.id] = { kind:'comment', sid:s.id };
      if (c.deleted_at) { posts.push({ id:c.id, parent:c.reply_to_take || c.reply_to_comment || null, deleted:true, isComment:true, created:c.created_at, likes:0 }); return; }
      posts.push({ id:c.id, parent:c.reply_to_take || c.reply_to_comment || null, by:c.author_name, uid:c.author_id, mine:!!(me && c.author_id === me.id),
        time:ago(c.created_at), created:c.created_at, text:c.body, likes:votes[c.id] || 0, isComment:true });
    });
    /* takes sent together as one reply: the first is the post, the others play as its stems */
    var groups = {};
    posts = posts.filter(function (p) {
      var g = p.group; if (!g || p.deleted) return true;
      if (!groups[g]) { groups[g] = p; p.stems = []; return true; }
      groups[g].stems.push({ id:p.id, by:p.by, uid:p.uid, mine:p.mine, layer:p.layer, url:p.url, path:p.path, copy:p.copy, dur:p.dur, peaks:p.peaks, amp:p.amp, wet:p.wet, tid:p.tid, sid:p.sid }); return false;
    });
    posts.sort(function (a, b) { return String(a.created).localeCompare(String(b.created)); });
    /* a reply on something the feed leaves out (a deleted take) moves up to the jam */
    var ids = {}; posts.forEach(function (p) { ids[p.id] = 1; });
    posts.forEach(function (p) { if (p.parent && !ids[p.parent]) p.parent = null; });
    /* deleted posts nobody replied to disappear; the ones with replies stay as a placeholder */
    for (var again = true; again;) {
      again = false;
      posts = posts.filter(function (p) {
        if (!p.deleted || posts.some(function (k) { return k.parent === p.id; })) return true;
        again = true; return false;
      });
    }
    var r = { id:s.id, slug:s.slug, by:seed.author_name, uid:s.host_id, title:title, bpm:s.bpm, key:s.music_key || '', sig:s.time_sig && s.time_sig !== '4/4' ? s.time_sig : '',
      time:ago(s.created_at), text:seed.note, layer:LAYERS[s.seed_role] ? s.seed_role : 'seed', dur:seed.duration_sec, peaks:seed.peaks || null,
      likes:votes[s.id] || 0, host:!!(me && s.host_id === me.id), open:s.status === 'open', mix:mix, posts:posts };
    Object.assign(r, sound(seed), { id:s.id, uid:s.host_id });
    if (s.status === 'released') r.song = { name:title, musicians:players(r).length + 1 };
    return r;
  }).filter(Boolean);
}
/* coming back from the song view: /?open=<jam id>&tid=<take id> opens that thread at that take */
var LANDING = (function () { try { var q = new URLSearchParams(location.search); return q.get('open') ? { open:q.get('open'), tid:q.get('tid') } : null; } catch (e) { return null; } })();
function land() {
  var r = LANDING && riff(LANDING.open); if (!r) { LANDING = null; return; }
  var hit = LANDING.tid ? postOf(r, LANDING.tid) || r.posts.filter(function (p) { return (p.stems || []).some(function (x) { return x.id === LANDING.tid; }); })[0] : null;
  LANDING = null;
  /* back from the project, the jam opens in its panel on the stack you had open */
  openJam(r.id); if (hit) { S.wsel[r.id] = hit.id; render(); }
  render();
  setTimeout(function () {
    var n = hit ? el('post-' + r.id + '-' + hit.id) : el('riff-' + r.id);
    if (n) { n.scrollIntoView({ block: hit ? 'center' : 'start' }); if (hit) n.classList.add('hl'); }
  }, 60);
}
/* names link to their profiles once we know who has one (user id -> name) */
var PROF = {};
function nameOf(text, uid) {
  return uid && PROF[uid] ? '<a class="pf-name" href="' + profileHref(PROF[uid]) + '">' + esc(text) + '</a>' : esc(text);
}
function askProfiles(feed) {
  var ids = feed.sessions.map(function (s) { return s.host_id; })
    .concat(feed.takes.map(function (t) { return t.author_id; }), feed.comments.map(function (c) { return c.author_id; }))
    .filter(function (id) { return id && !(id in PROF); });
  if (!ids.length) return;
  db.profilesFor(ids).then(function (names) {
    ids.forEach(function (id) { PROF[id] = names[id] || null; });
    if (Object.keys(names).length) render();
  }).catch(function (e) { console.warn('Could not load the profile names', e); });
}
function reload() {
  if (!configured) { S.failed = 'Supabase is not configured. Copy .env.example to .env.local and fill it in.'; render(); return Promise.resolve(); }
  return db.loadFeed(20).then(function (feed) { build(feed); S.loaded = true; S.failed = null; render(); askProfiles(feed); if (LANDING) land(); })
    .catch(function (e) { console.error(e); S.failed = 'The jams could not be loaded. Check your connection and reload the page.'; render(); });
}

/* ---------- votes: the score is everyone else's votes plus yours ---------- */
function score(base, k) { return base + (S.vote[k] || 0); }
function voteHtml(k, base) {
  var v = S.vote[k] || 0;
  return '<span class="vote" role="group" aria-label="Vote">' +
    '<button type="button" class="up" data-vote="' + k + '" data-dir="1" aria-pressed="' + (v === 1) + '" aria-label="Upvote">&#9650;</button>' +
    '<b>' + score(base, k) + '</b>' +
    '<button type="button" class="down" data-vote="' + k + '" data-dir="-1" aria-pressed="' + (v === -1) + '" aria-label="Downvote">&#9660;</button></span>';
}
function vote(k, dir) {
  var t = KIND[k]; if (!t) return;
  ensureMe('vote').then(function (u) {
    var before = S.vote[k] || 0, value = before === dir ? 0 : dir;
    S.vote[k] = value; render();
    return db.voteInThread({ targetId:k, targetKind:t.kind, sessionId:t.sid, voterId:u.id, value:value })
      .catch(function (e) { S.vote[k] = before; render(); oops(e); });
  });
}

/* a reply to a comment in the wall */
document.addEventListener('submit', function (e) {
  var f = e.target.closest && e.target.closest('[data-wcrepform]'); if (!f) return;
  e.preventDefault();
  var rid = f.dataset.wcrepform, r = riff(rid), t = el('wcrep-' + rid), text = t ? t.value.trim() : '', go = f.querySelector('button[type=submit]');
  if (!r) return;
  if (!text) { if (t) t.focus(); return; }
  if (go) go.disabled = true;
  ensureMe('reply').then(function (u) {
    return db.addThreadComment({ session_id:r.id, reply_to_take:null, reply_to_comment:f.dataset.post, author_id:u.id, author_name:db.accountName(u), body:text });
  }).then(function () { S.wcrep[rid] = null; if (t) t.value = ''; return reload().then(function () { toast('Your reply is posted.'); }); })
    .catch(function (err) { if (go) go.disabled = false; toast((err && err.message) || 'That didn’t work, try again.'); });
});
/* a comment from the wall: on the song as a whole, on the original track, or on one take */
document.addEventListener('submit', function (e) {
  var f = e.target.closest && e.target.closest('[data-wsayform]'); if (!f) return;
  e.preventDefault();
  var rid = f.dataset.wsayform, r = riff(rid), t = el('wsay-' + rid), text = t ? t.value.trim() : '';
  if (!r) return;
  if (!text) { if (t) t.focus(); toast('Write something first.'); return; }
  var on = S.wsay[rid] || '', p = on && on !== 'riff' ? postOf(r, on) : null, go = f.querySelector('button[type=submit]');
  if (go) go.disabled = true;
  ensureMe('reply').then(function (u) {
    return db.addThreadComment({ session_id:r.id, reply_to_take:p && !p.isComment ? p.id : null, reply_to_comment:p && p.isComment ? p.id : null,
      author_id:u.id, author_name:db.accountName(u), body:text });
  }).then(function () {
    if (t) t.value = '';
    S.wsay[rid] = ''; delete S.wtalk[rid];
    return reload().then(function () { toast('Your comment is posted.'); });
  }).catch(function (err) { if (go) go.disabled = false; toast((err && err.message) || 'That didn’t work, try again.'); });
});
document.addEventListener('change', function (e) {
  if (e.target.dataset && e.target.dataset.wsaywhat) { S.wsay[e.target.dataset.wsaywhat] = e.target.value; var t = el('wsay-' + e.target.dataset.wsaywhat), v = t ? t.value : ''; render(); t = el('wsay-' + e.target.dataset.wsaywhat); if (t) { t.value = v; t.focus(); } }
});
document.addEventListener('keydown', function (e) {
  if (e.target.id === 'c-text' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); postComment(); }
});

/* ---------- deleting: your own things, or anyone's as admin; two clicks ---------- */
function canDelete(owner) { return owner || db.isAdmin(me); }
function delBtn(what, id, label) {
  var k = what + ':' + id, sure = S.sure === k;
  return '<button class="ghost del' + (sure ? ' sure' : '') + '" type="button" data-del="' + k + '">' + (sure ? 'Click again to delete' : (label || 'Delete')) + '</button>';
}
var sureT = 0;
function askOrDelete(k) {
  if (S.sure !== k) { S.sure = k; render(); clearTimeout(sureT); sureT = setTimeout(function () { if (S.sure === k) { S.sure = null; render(); } }, 4000); return; }
  S.sure = null;
  var i = k.indexOf(':'), what = k.slice(0, i), id = k.slice(i + 1), job;
  if (what === 'jam') job = db.deleteJam(id);
  else {
    var r = RIFFS.filter(function (x) { return postOf(x, id); })[0], p = r && postOf(r, id);
    if (!p) return;
    if (S.playing && S.playing.indexOf(r.id) === 0) stop();
    job = p.isComment ? db.deleteThreadComment(id)
      : [p].concat(p.stems || []).reduce(function (pr, x) { return pr.then(function () { return db.deleteThreadTake(x.id, x.path, x.copy); }); }, Promise.resolve());
  }
  job.then(reload).then(function () {
    toast(what === 'jam' ? 'The jam is deleted.' : 'Deleted. Replies to it stay in the thread.');
  }).catch(function (e) { render(); oops(e); });
}

/* ---------- the thread ---------- */
function riff(id) { return RIFFS.filter(function (r) { return r.id === id; })[0]; }
function postOf(r, id) { return r.posts.filter(function (p) { return p.id === id; })[0]; }
function kids(r, id) { return r.posts.filter(function (p) { return p.parent === id; }); }
function audioPosts(r) { return r.posts.filter(function (p) { return p.layer && p.kind !== 'part'; }); }
function livePosts(r) { return r.posts.filter(function (p) { return !p.deleted; }); }
function players(r) { var seen = {}; return audioPosts(r).filter(function (p) { if (seen[p.by]) return false; seen[p.by] = 1; return true; }); }
function key(r, pid) { return r.id + ':' + (pid || 'riff'); }
function whose(p) { return p.mine ? 'your' : p.by + '’s'; }
/* the original track (or the new part a take sits on) plus every take from the top of the thread down to this one */
function stemsOf(p) { return [p].concat((p.stems || []).map(function (x) { return Object.assign({}, x, { id:p.id + '~' + x.id, dbId:x.id }); })); }
function chainOf(r, pid) {
  var out = [];
  for (var p = pid ? postOf(r, pid) : null; p; p = p.parent ? postOf(r, p.parent) : null) {
    if (p.kind === 'part') return [{ id:p.id, by:p.by, mine:p.mine, layer:'part', url:p.url, dur:p.dur, peaks:p.peaks, isPart:true }].concat(p.carry || [], out);
    if (p.layer) out = stemsOf(p).concat(out);
  }
  return [{ id:'riff', by:r.by, uid:r.uid, layer:r.layer, url:r.url, dur:r.dur, peaks:r.peaks, isRiff:true, mine:r.host, amp:r.amp, wet:r.wet, tid:r.tid, sid:r.sid }].concat(out);
}
function bufKey(r, p) { return p.isRiff ? r.id + ':riff' : r.id + ':' + p.id; }
function chipLabel(p) { return p.isRiff ? 'clip' : p.isPart ? 'new part' : lay(p.layer).label; }

/* ---------- audio ---------- */
function ac() { if (!AC) AC = newContext(); return AC; }
/* every tap wakes the sound (iPhones: silent switch, in-app browsers) */
['touchend', 'click'].forEach(function (ev) { document.addEventListener(ev, function () { wakeAudio(AC); }, true); });
document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('[data-play],[data-jplay],[data-wpick],[data-wsel],[data-wsolo],#transport,.play')) soundTip(toast); }, true);

/* DL: the downloads still running, each with what asked for it (`who`: a playList key, or '*' for
   anything else). A card left before it plays gives up the ones nothing else needs (dropLoads). */
var DL = {};
function load(r, p, who) {
  var k = bufKey(r, p);
  if (BUF[k] || !p.url) return Promise.resolve();
  if (BUF[k + ':loading']) { if (DL[k]) { DL[k].who[who || '*'] = 1; return DL[k].p; } return Promise.resolve(); }
  BUF[k + ':loading'] = true;
  BUF[k + ':wet'] = !!p.wet;   /* the stored render, already through the amp */
  var d = DL[k] = { ctl:window.AbortController ? new AbortController() : null, who:{} };
  d.who[who || '*'] = 1;
  d.p = fetch(p.url, d.ctl ? { signal:d.ctl.signal } : {}).then(function (x) { if (!x.ok) throw new Error(x.status); return x.arrayBuffer(); })
    .then(function (ab) { if (DL[k] === d) delete DL[k]; return ac().decodeAudioData(ab); })
    .then(function (b) { BUF[k] = b; drawWaves(); })
    .catch(function (e) {
      if (DL[k] === d) delete DL[k];
      if (e && e.name === 'AbortError') { delete BUF[k + ':loading']; return; }   /* a later play loads it again */
      console.warn('Could not load audio', p.url, e);
    });
  return d.p;
}
function dropLoads(who) {
  Object.keys(DL).forEach(function (k) {
    var d = DL[k]; delete d.who[who];
    if (!Object.keys(d.who).length && d.ctl) d.ctl.abort();
  });
}
/* What a take's row plays (db.playSource()): with an amp, its stored render (take_renders) when
   there is one, already through the amp (wet); otherwise the dry original, rendered here. */
function sound(row) {
  var amp = row.amp || '', src = db.playSource(row, amp);
  return { url:src.url, amp:amp, wet:!!amp && src.src === amp, tid:row.id, sid:row.session_id, uid:row.author_id };
}
/* A take with an amp (a dry DI guitar, set in the song view) plays rendered through it.
   The render is made once and kept next to the dry audio; if it fails, the take plays dry.
   Made here, it is stored for everyone when this is the take's author, the jam's creator or
   the admin (as in the project), so the next listener plays it right away. */
function ampKey(r, p) { return bufKey(r, p) + '@' + p.amp; }
function amped(r, p) {
  var b = BUF[bufKey(r, p)], k = ampKey(r, p);
  if (!p.amp || !b || BUF[k] || BUF[k + ':failed']) return Promise.resolve();
  if (BUF[bufKey(r, p) + ':wet']) { BUF[k] = b; return Promise.resolve(); }
  if (!BUF[k + ':busy']) BUF[k + ':busy'] = renderAmp(b, p.amp).then(function (x) { BUF[k] = x; keepRender(r, p, x); }, function (e) { console.warn('Could not render the amp', e); BUF[k + ':failed'] = true; });
  return BUF[k + ':busy'];
}
function keepRender(r, p, buf) {
  if (!me || !p.tid || !p.sid || !(p.uid === me.id || r.host || db.isAdmin(me))) return;
  encodeRender(buf).then(function (blob) { return db.storeRender({ id:p.tid, session_id:p.sid }, p.amp, blob); })
    .catch(function (e) { console.warn('The amp render was not stored; it plays here all the same:', e); });
}
function bufFor(r, p) { return (p.amp && BUF[ampKey(r, p)]) || BUF[bufKey(r, p)]; }
/* FADE: the gain everything that plays goes through; stopping takes it down over 5 ms first */
var SEQ = 0;   /* bumps with every stop or start, so a stack that plays round and round knows it is over */
function silence() { SEQ++; if (SRC.length) fadeOut(ac(), FADE, SRC); SRC = []; FADE = null; }
function stop() { silence(); S.playing = null; CLOCK = null; }
/* CLOCK: when the loop that is playing started and how long it is, for the playhead */
var CLOCK = null;
/* play a list of takes together, looped; `at` (seconds) starts somewhere in the middle.
   Playing what already plays stops it, unless `at` is given: then it jumps there. */
function playList(k, r, c, at) {
  var seek = typeof at === 'number';
  if (S.playing === k && !seek) { stop(); render(); return; }
  var was = S.playing;
  silence(); CLOCK = null;
  S.playing = k; if (was !== k) render();
  Promise.all(c.map(function (p) { return load(r, p, k); })).then(function () {
    return Promise.all(c.map(function (p) { return amped(r, p); }));
  }).then(function () {
    if (S.playing !== k) return;
    var a = ac(); a.resume(); var T = a.currentTime + 0.05, len = 0;
    c.forEach(function (p) { var b = bufFor(r, p); if (b) len = Math.max(len, b.duration); });
    var from = seek ? ((at % len) + len) % len : 0, fade = FADE = fadeIn(a, T, a.destination);
    c.forEach(function (p) {
      var b = bufFor(r, p); if (!b) return;
      var s = a.createBufferSource(); s.buffer = b; s.loop = true; s.connect(fade);
      s.start(T, from % b.duration); SRC.push(s);
    });
    CLOCK = { k:k, t0:T - from, len:len };
    tickHeads();
  });
}
/* while a stack plays, everything in it sounds: the take you pressed and everything it was
   played on. Those all show as playing, and pressing any of them pauses the whole stack. */
function sounding(r, pid) {
  if (!r || !S.playing || S.playing.indexOf(r.id + ':') !== 0) return false;
  var cur = S.playing.slice(r.id.length + 1);
  if (cur === (pid || 'riff')) return true;
  if (cur === 'riff' || cur === 'song' || cur === 'mix' || !postOf(r, cur)) return false;
  return chainOf(r, cur).some(function (x) { return pid ? x.id === pid || x.dbId === pid : x.isRiff; });
}
function play(rid, pid, at) {
  var r = riff(rid);
  if (typeof at !== 'number' && S.playing !== key(r, pid) && sounding(r, pid)) { stop(); render(); return; }
  playList(key(r, pid), r, chainOf(r, pid), at);
}

/* where the playing sound is now, in seconds from its start (null when nothing plays) */
function playPos() {
  if (!CLOCK || CLOCK.k !== S.playing || !CLOCK.len || !AC) return null;
  var t = AC.currentTime - CLOCK.t0; return ((t % CLOCK.len) + CLOCK.len) % CLOCK.len;
}
function playSeq(k, r, segs, from) {
  var all = segs[0].concat(segs[1]);
  from = from || 0;
  silence(); CLOCK = null;
  var mine = SEQ;
  S.playing = k; render();
  Promise.all(all.map(function (x) { return load(r, x); })).then(function () {
    return Promise.all(all.map(function (x) { return amped(r, x); }));
  }).then(function () {
    (function round() {
      if (S.playing !== k || SEQ !== mine) return;
      var a = ac(); a.resume(); var T0 = a.currentTime + 0.05, T = T0, fade = FADE = fadeIn(a, T0, a.destination), skip = from, total = 0;
      segs.forEach(function (seg) { var lead = bufFor(r, seg[0]); total += lead ? lead.duration : 0; });
      CLOCK = { k:k, t0:T0 - from, len:total }; tickHeads();
      segs.forEach(function (seg) {
        var lead = bufFor(r, seg[0]), len = lead ? lead.duration : 0;
        if (skip >= len) { skip -= len; return; }   /* a segment before the place you clicked */
        seg.forEach(function (x) {
          var b = bufFor(r, x); if (!b || !len) return;
          var s = a.createBufferSource(); s.buffer = b; s.loop = true; s.connect(fade);
          s.start(T, skip % b.duration); s.stop(T + len - skip); SRC.push(s);
        });
        T += len - skip; skip = 0;
      });
      from = 0;
      setTimeout(function () { if (S.playing === k && SEQ === mine) round(); }, Math.max(0, (T - a.currentTime) * 1000) - 30);
    })();
  });
}

/* ---------- seeking: click anywhere in a waveform to play from there ---------- */
function headOf(cv, cls) {
  var box = cv.parentNode, h = box.querySelector(':scope > .' + cls + '[data-for="' + cv.dataset.wave + '"]');
  if (!h) { h = document.createElement('span'); h.className = cls; h.dataset.for = cv.dataset.wave; h.setAttribute('aria-hidden', 'true'); box.appendChild(h); }
  h.style.top = cv.offsetTop + 'px'; h.style.height = cv.offsetHeight + 'px';
  return h;
}
var headRaf = 0;
function tickHeads() {
  cancelAnimationFrame(headRaf);
  [].forEach.call(document.querySelectorAll('.phead'), function (h) { h.hidden = true; });
  if (!CLOCK || S.playing !== CLOCK.k) return;
  var pos = ((ac().currentTime - CLOCK.t0) % CLOCK.len + CLOCK.len) % CLOCK.len, f = CLOCK.len ? pos / CLOCK.len : 0;
  wallHead(pos, CLOCK.len);
  [].forEach.call(document.querySelectorAll('canvas[data-wave]'), function (cv) {
    if (cv.closest('.wm-wave')) return;
    if (S.playing !== cv.dataset.wave && S.playing !== cv.dataset.of) return;
    var h = headOf(cv, 'phead'); h.hidden = false; h.style.left = (cv.offsetLeft + cv.offsetWidth * f) + 'px';
  });
  jhoverBack();
  /* a card: one line over all its lanes */
  [].forEach.call(document.querySelectorAll('.jwv[data-jseek]'), function (w) {
    var r = riff(w.dataset.jseek), h = w.querySelector('.jhead'); if (!r || !h || S.playing !== cardKey(r)) return;
    var cpos = r.dur ? ((ac().currentTime - CLOCK.t0) % r.dur + r.dur) % r.dur : pos;
    h.hidden = false; h.style.left = (r.dur ? cpos / r.dur : f) * w.clientWidth + 'px';
  });
  headRaf = requestAnimationFrame(tickHeads);
}
function seekTarget(cv) {
  var w = cv.dataset.wave, i = w.indexOf(':'), rid = w.slice(0, i), pid = w.slice(i + 1);
  var r = riff(rid); if (!r) return null;
  if (pid === 'riff') return { r:r, pid:null };
  var p = postOf(r, pid) || postOf(r, pid.split('~')[0]);   /* a stem of a grouped reply plays its reply */
  return p ? { r:r, pid:p.id } : null;
}
/* what a waveform draws: the riff, a post, a stem of a grouped reply (<post id>~<stem id>) or a
   track carried into a new part */
function waveOf(k) {
  var i = k.indexOf(':'), r = riff(k.slice(0, i)), pid = k.slice(i + 1); if (!r) return null;
  if (pid === 'riff') return r;
  var ids = pid.split('~'), p = postOf(r, ids[0]);
  if (p && ids[1]) return (p.stems || []).filter(function (x) { return x.id === ids[1]; })[0] || null;
  if (p) return p;
  for (var j = 0; j < r.posts.length; j++) { var c = (r.posts[j].carry || []).filter(function (x) { return x.id === pid; })[0]; if (c) return c; }
  return null;
}
function lenOf(cv) { var b = BUF[cv.dataset.wave], w = !b && waveOf(cv.dataset.wave); return b ? b.duration : w && w.peaks && w.dur || 0; }
document.addEventListener('mousemove', function (e) {
  var cv = e.target.closest && e.target.closest('canvas[data-wave]');
  [].forEach.call(document.querySelectorAll('.shead'), function (h) { if (!cv || h.dataset.for !== cv.dataset.wave) h.hidden = true; });
  if (!cv || !lenOf(cv)) return;
  var rect = cv.getBoundingClientRect(), f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  var h = headOf(cv, 'shead'); h.hidden = false; h.style.left = (cv.offsetLeft + cv.offsetWidth * f) + 'px';
  h.dataset.t = mmss(f * lenOf(cv));
});
document.addEventListener('mouseleave', function () { [].forEach.call(document.querySelectorAll('.shead'), function (h) { h.hidden = true; }); }, true);
document.addEventListener('click', function (e) {
  var cv = e.target.closest && e.target.closest('canvas[data-wave]'); if (!cv || !lenOf(cv)) return;
  if (cv.closest('.wb')) {
    /* a soloed take in the wall: click its waveform to play it from there */
    if (cv.dataset.of && S.playing === cv.dataset.of) {
      e.stopImmediatePropagation();
      var rct = cv.getBoundingClientRect();
      wallSolo(cv.dataset.of.replace(/:solo$/, ''), null, Math.min(1, Math.max(0, (e.clientX - rct.left) / rct.width)) * lenOf(cv));
    }
    return;
  }
  var t = seekTarget(cv); if (!t) return;
  var rect = cv.getBoundingClientRect(), f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  play(t.r.id, t.pid, f * lenOf(cv));
});
/* a real waveform: the highest and lowest sample in every pixel column, drawn as one shape
   (from the decoded audio, or from the take's saved peaks while the audio isn't loaded;
   `peaks` is the saved string or already decoded, as the master track's sum is) */
function waveShape(cv, buf, color, peaks) {
  var w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1;
  if (!w || !h) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  var g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  g.fillStyle = color;
  var mid = h / 2, pk = !buf && (typeof peaks === 'string' ? decodePeaks(peaks) : peaks);
  if (!buf && !pk) { g.globalAlpha = .35; g.fillRect(0, mid - 1, w, 2); return; }
  var cols = Math.max(1, Math.floor(w)), hi = [], lo = [], peak = 0, x, i;
  if (pk) { var c = columns(pk, cols); hi = c.hi; lo = c.lo; peak = Math.max.apply(null, hi.concat(lo.map(function (v) { return -v; }))); }
  else {
    var d = buf.getChannelData(0), step = d.length / cols;
    for (x = 0; x < cols; x++) {
      var a = Math.floor(x * step), z = Math.min(d.length, Math.floor((x + 1) * step)), mx = 0, mn = 0;
      for (i = a; i < z; i++) { var v = d[i]; if (v > mx) mx = v; else if (v < mn) mn = v; }
      hi.push(mx); lo.push(mn); peak = Math.max(peak, mx, -mn);
    }
  }
  var k = peak ? (mid - 1) / peak : 0;
  g.beginPath(); g.moveTo(0, mid - hi[0] * k);
  for (x = 1; x < cols; x++) g.lineTo(x * w / cols, mid - Math.max(.6, hi[x] * k));
  for (x = cols - 1; x >= 0; x--) g.lineTo(x * w / cols, mid - Math.min(-.6, lo[x] * k));
  g.closePath(); g.fill();
}
function drawWaves() {
  if (CLOCK) requestAnimationFrame(tickHeads);
  var css = getComputedStyle(document.documentElement);
  [].forEach.call(document.querySelectorAll('canvas[data-wave]'), function (cv) {
    var w = cv.dataset.of || cv.dataset.wave, i = w.indexOf(':'), wp = w.slice(i + 1);
    var lit = S.playing && (S.playing === cv.dataset.wave || S.playing === cv.dataset.of || sounding(riff(w.slice(0, i)), wp === 'riff' ? null : wp));
    /* a take in a thread wears its instrument's colour; everything turns green while you hear it */
    var tone = lit && !cv.closest('.wb, .jcard') ? '--sound' : cv.closest('.wb, .jcard') && cv.dataset.layer && lay(cv.dataset.layer).c.indexOf('var(') === 0 ? lay(cv.dataset.layer).c.slice(4, -1) : '--wave';
    var b = BUF[cv.dataset.wave], wv = !b && (cv.dataset.wave.indexOf('wmix:') === 0 ? { peaks:BUF[cv.dataset.wave + ':pk'] } : waveOf(cv.dataset.wave));
    waveShape(cv, b, css.getPropertyValue(tone).trim(), wv && wv.peaks);
  });
}

/* ---------- rendering ---------- */
function lyr(layer) { return '<b class="lyr" style="color:' + lay(layer).c + '">' + lay(layer).label + '</b>'; }
/* a take's avatar wears its instrument's colour; written replies get an outlined one */
function ava(name, layer, sm) {
  return '<span class="ava' + (sm ? ' sm' : '') + (layer ? '' : ' words') + '"' + (layer ? ' style="background:' + lay(layer).c + '"' : '') + ' aria-hidden="true">' +
    esc(String(name).charAt(0).toUpperCase()) + '</span>';
}
function riffMeta(r) {
  return esc(r.time) + (r.bpm ? ' · ' + r.bpm + ' bpm' : '') + (r.key ? ' · ' + esc(r.key) : '') + (r.sig ? ' · ' + esc(r.sig) : '') + (r.dur ? ' · ' + mmss(r.dur) : '');
}
/* the wall (src/wall.js) draws with this page's state, helpers and audio */
initWall({ S:S, BUF:BUF, esc:esc, lay:lay, mmss:mmss, ava:ava, lyr:lyr, nameOf:nameOf, riffMeta:riffMeta, voteHtml:voteHtml, canDelete:canDelete, delBtn:delBtn,
  riff:riff, postOf:postOf, stemsOf:stemsOf, chainOf:chainOf, chipLabel:chipLabel, bufKey:bufKey,
  ac:ac, load:load, playList:playList, playSeq:playSeq, playPos:playPos, stop:stop, render:render, drawWaves:drawWaves });
/* ---------- preview: the homepage as a grid of jams (after Yarne's "A1 · Grid, play on hover") ----------
   Every jam is a card with its latest stack (or only its original track) as lanes of waveforms.
   Hold the mouse over a card to hear it; "Play along" opens the jam's wall in a panel in the
   middle of the screen, over a blurred page, until you close it with the X. */
S.jmode = 'latest'; S.jhover = true; S.ov = null;
/* the three steps in a few words, for phones */
var shortSteps = function () {
  var sh = [['Upload a clip.', 'It sets the tempo, key and length.'], ['Strangers stack on top.', 'Every take plays on the ones below it.'], ['You shape the song.', 'Pick the best takes; every stack stays.']];
  [].forEach.call(document.querySelectorAll('.hero .steps li'), function (li, i) {
    if (!sh[i] || li.querySelector('.st-short')) return;
    var x = document.createElement('span'), b = document.createElement('b'); x.className = 'st-short';
    b.textContent = sh[i][0]; x.appendChild(b); x.appendChild(document.createTextNode(' ' + sh[i][1])); li.appendChild(x);
  });
};
shortSteps(); document.addEventListener('DOMContentLoaded', shortSteps);
var hdrH = function () { var h = document.querySelector('header.top'); if (h) document.documentElement.style.setProperty('--hdrh', h.offsetHeight + 'px'); };
hdrH(); document.addEventListener('DOMContentLoaded', hdrH); window.addEventListener('resize', hdrH);
document.addEventListener('DOMContentLoaded', jamTools);
if (document.readyState !== 'loading') setTimeout(jamTools, 0);
/* the switches above the grid: what a card plays, and play on hover */
function jamTools() {
  if (el('jtools') || !el('list')) return;
  var d = document.createElement('div'); d.id = 'jtools'; d.className = 'jtools';
  el('list').parentNode.insertBefore(d, el('list'));
  drawJamTools();
}
function drawJamTools() {
  var d = el('jtools'); if (!d) return;
  d.innerHTML = '<div class="jseg" role="group" aria-label="What a card plays"><button type="button" data-jmode="orig" aria-pressed="' + (S.jmode === 'orig') + '">Original track</button>' +
    '<button type="button" data-jmode="latest" aria-pressed="' + (S.jmode === 'latest') + '">Latest stack</button></div>' +
    '<button class="jsw" type="button" role="switch" data-jhover="1" aria-checked="' + S.jhover + '"><i></i>Play on hover</button>' +
    '<span class="jhint">' + (S.jhover ? 'Hold your mouse over a jam to hear it. Click anywhere once first, so your browser lets it play.' : 'Press ▶ on a jam to hear it.') + '</span>';
}
/* the newest take of a jam: the top of its latest stack */
function latestOf(r) {
  var takes = r.posts.filter(function (p) { return !p.isComment && !p.deleted && p.layer && p.kind !== 'part' && !p.section; });
  var newest = function (l) { return l.sort(function (a, b) { return String(b.created).localeCompare(String(a.created)); })[0] || null; };
  /* the newest take, then up to the top of its stack: takes can sit on top of a newer one (restacked jams) */
  var t = newest(takes.slice()), seen = {};
  while (t && !seen[t.id]) { seen[t.id] = 1; var up = newest(takes.filter(function (k) { return k.parent === t.id; })); if (!up) break; t = up; }
  return t;
}
function cardKey(r) { return r.id + ':card'; }
function cardChain(r) { var l = S.jmode === 'latest' ? latestOf(r) : null; return l ? chainOf(r, l.id) : chainOf(r, null); }
function cardHtml(r) {
  var chain = cardChain(r), on = S.playing === cardKey(r), n = livePosts(r);
  var seen = {}, dots = [];
  r.posts.forEach(function (p) { if (p.layer && !p.isComment && !p.deleted && p.kind !== 'part' && !seen[p.layer]) { seen[p.layer] = 1; dots.push(p.layer); } });
  var takes = r.posts.filter(function (p) { return p.layer && !p.isComment && !p.deleted; }).length, words = n.filter(function (p) { return p.isComment; }).length;
  var lanes = S.jmode === 'latest' && chain.length > 1
    ? chain.slice().reverse().map(function (x) { return '<canvas data-wave="' + (x.isRiff ? r.id + ':riff' : r.id + ':' + x.id) + '" data-layer="' + (x.isPart ? 'part' : x.layer) + '" aria-hidden="true"></canvas>'; }).join('')
    : '<canvas class="big" data-wave="' + r.id + ':riff" data-layer="' + r.layer + '" aria-hidden="true"></canvas>';
  var cap = S.jmode === 'latest' ? (chain.length > 1 ? 'Latest stack · ' + chain.length + ' layers' : 'Only the original track so far') : 'Original track';
  return '<article class="jcard' + (on ? ' on' : '') + '" id="card-' + r.id + '" data-jcard="' + r.id + '">' +
    '<div class="jcover"><span class="jpill">' + glyph(r.layer, lay(r.layer).c) + esc(r.layer === 'seed' ? 'Original track' : lay(r.layer).label) + '</span>' +
      (on ? '<span class="jnow">Playing</span>' : '') +
      '<div class="jwv" data-jseek="' + r.id + '" title="Click to play from there">' + lanes + '<span class="phead jhead" hidden></span><span class="jhover" hidden></span></div>' +
      '<div class="jbot"><button class="jplay' + (on ? ' on' : '') + '" type="button" data-jplay="' + r.id + '" aria-label="' + (on ? 'Stop' : 'Play ' + esc(r.title)) + '">' + (on ? '&#10074;&#10074;' : '&#9654;') + '</button>' +
        '<span class="jcap">' + cap + '</span><span class="jdur">' + mmss(r.dur) + '</span></div></div>' +
    '<div class="jmeta">' + ava(r.by, r.layer) + '<div class="jtext"><h3><button type="button" data-jopen="' + r.id + '">' + esc(r.title) + '</button></h3>' +
      '<p>' + esc(r.by) + (r.bpm ? ' · ' + r.bpm + ' bpm' : '') + (r.key ? ' · ' + esc(r.key) : '') + '</p>' +
      '<p><span class="jdots" aria-hidden="true">' + dots.map(function (l) { return glyph(l, lay(l).c); }).join('') + '</span>' +
        takes + (takes === 1 ? ' take' : ' takes') + ' · <button class="jwords" type="button" data-jwords="' + r.id + '">' + (words ? words + (words === 1 ? ' comment' : ' comments') : 'Comment') + '</button> · ' + esc(r.time) + '</p></div>' +
      '<button class="btn btn-main btn-sm" type="button" data-jopen="' + r.id + '">Play along</button></div></article>';
}
/* hovering a card's lanes: a white line where a click would start */
document.addEventListener('mousemove', function (e) {
  var w = e.target.closest && e.target.closest('[data-jseek]');
  [].forEach.call(document.querySelectorAll('.jhover:not([hidden])'), function (h) { if (!w || h.parentNode !== w) h.hidden = true; });
  if (!w) { S.jhx = null; return; }
  var h = w.querySelector('.jhover'); if (!h) return;
  var rc = w.getBoundingClientRect(), x = Math.max(0, Math.min(rc.width, e.clientX - rc.left));
  S.jhx = { rid:w.dataset.jseek, f:x / Math.max(1, rc.width) };
  h.hidden = false; h.style.left = x + 'px';
});
document.addEventListener('mouseleave', function (e) {
  /* only leaving the lanes themselves (or the window): the other mouseleave events bubble in from every element */
  if (e.target !== document && e.target !== document.documentElement && !(e.target.matches && e.target.matches('[data-jseek]'))) return;
  if (e.target.isConnected === false) return;
  if (e.target.getBoundingClientRect) {   /* a redraw under the mouse also counts as leaving: ignore that */
    var q = e.target.getBoundingClientRect();
    if (e.clientX > q.left && e.clientX < q.right && e.clientY > q.top && e.clientY < q.bottom) return;
  }
  S.jhx = null; [].forEach.call(document.querySelectorAll('.jhover'), function (h) { h.hidden = true; });
}, true);
/* the card redraws when it starts playing: put the line back where the mouse is */
function jhoverBack() {
  if (!S.jhx) return;
  var w = document.querySelector('.jwv[data-jseek="' + S.jhx.rid + '"]'), h = w && w.querySelector('.jhover');
  if (h && h.hidden) { h.hidden = false; h.style.left = S.jhx.f * w.clientWidth + 'px'; }
}
/* a card's lanes are one strip: click anywhere and every take plays from that moment */
document.addEventListener('click', function (e) {
  var w = e.target.closest && e.target.closest('[data-jseek]'); if (!w) return;
  e.stopImmediatePropagation(); e.preventDefault();
  var r = riff(w.dataset.jseek); if (!r) return;
  var rc = w.getBoundingClientRect(), f = Math.min(.999, Math.max(0, (e.clientX - rc.left) / Math.max(1, rc.width)));
  S.jpaused = null;
  playList(cardKey(r), r, cardChain(r), f * (r.dur || 0));
}, true);
function cardPlay(rid) {
  var r = riff(rid); if (!r) return;
  /* paused by hand: hovering doesn't start it again until the mouse leaves the card */
  if (S.playing === cardKey(r)) { S.jpaused = rid; stop(); render(); return; }
  S.jpaused = null;
  playList(cardKey(r), r, cardChain(r));
}
/* the panel: open from the card, close only with the X */
function overlay() {
  var o = el('wall-ov');
  if (!o) {
    o = document.createElement('div'); o.id = 'wall-ov'; o.className = 'wov'; o.hidden = true;
    o.innerHTML = '<div class="wov-panel" role="dialog" aria-modal="true" aria-label="The jam"><button class="wov-x" type="button" data-wclose="1" aria-label="Close">&times;</button><div class="wov-body"></div></div>';
    document.body.appendChild(o);
  }
  return o;
}
function renderOverlay() {
  if (!S.ov) return;
  var r = riff(S.ov); if (!r) return;
  /* what people are typing survives the redraw, each box by its own id */
  var b = overlay().querySelector('.wov-body'), keep = {}, foc = document.activeElement && b.contains(document.activeElement) ? document.activeElement.id : null;
  [].forEach.call(b.querySelectorAll('textarea[id],input[id]'), function (x) { if (x.value) keep[x.id] = x.value; });
  b.innerHTML = wallHtml(r);
  Object.keys(keep).forEach(function (id) { var x = el(id); if (x && b.contains(x)) x.value = keep[id]; });
  if (foc && el(foc)) el(foc).focus();
}
function openJam(rid) {
  var r = riff(rid); if (!r) return;
  var card = el('card-' + rid), from = card ? card.getBoundingClientRect() : null;
  if (S.playing) stop();   /* what played from the grid (hover, ▶) stops when the jam opens */
  S.ov = rid; S.expanded[rid] = true; delete S.wopen[rid];
  /* the grid played the latest stack: open on that stack */
  var lt = S.jmode === 'latest' ? latestOf(r) : null;
  S.wsel[rid] = lt ? lt.id : null;
  delete S.wscroll[rid];
  var o = overlay(), panel = o.querySelector('.wov-panel');
  o.hidden = false; document.body.classList.add('ov-open');
  render();
  panel.scrollTop = 0;
  /* on a phone, turn to the part that stack is in */
  var pk = panel.querySelector('.wb-picked'), pw = pk && pk.closest('.wwrap'), ps = pk && pk.closest('.wsec');
  if (pw && ps) { pw.scrollLeft += ps.getBoundingClientRect().left - pw.getBoundingClientRect().left; S.wscroll[rid] = pw.scrollLeft; wallFit(pw); }
  var to = panel.getBoundingClientRect();
  if (from && panel.animate) {
    var sx = from.width / to.width, sy = Math.min(1, from.height / to.height);
    panel.animate([{ transform:'translate(' + (from.left - to.left) + 'px,' + (from.top - to.top) + 'px) scale(' + sx + ',' + sy + ')', opacity:.4, borderRadius:'18px' },
                   { transform:'none', opacity:1, borderRadius:'24px' }], { duration:420, easing:'cubic-bezier(.2,.8,.2,1)' });
    o.animate([{ opacity:0 }, { opacity:1 }], { duration:260, easing:'ease-out' });
  }
  o.querySelector('.wov-x').focus({ preventScroll:true });
}
function closeJam() {
  var rid = S.ov, o = el('wall-ov'); if (!o || !rid) return;
  var panel = o.querySelector('.wov-panel'), card = el('card-' + rid), done = function () {
    o.hidden = true; document.body.classList.remove('ov-open'); S.ov = null;
    if (S.playing && S.playing.indexOf(rid + ':') === 0 && S.playing !== cardKey(riff(rid))) stop();
    render(); if (card) card.querySelector('[data-jopen]').focus({ preventScroll:true });
  };
  if (card && panel.animate) {
    var from = panel.getBoundingClientRect(), to = card.getBoundingClientRect();
    var a = panel.animate([{ transform:'none', opacity:1 }, { transform:'translate(' + (to.left - from.left) + 'px,' + (to.top - from.top) + 'px) scale(' + (to.width / from.width) + ',' + Math.min(1, to.height / from.height) + ')', opacity:0 }], { duration:300, easing:'cubic-bezier(.4,0,.6,1)' });
    o.animate([{ opacity:1 }, { opacity:0 }], { duration:300 });
    a.onfinish = done;
  } else done();
}
/* hover: hear a card while the mouse is over it (a real mouse: a tap on a phone also sends mouseover,
   which would start the card just before the tap's own click pauses it) */
var TOUCHED = 0, HOVER = null;
document.addEventListener('touchstart', function () { TOUCHED = Date.now(); }, { capture:true, passive:true });
function mouseHover() { return Date.now() - TOUCHED > 1000 && !(window.matchMedia && matchMedia('(hover: none)').matches); }
document.addEventListener('mouseover', function (e) {
  if (!S.jhover || S.ov || !mouseHover()) return;
  var c = e.target.closest && e.target.closest('[data-jcard]'); if (!c) return;
  /* the move that starts a card redraws it, and that move's own mousemove is lost: note the line here */
  var jw = c.querySelector('.jwv[data-jseek]');
  if (jw) { var jq = jw.getBoundingClientRect(); if (e.clientX >= jq.left && e.clientX <= jq.right && e.clientY >= jq.top && e.clientY <= jq.bottom) S.jhx = { rid:jw.dataset.jseek, f:(e.clientX - jq.left) / Math.max(1, jq.width) }; }
  var r = riff(c.dataset.jcard); if (!r || S.playing === cardKey(r) || S.jpaused === r.id) return;
  if (e.relatedTarget && c.contains(e.relatedTarget)) return;
  if (HOVER && HOVER.rid === r.id) return;
  /* a mouse passing over a card on its way somewhere else downloads nothing */
  clearTimeout(HOVER && HOVER.t);
  HOVER = { rid:r.id, t:setTimeout(function () {
    HOVER = null;
    if (!S.jhover || S.ov || S.playing === cardKey(r) || S.jpaused === r.id) return;
    playList(cardKey(r), r, cardChain(r));
  }, 300) };
});
document.addEventListener('mouseout', function (e) {
  if (!S.jhover || S.ov || !mouseHover()) return;
  var c = e.target.closest && e.target.closest('[data-jcard]'); if (!c || (e.relatedTarget && c.contains(e.relatedTarget))) return;
  if (!c.isConnected) return;   /* the card was redrawn under the mouse, it wasn't left */
  if (S.jpaused === c.dataset.jcard) S.jpaused = null;
  if (HOVER && HOVER.rid === c.dataset.jcard) { clearTimeout(HOVER.t); HOVER = null; }
  var r = riff(c.dataset.jcard); if (!r) return;
  dropLoads(cardKey(r));
  if (S.playing === cardKey(r)) { stop(); render(); }
});
function render() {
  requestAnimationFrame(jhoverBack);
  var list = RIFFS.slice();
  if (S.tab === 'hot') list.sort(function (a, b) { return players(b).length - players(a).length || score(b.likes, b.id) - score(a.likes, a.id); });
  if (S.tab === 'songs') list = list.filter(function (r) { return r.song; });
  if (S.tab === 'fresh') list = list.filter(function (r) { return !r.song; }).concat(list.filter(function (r) { return r.song; }));
  el('list').innerHTML = S.failed ? '<p class="empty">' + esc(S.failed) + '</p>'
    : !S.loaded ? '<p class="empty">Loading the jams…</p>'
    : list.length ? list.map(cardHtml).join('')
    : '<p class="empty">' + (S.tab === 'songs' ? 'No songs yet.' : 'No jams yet. <a href="#start">Start the first one.</a>') + '</p>';
  [].forEach.call(document.querySelectorAll('#tabs [data-tab]'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.tab === S.tab)); });
  /* waveforms draw from the takes' saved peaks; only a take without them (sent before they were
     saved) loads its audio for its waveform, replies once their thread is open */
  list.forEach(function (r) {
    if (!r.peaks) load(r, { isRiff:true, url:r.url, wet:r.wet });
    if (S.expanded[r.id]) r.posts.forEach(function (p) { if (p.url) stemsOf(p).forEach(function (x) { if (!x.peaks) load(r, x); }); });
  });
  renderOverlay();
  wallScrolls();
  drawWaves();
}

/* ---------- reply with audio ---------- */
var R = { rid:null, pid:null, file:null, buf:null, src:'file' };
var MD = null;
function openScrim(id) { el(id).classList.add('on'); }
function closeScrims() {
  if (RC.state === 'recording' || RC.state === 'asking') rcCancel();
  disarmMonitor();
  if (S.playing === 'reply') { stop(); mdIdle(); render(); }
  var fromStart = el('start-scrim').classList.contains('on');
  [].forEach.call(document.querySelectorAll('.scrim'), function (s) { s.classList.remove('on'); });
  if (fromStart && startFrom && startFrom.focus && document.contains(startFrom)) startFrom.focus();
}
function wantLen(c) { return c[0].dur || 0; }
/* the pop-up offers the project view too, on the same stack, with the instrument you picked */
function replyProjLink(r, pid) {
  var h = el('r-title'), row = h && h.parentNode.classList.contains('r-headrow') ? h.parentNode : null;
  if (h && !row) { row = document.createElement('div'); row.className = 'r-headrow'; h.parentNode.insertBefore(row, h); row.appendChild(h); }
  var a = el('r-proj');
  if (!a) { a = document.createElement('a'); a.id = 'r-proj'; a.className = 'btn btn-sm'; a.textContent = 'Or record in project view'; row.appendChild(a); }
  a.dataset.slug = r.slug; a.dataset.post = pid || 'seed';
  a.href = '/s/' + encodeURIComponent(r.slug) + '?stack=' + encodeURIComponent(pid || 'seed');
}
document.addEventListener('click', function (e) {
  var a = e.target.closest && e.target.closest('#r-proj'); if (!a) return;
  var l = el('r-layer') ? el('r-layer').value : '';
  a.href = '/s/' + encodeURIComponent(a.dataset.slug) + '?stack=' + encodeURIComponent(a.dataset.post) + (l ? '&rec=' + encodeURIComponent(l) : '');
}, true);
function openReply(rid, pid) {
  ensureMe(jamCard(riff(rid), 'play')).then(function () { replyPop(rid, pid); });
}
function replyPop(rid, pid) {
  var r = riff(rid); R = { rid:rid, pid:pid || null, file:null, buf:null, src:'file' };
  rcReset(); RC.click = !!r.bpm; RC.countIn = r.bpm ? 1 : 0;
  var c = chainOf(r, pid), used = c.map(function (p) { return p.layer; });
  var pp = pid ? postOf(r, pid) : null;
  el('r-title').textContent = 'Play along with ' + (!pp ? r.title : pp.kind === 'part' ? 'the new part' : whose(pp) + ' ' + lay(pp.layer).label);
  MD = { r:r, c:c, raf:0, dur:wantLen(c) };
  /* your take on top, under it the stack as one master track with who is in it */
  var you = '<div class="md-lane you"><span class="md-name"><i style="background:var(--sound)"></i><span><b>You</b><span id="md-you"></span></span></span><div class="md-slot" id="md-slot"><div class="md-empty" id="md-empty">Your take lands here</div></div><span></span></div>';
  var master = '<div class="md-master"><div class="md-mchips"><b>The stack</b>' + c.map(function (p) {
      return '<span>' + glyph(p.kind === 'part' ? 'part' : p.layer, lay(p.kind === 'part' ? 'part' : p.layer).c) + esc(p.isRiff ? r.by : p.mine ? 'You' : p.by) + ' · ' + esc(chipLabel(p)) + '</span>';
    }).join('') + '</div><div class="md-mwave"><span></span><canvas data-md="0" data-mdmix="1"></canvas><span></span></div></div>';
  el('r-over').innerHTML = '<div class="md-top"><button class="play" type="button" id="md-play" aria-label="Play what you play on">&#9654;</button>' +
      '<span class="md-time" id="md-time">0:00</span><span class="md-hint">' + (r.bpm ? r.bpm + ' bpm' : 'tempo unknown') + (r.key ? ' · ' + esc(r.key) : '') + (r.sig ? ' · ' + esc(r.sig) : '') + '. Play along first, then add your take.</span></div>' +
    '<div class="md-lanes" id="md-lanes">' + you + master + '<div class="md-head" id="md-head" hidden></div></div>';
  el('r-layer').innerHTML = ROLES.map(function (x) { return '<option value="' + x.id + '">' + esc(x.label) + '</option>'; }).join('');
  el('r-layer').value = ROLES.map(function (x) { return x.id; }).filter(function (l) { return used.indexOf(l) < 0; })[0] || 'vocals';
  el('r-err').textContent = ''; el('r-text').value = ''; el('r-file').value = '';
  el('r-len').textContent = MD.dur ? 'Make it ' + mmss(MD.dur) + ' long (' + MD.dur.toFixed(1) + ' s), the length of what you play on.' : '';
  el('r-as').innerHTML = postingAs();
  el('r-go').disabled = false;
  setRSrc('file');
  replyProjLink(r, pid);
  openScrim('reply-scrim'); mdYou(); mdDraw(); el('r-layer').focus();
  Promise.all(c.map(function (p) { return load(r, p); })).then(mdDraw);
}
function peakOf(buf) { var d = buf.getChannelData(0), pk = 0; for (var i = 0; i < d.length; i++) { var v = Math.abs(d[i]); if (v > pk) pk = v; } return pk; }
function mdYou() { var y = el('md-you'); if (y) y.textContent = (role(el('r-layer').value) || {}).label || ''; }
function mdDraw() {
  if (!MD) return;
  var ink = getComputedStyle(document.documentElement).getPropertyValue('--wave').trim();
  var mix = document.querySelector('canvas[data-mdmix]');
  if (mix) {
    /* the preview's master track: every take of the stack summed, once they're all in */
    var bs = MD.c.map(function (p) { return BUF[bufKey(MD.r, p)]; });
    bs.forEach(function (b) { if (b && !MD.dur) MD.dur = b.duration; });
    if (bs.every(Boolean) && bs.length) {
      if (!MD.mix) {
        var n = bs[0].length, out = ac().createBuffer(1, n, bs[0].sampleRate), d = out.getChannelData(0);
        bs.forEach(function (b) { var x = b.getChannelData(0), m = Math.min(n, x.length); for (var j = 0; j < m; j++) d[j] += x[j]; });
        MD.mix = out;
      }
      waveShape(mix, MD.mix, ink);
    }
    el('md-time').textContent = '0:00 / ' + mmss(MD.dur);
    return;
  }
  MD.c.forEach(function (p, i) {
    var b = BUF[bufKey(MD.r, p)], cv = document.querySelector('canvas[data-md="' + i + '"]');
    if (b && !MD.dur) MD.dur = b.duration;
    if (cv) waveShape(cv, b, ink);
  });
  el('md-time').textContent = '0:00 / ' + mmss(MD.dur);
}
function mdPlay() {
  if (RC.state === 'recording' || RC.state === 'asking') return;
  if (S.playing === 'reply') { stop(); mdIdle(); render(); return; }
  stop(); render(); S.playing = 'reply';
  el('md-play').innerHTML = '&#10074;&#10074;'; el('md-play').classList.add('on');
  var r = MD.r, a = ac(); a.resume(); var T = a.currentTime + 0.05, fade = FADE = fadeIn(a, T, a.destination);
  var m = mine(), lanes = MD.c.concat(m ? [{ mine:true, buf:m.buf, amp:m.amp }] : []);
  lanes.forEach(function (p, i) {
    var b = p.buf || bufFor(r, p); if (!b) return;
    if (!p.buf) amped(r, p);
    var src = a.createBufferSource(), g = a.createGain(); src.buffer = b; src.loop = true;
    src.start(T); SRC.push(src);
    /* a fresh take with an amp is heard through it live; the file itself stays dry */
    var la = p.mine && p.amp ? liveAmp(a, p.amp, peakOf(b)) : null;
    if (la) { src.connect(la.input); la.output.connect(g); SRC.push({ stop:function () { setTimeout(function () { dropAmp(la); }, 50); } }); }
    else src.connect(g);
    g.connect(fade);
  });
  MD.t0 = T; el('md-head').hidden = false;
  (function tick() {
    if (S.playing !== 'reply' || !MD) return mdIdle();
    var pos = MD.dur ? ((ac().currentTime - MD.t0) % MD.dur + MD.dur) % MD.dur : 0, cv = document.querySelector('canvas[data-md="0"]'), h = el('md-head');
    if (cv && h) h.style.left = (cv.offsetLeft + cv.offsetWidth * pos / (MD.dur || 1)) + 'px';
    el('md-time').textContent = mmss(pos) + ' / ' + mmss(MD.dur);
    MD.raf = requestAnimationFrame(tick);
  })();
}
function mdIdle() {
  if (!el('md-play')) return;
  el('md-play').innerHTML = '&#9654;'; el('md-play').classList.remove('on'); el('md-head').hidden = true;
  if (MD) { cancelAnimationFrame(MD.raf); el('md-time').textContent = '0:00 / ' + mmss(MD.dur); }
}
/* ---------- record your reply right here ----------
   The same recorder as in the project (rec.js): a count-in and click, the lanes above (unmuted)
   playing from bar 1, your input through an amp for guitar, lead and bass, and the take cut
   to start exactly at bar 1 and run exactly as long as what you play on. */
var RC = { state:'idle', nodes:[], player:[], mics:[], click:false, countIn:0, err:'', warn:'', info:'', done:null, level:0, peak:0 };
function rcRole() { return el('r-layer').value; }
function rcCleanup() {
  clearTimeout(RC.timer); clearInterval(RC.tick);
  RC.player.forEach(function (s) { try { s.stop(); } catch (e) {} });
  RC.player = [];
  RC.nodes.forEach(function (n) { try { n.disconnect(); } catch (e) {} });
  RC.nodes = [];
  if (RC.stream) RC.stream.getTracks().forEach(function (tr) { tr.stop(); });
  RC.stream = null;
}
function rcReset() {
  rcCleanup();
  RC.state = 'idle'; RC.err = ''; RC.warn = ''; RC.info = ''; RC.done = null; RC.chunks = null; RC.partial = 0;
}
function rcCancel() { rcCleanup(); RC.state = 'idle'; RC.chunks = null; rcDraw(); showMine(); }
function rcMicOptions() {
  var cur = savedMic();
  return '<option value="">Default input</option>' + RC.mics.map(function (m, i) {
    return '<option value="' + esc(m.id) + '"' + (m.id === cur ? ' selected' : '') + '>' + esc(m.label || ('Input ' + (i + 1))) + '</option>';
  }).join('');
}
function rcMics() { return listMics().then(function (l) { RC.mics = l; var s = document.querySelector('#r-rec [data-rc="mic"]'); if (s) s.innerHTML = rcMicOptions(); rcFindBtn(); }); }
/* before the browser has been allowed the microphone it only says "default": ask once */
function rcFindBtn() { var b = document.querySelector('#r-rec [data-rc="inputs"]'); if (b) b.hidden = RC.mics.length > 0; }
function rcAmpOptions() {
  var cur = savedAmp();
  return '<option value="">Off, as it comes in</option>' + AMPS.map(function (a) { return '<option value="' + a.id + '"' + (a.id === cur ? ' selected' : '') + '>' + esc(a.label) + '</option>'; }).join('');
}
function rcDraw() {
  var box = el('r-rec'); if (!box || !MD) return;
  var err = RC.err ? '<p class="rc-err">' + esc(RC.err) + '</p>' : '';
  if (RC.state === 'asking' || RC.state === 'recording') {
    box.innerHTML = '<div class="rc-live"><div class="rc-status" id="rc-status">' + (RC.state === 'asking' ? 'Waiting for the microphone...' : '') + '</div>' +
      '<div class="rc-meter"><i id="rc-meter"></i></div>' +
      '<div class="rc-acts"><button class="btn btn-main" type="button" data-rc="finish">Stop and keep it</button>' +
      '<button class="btn btn-sm" type="button" data-rc="cancel">Stop and throw away</button></div>' +
      '<p class="rc-tiny">It stops by itself at the end of the clip. Stop earlier and you keep what you played; the rest of the take is silence.</p></div>';
    rcStatus(); return;
  }
  if (RC.state === 'done' && RC.done) {
    box.innerHTML = '<div class="rc-done"><b>Recorded ' + (RC.partial ? mmss(RC.partial) + ' of ' + mmss(RC.fixed) : mmss(RC.done.buf.duration)) + '</b>' +
      '<span class="rc-tiny">' + (RC.partial ? 'You stopped early. The rest of the take is silence, so it still lines up with the clip.' : 'Cut to start exactly at bar 1 and end with the clip.') + '</span>' +
      '<div class="rc-acts"><button class="btn btn-sm" type="button" data-rc="listen">Hear it with the lanes</button>' +
      '<button class="btn btn-sm" type="button" data-rc="again">Record again</button></div></div>' +
      (RC.info ? '<p class="rc-info">' + esc(RC.info) + '</p>' : '') + (RC.warn ? '<p class="rc-warn">' + esc(RC.warn) + '</p>' : '') + err;
    return;
  }
  var ampOn = AMP_ROLES.indexOf(rcRole()) > -1;
  if (ampOn && savedAmp()) preloadAmp(savedAmp());
  box.innerHTML = '<div class="rc-row">' +
      '<label class="rc-opt"><input type="checkbox" data-rc="click"' + (RC.click ? ' checked' : '') + '><span>Click</span></label>' +
      '<label class="rc-sel"><span>count-in</span><select data-rc="countin">' + [0, 1, 2, 4].map(function (n) {
        return '<option value="' + n + '"' + (n === RC.countIn ? ' selected' : '') + '>' + n + ' bar' + (n === 1 ? '' : 's') + '</option>'; }).join('') + '</select></label>' +
      '<label class="rc-sel"><span>input</span><select data-rc="mic">' + rcMicOptions() + '</select></label>' +
      '<button class="ghost rc-find" type="button" data-rc="inputs"' + (RC.mics.length ? ' hidden' : '') + '>Show my inputs</button>' +
      '<label class="rc-sel" id="rc-amp"' + (ampOn ? '' : ' hidden') + ' title="Recorded dry, heard through this amp. You can change it later."><span>amp</span><select data-rc="amp">' + rcAmpOptions() + '</select></label>' +
      '<label class="rc-opt" title="Hear your input in the headphones right away, through the amp if you picked one. Leave it off if your interface already lets you hear yourself."><input type="checkbox" data-rc="mon"' + (savedMon() ? ' checked' : '') + '><span>Hear yourself</span></label>' +
    '</div>' +
    '<p class="rc-tiny">Wear headphones, otherwise the lanes end up in your take. You hear the lanes above that aren’t muted, from the first beat' +
      (MD.r.bpm ? '' : '. No tempo is known for this clip, so the click runs at 120 bpm') + '. It stops by itself after ' + mmss(MD.dur) + '.</p>' +
    (rateTip(ac()) ? '<p class="rc-tiny" id="rc-rate"' + (ampOn ? '' : ' hidden') + '>' + esc(rateTip(ac())) + '</p>' : '') +
    '<button class="btn btn-main rc-go" type="button" data-rc="start"><span class="rc-dot"></span> Start recording</button>' + err;
}
function rcStatus() {
  var st = el('rc-status'), meter = el('rc-meter');
  if (!st || RC.state !== 'recording') return;
  var a = ac(), now = a.currentTime, bar = RC.bar;
  if (now < RC.songStart) {
    if (now < RC.t0) st.textContent = 'Get ready';
    else { var left = RC.countIn - Math.floor((now - RC.t0) / bar); st.textContent = 'Count-in, ' + left + ' bar' + (left > 1 ? 's' : '') + ' to go'; }
    st.className = 'rc-status counting';
  } else { st.textContent = 'Recording ' + mmss(now - RC.songStart) + ' / ' + mmss(RC.fixed); st.className = 'rc-status live'; }
  if (meter) meter.style.width = Math.min(100, RC.level * 140) + '%';
  var slot = el('md-empty'); if (slot) { slot.classList.add('live'); slot.textContent = now < RC.songStart ? 'Count-in…' : 'Recording…'; }
}
/* "Hear yourself" arms the input: you hear it right away, through the amp for this layer
   (the take itself stays dry), until you untick it or close the pop-up */
function rcArm() {
  armMonitor(ac(), recAmpFor(rcRole()), ac().destination).then(rcMics, function (err) {
    rememberMon(false);
    var c = document.querySelector('#r-rec [data-rc="mon"]'); if (c) c.checked = false;
    RC.err = micError(err); rcDraw();
  });
}
function rcRearm() { if (monitorOn()) rcArm(); }
function rcStart() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { RC.err = 'This browser does not give pages access to a microphone.'; rcDraw(); return; }
  stop(); mdIdle(); render();
  RC.err = ''; RC.warn = ''; RC.info = ''; RC.done = null; RC.state = 'asking'; rcDraw(); showMine();
  var a = ac(); a.resume(); var r = MD.r;
  var loaded = Promise.all(MD.c.map(function (p) { return load(r, p).then(function () { return amped(r, p); }); }));
  Promise.all([openMic(), loaded]).then(function (x) {
    var stream = x[0];
    RC.stream = stream; rcMics();
    return recWorklet(a).then(function () { return { stream:stream, worklet:true }; }, function () { return { stream:stream, worklet:false }; });
  }).then(function (got) {
    if (RC.state !== 'asking') { got.stream.getTracks().forEach(function (tr) { tr.stop(); }); return; }
    var first = bufFor(r, MD.c[0]), len = first ? first.duration : MD.dur;
    if (!len) throw new Error('The clip could not be loaded, so there is nothing to play along with. Reload the page and try again.');
    var bi = beatInfoFor(r.bpm, r.sig), countIn = RC.countIn;
    var t0 = a.currentTime + 0.4, songStart = t0 + countIn * bi.bar, chunks = [];
    RC.t0 = t0; RC.songStart = songStart; RC.countIn = countIn; RC.fixed = len; RC.bar = bi.bar; RC.beat = bi; RC.level = 0; RC.peak = 0; RC.inLat = inputLatency(got.stream);
    var cap = capture(a, got.stream, got.worklet, function (d, t, sr) {
      var bp = blockPeaks(d);
      RC.level = Math.max(bp.peak, RC.level * 0.85);
      if (t >= songStart && bp.peak > RC.peak) RC.peak = bp.peak;
      chunks.push({ t:t, d:d, dur:d.length / sr });
    });
    var mg = a.createGain(); mg.connect(a.destination);
    RC.nodes = cap.nodes.concat([mg]);
    if (savedMon() && !monitorOn()) rcArm();
    if (RC.click) {
      var cs = a.createBufferSource(), cb = a.createBuffer(1, Math.ceil((countIn * bi.bar + len + 0.05) * a.sampleRate), a.sampleRate);
      cb.copyToChannel(clickSamples(a.sampleRate, countIn, len, bi).subarray(0, cb.length), 0);
      cs.buffer = cb; cs.connect(mg); cs.start(t0); RC.player.push(cs);
    }
    /* the lanes above, from bar 1 */
    MD.c.forEach(function (p, i) {
      var b = bufFor(r, p); if (!b) return;
      var s = a.createBufferSource(); s.buffer = b; s.connect(mg); s.start(songStart); RC.player.push(s);
    });
    RC.chunks = chunks; RC.state = 'recording';
    RC.tick = setInterval(rcStatus, 100);
    RC.timer = setTimeout(rcFinish, (songStart + len - a.currentTime + 0.25) * 1000);
    rcDraw();
  }).catch(function (err) {
    rcCleanup(); RC.state = 'idle';
    RC.err = err && /clip could not/.test(err.message || '') ? err.message : micError(err);
    rcDraw(); showMine();
  });
}
/* Stopping early keeps what was played: the take still runs the full length of the clip, and
   everything after the stop is silence. */
function rcFinish() {
  if (RC.state !== 'recording') return;
  var a = ac(), sr = a.sampleRate;
  var lat = (a.outputLatency || 0) + (a.baseLatency || 0) + (RC.inLat || 0);
  var played = Math.max(0, a.currentTime - RC.songStart), len = RC.fixed;
  rcCleanup();
  if (played < 0.5) {
    RC.state = 'idle'; RC.err = played === 0 ? 'Nothing was recorded yet, the count-in was still running.' : 'That was too short to keep.';
    rcDraw(); showMine(); return;
  }
  RC.partial = played < len - 0.25 ? played : 0;
  var made = assembleTake({ chunks:RC.chunks, sr:sr, t0:RC.t0, songStart:RC.songStart, lat:lat, len:len, countIn:RC.countIn, click:RC.click, beat:RC.beat });
  var buf = a.createBuffer(1, made.out.length, sr); buf.copyToChannel(made.out, 0);
  RC.warn = quietNote(RC.peak, !!recAmpFor(rcRole()), rcRole()) || (made.bleed ? bleedNote(made.bleed) : '');
  RC.done = { buf:buf, file:new File([encodeWav(buf)], 'recorded take.wav', { type:'audio/wav' }) };
  RC.chunks = null; RC.state = 'done';
  rcDraw(); showMine();
}
/* what the take on offer is: the uploaded file, or the recording, whichever tab is open */
function mine() {
  if (R.src === 'rec') return RC.done ? { file:RC.done.file, buf:RC.done.buf, amp:recAmpFor(rcRole()) } : null;
  return R.file && R.buf ? { file:R.file, buf:R.buf, amp:'' } : null;
}
function showMine() {
  var slot = el('md-slot'); if (!slot) return;
  var m = mine();
  if (!m) {
    var live = R.src === 'rec' && (RC.state === 'recording' || RC.state === 'asking');
    slot.innerHTML = '<div class="md-empty' + (live ? ' live' : '') + '" id="md-empty">' + (live ? 'Recording…' : 'Your take lands here') + '</div>'; return;
  }
  slot.innerHTML = '<canvas id="md-mine"></canvas>';
  waveShape(el('md-mine'), m.buf, getComputedStyle(document.documentElement).getPropertyValue('--sound').trim());
}
function setRSrc(src) {
  if (src === 'file' && (RC.state === 'recording' || RC.state === 'asking')) rcCancel();
  if (src === 'file') disarmMonitor();
  R.src = src;
  [].forEach.call(document.querySelectorAll('[data-rsrc]'), function (b) { b.setAttribute('aria-selected', String(b.dataset.rsrc === src)); });
  el('r-src-file').hidden = src !== 'file'; el('r-src-rec').hidden = src !== 'rec';
  if (S.playing === 'reply') { stop(); mdIdle(); render(); }
  if (src === 'rec') { rcDraw(); rcMics(); if (savedMon()) rcArm(); }
  showMine();
  el('r-err').textContent = '';
}
document.addEventListener('click', function (e) {
  var t = e.target.closest('[data-rsrc]');
  if (t) { setRSrc(t.dataset.rsrc); return; }
  var b = e.target.closest('#r-rec [data-rc]'); if (!b) return;
  var w = b.dataset.rc;
  if (w === 'start') rcStart();
  else if (w === 'finish') rcFinish();
  else if (w === 'cancel') rcCancel();
  else if (w === 'again') { rcReset(); rcDraw(); showMine(); }
  else if (w === 'listen') mdPlay();
  else if (w === 'inputs') allowInputs().then(function () { rcMics(); }, function (err) { RC.err = micError(err); rcDraw(); });
});
el('r-rec').addEventListener('change', function (e) {
  var t = e.target, w = t.dataset && t.dataset.rc;
  if (w === 'click') RC.click = t.checked;
  else if (w === 'countin') RC.countIn = +t.value;
  else if (w === 'mic') { rememberMic(t.value); rcRearm(); }
  else if (w === 'amp') { rememberAmp(t.value); if (t.value) preloadAmp(t.value); rcRearm(); }
  else if (w === 'mon') { rememberMon(t.checked); if (t.checked) rcArm(); else disarmMonitor(); }
});
el('r-layer').addEventListener('change', function () {
  mdYou();
  var l = el('rc-amp'); if (l) l.hidden = AMP_ROLES.indexOf(rcRole()) < 0;
  var rt = el('rc-rate'); if (rt) rt.hidden = AMP_ROLES.indexOf(rcRole()) < 0;
  rcRearm();
});
el('r-over').addEventListener('click', function (e) {
  var b;
  if (e.target.closest('#md-play')) { mdPlay(); return; }
});
el('r-file').addEventListener('change', function () {
  var f = el('r-file').files[0]; R.file = null; R.buf = null; el('r-err').textContent = '';
  showMine();
  if (!f) return;
  f.arrayBuffer().then(function (ab) { return ac().decodeAudioData(ab); }).then(function (b) {
    var want = MD.dur;
    if (want && Math.abs(b.duration - want) > TOL) {
      el('r-err').textContent = 'That take is ' + b.duration.toFixed(1) + ' s, it has to be ' + want.toFixed(1) + ' s (the length of what you play on). Trim it and try again.';
      return;
    }
    R.file = f; R.buf = b;
    showMine();
  }).catch(function () { el('r-err').textContent = 'That file could not be read. Try a wav or mp3.'; });
});
el('r-go').addEventListener('click', function () {
  var m = mine();
  if (!m) { el('r-err').textContent = el('r-err').textContent || (R.src === 'rec' ? 'Record your take first, or upload a file.' : 'Pick your take first, an audio file of the right length.'); return; }
  var r = riff(R.rid), pp = R.pid ? postOf(r, R.pid) : null, file = m.file, buf = m.buf, ampId = m.amp;
  var section = !pp ? null : pp.kind === 'part' ? pp.id : pp.section || null;
  var replyTo = pp && pp.kind !== 'part' ? pp.id : null;
  el('r-go').disabled = true; el('r-err').textContent = 'Uploading…';
  ensureMe('play').then(function (u) {
    var path = r.id + '/' + u.id + '/' + crypto.randomUUID() + '.' + extOf(file.name), type = typeFor(file);
    return Promise.all([db.uploadAudio(path, file, type), sendPlayCopy(db.uploadAudio, path, file, buf.duration)]).then(function (up) {
      var row = { session_id:r.id, author_id:u.id, author_name:db.accountName(u), role_id:el('r-layer').value, note:el('r-text').value.trim(),
        status:'waiting', storage_path:path, file_name:file.name, mime_type:type, duration_sec:buf.duration, peaks:peaksOfBuffer(buf), section_id:section, reply_to:replyTo,
        on_takes:section ? null : chainOf(r, R.pid).filter(function (x) { return !x.isRiff && !x.isPart; }).map(function (x) { return x.dbId || x.id; }) };
      if (ampId) row.amp = ampId;
      if (up[1]) row.play_path = up[1];
      /* without the amp migration the take still goes in, just without its amp (as in the project) */
      return db.insertTake(row).catch(function (e) {
        if (!row.amp || !/amp/.test(String(e && (e.message || e.details)))) throw e;
        delete row.amp;
        return db.insertTake(row);
      });
    });
  }).then(function (row) {
    BUF[r.id + ':' + row.id] = buf;
    closeScrims();
    S.expanded[r.id] = true;
    return reload().then(function () {
      var nr = riff(r.id); if (nr) { render(); play(nr.id, row.id); }
      setTimeout(function () { var n = el('post-' + r.id + '-' + row.id); if (n) n.scrollIntoView({ behavior:'smooth', block:'center' }); }, 60);
      toast('Your take is posted. Anyone can play along on top of it now.');
    });
  }).catch(function (e) {
    el('r-go').disabled = false;
    /* playing on a new part that isn't in the song yet needs 20261019230000_parts_as_replies.sql */
    el('r-err').textContent = pp && pp.kind === 'part' && pp.status !== 'in' && /row-level security/i.test(String(e && e.message))
      ? 'Playing on a new part that isn’t in the song yet needs a database update that isn’t applied yet. Try again later.'
      : (e && e.message) || 'That didn’t work, try again.';
  });
});

/* ---------- start a jam from the upload panel ---------- */
var UP = { file:null, buf:null, an:null };
el('up-layer').innerHTML = ROLES.map(function (x) { return '<option value="' + x.id + '">' + esc(x.label) + '</option>'; }).join('');
el('up-layer').value = 'guitar';
/* "Start a jam" is the band under the feed, and the same band in a pop-up for the buttons at
   the top. Both instrument rows show (and set) the same choice: the upload form's layer. */
(function () {
  var pop = el('start').cloneNode(true);
  pop.id = 'start-pop'; pop.classList.add('start-pop');
  pop.setAttribute('aria-labelledby', 'start-pop-h');
  pop.querySelector('h2').id = 'start-pop-h';
  pop.insertAdjacentHTML('afterbegin', '<button class="pop-x" type="button" data-close="start-scrim" aria-label="Close">&times;</button>');
  el('start-scrim').appendChild(pop);
})();
function renderInsts() {
  var html = ROLES.map(function (x) {
    return '<button class="inst" type="button" data-inst="' + x.id + '" aria-pressed="' + (el('up-layer').value === x.id) + '">' +
      glyph(x.id, 'var(' + x.color + ')') + esc(x.label) + '</button>';
  }).join('');
  [].forEach.call(document.querySelectorAll('[data-insts]'), function (row) { row.innerHTML = html; });
}
renderInsts();
el('up-layer').addEventListener('change', renderInsts);
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-inst]'); if (!b) return;
  var where = b.closest('#start-scrim') ? '#start-scrim' : '#start';
  el('up-layer').value = b.dataset.inst; renderInsts();
  /* re-rendering replaced the button: keep the focus on the same instrument */
  var same = document.querySelector(where + ' [data-inst="' + b.dataset.inst + '"]');
  if (same) same.focus();
  if (el('picked').hidden) toast(role(b.dataset.inst).label + ' it is. Upload your clip, or record it live.');
});
var startFrom = null;
function openStart() {
  startFrom = document.activeElement;
  openScrim('start-scrim');
  var x = document.querySelector('#start-scrim .inst[aria-pressed="true"]') || document.querySelector('#start-scrim .pop-x');
  if (x) setTimeout(function () { x.focus(); }, 30);
}
/* arriving on /#start opens the pop-up at the top of the page */
function startFromHash() {
  if (location.hash !== '#start') return;
  history.replaceState(null, '', location.pathname + location.search);
  window.scrollTo(0, 0);
  openStart();
}
window.addEventListener('hashchange', startFromHash);
function takeFile(f) {
  if (!f) return;
  el('up-err').textContent = '';
  f.arrayBuffer().then(function (ab) { return ac().decodeAudioData(ab); }).then(function (b) {
    UP = { file:f, buf:b, an:null };
    el('dropzone').hidden = true; el('picked').hidden = false;
    el('up-name').textContent = f.name + ' · ' + b.duration.toFixed(1) + ' s';
    if (!el('up-title').value) el('up-title').value = f.name.replace(/\.[^.]+$/, '');
    el('up-as').innerHTML = postingAs();
    waveShape(el('up-wave'), b, getComputedStyle(document.documentElement).getPropertyValue('--wave').trim());
    el('up-bpm').value = ''; el('up-bpm').placeholder = 'detecting…';
    analyse(f).then(function (an) {
      if (UP.file !== f) return;
      UP.an = an;
      if (an && an.tempo && !el('up-bpm').value) el('up-bpm').value = an.tempo.bpm;
      el('up-bpm').placeholder = 'bpm';
    }).catch(function () { el('up-bpm').placeholder = 'bpm'; });
    el('up-title').focus();
  }).catch(function () { toast('That file could not be read. Try a wav or mp3.'); });
}
el('dropzone').addEventListener('click', function (e) { if (e.target.id !== 'up-file') el('up-file').click(); });
el('dropzone').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el('up-file').click(); } });
['dragenter','dragover'].forEach(function (ev) { el('dropzone').addEventListener(ev, function (e) { e.preventDefault(); el('dropzone').classList.add('hover'); }); });
['dragleave','drop'].forEach(function (ev) { el('dropzone').addEventListener(ev, function (e) { e.preventDefault(); el('dropzone').classList.remove('hover'); }); });
el('dropzone').addEventListener('drop', function (e) { takeFile(e.dataTransfer.files[0]); });
el('up-file').addEventListener('change', function () { takeFile(el('up-file').files[0]); });
el('up-change').addEventListener('click', function () { el('picked').hidden = true; el('dropzone').hidden = false; el('up-file').value = ''; el('up-file').click(); });
el('up-go').addEventListener('click', function () {
  var title = el('up-title').value.trim(), f = UP.file, b = UP.buf, an = UP.an;
  if (!title) { el('up-err').textContent = 'Give your jam a name.'; el('up-title').focus(); return; }
  var bpm = +el('up-bpm').value || null, sess = null;
  ensureMe('start').then(function (u) {
    el('up-go').disabled = true; el('up-err').textContent = 'Uploading…';
    return db.createSession(u.id).then(function (s) {
      sess = s;
      var path = s.id + '/' + u.id + '/' + crypto.randomUUID() + '.' + extOf(f.name), type = typeFor(f);
      return Promise.all([db.uploadAudio(path, f, type), sendPlayCopy(db.uploadAudio, path, f, b.duration)]).then(function (up) {
        return db.insertTake({ session_id:s.id, author_id:u.id, author_name:db.accountName(u), role_id:'seed', note:el('up-text').value.trim(), status:'seed',
          storage_path:path, play_path:up[1] || undefined, file_name:f.name, mime_type:type, duration_sec:b.duration, peaks:peaksOfBuffer(b),
          an_bpm:an && an.tempo ? an.tempo.bpm : null, an_key:an && an.key ? an.key.key : null });
      });
    });
  }).then(function (row) {
    var patch = { seed_take_id:row.id, seed_role:el('up-layer').value, title:title.slice(0, 120) };
    if (bpm) patch.bpm = bpm;
    if (an && an.key) { patch.music_key = an.key.key; patch.key_alt = an.key.runnerUp; }
    if (an && (an.tempo || an.key)) {
      patch.meta_from = an.tempo && bpm === an.tempo.bpm ? 'detected' : 'you';
      patch.meta_sure = sureness(Math.min(an.tempo ? an.tempo.conf : 0, an.key ? an.key.conf : 0));
    } else if (bpm) patch.meta_from = 'you';
    return db.updateSession(sess.id, patch);
  }).then(function () {
    BUF[sess.id + ':riff'] = b;
    closeScrims();
    el('picked').hidden = true; el('dropzone').hidden = false; el('up-file').value = ''; el('up-title').value = ''; el('up-text').value = '';
    el('up-go').disabled = false; el('up-err').textContent = '';
    S.tab = 'fresh';
    return reload().then(function () {
      el('feed').scrollIntoView({ behavior:'smooth', block:'start' });
      toast('Your jam is live. When people play along, you’ll see it here.');
    });
  }).catch(function (e) { el('up-go').disabled = false; el('up-err').textContent = (e && e.message) || 'That didn’t work, try again.'; });
});

/* ---------- clicks ---------- */
document.addEventListener('click', function (e) {
  var b = e.target.closest('a[href="#start"], a[href="/#start"]');
  if (b) { e.preventDefault(); openStart(); return; }
  if ((b = e.target.closest('a[href="#feed"]'))) { e.preventDefault(); el('feed').scrollIntoView({ behavior:'smooth', block:'start' }); return; }
  if ((b = e.target.closest('[data-close]'))) { closeScrims(); return; }
  if ((b = e.target.closest('[data-upopen]'))) { closeScrims(); openScrim('up-scrim'); return; }
  if (e.target.classList && e.target.classList.contains('scrim')) { closeScrims(); return; }
  if ((b = e.target.closest('[data-wclose]'))) { closeJam(); return; }
  if ((b = e.target.closest('[data-wfull]'))) {
    var fr = b.dataset.wfull, fRiff = riff(fr), fid = fRiff && wallFullId(fRiff, wallTree(fRiff));
    if (!fid) return;
    S.wsel[fr] = fid;
    wallSeek(fr, fid, 0);
    var fm = document.querySelector('#riff-' + fr + ' .wmaster'); if (fm) fm.scrollIntoView({ behavior:'smooth', block:'nearest' });
    return;
  }
  if ((b = e.target.closest('[data-wdot]'))) {
    var dw = document.querySelector('.wwrap[data-wr="' + b.dataset.wdot + '"]'), ds = dw && dw.querySelectorAll('.wsec')[+b.dataset.i];
    if (ds) dw.scrollTo({ left:dw.scrollLeft + ds.getBoundingClientRect().left - dw.getBoundingClientRect().left, behavior:'smooth' });
    return;
  }
  if ((b = e.target.closest('[data-wseek]'))) { var wr = b.getBoundingClientRect(); wallSeek(b.dataset.wseek, b.dataset.post, (e.clientX - wr.left) / wr.width); return; }
  if ((b = e.target.closest('[data-jwords]'))) {
    /* the comments on a card: open the jam with its top comments and the comment box in view */
    var jr = b.dataset.jwords; delete S.wtalk[jr]; openJam(jr);
    setTimeout(function () { var t = document.querySelector('#wall-ov .wtalk'); if (t) t.scrollIntoView({ behavior:'smooth', block:'start' }); }, 450);
    return;
  }
  if ((b = e.target.closest('[data-wcreply]'))) {
    var cr = b.dataset.wcreply; S.wcrep[cr] = S.wcrep[cr] === b.dataset.post ? null : b.dataset.post; render();
    var ta = el('wcrep-' + cr); if (ta) ta.focus();
    return;
  }
  if ((b = e.target.closest('[data-wcrepx]'))) { S.wcrep[b.dataset.wcrepx] = null; render(); return; }
  if ((b = e.target.closest('[data-wtalkall]'))) { S.wtalk[b.dataset.wtalkall] = true; render(); return; }
  if ((b = e.target.closest('[data-jopen]'))) { openJam(b.dataset.jopen); return; }
  if ((b = e.target.closest('[data-jplay]'))) { cardPlay(b.dataset.jplay); return; }
  if ((b = e.target.closest('[data-jmode]'))) { S.jmode = b.dataset.jmode; if (S.playing && /:card$/.test(S.playing)) stop(); drawJamTools(); render(); return; }
  if ((b = e.target.closest('[data-jhover]'))) { S.jhover = !S.jhover; drawJamTools(); return; }
  if ((b = e.target.closest('[data-wsolo]'))) { wallSolo(b.dataset.wsolo, b.dataset.post); return; }
  if ((b = e.target.closest('[data-wpick]'))) { wallPick(b.dataset.wpick, b.dataset.post); return; }
  if ((b = e.target.closest('[data-wplus]'))) {
    /* + on a take (or above the top of a stack): record or upload a take on it, as on the live site */
    var pa = b.closest('article.riff'), prid = pa && pa.id.replace(/^riff-/, ''), ptile = b.closest('[data-post]');
    if (!prid || !riff(prid)) return;
    ghostOff();
    var ppid = ptile && ptile.dataset.post !== 'riff' ? ptile.dataset.post : null;
    openReply(prid, ppid);
    return;
  }
  if ((b = e.target.closest('[data-wtalk]'))) { var wt = b.dataset.wtalk; S.wtalk[wt] = S.wtalk[wt] === false; render(); return; }
  if ((b = e.target.closest('[data-wshow]'))) {
    /* a comment about a take: up to the wall, and hear that take's stack */
    var wr = b.dataset.wshow; S.expanded[wr] = true; wallPick(wr, b.dataset.post);
    var ww = document.querySelector('#riff-' + wr + ' .wwrap'); if (ww) ww.scrollIntoView({ behavior:'smooth', block:'center' });
    return;
  }
  if ((b = e.target.closest('[data-wsay]')) && !e.target.closest('[data-wpick]')) {
    /* 💬 on a take: open the comments, about that take */
    var sr = b.dataset.wsay; S.wtalk[sr] = true; S.wsay[sr] = b.dataset.post; render();
    var ta = el('wsay-' + sr); if (ta) { ta.scrollIntoView({ behavior:'smooth', block:'center' }); ta.focus({ preventScroll:true }); }
    return;
  }
  if ((b = e.target.closest('[data-wsel]'))) {
    /* clicking a stack plays it straight away (or switches to it), and the master track shows it */
    var xr = b.dataset.wsel;
    if (S.playing !== wallKey(riff(xr), b.dataset.post)) wallPick(xr, b.dataset.post);
    var fm = document.querySelector('#riff-' + xr + ' .wmaster'); if (fm) fm.scrollIntoView({ behavior:'smooth', block:'nearest' });
    return;
  }
  if ((b = e.target.closest('[data-expand]'))) { S.expanded[b.dataset.expand] = !S.expanded[b.dataset.expand]; render(); return; }
  if ((b = e.target.closest('[data-vote]'))) { vote(b.dataset.vote, +b.dataset.dir); return; }
  if ((b = e.target.closest('[data-del]'))) { askOrDelete(b.dataset.del); return; }
  if ((b = e.target.closest('[data-tab]'))) { e.preventDefault(); S.tab = b.dataset.tab; render(); return; }
});
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeScrims(); });
window.addEventListener('resize', drawWaves);
window.addEventListener('stackato:theme', drawWaves);

/* ---------- start ---------- */
render();
startFromHash();
setToast(toast);
var first = true;
/* who is signed in decides your votes, "(you)" and what you can delete: load again when it changes */
onAccount(function (u) {
  var was = me && me.id; me = u;
  ['up-as', 'r-as'].forEach(function (id) { if (el(id)) el(id).innerHTML = postingAs(); });
  if (first || (u && u.id) !== was) { first = false; reload(); } else render();
});

/* The homepage (/): a feed of jams with their threads.

   A jam is a session with an original track. Its thread holds the audio replies (takes;
   takes.reply_to says which take a reply was played on top of) and the written replies
   (thread_comments), and anyone can up- or downvote the jam, a take or a comment
   (thread_votes). Reading needs no sign-in; every write (a comment, a vote, a take, a new
   jam) asks for an account first (src/auth.js) and carries on once there is one. Playing a take plays it with everything above it in its thread.

   The markup is built from strings like in app.js; render() redraws the whole list. */

import './theme.js';
import { configured } from './supabase.js';
import * as db from './data.js';
import { requireAccount, onAccount, postingAs, setToast, profileHref } from './auth.js';
import { analyse, sureness } from './analysis.js';
import { ROLES, role } from './roles.js';
import { AMPS, renderAmp, liveAmp, dropAmp, preloadAmp } from './amp.js';
import { AMP_ROLES, savedMic, rememberMic, savedAmp, rememberAmp, savedMon, rememberMon, recAmpFor, recWorklet, openMic, fadeIn, fadeOut, listMics, capture, newContext, rateTip, monitorOn, armMonitor, disarmMonitor, allowInputs, inputLatency, blockPeaks,
         beatInfoFor, clickSamples, assembleTake, bleedNote, quietNote, micError, encodeWav } from './rec.js';

var TOL = 0.6;                     /* seconds a take may differ from what it plays on (as in app.js) */

var LAYERS = { seed:{ label:'original track', c:'var(--seed)' }, part:{ label:'new part', c:'var(--part)' } };
ROLES.forEach(function (r) { LAYERS[r.id] = { label:r.label.toLowerCase(), c:'var(' + r.color + ')' }; });
function lay(id) { return LAYERS[id] || LAYERS.wild; }

var RIFFS = [];
var S = { tab:'fresh', expanded:{}, fold:{}, vote:{}, playing:null, cmt:{ at:null, text:'' }, loaded:false, failed:null, sure:null };
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
        if (c.id === s.seed_take_id) return { id:'riff', isRiff:true, by:seed.author_name, layer:LAYERS[s.seed_role] ? s.seed_role : 'seed', url:db.publicUrl(seed.storage_path), dur:seed.duration_sec, amp:seed.amp || '' };
        return { id:c.id, by:c.author_name, uid:c.author_id, layer:LAYERS[c.role_id] ? c.role_id : 'wild', url:db.publicUrl(c.storage_path), dur:c.duration_sec, amp:c.amp || '' };
      }).filter(Boolean);
    }
    KIND[s.id] = { kind:'session', sid:s.id };
    tk.forEach(function (t) {
      if (t.id === s.seed_take_id || t.role_id === 'seed') return;
      if (t.role_id === 'mix') { if (t.status === 'mix') mix = { by:t.author_name, url:db.publicUrl(t.storage_path) }; return; }
      if (t.status === 'own') return;   /* own takes only live in someone's version */
      if (t.status === 'deleted') {
        /* a deleted take stays as an empty spot, so the replies played on it keep their place */
        if (t.role_id !== 'part') posts.push({ id:t.id, parent:t.reply_to || t.section_id || null, deleted:true, created:t.created_at, likes:0 });
        return;
      }
      var base = { id:t.id, by:t.author_name, uid:t.author_id, mine:!!(me && t.author_id === me.id), time:ago(t.created_at), created:t.created_at,
        text:t.note, url:db.publicUrl(t.storage_path), path:t.storage_path, dur:t.duration_sec, likes:votes[t.id] || 0, status:t.status, amp:t.amp || '' };
      KIND[t.id] = { kind:'take', sid:s.id };
      if (t.role_id === 'part') {
        if (t.status !== 'in' && t.status !== 'waiting') return;
        /* a new part is a reply on the stack it was made on (reply_to), or on the jam */
        posts.push(Object.assign(base, { parent:t.reply_to || null, kind:'part', layer:'part', pos:t.part_pos, carry:carried(t.carry) }));
        return;
      }
      posts.push(Object.assign(base, { parent:t.reply_to || t.section_id || null, section:t.section_id || null, group:t.group_id || null,
        layer:LAYERS[t.role_id] ? t.role_id : 'wild', inSong:t.status === 'in' && !t.section_id }));
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
      groups[g].stems.push({ id:p.id, by:p.by, mine:p.mine, layer:p.layer, url:p.url, path:p.path, dur:p.dur, amp:p.amp }); return false;
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
    /* preview only (?wall): in these two jams every take was meant to go on the one before it, but was
       sent on the original track; stack them in the order they came in */
    /* preview only: in "drum regeton" the new part before the original track was a mistake; leave it out, with what was played on it */
    if (WALL && /drum regeton/i.test(title)) {
      var gone = {};
      posts.forEach(function (p) { if (p.kind === 'part' && p.pos === 'before') gone[p.id] = 1; });
      posts = posts.filter(function (p) { return !gone[p.id] && !gone[p.section] && !gone[p.parent]; });
    }
    if (WALL && /krentenbol|jurgocal/i.test(title)) {
      /* takes sent together as one reply become takes of their own, each with its own waveform */
      var flat = [];
      posts.forEach(function (p) {
        flat.push(p);
        (p.stems || []).forEach(function (x) {
          flat.push(Object.assign({}, x, { uid:p.uid, time:p.time, created:p.created, likes:0, status:p.status, text:'', parent:p.parent, section:p.section, inSong:p.inSong }));
        });
        delete p.stems;
      });
      posts = flat;
      /* then one stack in band order: drums, bass, guitars, keys, lead, vocals; the same layer in the order it came in */
      var ORDER = ['drums', 'bass', 'guitar', 'keys', 'atmos', 'lead', 'vocals', 'wild'];
      var rank = function (l) { var i = ORDER.indexOf(l); return i < 0 ? ORDER.length : i; };
      var prevTake = null;
      posts.filter(function (p) { return !p.isComment && !p.deleted && p.layer && p.kind !== 'part' && !p.section; })
        .sort(function (a, b) { return rank(a.layer) - rank(b.layer) || String(a.created).localeCompare(String(b.created)); })
        .forEach(function (p) { p.parent = prevTake ? prevTake.id : null; prevTake = p; });
    }
    var r = { id:s.id, slug:s.slug, by:seed.author_name, uid:s.host_id, title:title, bpm:s.bpm, key:s.music_key || '', sig:s.time_sig && s.time_sig !== '4/4' ? s.time_sig : '',
      time:ago(s.created_at), text:seed.note, layer:LAYERS[s.seed_role] ? s.seed_role : 'seed', url:db.publicUrl(seed.storage_path), dur:seed.duration_sec, amp:seed.amp || '',
      likes:votes[s.id] || 0, host:!!(me && s.host_id === me.id), open:s.status === 'open', mix:mix, posts:posts };
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
  S.expanded[r.id] = true; if (hit) openTo(r, hit);
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

/* ---------- comments: reply with words only ---------- */
function commentBtn(r, pid, label) {
  return '<button class="ghost" type="button" data-comment="' + r.id + '" data-post="' + (pid || '') + '">' + (label || 'Comment') + '</button>';
}
function commentForm(r, pid) {
  if (S.cmt.at !== key(r, pid)) return '';
  var p = pid ? postOf(r, pid) : null, to = !p ? r.by : p.mine ? 'yourself' : p.by;
  return '<form class="cbox" id="c-form" data-cform="' + key(r, pid) + '">' +
    '<textarea id="c-text" maxlength="500" placeholder="Say something to ' + esc(to) + '" aria-label="Your comment">' + esc(S.cmt.text) + '</textarea>' +
    '<div class="crow">' + postingAs() + '<span class="grow"></span>' +
      '<button class="btn btn-sm" type="button" data-ccancel="1">Cancel</button><button class="btn btn-sm btn-main" type="submit" id="c-go">Post comment</button></div>' +
    '<p class="err" id="c-err"></p></form>';
}
function openComment(rid, pid) {
  var r = riff(rid), k = key(r, pid || null);
  if (S.cmt.at === k) { S.cmt.at = null; render(); return; }
  ensureMe(jamCard(r, 'reply')).then(function () {
    S.cmt = { at:k, text:'' };
    if (pid) { S.expanded[rid] = true; openTo(r, postOf(r, pid)); }
    render();
    var t = el('c-text'); if (t) t.focus();
  });
}
function postComment() {
  var text = el('c-text').value.trim();
  if (!text) { el('c-err').textContent = 'Write something first.'; el('c-text').focus(); return; }
  var parts = S.cmt.at.split(':'), r = riff(parts[0]), pid = parts[1] === 'riff' ? null : parts[1], p = pid ? postOf(r, pid) : null;
  el('c-go').disabled = true;
  ensureMe('reply').then(function (u) {
    /* the database writes the account's name over author_name */
    return db.addThreadComment({ session_id:r.id, reply_to_take:p && !p.isComment ? p.id : null, reply_to_comment:p && p.isComment ? p.id : null,
      author_id:u.id, author_name:db.accountName(u), body:text });
  }).then(function (row) {
    S.cmt = { at:null, text:'' };
    S.expanded[r.id] = true; if (pid) S.fold[r.id + ':' + pid] = true;
    return reload().then(function () {
      var n = el('post-' + r.id + '-' + row.id); if (n) { n.scrollIntoView({ behavior:'smooth', block:'center' }); n.classList.add('hl'); }
      toast('Your comment is posted.');
    });
  }).catch(function (e) { if (el('c-go')) el('c-go').disabled = false; if (el('c-err')) el('c-err').textContent = (e && e.message) || 'That didn’t work, try again.'; });
}
document.addEventListener('input', function (e) {
  if (e.target.id === 'c-text') S.cmt.text = e.target.value;
});
document.addEventListener('submit', function (e) { if (e.target.id === 'c-form') { e.preventDefault(); postComment(); } });
/* the wall preview only reads: a comment there is not posted */
document.addEventListener('submit', function (e) {
  var f = e.target.closest && e.target.closest('[data-wsayform]'); if (!f) return;
  e.preventDefault(); toast('This is a read-only preview, so the comment isn’t posted. Without ?wall you can comment as usual.');
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
      : [p].concat(p.stems || []).reduce(function (pr, x) { return pr.then(function () { return db.deleteThreadTake(x.id, x.path); }); }, Promise.resolve());
  }
  job.then(reload).then(function () {
    toast(what === 'jam' ? 'The jam is deleted.' : 'Deleted. Replies to it stay in the thread.');
  }).catch(function (e) { render(); oops(e); });
}

/* ---------- the thread ---------- */
function mixLink(label, r, tid) {
  return '<a class="ghost mixlink" href="/s/' + encodeURIComponent(r.slug) + (tid ? '?stack=' + encodeURIComponent(tid) : '') + '">' + label + '</a>';
}
function songOf(r) { return r.posts.filter(function (p) { return p.inSong; }); }
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
    if (p.kind === 'part') return [{ id:p.id, by:p.by, mine:p.mine, layer:'part', url:p.url, dur:p.dur, isPart:true }].concat(p.carry || [], out);
    if (p.layer) out = stemsOf(p).concat(out);
  }
  return [{ id:'riff', by:r.by, layer:r.layer, url:r.url, dur:r.dur, isRiff:true, mine:r.host, amp:r.amp }].concat(out);
}
function bufKey(r, p) { return p.isRiff ? r.id + ':riff' : r.id + ':' + p.id; }
function chipLabel(p) { return p.isRiff ? 'clip' : p.isPart ? 'new part' : lay(p.layer).label; }
function chainChips(r, c) { return c.map(function (p) { return '<span class="chip"><span class="dot" style="background:' + lay(p.layer).c + '"></span>' + esc(whose(p)) + ' ' + chipLabel(p) + '</span>'; }).join(''); }

/* ---------- audio ---------- */
function ac() { if (!AC) AC = newContext(); return AC; }
function load(r, p) {
  var k = bufKey(r, p);
  if (BUF[k] || BUF[k + ':loading'] || !p.url) return Promise.resolve();
  BUF[k + ':loading'] = true;
  return fetch(p.url).then(function (x) { if (!x.ok) throw new Error(x.status); return x.arrayBuffer(); })
    .then(function (ab) { return ac().decodeAudioData(ab); })
    .then(function (b) { BUF[k] = b; drawWaves(); })
    .catch(function (e) { console.warn('Could not load audio', p.url, e); });
}
/* A take with an amp (a dry DI guitar, set in the song view) plays rendered through it.
   The render is made once and kept next to the dry audio; if it fails, the take plays dry. */
function ampKey(r, p) { return bufKey(r, p) + '@' + p.amp; }
function amped(r, p) {
  var b = BUF[bufKey(r, p)], k = ampKey(r, p);
  if (!p.amp || !b || BUF[k] || BUF[k + ':failed']) return Promise.resolve();
  if (!BUF[k + ':busy']) BUF[k + ':busy'] = renderAmp(b, p.amp).then(function (x) { BUF[k] = x; }, function (e) { console.warn('Could not render the amp', e); BUF[k + ':failed'] = true; });
  return BUF[k + ':busy'];
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
  Promise.all(c.map(function (p) { return load(r, p); })).then(function () {
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
/* the whole song with a new part in it: what the part was made on, then the part (or the other
   way round for a part before), one after the other, each with what plays on it */
function wholeKey(r, pid) { return r.id + ':whole:' + pid; }
function playWhole(rid, pid) {
  var r = riff(rid), p = postOf(r, pid), k = wholeKey(r, pid);
  if (!p) return;
  if (S.playing === k) { stop(); render(); return; }
  var main = p.parent ? chainOf(r, p.parent) : chainOf(r, null).concat(songOf(r));
  var onPart = chainOf(r, p.id);
  r.posts.forEach(function (x) { if (x.section === p.id && x.layer && !x.deleted && !x.isComment && x.uid === p.uid && x.kind !== 'part') onPart = onPart.concat(stemsOf(x)); });
  var segs = p.pos === 'before' ? [onPart, main] : [main, onPart], all = segs[0].concat(segs[1]);
  SRC.forEach(function (s) { try { s.stop(); } catch (e) {} }); SRC = []; CLOCK = null;
  S.playing = k; render();
  Promise.all(all.map(function (x) { return load(r, x); })).then(function () {
    return Promise.all(all.map(function (x) { return amped(r, x); }));
  }).then(function () {
    if (S.playing !== k) return;
    var a = ac(); a.resume(); var T = a.currentTime + 0.05;
    segs.forEach(function (seg) {
      var lead = bufFor(r, seg[0]), len = lead ? lead.duration : 0;
      seg.forEach(function (x) {
        var b = bufFor(r, x); if (!b || !len) return;
        var s = a.createBufferSource(); s.buffer = b; s.loop = true; s.connect(a.destination);
        s.start(T); s.stop(T + len); SRC.push(s);
      });
      T += len;
    });
    var end = T - a.currentTime;
    setTimeout(function () { if (S.playing === k) { stop(); render(); } }, Math.max(0, end * 1000) + 100);
  });
}
function playSong(rid) { var r = riff(rid); playList(rid + ':song', r, chainOf(r, null).concat(songOf(r))); }
function playMix(rid) { var r = riff(rid); playList(rid + ':mix', r, [{ id:'mix', url:r.mix.url }]); }

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
  headRaf = requestAnimationFrame(tickHeads);
}
function seekTarget(cv) {
  var w = cv.dataset.wave, i = w.indexOf(':'), rid = w.slice(0, i), pid = w.slice(i + 1);
  var r = riff(rid); if (!r) return null;
  if (pid === 'riff') return { r:r, pid:null };
  var p = postOf(r, pid) || postOf(r, pid.split('~')[0]);   /* a stem of a grouped reply plays its reply */
  return p ? { r:r, pid:p.id } : null;
}
function lenOf(cv) { var b = BUF[cv.dataset.wave]; return b ? b.duration : 0; }
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
      var q = cv.dataset.of.split(':solo:'), rct = cv.getBoundingClientRect();
      wallSolo(q[0], q[1], Math.min(1, Math.max(0, (e.clientX - rct.left) / rct.width)) * lenOf(cv));
    }
    return;
  }
  var t = seekTarget(cv); if (!t) return;
  var rect = cv.getBoundingClientRect(), f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  play(t.r.id, t.pid, f * lenOf(cv));
});
/* a real waveform: the highest and lowest sample in every pixel column, drawn as one shape */
function waveShape(cv, buf, color) {
  var w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1;
  if (!w || !h) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  var g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  g.fillStyle = color;
  var mid = h / 2;
  if (!buf) { g.globalAlpha = .35; g.fillRect(0, mid - 1, w, 2); return; }
  var d = buf.getChannelData(0), cols = Math.max(1, Math.floor(w)), step = d.length / cols, hi = [], lo = [], peak = 0, x, i;
  for (x = 0; x < cols; x++) {
    var a = Math.floor(x * step), z = Math.min(d.length, Math.floor((x + 1) * step)), mx = 0, mn = 0;
    for (i = a; i < z; i++) { var v = d[i]; if (v > mx) mx = v; else if (v < mn) mn = v; }
    hi.push(mx); lo.push(mn); peak = Math.max(peak, mx, -mn);
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
    var tone = lit && !cv.closest('.wb, .jcard') ? '--sound' : cv.closest('.take, .wb, .jcard') && cv.dataset.layer && lay(cv.dataset.layer).c.indexOf('var(') === 0 ? lay(cv.dataset.layer).c.slice(4, -1) : '--wave';
    waveShape(cv, BUF[cv.dataset.wave], css.getPropertyValue(tone).trim());
  });
}

/* ---------- rendering ---------- */
function lyr(layer) { return '<b class="lyr" style="color:' + lay(layer).c + '">' + lay(layer).label + '</b>'; }
/* a take's avatar wears its instrument's colour; written replies get an outlined one */
function ava(name, layer, sm) {
  return '<span class="ava' + (sm ? ' sm' : '') + (layer ? '' : ' words') + '"' + (layer ? ' style="background:' + lay(layer).c + '"' : '') + ' aria-hidden="true">' +
    esc(String(name).charAt(0).toUpperCase()) + '</span>';
}
/* folding: every level of replies opens and closes on its own */
function folded(k) { return !S.fold[k]; }
function countDesc(r, id) { return kids(r, id).reduce(function (n, k) { return n + 1 + countDesc(r, k.id); }, 0); }
function foldBtn(r, id) {
  var n = countDesc(r, id), k = r.id + ':' + id;
  return '<button class="fold' + (folded(k) ? '' : ' open') + '" type="button" data-fold="' + k + '" aria-expanded="' + !folded(k) + '">' + (folded(k) ? 'Show ' + n + (n > 1 ? ' replies' : ' reply') : 'Hide replies') + '</button>';
}
function kidsHtml(r, p, depth) {
  var ks = kids(r, p.id);
  if (!ks.length) return '';
  return foldBtn(r, p.id) + (folded(r.id + ':' + p.id) ? '' : '<div class="kids">' + ks.map(function (k) { return replyHtml(r, k, depth + 1); }).join('') + '</div>');
}
/* open every level above a post, so a link can land on it */
function openTo(r, p) {
  var x = p;
  while (x && x.parent) { S.fold[r.id + ':' + x.parent] = true; x = postOf(r, x.parent); }
}
function metaTime(p) { return '<span class="muted">· ' + esc(p.time) + '</span>'; }
/* a reply in the thread: an avatar, then who and what, the words, the take, what you can do, and its own replies */
function node(r, p, cls, aside, body, depth) {
  return '<div class="node' + (cls ? ' ' + cls : '') + '" id="post-' + r.id + '-' + p.id + '">' + aside +
    '<div class="nbody">' + body + kidsHtml(r, p, depth) + '</div></div>';
}
function partHtml(r, p, depth) {
  var on = sounding(r, p.id), kept = p.status === 'in';
  return node(r, p, 'upd', '<span class="ava upd-ava" aria-hidden="true">&#8596;</span>',
    '<div class="meta"><b>' + nameOf(p.mine ? 'You' : p.by, p.uid) + '</b><span class="muted">made the song longer</span>' + (kept ? '<span class="songtag">In the song</span>' : '') + metaTime(p) + '</div>' +
    (p.text ? '<p class="bubble">' + esc(p.text) + '</p>' : '') +
    '<div class="take' + (on ? ' on' : '') + '"><div class="take-row"><button class="play sm' + (on ? ' on' : '') + '" type="button" data-play="' + r.id + '" data-post="' + p.id + '" aria-label="' + (on ? 'Stop' : 'Play the new part') + '">' + (on ? '&#10074;&#10074;' : '&#9654;') + '</button>' +
      '<canvas data-wave="' + r.id + ':' + p.id + '" data-layer="part"></canvas></div><div class="chain">plays ' + (p.pos === 'before' ? 'before' : 'after') + ' the original clip' +
      ((p.carry || []).length ? ', with ' + chainChips(r, p.carry) : '') + '</div></div>' +
    '<div class="acts">' + (r.host && r.open && !kept ? '<button class="btn btn-sm btn-main" type="button" data-letin="' + p.id + '">Add to song</button>' : '') +
      '<button class="ghost accent' + (S.playing === wholeKey(r, p.id) ? ' on' : '') + '" type="button" data-whole="' + r.id + '" data-post="' + p.id + '">' + (S.playing === wholeKey(r, p.id) ? '&#10074;&#10074; Stop the song' : '&#9654; Play the whole song') + '</button>' +
      (r.open ? '<button class="ghost accent" type="button" data-reply="' + r.id + '" data-post="' + p.id + '">+ Play on the new part</button>' : '') +
      mixLink('Open this stack in project view', r, p.id) + commentBtn(r, p.id, 'Reply') + voteHtml(p.id, p.likes) + '</div>' + commentForm(r, p.id), depth);
}
function goneHtml(r, p, depth) {
  return node(r, p, 'gone', '<span class="ava words" aria-hidden="true"></span>',
    '<p class="gone-txt">' + (p.isComment ? 'This reply was deleted.' : 'This take was deleted. The replies played on it stay.') + '</p>', depth);
}
function replyHtml(r, p, depth) {
  if (p.deleted) return goneHtml(r, p, depth);
  if (p.kind === 'part') return partHtml(r, p, depth);
  var on = sounding(r, p.id);
  return node(r, p, '', ava(p.mine ? 'You' : p.by, p.layer),
    '<div class="meta"><b>' + nameOf(p.mine ? 'You' : p.by, p.uid) + '</b>' + (p.layer ? '<span class="muted">added</span>' + stemsOf(p).map(function (x) { return lyr(x.layer); }).join(' + ') : '') +
      (p.inSong ? '<span class="songtag">In the song</span>' : '') + metaTime(p) + '</div>' +
    (p.text ? '<p class="bubble">' + esc(p.text) + '</p>' : '') +
    (p.layer ? '<div class="take' + (on ? ' on' : '') + '"><div class="take-row"><button class="play sm' + (on ? ' on' : '') + '" type="button" data-play="' + r.id + '" data-post="' + p.id + '" aria-label="' + (on ? 'Stop' : 'Play with everything above it') + '">' + (on ? '&#10074;&#10074;' : '&#9654;') + '</button>' +
      (p.stems && p.stems.length ? '<div class="mixlanes">' + stemsOf(p).map(function (x) { return '<canvas data-wave="' + r.id + ':' + x.id + '" data-of="' + key(r, p.id) + '" data-layer="' + x.layer + '"></canvas>'; }).join('') + '</div>'
        : '<canvas data-wave="' + r.id + ':' + p.id + '" data-of="' + key(r, p.id) + '" data-layer="' + p.layer + '"></canvas>') + '</div>' +
      '<div class="chain">on top of ' + chainChips(r, chainOf(r, p.id).slice(0, -stemsOf(p).length)) + '</div></div>' : '') +
    '<div class="acts">' +
      (p.layer && r.host && r.open && p.status === 'waiting' && !p.section ? '<button class="btn btn-sm btn-main" type="button" data-letin="' + p.id + '">Add to song</button>' : '') +
      (p.layer && r.open ? '<button class="ghost accent" type="button" data-reply="' + r.id + '" data-post="' + p.id + '">+ Reply with audio</button>' : '') +
      commentBtn(r, p.id, 'Reply') + (p.layer ? mixLink('Open this stack in project view', r, p.id) : '') +
      (canDelete(p.mine) ? delBtn(p.isComment ? 'comment' : 'take', p.id) : '') + voteHtml(p.id, p.likes) + '</div>' + commentForm(r, p.id), depth);
}
/* The thread bar: the way into a jam's replies, across the bottom of the card. It shows who
   replied, what kind of replies there are and the latest one, so it reads as "there's a
   conversation here" rather than a small link. */
function threadBar(r, open) {
  var live = livePosts(r), n = live.length;
  if (!r.posts.length) return '';
  var takes = live.filter(function (p) { return p.layer && p.kind !== 'part'; }).length, parts = live.filter(function (p) { return p.kind === 'part'; }).length;
  var words = n - takes - parts, seen = {}, faces = [];
  live.forEach(function (p) { var who = p.mine ? 'You' : p.by; if (!seen[who]) { seen[who] = 1; faces.push(ava(who, p.layer && p.kind !== 'part' ? p.layer : null, true)); } });
  var last = live.slice().sort(function (a, b) { return String(b.created).localeCompare(String(a.created)); })[0];
  var what = [takes ? takes + (takes > 1 ? ' takes' : ' take') : '', parts ? parts + (parts > 1 ? ' new parts' : ' new part') : '', words ? words + (words > 1 ? ' comments' : ' comment') : ''].filter(Boolean).join(', ');
  var lastTxt = last ? (last.mine ? 'You' : last.by) + (last.layer && last.kind !== 'part' ? ' added ' + lay(last.layer).label : last.kind === 'part' ? ' added a new part' : ': “' + (last.text.length > 60 ? last.text.slice(0, 57) + '…' : last.text) + '”') + ', ' + last.time : '';
  return '<button class="threadbar' + (open ? ' open' : '') + '" type="button" data-expand="' + r.id + '" aria-expanded="' + open + '" aria-controls="replies-' + r.id + '">' +
    (faces.length ? '<span class="faces">' + faces.slice(0, 4).join('') + '</span>' : '') +
    '<span class="tb-txt"><b>' + (n ? n + (n > 1 ? ' replies' : ' reply') : 'Replies') + '</b>' + (what ? ' · ' + what : '') +
      (lastTxt && !open ? '<small>Latest: ' + esc(lastTxt) + '</small>' : '') + '</span>' +
    '<span class="tb-go">' + (open ? 'Hide the thread <i aria-hidden="true">&#9652;</i>' : 'Show the thread <i aria-hidden="true">&#9662;</i>') + '</span></button>';
}
function riffMeta(r) {
  return esc(r.time) + (r.bpm ? ' · ' + r.bpm + ' bpm' : '') + (r.key ? ' · ' + esc(r.key) : '') + (r.sig ? ' · ' + esc(r.sig) : '') + (r.dur ? ' · ' + mmss(r.dur) : '');
}
function riffHtml(r) {
  if (WALL) return cardHtml(r);
  var on = sounding(r, null), ps = players(r), open = !!S.expanded[r.id], song = songOf(r);
  var top = r.posts.filter(function (p) { return !p.parent; });
  var html = '<article class="riff' + (r.host ? ' mine' : '') + '" id="riff-' + r.id + '"><div class="rmain">' +
    '<div class="rhead">' + ava(r.by, r.layer) + '<div class="rwho"><b>' + nameOf(r.by, r.uid) + (r.host ? ' (you)' : '') + '</b> started a jam' + (r.layer !== 'seed' ? ' · ' + lyr(r.layer) : '') +
      '<small>' + riffMeta(r) + '</small></div></div>' +
    '<h2 class="rtitle">' + esc(r.title) + (r.song ? '<span class="tag">Became a song</span>' : '') + '</h2>' + (r.text ? '<p class="rtext">' + esc(r.text) + '</p>' : '') +
    '<div class="well"><button class="play big' + (on ? ' on' : '') + '" type="button" data-play="' + r.id + '" aria-label="' + (on ? 'Stop' : 'Play the clip') + '">' + (on ? '&#10074;&#10074;' : '&#9654;') + '</button>' +
      '<canvas data-wave="' + r.id + ':riff" data-layer="' + r.layer + '"></canvas><span class="wtime">' + mmss(r.dur) + '</span></div>' +
    '<div class="racts">' + (r.open ? '<button class="btn btn-main" type="button" data-reply="' + r.id + '">Play along</button>' : '') +
      '<a class="btn" href="/s/' + encodeURIComponent(r.slug) + '">Open in project view</a>' +
      (song.length ? '<button class="btn btn-soft" type="button" data-playsong="' + r.id + '">' + (S.playing === r.id + ':song' ? '&#10074;&#10074; ' : '&#9654; ') + 'The song · ' + song.length + (song.length > 1 ? ' takes' : ' take') + '</button>' : '') +
      commentBtn(r, null) + (canDelete(r.host) ? delBtn('jam', r.id, 'Delete jam') : '') +
      '<span class="grow"></span>' +
      (ps.length ? '<span class="played"><span class="faces">' + ps.slice(0, 5).map(function (p) { return ava(p.mine ? 'You' : p.by, p.layer, true); }).join('') + '</span>' +
        ps.length + ' musician' + (ps.length > 1 ? 's' : '') + ' played along</span>' : '<span class="played">Nobody played along yet. Be the first.</span>') +
      voteHtml(r.id, r.likes) + '</div>' + commentForm(r, null);
  if (r.song) html += '<div class="became"><p><b>' + esc(r.song.name) + '</b>Released. ' + r.song.musicians + ' musician' + (r.song.musicians > 1 ? 's are' : ' is') + ' on the song.' + (r.mix ? ' ' + esc(r.mix.by) + ' uploaded the mix.' : '') + '</p>' +
    (r.mix ? '<button class="btn btn-sm btn-sound" type="button" data-playmix="' + r.id + '">' + (S.playing === r.id + ':mix' ? '&#10074;&#10074; Stop' : '&#9654; Play the mix') + '</button>' : '') + '</div>';
  html += '</div>' + threadBar(r, open);
  if (open && r.posts.length) html += '<div class="replies" id="replies-' + r.id + '">' + top.map(function (x) { return replyHtml(r, x, 0); }).join('') + '</div>';
  return html + '</article>';
}
/* ---------- preview: the thread as a wall of stacks (/?wall, read-only, not in the live site) ----------
   The original track is the bottom block; every take sits on top of the take it was played on,
   and takes played on the same take share its width. A new part is its own little wall, before
   or after the original track. "Show reactions" unrolls the wall upwards, row by row. */
var WALL = (function () { try { return new URLSearchParams(location.search).has('wall'); } catch (e) { return false; } })();
S.wsel = {}; S.wtalk = {}; S.wsay = {}; S.wopen = {}; S.wscroll = {}; S.wpage = {}; S.wfull = {}; S.wcore = {};
/* keep each wall where it was scrolled to, through every redraw, and move its dots along */
document.addEventListener('scroll', function (e) {
  var w = e.target; if (!w.classList || !w.classList.contains('wwrap') || !w.dataset.wr) return;
  S.wscroll[w.dataset.wr] = w.scrollLeft;
  var i = wallPageOf(w); if (S.wpage[w.dataset.wr] === i) return;
  S.wpage[w.dataset.wr] = i; wallFit(w);
  var fb = w.parentNode.querySelector('.wfull'), cur = w.querySelectorAll('.wsec')[i];
  if (fb) fb.hidden = !(fb.dataset.keep || (cur && !cur.classList.contains('wsec-core')));
  var box = w.parentNode.querySelector('.wdots');
  if (box) [].forEach.call(box.querySelectorAll('[data-wdot]'), function (b) { b.setAttribute('aria-current', String(+b.dataset.i === i)); });
}, true);
/* /?wall&embed=<jam id>: the project shows this page in a frame under its tracks; the tracks are the
   master track there, so picking a stack tells the project, and the project says which stack it plays */
var EMBED = WALL && (function () { try { return new URLSearchParams(location.search).get('embed'); } catch (e) { return null; } })();
function embedH() { var l = el('list'); return l ? Math.ceil(l.getBoundingClientRect().bottom + window.scrollY + 12) : 400; }
function toProject(msg) { try { parent.postMessage(Object.assign({ stk:1 }, msg), location.origin); } catch (e) {} }
if (EMBED) {
  document.documentElement.classList.add('wembed');
  var est = document.createElement('style');
  est.textContent = 'html.wembed body{background:var(--paper)}html.wembed header.top,html.wembed .wide:not(#feed),html.wembed footer,html.wembed .sitefoot,html.wembed .feedhead,html.wembed #jtools,html.wembed [class*="viewas"]{display:none!important}' +
    'html.wembed #feed{padding:0;max-width:none}html.wembed #list{display:block}html.wembed .riff{border:0;box-shadow:none;border-radius:0;background:transparent}html.wembed .rmain{padding:4px 2px 8px}';
  document.head.appendChild(est);
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || !e.data.stk) return;
    if (e.data.sel !== undefined && S.wsel[EMBED] !== e.data.sel) { S.wsel[EMBED] = e.data.sel; render(); }
  });
  if (window.ResizeObserver) new ResizeObserver(function () { toProject({ h:embedH() }); }).observe(document.documentElement);
}
if (WALL) {
  var wst = document.createElement('style');
  wst.textContent =
    '@keyframes wb-rise{from{opacity:0;transform:translateY(18px) scale(.9)}to{opacity:1;transform:none}}' +
    '.wpre{display:inline-block;margin-left:8px;font-size:12px;font-weight:700;color:var(--wait-ink);background:var(--wait-bg);padding:3px 10px;border-radius:99px;vertical-align:middle}' +
    '.wwrap{overflow-x:auto;padding:2px 2px 6px;margin-top:4px}' +
    '.wrow{display:flex;align-items:flex-end;width:100%}' +
    '.wsec{display:flex;flex-direction:column;gap:6px;flex:var(--n) 1 0;min-width:calc(var(--n) * 104px)}' +
    '.wsec.wsec-shut{min-width:0}' +
    '.wsec small{font-size:12px;line-height:1.35;color:var(--muted);padding-left:2px}' +
    '.warrow{width:44px;flex:none;align-self:stretch;display:flex;align-items:flex-end;justify-content:center;padding-bottom:30px;color:var(--part);font-size:20px}' +
    '.wgrid{display:grid;gap:4px}' +
    '.wb{display:flex;align-items:center;gap:6px;padding:0 6px;border-radius:10px;min-width:0;font-size:13px;--c:var(--wild);background:var(--paper);border:1px solid var(--line-strong);color:var(--ink)}' +
    '.wb.wb-rise{animation:wb-rise .35s ease both}' +
    '.wb.wb-lit{border:2px solid var(--c);background:color-mix(in srgb,var(--c) 7%,var(--paper))}' +
    '.wb.wb-root{--c:var(--ink);background:color-mix(in srgb,var(--ink) 5%,var(--paper))}' +
    '.wb.wb-part{--c:var(--part);border-style:dashed}' +
    '.wb.wb-gone{background:transparent;border:1.5px dashed var(--line-strong);color:var(--muted)}' +
    '.wb.wb-picked{box-shadow:0 0 0 2px var(--paper),0 0 0 4px var(--ink)}' +
    '.wb .wsolo{width:30px;height:30px;border-radius:50%;border:0;flex:none;cursor:pointer;font-size:11px;background:color-mix(in srgb,var(--c) 14%,var(--paper));color:color-mix(in srgb,var(--c) 80%,var(--ink))}' +
    '.wb .wsolo.on{background:var(--sound);color:#fff}' +
    '.wb .wsolo1{width:24px;height:24px;border-radius:6px;border:1px solid var(--line-strong);flex:none;cursor:pointer;font:700 11px/1 var(--body);background:var(--paper);color:var(--muted)}' +
    '.wb .wadd{width:24px;height:24px;border-radius:50%;border:0;flex:none;cursor:pointer;font:700 15px/1 var(--body);background:var(--action);color:var(--on-action)}' +
    '.wb .wadd:hover{background:var(--action-hover)}' +
    '.wb .wsolo1:hover{color:var(--ink);border-color:var(--ink)}.wb .wsolo1.on{background:#E5B53B;border-color:#E5B53B;color:#121212}' +
    '.wb .wname{flex:1 1 auto;min-width:0;height:100%;display:flex;align-items:center;gap:8px;background:transparent;border:0;color:inherit;font:inherit;cursor:pointer;text-align:left;padding:0}' +
    '.wb .wname span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:0 1 auto}' +
    '.wb .wname canvas{flex:1 1 40px;min-width:24px;height:28px;pointer-events:none}.wb .wname canvas.wseekable{pointer-events:auto;cursor:text}' +
    '.wb .wbadge{font-size:11px;font-weight:700;padding:3px 7px;border-radius:99px;flex:none;border:0;cursor:pointer;background:color-mix(in srgb,var(--ink) 6%,var(--paper));color:var(--ink)}' +
    '.wb .wbadge:hover{background:color-mix(in srgb,var(--ink) 12%,var(--paper))}' +
    '.wsay{display:flex;flex-direction:column;gap:8px;padding-top:6px;border-top:1px solid var(--line)}' +
    '.wsay label{font-size:13px;color:var(--muted);display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
    '.wsay select{min-height:40px;border-radius:12px;border:1px solid var(--line-strong);padding:0 10px;font:inherit;background:var(--paper);color:var(--ink);max-width:100%}' +
    '.wsay .wsay-row{display:flex;gap:8px}.wsay textarea{flex:1 1 auto;min-width:0;min-height:44px;border-radius:12px;border:1px solid var(--line-strong);padding:10px 12px;font:inherit;resize:vertical;background:var(--paper);color:var(--ink)}' +
    '.wplus{display:flex;align-items:flex-end;justify-content:center;padding-bottom:4px}.wplus.wp-rise{animation:wb-rise .35s ease both}' +
    '.wplus button{width:28px;height:28px;border-radius:50%;border:0;background:var(--action);color:var(--on-action);font:700 17px/1 var(--body);cursor:pointer}' +
    '.wb{cursor:pointer}.wb:hover{border-color:var(--ink)}' +
    '.wfull{display:flex;justify-content:center;margin-top:10px}' +
    '.wmaster{margin-top:14px;border-radius:16px;background:var(--sound-soft);padding:12px 14px;display:flex;flex-direction:column;gap:10px}' +
    '.wm-top{display:flex;align-items:center;gap:12px}' +
    '.wm-top .play{flex:none;width:52px;height:52px;border-radius:50%;border:0;background:var(--sound);color:#fff;font-size:16px;cursor:pointer}' +
    '.wm-what{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 auto}' +
    '.wm-what b{font-size:15px}' +
    '.wm-chips{display:flex;gap:6px;flex-wrap:wrap}' +
    '.wm-chips span{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;background:var(--paper);border-radius:99px;padding:2px 9px}' +
    '.wm-chips i{width:8px;height:8px;border-radius:50%;display:inline-block}' +
    '.wm-wave{position:relative;display:flex;gap:6px;height:56px}' +
    '.wm-wave div{position:relative;flex:1 1 0;min-width:0;background:color-mix(in srgb,var(--paper) 55%,transparent);border-radius:10px;padding:4px 8px 16px}' +
    '.wm-wave canvas{width:100%;height:100%;display:block}' +
    '.wm-wave small{position:absolute;left:8px;bottom:2px;font-size:11px;font-weight:700;color:var(--sound-ink)}' +
    '.wm-wave{cursor:pointer}.wm-head{position:absolute;top:-4px;bottom:-4px;width:2px;margin-left:-1px;background:var(--ink);border-radius:1px;pointer-events:none}' +
    '.wm-hover{position:absolute;top:0;bottom:0;width:1px;background:var(--sound-ink);opacity:.5;pointer-events:none}' +
    '.wm-acts{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;color:var(--sound-ink)}' +
    '.wtalk{display:flex;align-items:center;gap:12px;width:100%;padding:14px 24px;border:0;border-top:1px solid var(--line);background:var(--paper);color:var(--ink);font:inherit;text-align:left;cursor:pointer}' +
    '.wtalk .wlast{flex:1 1 auto;min-width:0;font-size:13px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.wtalk .wgo{flex:none;font-weight:700;font-size:14px;border:1px solid var(--line-strong);border-radius:99px;padding:8px 14px}' +
    '.wwords{padding:4px 24px 20px;display:flex;flex-direction:column;gap:14px}' +
    '.wword{display:flex;gap:10px}.wword .ava{flex:none}' +
    '.wword b{font-size:14px}.wword .muted{font-size:12px;margin-left:6px}' +
    '.wword p{margin:3px 0 0;font-size:15px;line-height:1.45}' +
    '.wchip{display:inline-block;margin-top:3px;font-size:12px;font-weight:700;padding:2px 8px;border-radius:99px;border:0;cursor:pointer;--c:var(--muted);background:color-mix(in srgb,var(--c) 14%,var(--paper));color:color-mix(in srgb,var(--c) 75%,var(--ink))}';
  document.head.appendChild(wst);
}
function wallTree(r) {
  var takes = r.posts.filter(function (p) { return !p.isComment && (p.layer || p.deleted); }), byId = {};
  takes.forEach(function (p) { byId[p.id] = p; });
  function up(p) { return p.parent && byId[p.parent] ? byId[p.parent] : null; }
  function secOf(p) { if (p.kind === 'part') return p.id; for (var x = up(p); x; x = up(x)) if (x.kind === 'part') return x.id; return 'core'; }
  var root = { id:'riff', isRiff:true, by:r.by, layer:r.layer, kids:[] }, nodes = { riff:root };
  takes.forEach(function (p) { nodes[p.id] = { id:p.id, p:p, kids:[] }; });
  var parts = [];
  takes.forEach(function (p) {
    var n = nodes[p.id], par = up(p);
    if (p.kind === 'part') { n.madeOn = par ? par.id : 'riff'; parts.push(n); return; }
    (par ? nodes[par.id] : root).kids.push(n);
  });
  var words = {};
  r.posts.forEach(function (c) { if (c.isComment && !c.deleted && c.parent) words[c.parent] = (words[c.parent] || 0) + 1; });
  function parentOf(id) {
    if (id === 'riff') return null;
    var n = nodes[id]; if (n.p.kind === 'part') return n.madeOn;
    var par = up(n.p); return par ? par.id : 'riff';
  }
  var before = parts.filter(function (n) { return n.p.pos === 'before'; }).reverse(), after = parts.filter(function (n) { return n.p.pos !== 'before'; });
  var secs = before.map(function (n) { return { root:n, part:true } }).concat([{ root:root, core:true }], after.map(function (n) { return { root:n, part:true }; }));
  var maxD = 0;
  secs.forEach(function (sx) {
    var cols = 0;
    (function walk(n, d) {
      n.d = d; maxD = Math.max(maxD, d); sx.maxD = Math.max(sx.maxD || 0, d);
      if (!n.kids.length) { n.c0 = n.c1 = cols++; return; }
      n.kids.forEach(function (k) { walk(k, d + 1); });
      n.c0 = n.kids[0].c0; n.c1 = n.kids[n.kids.length - 1].c1;
    })(sx.root, 0);
    sx.cols = cols;
  });
  var partOf = {};
  parts.forEach(function (pn) { (function mark(n) { partOf[n.id] = pn; n.kids.forEach(mark); })(pn); });
  return { secs:secs, nodes:nodes, maxD:maxD, partOf:partOf, words:words, parentOf:parentOf, parts:parts.length, takes:takes.filter(function (p) { return p.kind !== 'part' && !p.deleted; }).length };
}
function wallLabel(n) {
  if (n.isRiff) return 'Original track' + (n.layer !== 'seed' ? ' · ' + lay(n.layer).label : '');
  var p = n.p;
  if (p.deleted) return 'deleted take';
  if (p.kind === 'part') return '↦ new part';
  return stemsOf(p).map(function (x) { return lay(x.layer).label; }).join(' + ');
}
function wallWhose(r, id) {
  if (id === 'riff') return r.by + '’s original track';
  var p = postOf(r, id); if (!p) return 'a take';
  return (p.mine ? 'your ' : p.by + '’s ') + (p.kind === 'part' ? 'new part' : stemsOf(p).map(function (x) { return lay(x.layer).label; }).join(' + '));
}
function wallHtml(r) {
  var open = !!S.expanded[r.id], T = wallTree(r), sel = S.wsel[r.id] || null, STEP = 0.16;
  /* the rows rise in only right after "Show reactions", not on every redraw */
  if (!open) delete S.wopen[r.id]; else if (!S.wopen[r.id]) S.wopen[r.id] = Date.now();
  var anim = open && Date.now() - S.wopen[r.id] < 700, LAND = S.ov === r.id ? 0.32 : 0;
  var lit = {};
  for (var x = sel; x; x = T.parentOf(x)) lit[x] = true;
  if (sel && T.partOf[sel]) for (var y = wallBase(r, T, T.partOf[sel]); y; y = T.parentOf(y)) lit[y] = true;
  var MOB = window.matchMedia && matchMedia('(max-width:760px)').matches;
  function rowsOf(sx) { return !open ? 1 : MOB ? sx.maxD + 2 : T.maxD + 2; }
  var rows = 1;
  function block(n, sx) {
    rows = rowsOf(sx);
    var d = n.d + (sx.part ? 1 : 0);   /* a new part came after the jam started: it rises with the first row */
    if (!open && !(sx.core && n.isRiff)) return '';
    var p = n.p || {}, layer = n.isRiff ? r.layer : p.kind === 'part' ? 'part' : p.layer;
    var cls = 'wb' + (n.isRiff ? ' wb-root' : '') + (p.kind === 'part' ? ' wb-part' : '') + (p.deleted ? ' wb-gone' : '') + (lit[n.id] ? ' wb-lit' : '') + (n.id === sel ? ' wb-picked' : '') + (anim && d ? ' wb-rise' : '');
    var soloOn = S.playing === wallKey(r, n.id), w = T.words[n.id] || 0;
    var style = 'grid-column:' + (n.c0 + 1) + ' / ' + (n.c1 + 2) + ';grid-row:' + (rows - n.d) + ';--c:' + lay(layer).c + (anim && d ? ';animation-delay:' + (LAND + d * STEP).toFixed(2) + 's' : '');
    if (p.deleted) return '<div class="' + cls + '" style="' + style + '"><span class="wname"><span>Deleted take</span></span></div>';
    var who = n.isRiff ? r.by : (p.mine ? 'You' : p.by);
    return '<div class="' + cls + '" style="' + style + '" data-wsel="' + r.id + '" data-post="' + n.id + '">' +
      '<button class="wsolo' + (soloOn ? ' on' : '') + '" type="button" data-wpick="' + r.id + '" data-post="' + n.id + '" aria-label="' + (soloOn ? 'Pause' : 'Play the stack up to ' + esc(wallWhose(r, n.id))) + '">' + (soloOn ? '&#10074;&#10074;' : '&#9654;') + '</button>' +
      '<button class="wname" type="button" data-wsel="' + r.id + '" data-post="' + n.id + '" title="Show the stack up to ' + esc(wallWhose(r, n.id)) + ' below"><span><b>' + esc(who) + '</b> ' + esc(wallLabel(n)) + '</span>' +
        '<canvas data-wave="' + r.id + ':' + n.id + '" data-layer="' + layer + '"' + (S.playing === r.id + ':solo:' + n.id ? ' data-of="' + r.id + ':solo:' + n.id + '" class="wseekable" title="Click to play from there"' : '') + ' aria-hidden="true"></canvas></button>' +
      '<button class="wsolo1' + (S.playing === r.id + ':solo:' + n.id ? ' on' : '') + '" type="button" data-wsolo="' + r.id + '" data-post="' + n.id + '" aria-pressed="' + (S.playing === r.id + ':solo:' + n.id) + '" aria-label="Solo: ' + esc(wallWhose(r, n.id)) + ' on its own" title="Solo: hear only this take">S</button>' +
      (open ? '<button class="wadd" type="button" data-wplus="1" aria-label="Play on top of ' + esc(wallWhose(r, n.id)) + '" title="Play on top of this take">+</button>' : '') +
      (open ? '<button class="wbadge" type="button" data-wsay="' + r.id + '" data-post="' + n.id + '" aria-label="Comments on ' + esc(wallWhose(r, n.id)) + '">&#128172;' + (w ? ' ' + w : '') + '</button>' : '') + '</div>';
  }
  function plusCells(n, sx) {
    if (!open) return '';
    rows = rowsOf(sx);
    if (n.kids.length) return n.kids.map(function (k) { return plusCells(k, sx); }).join('');
    return '<div class="wplus' + (anim ? ' wp-rise' : '') + '" style="grid-column:' + (n.c0 + 1) + ';grid-row:' + (rows - n.d - 1) + ';animation-delay:' + (LAND + (T.maxD + 2) * STEP).toFixed(2) + 's">' +
      '<button type="button" data-wplus="1" aria-label="Play on the stack up to ' + esc(wallWhose(r, n.id)) + '">+</button></div>';
  }
  function all(n, sx) { return block(n, sx) + n.kids.map(function (k) { return all(k, sx); }).join(''); }
  var secHtml = T.secs.map(function (sx, i) {
    if (!open && !sx.core) return '';
    var grid = '<div class="wgrid" style="grid-template-columns:repeat(' + sx.cols + ',minmax(0,1fr));grid-template-rows:repeat(' + rowsOf(sx) + ',var(--wrh,44px))">' + plusCells(sx.root, sx) + all(sx.root, sx) + '</div>';
    var cap = !open ? '' : sx.core ? '<small>The original track · ' + mmss(r.dur) + '</small>' :
      '<small>' + esc(sx.root.p.mine ? 'Your' : sx.root.p.by + '’s') + ' new part · ' + (sx.root.p.pos === 'before' ? 'before' : 'after') + ' the original, made on ' + esc(wallWhose(r, sx.root.madeOn)) + (sx.root.p.status === 'in' ? ' · in the song' : '') + '</small>';
    var arrow = open && i > 0 ? '<div class="warrow" aria-hidden="true">&rarr;</div>' : '';
    return arrow + '<div class="wsec' + (sx.core ? ' wsec-core' : '') + (!open ? ' wsec-shut' : '') + '" style="--n:' + sx.cols + '">' + grid + cap + '</div>';
  }).join('');
  var playingStack = sel && S.playing === wallKey(r, sel);
  var now = '';
  if (open && (!EMBED || S.wfull[r.id])) {
    var ms = EMBED ? S.wfull[r.id] : sel || 'riff', mk = wallKey(r, ms), mOn = S.playing === mk, segs = wallSegs(r, ms, T);
    wallMix(r, ms, segs);
    var people = [];
    segs.forEach(function (sg, si) { sg.list.forEach(function (x) { if (si && people.some(function (q) { return q.id === x.id; })) return; people.push(x); }); });
    now = '<div class="wmaster"><div class="wm-top">' +
        '<button class="play' + (mOn ? ' on' : '') + '" type="button" data-wpick="' + r.id + '" data-post="' + ms + '" aria-label="' + (mOn ? 'Pause' : 'Play the master track') + '">' + (mOn ? '&#10074;&#10074;' : '&#9654;') + '</button>' +
        '<div class="wm-what"><b>' + (ms === 'riff' ? 'The original track' : 'Up to ' + esc(wallWhose(r, ms))) + '</b>' +
          '<div class="wm-chips">' + people.map(function (x) { return '<span><i style="background:' + lay(x.isPart ? 'part' : x.layer).c + '"></i>' + esc(x.isRiff ? r.by + ' · original' : (x.mine ? 'You' : x.by) + ' · ' + chipLabel(x)) + '</span>'; }).join('') + '</div></div></div>' +
      '<div class="wm-wave" data-wseek="' + r.id + '" data-post="' + ms + '" title="Click to play from there">' + segs.map(function (sg, i) {
        return '<div style="flex:' + Math.max(1, Math.round(sg.len * 10)) + ' 1 0"><canvas data-wave="wmix:' + r.id + ':' + ms + ':' + i + '" data-of="' + mk + '" aria-hidden="true"></canvas>' +
          (segs.length > 1 ? '<small>' + esc(sg.label) + '</small>' : '') + '</div>';
      }).join('') + '<span class="wm-head" hidden></span></div>' +
      '<div class="wm-acts"><span>Master track · ' + people.length + (people.length === 1 ? ' track' : ' tracks') + ' together · click a tile above to switch</span><span class="grow"></span>' +
        (EMBED ? '<button class="btn btn-sm" type="button" data-wfullclose="' + r.id + '">Hide the master track</button>' :
          '<a class="btn btn-sm" href="/s/' + encodeURIComponent(r.slug) + (ms === 'riff' ? '?stack=seed' : '?stack=' + encodeURIComponent(ms)) + '&amp;wall">Open this stack in project view</a>') + '</div></div>';
  }

  /* talk about this song: every written reply, newest first, with what it is about */
  var ws = r.posts.filter(function (p) { return p.isComment && !p.deleted; }).sort(function (a, b) { return String(b.created).localeCompare(String(a.created)); });
  var talkOpen = !!S.wtalk[r.id];
  function about(c) {
    var t = c.parent ? postOf(r, c.parent) : null;
    if (!t) return '<span class="wchip" style="cursor:default">on the jam</span>';
    if (t.isComment) return '<span class="wchip" style="cursor:default">reply to ' + esc(t.mine ? 'you' : t.by) + '</span>';
    return '<button class="wchip" type="button" data-wshow="' + r.id + '" data-post="' + t.id + '" style="--c:' + lay(t.kind === 'part' ? 'part' : t.layer).c + '">on ' + esc(wallWhose(r, t.id)) + '</button>';
  }
  var target = S.wsay[r.id] || '', opts = [{ id:'', label:'the song as a whole' }, { id:'riff', label:r.by + '’s original track' }];
  r.posts.forEach(function (p) { if (!p.isComment && !p.deleted && (p.layer || p.kind === 'part')) opts.push({ id:p.id, label:wallWhose(r, p.id) }); });
  var say = '<form class="wsay" data-wsayform="' + r.id + '"><label>Comment on <select data-wsaywhat="' + r.id + '" aria-label="What your comment is about">' +
      opts.map(function (o) { return '<option value="' + o.id + '"' + (o.id === target ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('') + '</select></label>' +
    '<div class="wsay-row"><textarea id="wsay-' + r.id + '" rows="1" maxlength="1000" placeholder="Say something about ' + esc(target ? wallWhose(r, target) : 'the song') + '"></textarea>' +
    '<button class="btn btn-main" type="submit">Post</button></div></form>';
  var talk = !open ? '' : '<button class="wtalk" type="button" data-wtalk="' + r.id + '" aria-expanded="' + talkOpen + '"><span aria-hidden="true">&#128172;</span>' +
      '<span><b>Talk about this song</b> · ' + (ws.length ? ws.length + (ws.length > 1 ? ' comments' : ' comment') : 'no comments yet') + '</span>' +
      '<span class="wlast">' + (talkOpen || !ws.length ? '' : '“' + esc(ws[0].text.length > 70 ? ws[0].text.slice(0, 67) + '…' : ws[0].text) + '” · ' + esc(ws[0].mine ? 'You' : ws[0].by)) + '</span>' +
      '<span class="wgo">' + (talkOpen ? 'Hide comments &#9652;' : 'Show comments &#9662;') + '</span></button>' +
    (talkOpen ? '<div class="wwords">' + ws.map(function (c) {
      return '<div class="wword">' + ava(c.mine ? 'You' : c.by, null, true) + '<div><b>' + nameOf(c.mine ? 'You' : c.by, c.uid) + '</b><span class="muted">' + esc(c.time) + '</span><br>' + about(c) + '<p>' + esc(c.text) + '</p></div></div>';
    }).join('') + say + '</div>' : '');

  var n = T.takes + T.parts;
  var bar = n && S.ov !== r.id && !EMBED ? '<button class="threadbar' + (open ? ' open' : '') + '" type="button" data-expand="' + r.id + '" aria-expanded="' + open + '">' +
    '<span class="tb-txt"><b>' + n + (n > 1 ? ' reactions' : ' reaction') + '</b> · ' + T.takes + (T.takes === 1 ? ' take' : ' takes') + (T.parts ? ', ' + T.parts + (T.parts > 1 ? ' new parts' : ' new part') : '') + '</span>' +
    '<span class="tb-go">' + (open ? 'Hide reactions <i aria-hidden="true">&#9652;</i>' : 'Show reactions <i aria-hidden="true">&#9662;</i>') + '</span></button>' : '';

  if (EMBED) return '<article class="riff" id="riff-' + r.id + '"><div class="rmain">' +
    '<p class="jhint" style="margin:0 0 6px">Click a tile to hear its stack in the tracks above. ▶ plays it, S plays only that take.</p>' +
    '<div class="wwrap" data-wr="' + r.id + '"><div class="wrow">' + secHtml + '</div></div>' + wallDots(r, T, open) + wallFullBtn(r, T, open) + now + '</div>' + talk + '</article>';
  return '<article class="riff" id="riff-' + r.id + '"><div class="rmain">' +
    '<div class="rhead">' + ava(r.by, r.layer) + '<div class="rwho"><b>' + nameOf(r.by, r.uid) + '</b> started a jam' + (r.layer !== 'seed' ? ' · ' + lyr(r.layer) : '') +
      '<small>' + riffMeta(r) + '</small></div></div>' +
    '<h2 class="rtitle">' + esc(r.title) + '<span class="wpre">Preview · read-only</span></h2>' + (r.text ? '<p class="rtext">' + esc(r.text) + '</p>' : '') +
    '<div class="wwrap" data-wr="' + r.id + '"><div class="wrow">' + secHtml + '</div></div>' + wallDots(r, T, open) + wallFullBtn(r, T, open) + now +
    (open ? '' : '<div class="racts"><a class="btn" href="/s/' + encodeURIComponent(r.slug) + '">Open in project view</a></div>') +
    '</div>' + bar + talk + '</article>';
}
function wallKey(r, id) { return r.id + ':wall:' + id; }
/* phones: one part of the song at a time, swipe for the next; the dots say where you are */
/* the whole song from the top: the stack you picked if it is on a new part, else the part you look at, else the first new part */
function wallFullId(r, T) {
  var sel = S.wsel[r.id];
  if (sel && T.partOf[sel]) return sel;
  var pg = T.secs[S.wpage[r.id] || 0];
  if (pg && pg.part) return pg.root.id;
  var first = T.secs.filter(function (x) { return x.part; })[0];
  return first ? first.root.id : null;
}
function wallFullBtn(r, T, open) {
  if (!open || T.secs.length < 2) return '';
  var sel = S.wsel[r.id], pg = T.secs[S.wpage[r.id] || 0], MOBV = window.matchMedia && matchMedia('(max-width:760px)').matches;
  var on = !!(sel && T.partOf[sel]) || !!(MOBV && pg && pg.part);
  return '<div class="wfull"' + (on ? '' : ' hidden') + (sel && T.partOf[sel] ? ' data-keep="1"' : '') + '><button class="btn btn-sm btn-sound" type="button" data-wfull="' + r.id + '">&#9654; Play the whole song from the start</button></div>';
}
function wallDots(r, T, open) {
  if (!open || T.secs.length < 2) return '';
  var at = S.wpage[r.id] || 0;
  return '<div class="wdots" role="group" aria-label="Parts of the song"><span class="wswipe" aria-hidden="true">&lsaquo;</span>' + T.secs.map(function (sx, i) {
      var label = sx.core ? 'The original track' : (sx.root.p.mine ? 'Your' : sx.root.p.by + '’s') + ' new part';
      return '<button type="button" data-wdot="' + r.id + '" data-i="' + i + '" aria-label="' + esc(label) + '" aria-current="' + (i === at) + '"></button>';
    }).join('') + '<span class="wswipe" aria-hidden="true">&rsaquo;</span><span class="wswipe-t">Swipe for the other part' + (T.secs.length > 2 ? 's' : '') + '</span></div>';
}
function wallPageOf(w) {
  var secs = w.querySelectorAll('.wsec'), best = 0, d = Infinity;
  var w0 = w.getBoundingClientRect().left;
  [].forEach.call(secs, function (sx, i) { var x = Math.abs(sx.getBoundingClientRect().left - w0); if (x < d) { d = x; best = i; } });
  return best;
}
function wallScrolls() {
  [].forEach.call(document.querySelectorAll('.wwrap[data-wr]'), function (w) {
    var rid = w.dataset.wr;
    if (S.wscroll[rid] !== undefined) w.scrollLeft = S.wscroll[rid];
    [].forEach.call(w.querySelectorAll('.wgrid'), railTop);
    wallFit(w);
  });
}
/* the rail left of a stack starts at its highest take, not at the top of the (taller) grid */
function railTop(g) {
  var top = Infinity, gt = g.getBoundingClientRect().top;
  [].forEach.call(g.querySelectorAll('.wb,.wplus button'), function (b) { var t = b.getBoundingClientRect().top - gt; if (t < top) top = t; });
  if (top < Infinity) g.style.setProperty('--rt', Math.max(0, top) + 'px');
}
function wallFit(w) {
  if (!(window.matchMedia && matchMedia('(max-width:760px)').matches)) { w.style.height = ''; return; }
  var sx = w.querySelectorAll('.wsec')[wallPageOf(w)];
  if (sx) w.style.height = (sx.offsetHeight + 8) + 'px';
  if (EMBED) setTimeout(function () { toProject({ h:embedH() }); }, 280);   /* the project's frame follows */
}
/* the master track's playhead: where in the stack you are, across both parts of a long one */
function wallHead(pos, len) {
  [].forEach.call(document.querySelectorAll('.wm-wave'), function (w) {
    var h = w.querySelector('.wm-head'); if (!h) return;
    var k = wallKey({ id:w.dataset.wseek }, w.dataset.post);
    if (S.playing !== k || !len) { h.hidden = true; return; }
    h.hidden = false; h.style.left = (pos / len * w.clientWidth) + 'px';
  });
}
function wallSeek(rid, id, f) {
  var r = riff(rid), k = wallKey(r, id), T = wallTree(r), segs = wallSegs(r, id, T);
  S.wsel[rid] = id; if (!T.partOf[id]) S.wcore[rid] = id;
  var total = segs.reduce(function (n, sg) { return n + sg.len; }, 0), at = Math.max(0, Math.min(.999, f)) * total;
  if (segs.length === 1) { playList(k, r, segs[0].list, at); render(); return; }
  playSeq(k, r, segs.map(function (sg) { return sg.list; }), at);
}
function wallSolo(rid, id, at) {
  if (EMBED) toProject({ stop:true });   /* the take on its own plays here; the tracks pause */
  var r = riff(rid), k = rid + ':solo:' + id;
  if (S.playing === k && typeof at !== 'number') { stop(); render(); return; }
  var p = id === 'riff' ? null : postOf(r, id);
  playList(k, r, p ? stemsOf(p) : [{ id:'riff', isRiff:true, url:r.url, dur:r.dur, amp:r.amp, layer:r.layer }], at);
}
function wallBase(r, T, part) {
  var c = S.wcore[r.id];
  if (c && !T.partOf[c] && (c === 'riff' || postOf(r, c))) return c;
  if (part.madeOn !== 'riff') return part.madeOn;
  var top = null;
  Object.keys(T.nodes).forEach(function (k) {
    var n = T.nodes[k]; if (k === 'riff' || T.partOf[k] || n.kids.length || !n.p || n.p.deleted) return;
    if (!top || String(n.p.created) > String(top.p.created)) top = n;
  });
  return top ? top.id : 'riff';
}
function wallSegs(r, id, T) {
  var part = T.partOf[id];
  if (!part) return [{ list:chainOf(r, id === 'riff' ? null : id), len:r.dur || 1, label:'The original track' }];
  var bid = wallBase(r, T, part);
  var base = { list:chainOf(r, bid === 'riff' ? null : bid), len:r.dur || 1, label:bid === 'riff' ? 'The original track' : 'Up to ' + wallWhose(r, bid) },
      on = { list:chainOf(r, id), len:part.p.dur || 1, label:wallWhose(r, part.id) };
  return part.p.pos === 'before' ? [on, base] : [base, on];
}
/* the master track's waveform: every track of a segment summed, once all of them are in */
function wallMix(r, id, segs) {
  segs.forEach(function (sg, i) {
    var k = 'wmix:' + r.id + ':' + id + ':' + i;
    if (BUF[k] || BUF[k + ':busy']) return;
    BUF[k + ':busy'] = true;
    Promise.all(sg.list.map(function (x) { return load(r, x); })).then(function () {
      var bs = sg.list.map(function (x) { return BUF[bufKey(r, x)]; }).filter(Boolean);
      if (!bs.length) { delete BUF[k + ':busy']; return; }
      var len = bs[0].length, out = ac().createBuffer(1, len, bs[0].sampleRate), d = out.getChannelData(0);
      bs.forEach(function (b) { var c = b.getChannelData(0), n = Math.min(len, c.length); for (var j = 0; j < n; j++) d[j] += c[j]; });
      BUF[k] = out; drawWaves();
    });
  });
}
/* Picking a take plays its stack: the take and everything under it. On a new part, what the part
   was made on plays first (or after, for a part before), then the part with its takes, and round again. */
function wallPick(rid, id) {
  if (EMBED) { if (S.playing) stop(); delete S.wfull[rid]; S.wsel[rid] = id; render(); toProject({ pick:id, play:true }); return; }
  var r = riff(rid), k = wallKey(r, id);
  S.wsel[rid] = id;
  if (S.playing === k) { stop(); render(); return; }
  var T = wallTree(r), part = T.partOf[id];
  if (!part) { S.wcore[rid] = id; playList(k, r, chainOf(r, id === 'riff' ? null : id)); render(); return; }
  var segs = wallSegs(r, id, T);
  playSeq(k, r, segs.map(function (sg) { return sg.list; }), part.p.pos === 'before' ? 0 : segs[0].len);
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
/* ---------- preview: the homepage as a grid of jams (after Yarne's "A1 · Grid, play on hover") ----------
   Every jam is a card with its latest stack (or only its original track) as lanes of waveforms.
   Hold the mouse over a card to hear it; "Play along" opens the jam's wall in a panel in the
   middle of the screen, over a blurred page, until you close it with the X. */
S.jmode = 'latest'; S.jhover = true; S.ov = null;
if (WALL) {
  var cst = document.createElement('style');
  cst.textContent =
        '#list.feed{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:28px 24px}' +
    '.jtools{display:flex;align-items:center;gap:12px 20px;flex-wrap:wrap;margin:-6px 0 18px}' +
    '.jseg{display:inline-flex;gap:4px;padding:4px;border:1px solid var(--line-strong);border-radius:99px;background:var(--paper)}' +
    '.jseg button{min-height:36px;padding:0 14px;border:0;border-radius:99px;background:transparent;font:700 14px var(--body);color:var(--muted);cursor:pointer}' +
    '.jseg button[aria-pressed="true"]{background:var(--sound);color:#fff}' +
    '.jsw{display:inline-flex;align-items:center;gap:10px;border:0;background:none;font:700 14px var(--body);color:var(--ink);cursor:pointer;min-height:44px;padding:0}' +
    '.jsw i{width:40px;height:24px;border-radius:99px;background:var(--line-strong);position:relative;display:inline-block}' +
    '.jsw i::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:left .15s}' +
    '.jsw[aria-checked="true"] i{background:var(--ink)}.jsw[aria-checked="true"] i::after{left:19px}' +
    '.jhint{font-size:13.5px;color:var(--muted)}' +
    '.jcard{background:var(--paper);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);padding:8px 8px 14px;display:flex;flex-direction:column;gap:12px;transition:box-shadow .15s,transform .15s}' +
    '.jcard.on{box-shadow:0 0 0 2px var(--sound),0 18px 40px -18px rgba(18,18,18,.35);transform:translateY(-2px)}' +
    '.jcover{position:relative;height:196px;border-radius:12px;background:color-mix(in srgb,var(--ink) 5%,var(--paper));overflow:hidden}' +
    '.jpill{position:absolute;top:10px;left:10px;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px 0 9px;background:var(--paper);border-radius:99px;font-size:13px;font-weight:700;box-shadow:0 1px 2px rgba(18,18,18,.1)}' +
    '.jpill i{width:9px;height:9px;border-radius:50%;display:inline-block}' +
    '.jnow{position:absolute;top:10px;right:10px;height:28px;padding:0 11px;display:inline-flex;align-items:center;background:var(--sound);color:#fff;border-radius:99px;font-size:12.5px;font-weight:700}' +
    '.jwv{position:absolute;left:14px;right:14px;top:48px;bottom:50px;display:flex;flex-direction:column;justify-content:center;gap:4px}' +
    '.jwv canvas{display:block;width:100%;flex:1 1 0;min-height:4px;max-height:16px}.jwv canvas.big{flex:none;height:80px;max-height:80px}' +
    '.jbot{position:absolute;left:10px;right:10px;bottom:10px;display:flex;align-items:center;gap:8px}' +
    '.jplay{width:34px;height:34px;border-radius:50%;border:0;background:var(--paper);color:var(--sound-ink);cursor:pointer;flex:none;box-shadow:0 1px 2px rgba(18,18,18,.1);font-size:12px}' +
    '.jplay.on{background:var(--sound);color:#fff}' +
    '.jcap{font-size:12.5px;font-weight:700;color:var(--muted);background:color-mix(in srgb,var(--paper) 85%,transparent);border-radius:99px;padding:3px 9px}' +
    '.jdur{margin-left:auto;font-size:12.5px;font-weight:700;color:#fff;background:rgba(18,18,18,.82);border-radius:6px;padding:2px 7px;font-variant-numeric:tabular-nums}' +
    '.jmeta{display:flex;gap:12px;padding:0 8px;align-items:flex-start}.jmeta .ava{flex:none}' +
    '.jtext{flex:1;min-width:0}.jtext h3{margin:0;font-size:19px;line-height:1.15}' +
    '.jtext h3 button{border:0;background:none;padding:0;font:inherit;color:var(--ink);cursor:pointer;text-align:left}.jtext h3 button:hover{text-decoration:underline;text-underline-offset:3px}' +
    '.jtext p{margin:3px 0 0;font-size:14px;color:var(--muted)}' +
    '.jdots{display:inline-flex;gap:3px;margin-right:6px;vertical-align:1px}.jdots i{width:8px;height:8px;border-radius:50%;display:block}' +
    /* the panel over the blurred page */
    '.wov{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--bg) 35%,transparent);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}' +
    '.wov[hidden]{display:none}' +
    '.wov-panel{position:relative;width:min(1180px,100%);max-height:calc(100vh - 48px);overflow:auto;border-radius:24px;background:var(--paper);box-shadow:0 30px 80px -20px rgba(18,18,18,.45);transform-origin:top left}' +
    '.wov-panel .riff{border:0;box-shadow:none;border-radius:0}' +
    '.wov-x{position:sticky;top:12px;float:right;margin:12px 12px -56px 0;z-index:3;width:44px;height:44px;border-radius:50%;border:1px solid var(--line-strong);background:var(--paper);color:var(--ink);font-size:22px;line-height:1;cursor:pointer}' +
    '.wov-x:hover{border-color:var(--ink)}' +
    'body.ov-open{overflow:hidden}';
  cst.textContent +=
    /* a stack grows from the bottom up: a faint rail left of the tiles, an arrow at the top */
    '.wgrid{position:relative;margin-left:14px}' +
    '.wgrid::before{content:"";position:absolute;left:-11px;top:calc(var(--rt,0px) + 14px);bottom:10px;width:2px;border-radius:2px;background:linear-gradient(to top,color-mix(in srgb,var(--muted) 70%,transparent),color-mix(in srgb,var(--muted) 8%,transparent))}' +
    '.wgrid::after{content:"";position:absolute;left:-14px;top:calc(var(--rt,0px) + 6px);border:4px solid transparent;border-bottom:6px solid color-mix(in srgb,var(--muted) 35%,transparent);border-top:0}' +
    '.wsec>small::after{content:" \\00B7  builds up from here \\2191"}' +
    '.wb.wb-root{position:relative}' +
    '';
  cst.textContent += '.wdots{display:none}' +
    '@media (max-width:760px){' +
      '#tabs [data-tab="songs"]{display:none}' +
      '.feedhead h2{font-size:27px}.feedhead .kicker{font-size:12.5px}' +
      '#tabs button{font-size:13px;padding:0 12px;min-height:34px}' +
      '.jtools{gap:8px 12px;margin:-4px 0 14px}.jseg button{font-size:12.5px;min-height:32px;padding:0 11px}' +
      '.jsw{font-size:12.5px;min-height:36px}.jsw i{width:34px;height:20px}.jsw i::after{width:14px;height:14px}.jsw[aria-checked="true"] i::after{left:17px}' +
      '.jhint{font-size:12px}' +
      '.wwrap{padding-inline:0;container-type:inline-size;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;overscroll-behavior-x:contain}.wwrap::-webkit-scrollbar{display:none}' +
      '.wrow{width:auto;min-width:100%;align-items:flex-start}' +
      '.wwrap{transition:height .25s ease;overflow-y:hidden}' +
      '.wtalk{padding:12px 16px;gap:10px}.wtalk .wlast{display:none}.wtalk>span:nth-child(2){flex:1 1 auto;min-width:0}' +
      '.wsec{flex:0 0 auto!important;width:max(100cqw,calc(var(--n) * 92px));min-width:0!important;scroll-snap-align:start;scroll-snap-stop:always}' +
      '.wsec.wsec-shut{width:100cqw}' +
      '.warrow{display:none}' +
      '.wb{gap:4px;padding:0 4px}.wb .wadd,.wb .wbadge{display:none}.wb .wname canvas{min-width:30px}' +
      '.wdots{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:10px}' +
      '.wdots button{width:9px;height:9px;padding:0;border:0;border-radius:99px;background:var(--line-strong);cursor:pointer;transition:width .2s,background .2s}' +
      '.wdots button[aria-current="true"]{width:22px;background:var(--ink)}' +
      '.wswipe{font-size:18px;color:var(--muted);line-height:1}.wswipe-t{font-size:12.5px;color:var(--muted);margin-left:4px}' +
      /* the first screen is the pitch only; "Or play along with one below" scrolls to the jams */
      '.wide:has(>.hero){min-height:calc(100svh - var(--hdrh,64px));display:flex;flex-direction:column;justify-content:center}.hero{margin:12px 0;padding:22px 20px}.hero h1{font-size:40px}.hero-lead{font-size:17px}.hero-copy{gap:14px}.hero{gap:16px}.hero .steps li{padding:9px 12px}.hero .steps span:not(.n){font-size:13px;line-height:1.4}#feed{scroll-margin-top:calc(var(--hdrh,64px) + 6px)}' +
      '.wov{padding:0}.wov-panel{max-height:100vh;max-height:100dvh;border-radius:0;height:100%}' +
      /* the panel on a phone: the jam small at the top, tiles a bit lower, the master track always in view at the bottom */
      '.wov .riff{overflow:visible}.wov .rmain{padding:12px 14px 0;gap:8px}.wov .rwho{font-size:13px}' +
      '.wov .rtitle{font-size:21px;padding-right:44px}.wov .wpre{font-size:11px;padding:2px 8px;margin-left:6px}.wov .rtext{font-size:13.5px;margin:0}' +
      '.wov-x{width:38px;height:38px;font-size:19px;margin:10px 10px -48px 0}' +
      '.wov .wwrap{margin-top:0}.wov .wgrid{--wrh:38px}.wov .wb .wsolo{width:26px;height:26px}.wov .wb .wname canvas{height:24px}.wov .wsec small{font-size:11.5px}' +
      '.wov .wdots{margin-top:6px}' +
      '.wov .wmaster{position:sticky;bottom:0;z-index:2;margin:8px -14px 0;border-radius:18px 18px 0 0;padding:10px 14px calc(10px + env(safe-area-inset-bottom,0px));gap:8px;box-shadow:0 -12px 24px -16px rgba(18,18,18,.35)}' +
      '.wov .wm-top{gap:10px}.wov .wm-top .play{width:42px;height:42px;font-size:14px}.wov .wm-what b{font-size:14px}' +
      '.wov .wm-chips{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}.wov .wm-chips::-webkit-scrollbar{display:none}.wov .wm-chips span{flex:none}' +
      '.wov .wm-wave{height:44px}.wov .wm-wave div{padding:3px 6px 14px}' +
      '.wov .wm-acts>span:first-child{display:none}.wov .wm-acts .btn{min-height:34px;font-size:13px}' +
      '.wov .wfull{margin-top:6px}' +
    '}';
  document.head.appendChild(cst);
  var hdrH = function () { var h = document.querySelector('header.top'); if (h) document.documentElement.style.setProperty('--hdrh', h.offsetHeight + 'px'); };
  hdrH(); document.addEventListener('DOMContentLoaded', hdrH); window.addEventListener('resize', hdrH);
  document.addEventListener('DOMContentLoaded', jamTools);
  if (document.readyState !== 'loading') setTimeout(jamTools, 0);
}
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
  var takes = r.posts.filter(function (p) { return !p.isComment && !p.deleted && p.layer && p.kind !== 'part'; });
  return takes.sort(function (a, b) { return String(b.created).localeCompare(String(a.created)); })[0] || null;
}
function cardKey(r) { return r.id + ':card'; }
function cardChain(r) { var l = S.jmode === 'latest' ? latestOf(r) : null; return l ? chainOf(r, l.id) : chainOf(r, null); }
function cardHtml(r) {
  var chain = cardChain(r), on = S.playing === cardKey(r), n = livePosts(r);
  chain.forEach(function (x) { load(r, x); });
  var seen = {}, dots = [];
  r.posts.forEach(function (p) { if (p.layer && !p.isComment && !p.deleted && p.kind !== 'part' && !seen[p.layer]) { seen[p.layer] = 1; dots.push(p.layer); } });
  var takes = r.posts.filter(function (p) { return p.layer && !p.isComment && !p.deleted; }).length, words = n.filter(function (p) { return p.isComment; }).length;
  var lanes = S.jmode === 'latest' && chain.length > 1
    ? chain.map(function (x) { return '<canvas data-wave="' + (x.isRiff ? r.id + ':riff' : r.id + ':' + x.id) + '" data-layer="' + (x.isPart ? 'part' : x.layer) + '" aria-hidden="true"></canvas>'; }).join('')
    : '<canvas class="big" data-wave="' + r.id + ':riff" data-layer="' + r.layer + '" aria-hidden="true"></canvas>';
  var cap = S.jmode === 'latest' ? (chain.length > 1 ? 'Latest stack · ' + chain.length + ' layers' : 'Only the original track so far') : 'Original track';
  return '<article class="jcard' + (on ? ' on' : '') + '" id="card-' + r.id + '" data-jcard="' + r.id + '">' +
    '<div class="jcover"><span class="jpill"><i style="background:' + lay(r.layer).c + '"></i>' + esc(r.layer === 'seed' ? 'Original track' : lay(r.layer).label) + '</span>' +
      (on ? '<span class="jnow">Playing</span>' : '') +
      '<div class="jwv">' + lanes + '</div>' +
      '<div class="jbot"><button class="jplay' + (on ? ' on' : '') + '" type="button" data-jplay="' + r.id + '" aria-label="' + (on ? 'Stop' : 'Play ' + esc(r.title)) + '">' + (on ? '&#10074;&#10074;' : '&#9654;') + '</button>' +
        '<span class="jcap">' + cap + '</span><span class="jdur">' + mmss(r.dur) + '</span></div></div>' +
    '<div class="jmeta">' + ava(r.by, r.layer) + '<div class="jtext"><h3><button type="button" data-jopen="' + r.id + '">' + esc(r.title) + '</button></h3>' +
      '<p>' + esc(r.by) + (r.bpm ? ' · ' + r.bpm + ' bpm' : '') + (r.key ? ' · ' + esc(r.key) : '') + '</p>' +
      '<p><span class="jdots" aria-hidden="true">' + dots.map(function (l) { return '<i style="background:' + lay(l).c + '"></i>'; }).join('') + '</span>' +
        takes + (takes === 1 ? ' take' : ' takes') + ' · ' + words + (words === 1 ? ' comment' : ' comments') + ' · ' + esc(r.time) + '</p></div>' +
      '<button class="btn btn-main btn-sm" type="button" data-jopen="' + r.id + '">Play along</button></div></article>';
}
function cardPlay(rid) {
  var r = riff(rid); if (!r) return;
  if (S.playing === cardKey(r)) { stop(); render(); return; }
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
  if (!WALL || !S.ov) return;
  var r = riff(S.ov); if (!r) return;
  var b = overlay().querySelector('.wov-body'), keep = b.querySelector('textarea'), val = keep ? keep.value : '';
  b.innerHTML = wallHtml(r);
  var t = b.querySelector('textarea'); if (t && val) t.value = val;
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
/* hover: hear a card while the mouse is over it */
document.addEventListener('mouseover', function (e) {
  if (!WALL || !S.jhover || S.ov) return;
  var c = e.target.closest && e.target.closest('[data-jcard]'); if (!c) return;
  var r = riff(c.dataset.jcard); if (!r || S.playing === cardKey(r)) return;
  if (e.relatedTarget && c.contains(e.relatedTarget)) return;
  playList(cardKey(r), r, cardChain(r));
});
document.addEventListener('mouseout', function (e) {
  if (!WALL || !S.jhover || S.ov) return;
  var c = e.target.closest && e.target.closest('[data-jcard]'); if (!c || (e.relatedTarget && c.contains(e.relatedTarget))) return;
  var r = riff(c.dataset.jcard); if (r && S.playing === cardKey(r)) { stop(); render(); }
});
function render() {
  if (EMBED) {
    var er = riff(EMBED);
    el('list').innerHTML = !S.loaded ? '<p class="empty">Loading…</p>' : er ? (S.expanded[er.id] = true, wallHtml(er)) : '<p class="empty">This jam isn’t in the feed.</p>';
    if (er) { load(er, { isRiff:true, url:er.url }); er.posts.forEach(function (p) { if (p.url) stemsOf(p).forEach(function (x) { load(er, x); }); }); }
    wallScrolls(); drawWaves(); toProject({ h:embedH() });
    return;
  }
  var list = RIFFS.slice();
  if (S.tab === 'hot') list.sort(function (a, b) { return players(b).length - players(a).length || score(b.likes, b.id) - score(a.likes, a.id); });
  if (S.tab === 'songs') list = list.filter(function (r) { return r.song; });
  if (S.tab === 'fresh') list = list.filter(function (r) { return !r.song; }).concat(list.filter(function (r) { return r.song; }));
  el('list').innerHTML = S.failed ? '<p class="empty">' + esc(S.failed) + '</p>'
    : !S.loaded ? '<p class="empty">Loading the jams…</p>'
    : list.length ? list.map(riffHtml).join('')
    : '<p class="empty">' + (S.tab === 'songs' ? 'No songs yet.' : 'No jams yet. <a href="#start">Start the first one.</a>') + '</p>';
  [].forEach.call(document.querySelectorAll('#tabs [data-tab]'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.tab === S.tab)); });
  /* every clip loads for its waveform; replies load once their thread is open */
  list.forEach(function (r) {
    load(r, { isRiff:true, url:r.url });
    if (S.expanded[r.id]) r.posts.forEach(function (p) { if (p.url) stemsOf(p).forEach(function (x) { load(r, x); }); });
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
function openReply(rid, pid) {
  ensureMe(jamCard(riff(rid), 'play')).then(function () { replyPop(rid, pid); });
}
function replyPop(rid, pid) {
  var r = riff(rid); R = { rid:rid, pid:pid || null, file:null, buf:null, src:'file' };
  rcReset(); RC.click = !!r.bpm; RC.countIn = r.bpm ? 1 : 0;
  var c = chainOf(r, pid), used = c.map(function (p) { return p.layer; });
  var pp = pid ? postOf(r, pid) : null;
  el('r-title').textContent = 'Play along with ' + (!pp ? r.title : pp.kind === 'part' ? 'the new part' : whose(pp) + ' ' + lay(pp.layer).label);
  MD = { r:r, c:c, mute:{}, raf:0, dur:wantLen(c) };
  el('r-over').innerHTML = '<div class="md-top"><button class="play" type="button" id="md-play" aria-label="Play what you play on">&#9654;</button>' +
      '<span class="md-time" id="md-time">0:00</span><span class="md-hint">' + (r.bpm ? r.bpm + ' bpm' : 'tempo unknown') + (r.key ? ' · ' + esc(r.key) : '') + (r.sig ? ' · ' + esc(r.sig) : '') + '. Play along first, then add your take.</span></div>' +
    '<div class="md-lanes" id="md-lanes">' + c.map(function (p, i) {
      return '<div class="md-lane"><span class="md-name"><i style="background:' + lay(p.layer).c + '"></i><span><b>' + esc(p.by) + '</b>' + chipLabel(p) + '</span></span>' +
        '<canvas data-md="' + i + '"></canvas><button class="md-m" type="button" data-mdmute="' + i + '" aria-pressed="false" aria-label="Mute">M</button></div>';
    }).join('') +
    '<div class="md-lane you"><span class="md-name"><i style="background:var(--sound)"></i><span><b>You</b><span id="md-you"></span></span></span><div class="md-slot" id="md-slot"><div class="md-empty" id="md-empty">Your take lands here</div></div><span></span></div>' +
    '<div class="md-head" id="md-head" hidden></div></div>';
  el('r-layer').innerHTML = ROLES.map(function (x) { return '<option value="' + x.id + '">' + esc(x.label) + '</option>'; }).join('');
  el('r-layer').value = ROLES.map(function (x) { return x.id; }).filter(function (l) { return used.indexOf(l) < 0; })[0] || 'vocals';
  el('r-err').textContent = ''; el('r-text').value = ''; el('r-file').value = '';
  el('r-len').textContent = MD.dur ? 'Make it ' + mmss(MD.dur) + ' long (' + MD.dur.toFixed(1) + ' s), the length of what you play on.' : '';
  el('r-as').innerHTML = postingAs();
  el('r-go').disabled = false;
  setRSrc('file');
  openScrim('reply-scrim'); mdYou(); mdDraw(); el('r-layer').focus();
  Promise.all(c.map(function (p) { return load(r, p); })).then(mdDraw);
}
function peakOf(buf) { var d = buf.getChannelData(0), pk = 0; for (var i = 0; i < d.length; i++) { var v = Math.abs(d[i]); if (v > pk) pk = v; } return pk; }
function mdYou() { var y = el('md-you'); if (y) y.textContent = (role(el('r-layer').value) || {}).label || ''; }
function mdDraw() {
  if (!MD) return;
  var ink = getComputedStyle(document.documentElement).getPropertyValue('--wave').trim();
  MD.c.forEach(function (p, i) {
    var b = BUF[bufKey(MD.r, p)], cv = document.querySelector('canvas[data-md="' + i + '"]');
    if (b && !MD.dur) MD.dur = b.duration;
    if (cv) { waveShape(cv, b, ink); cv.style.opacity = MD.mute[i] ? .3 : 1; }
  });
  el('md-time').textContent = '0:00 / ' + mmss(MD.dur);
}
function mdPlay() {
  if (RC.state === 'recording' || RC.state === 'asking') return;
  if (S.playing === 'reply') { stop(); mdIdle(); render(); return; }
  stop(); render(); S.playing = 'reply';
  el('md-play').innerHTML = '&#10074;&#10074;'; el('md-play').classList.add('on');
  var r = MD.r, a = ac(); a.resume(); var T = a.currentTime + 0.05, fade = FADE = fadeIn(a, T, a.destination); MD.gains = {};
  var m = mine(), lanes = MD.c.concat(m ? [{ mine:true, buf:m.buf, amp:m.amp }] : []);
  lanes.forEach(function (p, i) {
    var b = p.buf || bufFor(r, p); if (!b) return;
    if (!p.buf) amped(r, p);
    var src = a.createBufferSource(), g = a.createGain(); src.buffer = b; src.loop = true;
    g.gain.value = MD.mute[i] ? 0 : 1; src.start(T); SRC.push(src); MD.gains[i] = g;
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
    /* the lanes above, from bar 1 (the ones you muted stay silent) */
    MD.c.forEach(function (p, i) {
      var b = bufFor(r, p); if (!b || MD.mute[i]) return;
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
  if ((b = e.target.closest('[data-mdmute]'))) {
    var i = +b.dataset.mdmute; MD.mute[i] = !MD.mute[i]; b.setAttribute('aria-pressed', String(!!MD.mute[i]));
    if (MD.gains && MD.gains[i]) MD.gains[i].gain.value = MD.mute[i] ? 0 : 1;
    mdDraw();
  }
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
    return db.uploadAudio(path, file, type).then(function () {
      var row = { session_id:r.id, author_id:u.id, author_name:db.accountName(u), role_id:el('r-layer').value, note:el('r-text').value.trim(),
        status:'waiting', storage_path:path, file_name:file.name, mime_type:type, duration_sec:buf.duration, section_id:section, reply_to:replyTo,
        on_takes:section ? null : chainOf(r, R.pid).filter(function (x) { return !x.isRiff && !x.isPart; }).map(function (x) { return x.dbId || x.id; }) };
      if (ampId) row.amp = ampId;
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
      var nr = riff(r.id); if (nr) { openTo(nr, postOf(nr, row.id)); render(); play(nr.id, row.id); }
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
      '<i style="background:var(' + x.color + ')" aria-hidden="true"></i>' + esc(x.label) + '</button>';
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
      return db.uploadAudio(path, f, type).then(function () {
        return db.insertTake({ session_id:s.id, author_id:u.id, author_name:db.accountName(u), role_id:'seed', note:el('up-text').value.trim(), status:'seed',
          storage_path:path, file_name:f.name, mime_type:type, duration_sec:b.duration,
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
    if (EMBED) { toProject({ stop:true }); S.wfull[fr] = fid; } else S.wsel[fr] = fid;
    wallSeek(fr, fid, 0);
    var fm = document.querySelector('#riff-' + fr + ' .wmaster'); if (fm) fm.scrollIntoView({ behavior:'smooth', block:'nearest' });
    return;
  }
  if ((b = e.target.closest('[data-wfullclose]'))) { var fc = b.dataset.wfullclose; if (S.playing && S.playing.indexOf(fc + ':wall:') === 0) stop(); delete S.wfull[fc]; render(); return; }
  if ((b = e.target.closest('[data-wdot]'))) {
    var dw = document.querySelector('.wwrap[data-wr="' + b.dataset.wdot + '"]'), ds = dw && dw.querySelectorAll('.wsec')[+b.dataset.i];
    if (ds) dw.scrollTo({ left:dw.scrollLeft + ds.getBoundingClientRect().left - dw.getBoundingClientRect().left, behavior:'smooth' });
    return;
  }
  if ((b = e.target.closest('[data-wseek]'))) { var wr = b.getBoundingClientRect(); wallSeek(b.dataset.wseek, b.dataset.post, (e.clientX - wr.left) / wr.width); return; }
  if ((b = e.target.closest('[data-jopen]'))) { openJam(b.dataset.jopen); return; }
  if ((b = e.target.closest('[data-jplay]'))) { cardPlay(b.dataset.jplay); return; }
  if ((b = e.target.closest('[data-jmode]'))) { S.jmode = b.dataset.jmode; if (S.playing && /:card$/.test(S.playing)) stop(); drawJamTools(); render(); return; }
  if ((b = e.target.closest('[data-jhover]'))) { S.jhover = !S.jhover; drawJamTools(); return; }
  if ((b = e.target.closest('[data-wsolo]'))) { wallSolo(b.dataset.wsolo, b.dataset.post); return; }
  if ((b = e.target.closest('[data-wpick]'))) { wallPick(b.dataset.wpick, b.dataset.post); return; }
  if ((b = e.target.closest('[data-wplus]'))) { toast('This is a read-only preview. Open the page without ?wall to play along.'); return; }
  if ((b = e.target.closest('[data-wtalk]'))) { S.wtalk[b.dataset.wtalk] = !S.wtalk[b.dataset.wtalk]; render(); return; }
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
  if ((b = e.target.closest('[data-wsel]')) && EMBED) { if (S.playing) stop(); delete S.wfull[EMBED]; S.wsel[EMBED] = b.dataset.post; if (!wallTree(riff(EMBED)).partOf[b.dataset.post]) S.wcore[EMBED] = b.dataset.post; render(); toProject({ pick:b.dataset.post, play:false }); return; }
  if ((b = e.target.closest('[data-wsel]'))) {
    var xr = b.dataset.wsel, was = S.playing && S.playing.indexOf(xr + ':wall:') === 0;
    if (was) { if (S.playing !== xr + ':wall:' + b.dataset.post) wallPick(xr, b.dataset.post); return; }
    S.wsel[xr] = b.dataset.post; var xT = wallTree(riff(xr)); if (!xT.partOf[b.dataset.post]) S.wcore[xr] = b.dataset.post; render(); return;
  }
  if ((b = e.target.closest('[data-whole]'))) { playWhole(b.dataset.whole, b.dataset.post); return; }
  if ((b = e.target.closest('[data-play]'))) { play(b.dataset.play, b.dataset.post); return; }
  if ((b = e.target.closest('[data-reply]'))) { openReply(b.dataset.reply, b.dataset.post); return; }
  if ((b = e.target.closest('[data-comment]'))) { openComment(b.dataset.comment, b.dataset.post); return; }
  if ((b = e.target.closest('[data-ccancel]'))) { S.cmt.at = null; render(); return; }
  if ((b = e.target.closest('[data-fold]'))) { S.fold[b.dataset.fold] = !S.fold[b.dataset.fold]; render(); return; }
  if ((b = e.target.closest('[data-expand]'))) { S.expanded[b.dataset.expand] = !S.expanded[b.dataset.expand]; render(); return; }
  if ((b = e.target.closest('[data-letin]'))) {
    b.disabled = true;
    /* a new part brings the tracks its author sent with it */
    var lr = RIFFS.filter(function (x) { return postOf(x, b.dataset.letin); })[0], lp = lr && postOf(lr, b.dataset.letin);
    var withIt = lp && lp.kind === 'part' ? kids(lr, lp.id).filter(function (k) { return k.layer && !k.isComment && k.uid === lp.uid && k.status === 'waiting'; })
      .reduce(function (a, k) { return a.concat([k.id], (k.stems || []).map(function (x) { return x.id; })); }, []) : [];
    db.letIn(b.dataset.letin).then(function () {
      return withIt.reduce(function (p, id) { return p.then(function () { return db.letIn(id); }); }, Promise.resolve());
    }).then(reload).then(function () { toast('It’s in the song now.'); }).catch(function (x) { b.disabled = false; oops(x); });
    return;
  }
  if ((b = e.target.closest('[data-playsong]'))) { playSong(b.dataset.playsong); return; }
  if ((b = e.target.closest('[data-playmix]'))) { playMix(b.dataset.playmix); return; }
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

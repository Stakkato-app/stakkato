/* The wall: a jam's takes drawn as stacks of tiles, the master track under them and the
   comments next to it. The homepage draws it in its panel; the project view can draw the same.

   The page that uses it hands over its own pieces with initWall(): the state (S), the cache of
   decoded audio (BUF), its helpers (esc, lay, nameOf, voteHtml, ...) and its audio engine
   (playList, playSeq, playPos, stop, load, ac). The markup is built from strings like in app.js. */

import { decodePeaks, peaksOfBuffer } from './peaks.js';

var H = null, S = null, BUF = null;
export function initWall(host) {
  H = host; S = host.S; BUF = host.BUF;
  S.wcrep = {}; S.wsel = {}; S.wtalk = {}; S.wsay = {}; S.wopen = {}; S.wscroll = {}; S.wpage = {}; S.wcore = {}; S.wsolo = {};
}

/* ---------- the stacks ----------
   The original track is the bottom block; every take sits on top of the take it was played on,
   and takes played on the same take share its width. A new part is its own little wall, before
   or after the original track. */
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
  if (n.isRiff) return 'Original track' + (n.layer !== 'seed' ? ' · ' + H.lay(n.layer).label : '');
  var p = n.p;
  if (p.deleted) return 'deleted take';
  if (p.kind === 'part') return '↦ new part';
  return H.stemsOf(p).map(function (x) { return H.lay(x.layer).label; }).join(' + ');
}
function wallWhose(r, id) {
  if (id === 'riff') return r.by + '’s original track';
  var p = H.postOf(r, id); if (!p) return 'a take';
  return (p.mine ? 'your ' : p.by + '’s ') + (p.kind === 'part' ? 'new part' : H.stemsOf(p).map(function (x) { return H.lay(x.layer).label; }).join(' + '));
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
    var style = 'grid-column:' + (n.c0 + 1) + ' / ' + (n.c1 + 2) + ';grid-row:' + (rows - n.d) + ';--c:' + H.lay(layer).c + (anim && d ? ';animation-delay:' + (LAND + d * STEP).toFixed(2) + 's' : '');
    if (p.deleted) return '<div class="' + cls + '" style="' + style + '"><span class="wname"><span>Deleted take</span></span></div>';
    var who = n.isRiff ? r.by : (p.mine ? 'You' : p.by);
    return '<div class="' + cls + '" style="' + style + '" data-wsel="' + r.id + '" data-post="' + n.id + '">' +
      '<button class="wsolo' + (soloOn ? ' on' : '') + '" type="button" data-wpick="' + r.id + '" data-post="' + n.id + '" aria-label="' + (soloOn ? 'Pause' : 'Play the stack up to ' + H.esc(wallWhose(r, n.id))) + '">' + (soloOn ? '&#10074;&#10074;' : '&#9654;') + '</button>' +
      '<button class="wname" type="button" data-wsel="' + r.id + '" data-post="' + n.id + '" title="Show the stack up to ' + H.esc(wallWhose(r, n.id)) + ' below"><span><b>' + H.esc(who) + '</b> ' + H.esc(wallLabel(n)) + '</span>' +
        '<canvas data-wave="' + r.id + ':' + n.id + '" data-layer="' + layer + '"' + (soloed(r, n.id) ? ' data-of="' + r.id + ':solo" class="wseekable" title="Click to play from there"' : '') + ' aria-hidden="true"></canvas></button>' +
      '<button class="wsolo1' + (soloed(r, n.id) ? ' on' : '') + '" type="button" data-wsolo="' + r.id + '" data-post="' + n.id + '" aria-pressed="' + soloed(r, n.id) + '" aria-label="Solo: ' + H.esc(wallWhose(r, n.id)) + '" title="Solo: hear only the takes with S on">S</button>' +
      (open ? '<button class="wadd" type="button" data-wplus="1" aria-label="Play on top of ' + H.esc(wallWhose(r, n.id)) + '" title="Play on top of this take">+</button>' : '') +
      (open ? '<button class="wbadge" type="button" data-wsay="' + r.id + '" data-post="' + n.id + '" aria-label="Comments on ' + H.esc(wallWhose(r, n.id)) + '">&#128172;' + (w ? ' ' + w : '') + '</button>' : '') + '</div>';
  }
  function plusCells(n, sx) {
    if (!open) return '';
    rows = rowsOf(sx);
    if (n.kids.length) return n.kids.map(function (k) { return plusCells(k, sx); }).join('');
    return '<div class="wplus' + (anim ? ' wp-rise' : '') + '" data-post="' + n.id + '" style="grid-column:' + (n.c0 + 1) + ';grid-row:' + (rows - n.d - 1) + ';animation-delay:' + (LAND + (T.maxD + 2) * STEP).toFixed(2) + 's">' +
      '<button type="button" data-wplus="1" aria-label="Play on the stack up to ' + H.esc(wallWhose(r, n.id)) + '">+</button></div>';
  }
  function all(n, sx) { return block(n, sx) + n.kids.map(function (k) { return all(k, sx); }).join(''); }
  /* where each part sits in the song: parts before the original track lead into it, parts after pick up where it ends */
  var befores = T.secs.filter(function (sx) { return !sx.core && sx.root.p.pos === 'before'; });
  var preLen = befores.reduce(function (n, sx) { return n + (sx.root.p.dur || 0); }, 0);
  var order = befores.concat(T.secs.filter(function (sx) { return sx.core; }), T.secs.filter(function (sx) { return !sx.core && sx.root.p.pos !== 'before'; }));
  function span(sx) {
    if (sx.core) return [preLen, preLen + (r.dur || 0)];
    var d = sx.root.p.dur || 0;
    if (sx.root.p.pos === 'before') { var a = 0; for (var j = 0; befores[j] !== sx; j++) a += befores[j].root.p.dur || 0; return [a, a + d]; }
    return [preLen + (r.dur || 0), preLen + (r.dur || 0) + d];
  }
  function timeHead(sx) {
    if (!open || T.secs.length < 2) return '';
    var t = span(sx), n = order.indexOf(sx) + 1;
    return '<div class="wtime' + (sx.core ? '' : ' wtime-part') + '"><span>' + H.mmss(t[0]) + '</span><i></i><em>Part ' + n + (sx.core ? ' · the original track' : sx.root.p.pos === 'before' ? ' · leads into it' : ' · picks up where it ends') + '</em><i></i><span>' + H.mmss(t[1]) + '</span></div>';
  }
  var secHtml = T.secs.map(function (sx, i) {
    if (!open && !sx.core) return '';
    var grid = '<div class="wgrid" style="grid-template-columns:repeat(' + sx.cols + ',minmax(0,1fr));grid-template-rows:repeat(' + rowsOf(sx) + ',var(--wrh,44px))">' + plusCells(sx.root, sx) + all(sx.root, sx) + '</div>';
    var cap = !open ? '' : '<small>Builds up from here &uarr;</small>';
    var arrow = open && i > 0 ? '<div class="warrow" aria-hidden="true">&rarr;</div>' : '';
    return arrow + '<div class="wsec' + (sx.core ? ' wsec-core' : '') + (!open ? ' wsec-shut' : '') + '" style="--n:' + sx.cols + '">' + timeHead(sx) + grid + cap + '</div>';
  }).join('');
  var playingStack = sel && S.playing === wallKey(r, sel);
  var now = '';
  if (open) {
    var ms = sel || 'riff', mk = wallKey(r, ms), mOn = S.playing === mk, segs = wallSegs(r, ms, T);
    wallMix(r, ms, segs);
    var people = [];
    segs.forEach(function (sg, si) { sg.list.forEach(function (x) { if (si && people.some(function (q) { return q.id === x.id; })) return; people.push(x); }); });
    now = '<div class="wmaster"><div class="wm-top">' +
        '<button class="play' + (mOn ? ' on' : '') + '" type="button" data-wpick="' + r.id + '" data-post="' + ms + '" aria-label="' + (mOn ? 'Pause' : 'Play the master track') + '">' + (mOn ? '&#10074;&#10074;' : '&#9654;') + '</button>' +
        '<div class="wm-what"><b>' + (ms === 'riff' ? 'The original track' : 'Up to ' + H.esc(wallWhose(r, ms))) + '</b>' + wallNote(r, ms) +
          '<div class="wm-chips">' + people.map(function (x) { return '<span><i style="background:' + H.lay(x.isPart ? 'part' : x.layer).c + '"></i>' + H.esc(x.isRiff ? r.by + ' · original' : (x.mine ? 'You' : x.by) + ' · ' + H.chipLabel(x)) + '</span>'; }).join('') + '</div></div></div>' +
      '<div class="wm-wave" data-wseek="' + r.id + '" data-post="' + ms + '" title="Click to play from there">' + segs.map(function (sg, i) {
        return '<div style="flex:' + Math.max(1, Math.round(sg.len * 10)) + ' 1 0"><canvas data-wave="wmix:' + r.id + ':' + ms + ':' + i + '" data-of="' + mk + '" aria-hidden="true"></canvas>' +
          (segs.length > 1 ? '<small>' + H.esc(sg.label) + '</small>' : '') + '</div>';
      }).join('') + '<span class="wm-head" hidden></span></div>' +
      '<div class="wm-acts">' + selActs(r, ms) + '<span>Master track · ' + people.length + (people.length === 1 ? ' track' : ' tracks') + ' together · click a tile above to switch</span><span class="grow"></span>' +
        '<a class="btn btn-sm" href="/s/' + encodeURIComponent(r.slug) + (ms === 'riff' ? '?stack=seed' : '?stack=' + encodeURIComponent(ms)) + '">Open this stack in project view</a></div></div>';
  }

  /* talk about this song: every written reply, newest first, with what it is about */
  var ws = r.posts.filter(function (p) { return p.isComment && !p.deleted; }).sort(function (a, b) { return String(b.created).localeCompare(String(a.created)); });
  /* open: the top three comments (most liked, then newest) and the comment box; "all" after "Show all";
     the bar folds them away (false) */
  var talkMode = S.wtalk[r.id] === true ? 'all' : S.wtalk[r.id] === false ? 'hide' : 'top', talkOpen = talkMode !== 'hide';
  /* replies to a comment sit under it; the top three are picked from the comments themselves */
  var kidsOf = {}, roots = ws.filter(function (c) {
    var t = c.parent ? H.postOf(r, c.parent) : null;
    if (t && t.isComment) { (kidsOf[t.id] = kidsOf[t.id] || []).unshift(c); return false; }
    return true;
  });
  var shown = talkMode === 'all' ? roots : roots.slice().sort(function (a, b) { return (b.likes || 0) - (a.likes || 0) || String(b.created).localeCompare(String(a.created)); }).slice(0, 3);
  function oneWord(c, sub) {
    var rep = S.wcrep[r.id] === c.id;
    return '<div class="wword' + (sub ? ' sub' : '') + '">' + H.ava(c.mine ? 'You' : c.by, null, true) + '<div class="wword-b"><b>' + H.nameOf(c.mine ? 'You' : c.by, c.uid) + '</b><span class="muted">' + H.esc(c.time) + '</span>' +
      (sub ? '' : '<br>' + about(c)) + '<p>' + H.esc(c.text) + '</p>' +
      '<div class="wword-acts">' + H.voteHtml(c.id, c.likes) + '<button class="ghost" type="button" data-wcreply="' + r.id + '" data-post="' + c.id + '">Reply</button>' +
        (H.canDelete(c.mine) ? H.delBtn('comment', c.id) : '') + '</div>' +
      (rep ? '<form class="wcrep" data-wcrepform="' + r.id + '" data-post="' + c.id + '"><textarea id="wcrep-' + r.id + '" rows="1" maxlength="1000" placeholder="Reply to ' + H.esc(c.mine ? 'yourself' : c.by) + '"></textarea>' +
        '<button class="btn btn-main btn-sm" type="submit">Reply</button><button class="btn btn-sm" type="button" data-wcrepx="' + r.id + '">Cancel</button></form>' : '') +
      '</div></div>' + (kidsOf[c.id] || []).map(function (k) { return oneWord(k, true); }).join('');
  }
  function about(c) {
    var t = c.parent ? H.postOf(r, c.parent) : null;
    if (!t) return '<span class="wchip" style="cursor:default">on the jam</span>';
    if (t.isComment) return '<span class="wchip" style="cursor:default">reply to ' + H.esc(t.mine ? 'you' : t.by) + '</span>';
    return '<button class="wchip" type="button" data-wshow="' + r.id + '" data-post="' + t.id + '" style="--c:' + H.lay(t.kind === 'part' ? 'part' : t.layer).c + '">on ' + H.esc(wallWhose(r, t.id)) + '</button>';
  }
  var target = S.wsay[r.id] || '', opts = [{ id:'', label:'the song as a whole' }, { id:'riff', label:r.by + '’s original track' }];
  r.posts.forEach(function (p) { if (!p.isComment && !p.deleted && (p.layer || p.kind === 'part')) opts.push({ id:p.id, label:wallWhose(r, p.id) }); });
  var say = '<form class="wsay" data-wsayform="' + r.id + '"><label>Comment on <select data-wsaywhat="' + r.id + '" aria-label="What your comment is about">' +
      opts.map(function (o) { return '<option value="' + o.id + '"' + (o.id === target ? ' selected' : '') + '>' + H.esc(o.label) + '</option>'; }).join('') + '</select></label>' +
    '<div class="wsay-row"><textarea id="wsay-' + r.id + '" rows="1" maxlength="1000" placeholder="Say something about ' + H.esc(target ? wallWhose(r, target) : 'the song') + '"></textarea>' +
    '<button class="btn btn-main" type="submit">Post</button></div></form>';
  var talk = !open ? '' : '<button class="wtalk" type="button" data-wtalk="' + r.id + '" aria-expanded="' + talkOpen + '"><span aria-hidden="true">&#128172;</span>' +
      '<span><b>Talk about this song</b> · ' + (ws.length ? ws.length + (ws.length > 1 ? ' comments' : ' comment') : 'no comments yet') + '</span>' +
      '<span class="wlast">' + (talkOpen || !ws.length ? '' : '“' + H.esc(ws[0].text.length > 70 ? ws[0].text.slice(0, 67) + '…' : ws[0].text) + '” · ' + H.esc(ws[0].mine ? 'You' : ws[0].by)) + '</span>' +
      '<span class="wgo">' + (talkOpen ? 'Hide comments &#9652;' : 'Show comments &#9662;') + '</span></button>' +
    (talkOpen ? '<div class="wwords">' + (talkMode === 'top' && roots.length > 3 ? '<span class="wtop">Top comments</span>' : '') + shown.map(function (c) { return oneWord(c, false); }).join('') + (talkMode === 'top' && roots.length > 3 ? '<button class="btn btn-sm wall-all" type="button" data-wtalkall="' + r.id + '">Show all ' + roots.length + ' comments</button>' : '') + say + '</div>' : '');

  var n = T.takes + T.parts;
  var bar = n && S.ov !== r.id ? '<button class="threadbar' + (open ? ' open' : '') + '" type="button" data-expand="' + r.id + '" aria-expanded="' + open + '">' +
    '<span class="tb-txt"><b>' + n + (n > 1 ? ' reactions' : ' reaction') + '</b> · ' + T.takes + (T.takes === 1 ? ' take' : ' takes') + (T.parts ? ', ' + T.parts + (T.parts > 1 ? ' new parts' : ' new part') : '') + '</span>' +
    '<span class="tb-go">' + (open ? 'Hide reactions <i aria-hidden="true">&#9652;</i>' : 'Show reactions <i aria-hidden="true">&#9662;</i>') + '</span></button>' : '';

  return '<article class="riff" id="riff-' + r.id + '"><div class="rmain">' +
    '<div class="rhead">' + H.ava(r.by, r.layer) + '<div class="rwho"><b>' + H.nameOf(r.by, r.uid) + '</b> started a jam' + (r.layer !== 'seed' ? ' · ' + H.lyr(r.layer) : '') +
      '<small>' + H.riffMeta(r) + '</small></div></div>' +
    '<h2 class="rtitle">' + H.esc(r.title) + '</h2>' + (r.text ? '<p class="rtext">' + H.esc(r.text) + '</p>' : '') +
    '<div class="wwrap" data-wr="' + r.id + '"><div class="wrow">' + secHtml + '</div></div>' + wallDots(r, T, open) + wallFullBtn(r, T, open) + now +
    (open ? '' : '<div class="racts"><a class="btn" href="/s/' + encodeURIComponent(r.slug) + '">Open in project view</a></div>') +
    '</div>' + bar + talk + '</article>';
}
function wallKey(r, id) { return r.id + ':wall:' + id; }
/* what the person on top of the stack said about their take (only that one take) */
function wallNote(r, id) {
  var p = id === 'riff' ? null : H.postOf(r, id), t = p ? p.text : r.text, who = p ? (p.mine ? 'You' : p.by) : r.by;
  if (!t || !String(t).trim() || id === 'riff') return '';
  return '<p class="wm-note">“' + H.esc(String(t).trim()) + '” <span>· ' + H.esc(who) + '</span></p>';
}
/* the take on top of the picked stack: rate it, and delete it if it's yours */
function selActs(r, id) {
  if (!id) return '';
  var p = id === 'riff' ? null : H.postOf(r, id);
  if (id !== 'riff' && (!p || p.deleted)) return '';
  return '<span class="wsel-acts"><span class="wsel-what">' + H.esc((function (x) { return x.charAt(0).toUpperCase() + x.slice(1); })(p ? wallWhose(r, id) : r.by + '’s original track')) + '</span>' + H.voteHtml(p ? p.id : r.id, p ? p.likes : r.likes) +
    (p && p.kind !== 'part' && H.canDelete(p.mine) ? H.delBtn('take', p.id, p.mine ? 'Delete my take' : 'Delete') : '') + '</span>';
}
function soloed(r, id) { return S.playing === r.id + ':solo' && (S.wsolo[r.id] || []).indexOf(id) > -1; }
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
      return '<button type="button" data-wdot="' + r.id + '" data-i="' + i + '" aria-label="' + H.esc(label) + '" aria-current="' + (i === at) + '"></button>';
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
  var bot = 0, gb = g.getBoundingClientRect().bottom;
  [].forEach.call(g.querySelectorAll('.wb,.wplus button'), function (b) { var x = b.getBoundingClientRect().bottom; if (x > bot) bot = x; });
  if (bot) g.style.setProperty('--rb', Math.max(0, gb - bot) + 'px');
}
function wallFit(w) {
  if (!(window.matchMedia && matchMedia('(max-width:760px)').matches)) { w.style.height = ''; return; }
  var sx = w.querySelectorAll('.wsec')[wallPageOf(w)];
  if (sx) w.style.height = (sx.offsetHeight + 8) + 'px';
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
  var r = H.riff(rid), k = wallKey(r, id), T = wallTree(r), segs = wallSegs(r, id, T);
  S.wsel[rid] = id; if (!T.partOf[id]) S.wcore[rid] = id;
  var total = segs.reduce(function (n, sg) { return n + sg.len; }, 0), at = Math.max(0, Math.min(.999, f)) * total;
  if (segs.length === 1) { H.playList(k, r, segs[0].list, at); H.render(); return; }
  H.playSeq(k, r, segs.map(function (sg) { return sg.list; }), at);
}

/* S: hear only that take; S on more takes plays them together (S again takes one out). While the
   master track plays, S takes over from that moment; when the last S goes off, the master picks
   up from where the takes got to. */
function wallSolo(rid, id, at) {
  var r = H.riff(rid), k = rid + ':solo', now = H.playPos(), soloing = S.playing === k;
  var list = soloing ? (S.wsolo[rid] || []).slice() : [];
  if (typeof at === 'number') { if (!soloing) return; }
  else {
    var i = list.indexOf(id);
    if (i > -1) list.splice(i, 1); else list.push(id);
    if (!list.length) {
      var back = S.wback; S.wback = null; S.wsolo[rid] = [];
      if (back && H.ac()) {
        /* the master goes on where it would be now, had it kept playing */
        var bs = wallSegs(r, back.master, wallTree(r)), total = bs.reduce(function (n, sg) { return n + sg.len; }, 0);
        var pos = total ? (back.pos + H.ac().currentTime - back.t) % total : 0;
        wallSeek(rid, back.master, total ? pos / total : 0); return;
      }
      H.stop(); H.render(); return;
    }
    at = 0;
    if (soloing && now !== null) at = now;   /* another take joins: carry on from here */
    else {
      S.wback = null;
      var pre = rid + ':wall:';
      if (now !== null && S.playing && S.playing.indexOf(pre) === 0) {
        var mid = S.playing.slice(pre.length), segs = wallSegs(r, mid, wallTree(r)), off = 0, si = -1, acc = 0;
        var has = function (sg) { return sg.list.some(function (x) { return id === 'riff' ? x.isRiff : x.id === id; }); };
        segs.forEach(function (sg, j) { if (si < 0 && now >= acc && now < acc + sg.len && has(sg)) { si = j; off = acc; } acc += sg.len; });
        if (si < 0) { acc = 0; segs.forEach(function (sg, j) { if (si < 0 && has(sg)) { si = j; off = acc; } acc += sg.len; }); }
        if (si >= 0) { var local = now - off; at = local >= 0 && local < segs[si].len ? local : 0; }
        else at = now % (segs[0].len || 1);   /* a take that isn't in this stack: at the same point in the bar */
        S.wback = { master:mid, pos:now, t:H.ac().currentTime };
      }
    }
  }
  S.wsolo[rid] = list;
  var seen = {}, chain = [];
  list.forEach(function (x) {
    var p = x === 'riff' ? null : H.postOf(r, x);
    (p ? H.stemsOf(p) : H.chainOf(r, null).slice(0, 1)).forEach(function (c) { if (!seen[c.id]) { seen[c.id] = 1; chain.push(c); } });
  });
  H.playList(k, r, chain, at);
  H.render();
}
function wallBase(r, T, part) {
  var c = S.wcore[r.id];
  if (c && !T.partOf[c] && (c === 'riff' || H.postOf(r, c))) return c;
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
  if (!part) return [{ list:H.chainOf(r, id === 'riff' ? null : id), len:r.dur || 1, label:'The original track' }];
  var bid = wallBase(r, T, part);
  var base = { list:H.chainOf(r, bid === 'riff' ? null : bid), len:r.dur || 1, label:bid === 'riff' ? 'The original track' : 'Up to ' + wallWhose(r, bid) },
      on = { list:H.chainOf(r, id), len:part.p.dur || 1, label:wallWhose(r, part.id) };
  return part.p.pos === 'before' ? [on, base] : [base, on];
}
/* the master track's waveform: every track of a segment summed. Once all of them are loaded
   (after a play) from the audio; until then from their saved peaks (BUF[k + ':pk']), which only
   loads the tracks that have none. Each take's peaks are scaled to its own loudest sample, so
   that sum is close to the real one, not the same. */
function wallMix(r, id, segs) {
  segs.forEach(function (sg, i) {
    var k = 'wmix:' + r.id + ':' + id + ':' + i;
    if (BUF[k]) return;
    var bs = sg.list.map(function (x) { return BUF[H.bufKey(r, x)]; });
    if (bs.length && bs.every(Boolean)) {
      var len = bs[0].length, out = H.ac().createBuffer(1, len, bs[0].sampleRate), d = out.getChannelData(0);
      bs.forEach(function (b) { var c = b.getChannelData(0), n = Math.min(len, c.length); for (var j = 0; j < n; j++) d[j] += c[j]; });
      BUF[k] = out; return;
    }
    if (BUF[k + ':pk'] || BUF[k + ':busy']) return;
    BUF[k + ':busy'] = true;
    Promise.all(sg.list.map(function (x) { return x.peaks ? null : H.load(r, x); })).then(function () {
      var pks = sg.list.map(function (x) { var b = BUF[H.bufKey(r, x)]; return decodePeaks(x.peaks || (b && peaksOfBuffer(b))); }).filter(Boolean);
      delete BUF[k + ':busy'];
      if (!pks.length) return;
      /* each take's peaks are scaled to its own loudest moment, and loud moments rarely line up:
         a root of the summed squares looks closer to the real sum than adding them up */
      var n = pks[0].hi.length, hi = new Float32Array(n), lo = new Float32Array(n);
      pks.forEach(function (pk) { for (var j = 0; j < n && j < pk.hi.length; j++) { hi[j] += pk.hi[j] * pk.hi[j]; lo[j] += pk.lo[j] * pk.lo[j]; } });
      for (var j = 0; j < n; j++) { hi[j] = Math.sqrt(hi[j]); lo[j] = -Math.sqrt(lo[j]); }
      BUF[k + ':pk'] = { hi:hi, lo:lo, peak:1 }; H.drawWaves();
    });
  });
}
/* Picking a take plays its stack: the take and everything under it. On a new part, what the part
   was made on plays first (or after, for a part before), then the part with its takes, and round again. */
function wallPick(rid, id) {
  var r = H.riff(rid), k = wallKey(r, id);
  S.wsel[rid] = id;
  if (S.playing === k) { H.stop(); H.render(); return; }
  var T = wallTree(r), part = T.partOf[id];
  if (!part) { S.wcore[rid] = id; H.playList(k, r, H.chainOf(r, id === 'riff' ? null : id)); H.render(); return; }
  var segs = wallSegs(r, id, T);
  H.playSeq(k, r, segs.map(function (sg) { return sg.list; }), part.p.pos === 'before' ? 0 : segs[0].len);
}

export { wallHtml, wallTree, wallKey, wallWhose, wallSegs, wallPick, wallSeek, wallSolo, wallHead, wallScrolls, wallFit, wallFullId };

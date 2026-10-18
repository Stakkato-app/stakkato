/* /admin (temporary): every account, how it signed up, whether it's confirmed, its jams and
   takes, and "View as" (src/viewas.js). The page loads for anyone; only admin_accounts()
   decides who sees data, and it refuses everyone but the admin. House accounts (our own
   seeding accounts) are in the table with a tag, but left out of the tiles. */

import './styles.css';
import './theme.js';
import { onAccount, openAuth, account, viewAs, profileHref } from './auth.js';
import { configured } from './supabase.js';
import * as db from './data.js';

var box = document.getElementById('admin');
var real = null;          // who is actually signed in (also while viewing as someone)
var ROWS = null, failed = '', filter = 'all', q = '', loading = false;

function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function ago(iso) {
  var m = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 2) return 'just now';
  if (m < 60) return Math.round(m) + ' minutes ago';
  var h = m / 60; if (h < 24) return Math.round(h) + ' hour' + (Math.round(h) > 1 ? 's' : '') + ' ago';
  var d = h / 24; if (d < 2) return 'yesterday';
  if (d < 14) return Math.round(d) + ' days ago';
  return day(iso);
}
function day(iso) {
  var d = new Date(iso), o = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
  return d.toLocaleDateString(undefined, o);
}

var VIA = { email: ['@', 'Email'], google: ['G', 'Google'] };
function via(p) { return VIA[p] || [String(p || '?').charAt(0).toUpperCase(), p || 'Unknown']; }
function first(r) { return r.signed_up_with || (r.providers || [])[0] || 'email'; }
function confirmed(r) { return !!r.email_confirmed_at; }

var FILTERS = [
  ['all', 'All', function () { return true; }],
  ['email', 'Email', function (r) { return first(r) === 'email'; }],
  ['google', 'Google', function (r) { return first(r) === 'google'; }],
  ['unconfirmed', 'Not confirmed', function (r) { return !confirmed(r); }]
];
function test(key) { return FILTERS.filter(function (f) { return f[0] === key; })[0][2]; }
function shown() {
  var t = test(filter), s = q.trim().toLowerCase();
  return ROWS.filter(function (r) {
    return t(r) && (!s || String(r.username || '').toLowerCase().indexOf(s) > -1 || String(r.email || '').toLowerCase().indexOf(s) > -1);
  });
}

function render() {
  if (!configured) { box.innerHTML = '<p class="song-empty">Supabase is not configured. Copy .env.example to .env.local and fill it in.</p>'; return; }
  if (!real) {
    box.innerHTML = '<h1>Accounts</h1><section class="st-card"><h2>Sign in first</h2><p class="muted">This page is for the admin. Sign in with the admin account to see it.</p>' +
      '<div><button class="btn btn-main" type="button" data-signin>Sign in</button></div></section>';
    return;
  }
  if (!db.isAdmin(real)) {
    box.innerHTML = '<h1>Accounts</h1><section class="st-card"><h2>Only for the admin</h2><p class="muted">This page lists everyone’s accounts, so only the admin can see it.</p>' +
      '<div><a class="btn btn-main" href="/">See the jams</a></div></section>';
    return;
  }
  if (failed) { box.innerHTML = '<h1>Accounts</h1><p class="song-empty">' + esc(failed) + '</p>'; return; }
  if (!ROWS) { box.innerHTML = '<h1>Accounts</h1><p class="song-empty">Loading the accounts...</p>'; return; }

  var people = ROWS.filter(function (r) { return !r.house; });
  var tiles = [
    [people.length, people.length === 1 ? 'account' : 'accounts'],
    [people.filter(test('email')).length, 'signed up with email'],
    [people.filter(test('google')).length, 'signed up with Google']
  ];
  var waiting = people.filter(test('unconfirmed')).length;
  var house = ROWS.length - people.length;

  box.innerHTML =
    '<div class="ad-head"><p class="ad-kicker">Admin · only you can see this page</p><h1>Accounts</h1></div>' +
    '<div class="ad-tiles">' +
      tiles.map(function (t) { return '<div class="ad-tile"><b>' + t[0] + '</b><span>' + esc(t[1]) + '</span></div>'; }).join('') +
      '<div class="ad-tile' + (waiting ? ' warn' : '') + '"><b>' + waiting + '</b><span>' + (waiting === 1 ? 'hasn’t' : 'haven’t') + ' confirmed their email</span></div>' +
    '</div>' +
    '<section class="ad-card" aria-label="All accounts">' +
      '<div class="ad-bar"><div class="seg" role="group" aria-label="Show">' +
        FILTERS.map(function (f) {
          return '<button type="button" data-filter="' + f[0] + '" aria-pressed="' + (filter === f[0]) + '">' + esc(f[1]) + ' <span>· ' + ROWS.filter(f[2]).length + '</span></button>';
        }).join('') + '</div>' +
        '<label class="ad-find"><span class="sr-only">Find a name or email</span><input id="ad-q" type="search" placeholder="Find a name or email" value="' + esc(q) + '" autocomplete="off"></label>' +
      '</div>' +
      '<div class="ad-scroll"><table class="ad-table"><thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Signed up with</th><th scope="col">Status</th><th scope="col">Joined</th><th scope="col" class="num">Jams</th><th scope="col" class="num">Takes</th><th scope="col">Last signed in</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>' +
      '<tbody>' + rows(shown()) + '</tbody></table></div>' +
    '</section>' +
    '<p class="muted ad-note">“View as” shows Stakkato the way that person sees it: their profile, their takes waiting for review, their own versions. You can’t post, vote or change anything while viewing.' +
      (house ? ' House accounts (' + house + ') seed jams and takes; they’re in the table but not in the counts above.' : '') + '</p>';
}

function rows(list) {
  if (!list.length) return '<tr><td colspan="9" class="ad-none">' + (q ? 'Nobody matches “' + esc(q) + '”.' : 'Nobody here.') + '</td></tr>';
  return list.map(function (r) {
    var f = via(first(r)), more = (r.providers || []).filter(function (p) { return p !== first(r); });
    var you = real && r.id === real.id;
    var name = r.username ? '<a class="ad-who" href="' + profileHref(r.username) + '">' + esc(r.username) + '</a>' : '<span class="muted">No name yet</span>';
    return '<tr>' +
      '<td>' + name + (you ? ' <span class="ad-pill ink">Admin</span>' : '') + (r.house ? ' <span class="ad-pill">House</span>' : '') + '</td>' +
      '<td>' + esc(r.email || '') + '</td>' +
      '<td><span class="ad-via"><i class="' + esc(first(r)) + '" aria-hidden="true">' + esc(f[0]) + '</i>' + esc(f[1]) + '</span>' +
        (more.length ? ' <span class="ad-more">+ ' + esc(more.map(function (p) { return via(p)[1]; }).join(', ')) + '</span>' : '') + '</td>' +
      '<td>' + (confirmed(r) ? '<span class="ad-pill">Confirmed</span>' : '<span class="ad-pill warn">Not confirmed</span>') + '</td>' +
      '<td>' + esc(day(r.created_at)) + '</td>' +
      '<td class="num">' + (r.jams || 0) + '</td><td class="num">' + (r.takes || 0) + '</td>' +
      '<td>' + (r.last_sign_in_at ? esc(ago(r.last_sign_in_at)) : '<span class="muted">never</span>') + '</td>' +
      '<td>' + (you ? '' : '<button class="btn btn-sm" type="button" data-view="' + esc(r.id) + '">View as</button>') + '</td>' +
    '</tr>';
  }).join('');
}

function load() {
  if (loading || ROWS) return;
  loading = true; render();
  db.adminAccounts().then(function (r) { ROWS = r || []; })
    .catch(function (x) { console.error(x); failed = 'The accounts didn’t load: ' + ((x && x.message) || 'try again in a moment') + '.'; })
    .then(function () { loading = false; render(); });
}

box.addEventListener('click', function (e) {
  var t = e.target.closest('button');
  if (!t) return;
  if (t.hasAttribute('data-signin')) openAuth('in');
  else if (t.hasAttribute('data-filter')) { filter = t.getAttribute('data-filter'); render(); }
  else if (t.hasAttribute('data-view')) {
    var r = ROWS.filter(function (x) { return x.id === t.getAttribute('data-view'); })[0];
    if (r) viewAs({ id: r.id, name: r.username, email: r.email, providers: r.providers });
  }
});
/* searching only redraws the rows, so the field keeps its focus */
box.addEventListener('input', function (e) {
  if (e.target.id !== 'ad-q') return;
  q = e.target.value;
  var body = box.querySelector('.ad-table tbody');
  if (body) body.innerHTML = rows(shown());
});

onAccount(function () {
  real = account().real;
  if (real && db.isAdmin(real)) load();
  render();
});
if (!configured) render();

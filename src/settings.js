/* /settings: your name and profile link, how you sign in, changing your password, and how to
   delete your account (by email for now). Needs an account; signed out it asks you to sign in. */

import './styles.css';
import './theme.js';
import { onAccount, openAuth, signOutNow, profileHref, say } from './auth.js';
import { configured } from './supabase.js';
import * as db from './data.js';

var HELLO = 'hello@stakkato.app';
var box = document.getElementById('settings');
var me = null, name = null;

function el(id) { return document.getElementById(id); }
function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function providers(u) { return ((u && u.identities) || []).map(function (i) { return i.provider; }); }

function render() {
  if (!configured) { box.innerHTML = '<p class="song-empty">Supabase is not configured. Copy .env.example to .env.local and fill it in.</p>'; return; }
  if (!me) {
    document.title = 'Stakkato settings';
    box.innerHTML = '<h1>Settings</h1><section class="st-card"><h2>Sign in first</h2>' +
      '<p class="muted">Your settings belong to your account. Sign in to change your password or see your profile.</p>' +
      '<div><button class="btn btn-main" type="button" data-signin>Sign in</button></div></section>';
    return;
  }
  var via = providers(me), mail = via.indexOf('email') > -1, google = via.indexOf('google') > -1;
  var link = name ? location.host + profileHref(name) : '';
  box.innerHTML =
    (name ? '<a class="st-back" href="' + profileHref(name) + '">← Your profile</a>' : '') +
    '<h1>Settings</h1>' +
    '<section class="st-card" aria-labelledby="st-name"><h2 id="st-name">Your name</h2>' +
      '<div class="st-me"><span class="pf-av" aria-hidden="true">' + esc((name || me.email || '?').charAt(0).toUpperCase()) + '</span>' +
        '<div class="st-who"><b>' + esc(name || 'No name yet') + '</b>' + (name ? '<span class="muted">Your profile: ' + esc(link) + '</span>' : '') + '</div>' +
        (name ? '<a class="btn btn-sm" href="' + profileHref(name) + '">See your profile</a>' : '<button class="btn btn-sm btn-main" type="button" data-pick>Pick your name</button>') + '</div>' +
      '<p class="muted">Your name is on every jam, take and reply you’ve posted, so it stays the same. Made a typo or want a different one? Write to <a href="mailto:' + HELLO + '">' + HELLO + '</a>.</p>' +
    '</section>' +
    '<section class="st-card" aria-labelledby="st-in"><h2 id="st-in">Signing in</h2>' +
      '<dl class="st-rows">' +
        '<div><dt>Email</dt><dd>' + esc(me.email || '') + '</dd></div>' +
        '<div><dt>Google</dt><dd>' + (google ? 'Connected <span class="st-pill">Same email</span>' : '<span class="muted">Not connected</span>') + '</dd></div>' +
        '<div><dt>Password</dt><dd>' + (mail ? 'Set' : '<span class="muted">None, you sign in with Google</span>') + '</dd></div>' +
      '</dl>' +
      (mail ? '<form class="st-form" id="st-pass" novalidate><h3>Change your password</h3>' +
        '<div class="acct-field"><label for="st-cur">Current password</label><input id="st-cur" type="password" autocomplete="current-password"></div>' +
        '<div class="acct-field"><label for="st-new">New password</label><input id="st-new" type="password" autocomplete="new-password" aria-describedby="st-hint"><p class="acct-hint" id="st-hint">At least 8 characters.</p></div>' +
        '<p class="acct-err" id="st-err" role="alert"></p>' +
        '<div class="st-acts"><button class="btn btn-main" type="submit" id="st-go">Change my password</button><button class="acct-link" type="button" data-forgot>Forgot your current one?</button></div>' +
      '</form>' : '') +
    '</section>' +
    '<section class="st-card" aria-labelledby="st-del"><h2 id="st-del">Delete your account</h2>' +
      '<p class="muted">Want to leave Stakkato? We’ll delete your account for you.</p>' +
      '<div><button class="btn st-danger" type="button" data-delete>Delete my account</button></div></section>' +
    (me.viewing ? '<div><button class="btn" type="button" data-va-stop>Stop viewing</button></div>'
      : '<div><button class="btn" type="button" data-signout>Sign out</button></div>');
}

/* deleting isn't self-service yet: the pop-up says who to write to, from this account's email */
function deletePop() {
  var subject = encodeURIComponent('Delete my Stakkato account');
  var body = encodeURIComponent('Please delete my Stakkato account' + (name ? ' (' + name + ')' : '') + '.');
  var s = document.createElement('div');
  s.className = 'acct-scrim on'; s.id = 'st-scrim';
  s.innerHTML = '<div class="acct-card" role="dialog" aria-modal="true" aria-labelledby="st-del-h">' +
    '<div class="acct-top"><h3 id="st-del-h">Delete your account</h3><button class="acct-ghost" type="button" data-close>Close</button></div>' +
    '<p class="acct-sub">You can’t delete your account from here yet. Send us an email and we’ll take care of it.</p>' +
    '<div class="acct-note">Write to<br><b>' + HELLO + '</b><br>from <b>' + esc(me.email || 'the email of this account') + '</b>, the email of this account, so we know it’s you.</div>' +
    '<a class="acct-main acct-go" href="mailto:' + HELLO + '?subject=' + subject + '&body=' + body + '">Write the email</a>' +
    '<button class="acct-btn acct-wide" type="button" data-copymail>Copy the address</button></div>';
  document.body.appendChild(s);
  s.querySelector('[data-close]').focus();
  function close() { s.remove(); document.removeEventListener('keydown', key); var b = box.querySelector('[data-delete]'); if (b) b.focus(); }
  function key(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', key);
  s.addEventListener('click', function (e) {
    if (e.target === s || e.target.closest('[data-close]')) close();
    else if (e.target.closest('[data-copymail]')) {
      (navigator.clipboard ? navigator.clipboard.writeText(HELLO) : Promise.reject())
        .then(function () { say('Copied: ' + HELLO); }, function () { say('Copying didn’t work. The address is ' + HELLO); });
    }
  });
}

function changePassword(e) {
  e.preventDefault();
  var cur = el('st-cur'), next = el('st-new'), err = el('st-err'), go = el('st-go');
  err.textContent = '';
  if (!cur.value) { err.textContent = 'Fill in your current password.'; cur.focus(); return; }
  if (next.value.length < 8) { err.textContent = 'The new password needs at least 8 characters.'; next.focus(); return; }
  go.disabled = true;
  db.changePassword(me.email, cur.value, next.value).then(function () {
    cur.value = ''; next.value = ''; go.disabled = false;
    say('Your password is changed. Use the new one next time you sign in.');
  }).catch(function (x) {
    var m = (x && x.message) || '';
    err.textContent = /invalid login|credentials/i.test(m) ? 'That isn’t your current password. Check it, or ask for a reset link.'
      : /different from the old|same/i.test(m) ? 'That’s your old password. Pick a new one.'
      : m || 'Changing it didn’t work. Try again in a moment.';
    go.disabled = false;
  });
}

box.addEventListener('submit', function (e) { if (e.target.id === 'st-pass') changePassword(e); });
box.addEventListener('click', function (e) {
  var t = e.target.closest('button');
  if (!t) return;
  if (t.hasAttribute('data-signin')) openAuth('in');
  else if (t.hasAttribute('data-pick')) openAuth('name');
  else if (t.hasAttribute('data-signout')) signOutNow();
  else if (t.hasAttribute('data-delete')) deletePop();
  else if (t.hasAttribute('data-forgot')) {
    t.disabled = true;
    db.requestReset(me.email).then(function () { say('We sent a link to ' + me.email + '. It works once, for an hour.'); })
      .catch(function (x) { say((x && x.message) || 'Sending the link didn’t work. Try again in a moment.'); })
      .then(function () { t.disabled = false; });
  }
});

onAccount(function (user, n) { me = user; name = n; render(); });
if (!configured) render();

/* Accounts on every page: the header's account corner and the one pop-up for signing up,
   signing in, checking your email, a forgotten password and picking a name after Google.

   Reading needs no account; every write does (the database checks has_account()). A page
   asks for one with requireAccount(reason), which resolves once someone is signed in with
   a name, so the action they pressed carries on right after. onAccount(fn) tells the page
   who is signed in (fn(user, name), user null when signed out) whenever that changes.

   Email links land on /auth/confirm. On Cloudflare the gate checks them and sends people
   on signed in (/?auth=confirmed#tokens, or /reset# for a new password); without the gate
   (npm run dev) the homepage gets the link and this file checks it. */

import './auth.css';
import * as db from './data.js';
import { configured } from './supabase.js';

var A = { user: null, name: null, ready: false };
var subs = [];
var V = { view: 'up', ctx: null, pending: [], mail: '', name: '', err: '', notice: '', cool: 0, coolT: 0, poll: 0, checkT: 0, checkSeq: 0, check: null, show: false, asked: false };
var RETURN_KEY = 'stackato:auth-return';
var NAME_RULE = 'Names: 3 to 24 letters, numbers, dots, dashes or underscores. No two people share a name, whatever the capitals.';
var NAME_RE = /^[A-Za-z0-9._-]{3,24}$/;
var MAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
var TICK = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>';
var MAIL = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M4 7l8 6 8-6"/></svg>';
var CHEVRON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

/* what the pop-up says when an action needs an account */
var REASONS = {
  play:    ['Sign up to play along', 'Every take carries your name and shows up on your profile. It takes a minute, and you can listen without an account.'],
  start:   ['Sign up to start a jam', 'Your jam carries your name, and you pick which takes go in. It takes a minute, and you can listen without an account.'],
  reply:   ['Sign up to reply', 'Every reply carries your name. It takes a minute, and you can read and listen without an account.'],
  vote:    ['Sign up to vote', 'Every vote is one person’s, so it needs an account. It takes a minute, and you can listen without an account.'],
  like:    ['Sign up to like this', 'Every like is one person’s, so it needs an account. It takes a minute, and you can listen without an account.'],
  version: ['Sign up to save your version', 'Your version carries your name, and others can play and fork it. It takes a minute, and you can listen without an account.'],
  mix:     ['Sign up to add a mix', 'Your mix carries your name, next to the song. It takes a minute, and you can listen without an account.']
};

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function el(id) { return document.getElementById(id); }
function val(id) { var x = el(id); return x ? x.value : ''; }
function msg(x) { return (x && (x.message || x.error_description)) || ''; }

/* ---------- toasts: the page's own if it gave one ---------- */
var toastFn = null, toastT = 0;
export function setToast(fn) { toastFn = fn; }
function toast(m) {
  if (toastFn) return toastFn(m);
  var t = document.querySelector('.acct-toast');
  if (!t) { t = document.createElement('div'); t.className = 'acct-toast'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); document.body.appendChild(t); }
  t.textContent = m; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('on'); }, 4500);
}

/* ---------- who is signed in ---------- */
export function account() { return A; }
export function onAccount(fn) { subs.push(fn); if (A.ready) fn(A.user, A.name); }

function setUser(user) {
  if (user && user.is_anonymous) user = null;   // an old anonymous session counts as signed out
  var load = user ? db.loadProfile(user).catch(function (e) { console.error(e); return db.accountName(user); }) : Promise.resolve(null);
  return load.then(function (name) {
    var changed = !A.ready || (A.user && A.user.id) !== (user && user.id) || A.name !== name;
    A.user = user; A.name = name || null; A.ready = true;
    paintHeader();
    if (changed) subs.forEach(function (fn) { try { fn(A.user, A.name); } catch (e) { console.error(e); } });
    if (A.user && A.name) done();
    else if (A.user && !A.name && !V.asked) { V.asked = true; openView('name'); }
  });
}

/* the action someone pressed before signing up carries on */
function done() {
  var p = V.pending; V.pending = [];
  if (V.show && V.view !== 'forgot') close();
  p.forEach(function (fn) { try { fn(A.user); } catch (e) { console.error(e); } });
}

/* resolves with the user once someone is signed in with a name; reason is a key of REASONS
   or { heading, text, jam: { title, meta } } */
export function requireAccount(reason) {
  return new Promise(function (resolve) {
    if (A.user && A.name) return resolve(A.user);
    V.pending.push(resolve);
    if (A.user) openView('name');
    else openView('up', typeof reason === 'string' ? { heading: REASONS[reason][0], text: REASONS[reason][1] } : reason || null);
  });
}

export function openAuth(view) { openView(view || 'in', null); }

export function signOutNow() {
  return db.signOut().then(function () { V.asked = false; toast('You’re signed out. You can still listen to everything.'); }).catch(function (x) { toast(msg(x) || 'Signing out didn’t work. Try again.'); });
}

/* "Posting as Yarne · Not you? Sign out", for the forms that write */
export function postingAs() {
  if (!A.user || !A.name) return '';
  return '<div class="acct-as"><i class="acct-av" aria-hidden="true">' + esc(A.name.charAt(0).toUpperCase()) + '</i><span>Posting as <b>' + esc(A.name) + '</b></span><button class="acct-ghost" type="button" data-acct-signout>Not you? Sign out</button></div>';
}

/* ---------- the header ---------- */
function paintHeader() {
  [].forEach.call(document.querySelectorAll('.hdr-acts'), function (acts) {
    var slot = acts.querySelector('.acct-hdr');
    if (!slot) {
      slot = document.createElement('span'); slot.className = 'acct-hdr';
      var tgl = acts.querySelector('[data-theme-toggle]');
      if (tgl) tgl.after(slot); else acts.prepend(slot);
    }
    if (!A.ready) { slot.innerHTML = ''; return; }
    if (!A.user) { slot.innerHTML = '<button class="acct-ghost" type="button" data-acct="in">Sign in</button><button class="acct-btn" type="button" data-acct="up">Sign up</button>'; return; }
    var nm = A.name || 'Pick your name';
    slot.innerHTML = '<details class="acct-me"><summary aria-label="Your account"><i class="acct-av" aria-hidden="true">' + esc((A.name || A.user.email || '?').charAt(0).toUpperCase()) + '</i><span class="acct-nm">' + esc(nm) + '</span>' + CHEVRON + '</summary>'
      + '<div class="acct-menu" role="menu"><div class="who"><b>' + esc(nm) + '</b><span>' + esc(A.user.email || '') + '</span></div>'
      + (A.name ? '' : '<button type="button" role="menuitem" data-acct="name">Pick your name</button>')
      + '<button type="button" role="menuitem" data-acct-signout>Sign out</button></div></details>';
  });
}

/* ---------- the pop-up ---------- */
function scrim() {
  var s = el('acct-scrim');
  if (!s) {
    s = document.createElement('div'); s.id = 'acct-scrim'; s.className = 'acct-scrim';
    s.setAttribute('role', 'dialog'); s.setAttribute('aria-modal', 'true'); s.setAttribute('aria-labelledby', 'acct-h');
    document.body.appendChild(s);
  }
  return s;
}

function openView(view, ctx) {
  if (!configured) { toast('Accounts need the database, which this copy of the site isn’t connected to.'); return; }
  remember();
  if (ctx !== undefined) V.ctx = ctx;
  V.view = view; V.err = ''; V.notice = '';
  V.show = true;
  render();
  scrim().classList.add('on');
  setTimeout(focusFirst, 30);
}

function close() {
  if (V.view === 'name' && A.user && !A.name) return;   // a name first (or sign out)
  remember();
  V.show = false; V.pending = []; V.ctx = null;
  stopPoll();
  var s = el('acct-scrim'); if (s) s.classList.remove('on');
}

function focusFirst() {
  var c = scrim().querySelector('[aria-invalid="true"]') || scrim().querySelector('input:not([type=hidden])') || scrim().querySelector('.acct-main');
  if (c) c.focus();
}

/* typed values survive switching views */
function remember() {
  if (el('acct-mail')) V.mail = val('acct-mail').trim();
  if (el('acct-name')) V.name = val('acct-name').trim();
}

function field(id, label, input, after) {
  return '<div class="acct-field"><label for="' + id + '">' + label + '</label>' + input + (after || '') + '</div>';
}
function mailField() {
  return field('acct-mail', 'Email', '<input id="acct-mail" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" value="' + esc(V.mail) + '">');
}
function nameField() {
  return field('acct-name', 'Your name', '<input id="acct-name" type="text" autocomplete="username" maxlength="24" spellcheck="false" placeholder="how you show up in the credits" value="' + esc(V.name) + '" aria-describedby="acct-name-hint">',
    '<p class="acct-hint" id="acct-name-hint" aria-live="polite"></p><div class="acct-sugg" id="acct-sugg"></div>');
}
function passField(isNew) {
  var lab = isNew ? '<label for="acct-pass">Password</label>'
    : '<div class="acct-lab"><label for="acct-pass">Password</label><button class="acct-ghost" type="button" data-acct="forgot">Forgot your password?</button></div>';
  return '<div class="acct-field">' + lab + '<div class="acct-pass"><input id="acct-pass" type="password" autocomplete="' + (isNew ? 'new-password' : 'current-password') + '"' + (isNew ? ' aria-describedby="acct-pass-hint"' : '') + '><button class="acct-ghost" type="button" data-acct-show aria-pressed="false">Show</button></div>'
    + (isNew ? '<p class="acct-hint" id="acct-pass-hint">At least 8 characters.</p>' : '') + '</div>';
}
function google() {
  return '<button class="acct-btn acct-wide" type="button" data-acct-google><span class="acct-g" aria-hidden="true">G</span> Continue with Google</button><div class="acct-or">or with your email</div>';
}
function tabs() {
  var up = V.view === 'up';
  return '<div class="acct-top"><div class="acct-tabs" role="tablist" aria-label="Sign up or sign in">'
    + '<button type="button" role="tab" aria-selected="' + up + '" data-acct="up">Sign up</button>'
    + '<button type="button" role="tab" aria-selected="' + !up + '" data-acct="in">Sign in</button></div>'
    + '<button class="acct-ghost" type="button" data-acct-close>Close</button></div>';
}
function closeOnly() { return '<div class="acct-top end"><button class="acct-ghost" type="button" data-acct-close>Close</button></div>'; }
function head(h, sub) { return '<div class="acct-head"><h3 id="acct-h">' + h + '</h3>' + (sub ? '<p class="acct-sub">' + sub + '</p>' : '') + '</div>'; }
function jamCard() {
  var j = V.ctx && V.ctx.jam;
  return j ? '<div class="acct-jam"><div><b>' + esc(j.title) + '</b><span>' + esc(j.meta || '') + '</span></div></div>' : '';
}
function errBox() { return '<p class="acct-err" id="acct-err" role="alert">' + V.err + '</p>'; }

function render() {
  var v = V.view, h = '';
  if (v === 'up') {
    h = '<form class="acct-card" id="acct-form" novalidate>' + (V.ctx ? closeOnly() + jamCard() + head(esc(V.ctx.heading), esc(V.ctx.text)) : tabs() + head('Join Stakkato', 'Start jams, play along with others, and keep your name on every take.'))
      + google() + nameField() + mailField() + passField(true) + errBox()
      + '<button class="acct-main acct-go" type="submit" id="acct-go">Create my account</button>'
      + '<p class="acct-legal">We email you a link to check it’s really you. Read how we handle your takes in <a href="/privacy">Privacy &amp; rights</a>.</p>'
      + '<p class="acct-switch">Already have an account? <button class="acct-link" type="button" data-acct="in">Sign in</button></p></form>';
  } else if (v === 'in') {
    h = '<form class="acct-card" id="acct-form" novalidate>' + tabs() + head('Welcome back', 'Sign in to keep playing where you left off.')
      + google() + mailField() + passField(false) + errBox()
      + (V.notice === 'unconfirmed' ? '<div class="acct-warn"><span><b>Confirm your email first.</b> We sent a link to ' + esc(V.mail) + ' when you signed up.</span><button class="acct-btn" type="button" data-acct-resend>Send the link again</button></div>' : '')
      + '<button class="acct-main acct-go" type="submit" id="acct-go">Sign in</button>'
      + '<p class="acct-switch">New here? <button class="acct-link" type="button" data-acct="up">Sign up</button></p></form>';
  } else if (v === 'check') {
    h = '<div class="acct-card">' + closeOnly() + '<div class="acct-icon">' + MAIL + '</div>'
      + head('Check your email', 'We sent a link to <b>' + esc(V.mail) + '</b>. Click it to finish signing up.')
      + '<p class="acct-sub">Keep this tab open. Once you’ve clicked the link, you carry on right here.</p>'
      + '<div class="acct-wait" aria-live="polite"><span aria-hidden="true"></span>Waiting for you to click the link…</div>'
      + '<div class="acct-row"><button class="acct-btn" type="button" id="acct-resend" data-acct-resend disabled>Send it again</button><button class="acct-ghost" type="button" data-acct="up" data-acct-other>Use another email</button></div>'
      + errBox()
      + '<p class="acct-small">Can’t find it? Look in your spam folder. It comes from noreply@stakkato.app.</p></div>';
  } else if (v === 'forgot') {
    h = '<form class="acct-card" id="acct-form" novalidate><div class="acct-top"><button class="acct-ghost" type="button" data-acct="in">← Back to sign in</button><button class="acct-ghost" type="button" data-acct-close>Close</button></div>'
      + head('Forgot your password?', 'Fill in your email and we’ll send you a link to set a new one.')
      + (V.notice === 'sent'
        ? '<div class="acct-note"><b>If there’s an account for this email, the link is on its way.</b><span>It works once, for an hour. Look in your spam folder if it doesn’t show up.</span></div>'
        : mailField() + errBox() + '<button class="acct-main acct-go" type="submit" id="acct-go">Email me a link</button>')
      + '</form>';
  } else if (v === 'name') {
    var email = A.user && A.user.email;
    h = '<form class="acct-card" id="acct-form" novalidate>'
      + (email ? '<p class="acct-small">Signed in with Google as <b>' + esc(email) + '</b></p>' : '')
      + head('One more thing: your name', 'It’s how you show up in the credits, on every take and on your profile. Pick carefully: it stays the same once you’ve picked it.')
      + nameField() + errBox()
      + '<button class="acct-main acct-go" type="submit" id="acct-go">Save my name</button>'
      + '<p class="acct-small" style="text-align:center">You can’t start jams or post takes until you’ve picked a name.</p>'
      + '<p class="acct-switch"><button class="acct-link" type="button" data-acct-signout>Sign out</button></p></form>';
  }
  scrim().innerHTML = h;
  if (v === 'check') { tickCool(); startPoll(); } else stopPoll();
  if ((v === 'up' || v === 'name') && V.name) checkName(true);
}

/* ---------- the name check, live ---------- */
function hints() {
  var m = (A.user && A.user.user_metadata) || {};
  return [m.full_name, m.name].filter(Boolean);
}
function paintName(name, res) {
  var hint = el('acct-name-hint'), sugg = el('acct-sugg'), input = el('acct-name');
  if (!hint) return;
  hint.className = 'acct-hint'; sugg.innerHTML = '';
  if (input) input.removeAttribute('aria-invalid');
  if (!res) { hint.innerHTML = ''; return; }
  if (res.ok) { hint.innerHTML = TICK + '<span><b>' + esc(name) + ' is free.</b> Your profile: stakkato.app/u/' + esc(name.toLowerCase()) + '</span>'; return; }
  hint.classList.add('bad'); if (input) input.setAttribute('aria-invalid', 'true');
  var after = V.view === 'name' ? ' How about one of these?' : ' Pick another name, or one of these:';
  var list = res.suggestions || [];
  if (res.reason === 'invalid') hint.textContent = NAME_RULE;
  else if (res.reason === 'reserved') hint.textContent = name + ' is kept for Stakkato itself.' + (list.length ? after : ' Pick another name.');
  else hint.textContent = 'Someone already plays as ' + name + '.' + (list.length ? after : ' Pick another name.');
  sugg.innerHTML = list.map(function (s) { return '<button type="button" data-acct-sugg="' + esc(s) + '">' + esc(s) + '</button>'; }).join('');
}
/* now = check without waiting (on blur, on submit); returns a promise of the result */
function checkName(now) {
  var name = val('acct-name').trim(), seq = ++V.checkSeq;
  clearTimeout(V.checkT);
  if (!name) { paintName(name, null); V.check = null; return Promise.resolve(null); }
  if (!NAME_RE.test(name)) {
    var res = { ok: false, reason: 'invalid', suggestions: [] };
    // while typing, a short name isn't wrong yet
    if (now || /[^A-Za-z0-9._-]/.test(name) || name.length > 24) paintName(name, res); else paintName(name, null);
    V.check = { name: name, res: res };
    return Promise.resolve(res);
  }
  if (V.check && V.check.name === name && V.check.res) { paintName(name, V.check.res); return Promise.resolve(V.check.res); }
  var p = new Promise(function (resolve) {
    V.checkT = setTimeout(function () {
      db.usernameCheck(name, hints()).then(function (r) {
        if (seq === V.checkSeq) { V.check = { name: name, res: r }; paintName(name, r); }
        resolve(r);
      }).catch(function (e) { console.error(e); resolve(null); });
    }, now ? 0 : 350);
  });
  return p;
}

/* ---------- waiting for the email link ---------- */
function startCool() { V.cool = 60; tickCool(); }
function tickCool() {
  clearTimeout(V.coolT);
  var b = el('acct-resend');
  if (!b) return;
  if (V.cool > 0) {
    b.disabled = true; b.textContent = 'Send it again in 0:' + String(V.cool).padStart(2, '0');
    V.coolT = setTimeout(function () { V.cool--; tickCool(); }, 1000);
  } else { b.disabled = false; b.textContent = 'Send it again'; }
}
/* the link opens in another tab, which stores the session; this tab notices here
   (Supabase also tells other tabs itself, this covers browsers where that doesn't arrive) */
function startPoll() {
  stopPoll();
  V.poll = setInterval(function () {
    db.ensureUser().then(function (u) { if (u && (!A.user || A.user.id !== u.id)) setUser(u); }).catch(function () {});
  }, 3000);
}
function stopPoll() { clearInterval(V.poll); V.poll = 0; }

/* where to go back to after clicking the link in the email */
function saveReturn() {
  var p = location.pathname + location.search.replace(/[?&]auth=[^&]*/g, '').replace(/^&/, '?');
  try { localStorage.setItem(RETURN_KEY, JSON.stringify({ path: p, at: Date.now() })); } catch (e) {}
}
function takeReturn() {
  try {
    var r = JSON.parse(localStorage.getItem(RETURN_KEY) || 'null');
    localStorage.removeItem(RETURN_KEY);
    if (r && r.path && r.path.charAt(0) === '/' && r.path.charAt(1) !== '/' && Date.now() - r.at < 864e5) return r.path;
  } catch (e) {}
  return null;
}

/* ---------- submitting ---------- */
function setErr(html) { V.err = html; var e = el('acct-err'); if (e) e.innerHTML = html; }
function busy(on) { var b = el('acct-go'); if (b) b.disabled = on; }

function passHint(bad) {
  var n = val('acct-pass').length, h = el('acct-pass-hint');
  if (!h) return;
  h.className = 'acct-hint' + (bad && n < 8 ? ' bad' : '');
  h.innerHTML = 'At least 8 characters.' + (n > 0 && n < 8 ? ' <b>' + (8 - n) + ' more to go.</b>' : '');
}

function submitUp() {
  remember();
  var mail = V.mail, pass = val('acct-pass'), name = V.name;
  setErr(''); el('acct-mail').removeAttribute('aria-invalid');
  checkName(true).then(function (res) {
    if (!name) { paintName('', null); setErr('Fill in your name: it’s how you show up in the credits.'); el('acct-name').focus(); return; }
    if (res && !res.ok) { el('acct-name').focus(); return; }
    if (!MAIL_RE.test(mail)) { el('acct-mail').setAttribute('aria-invalid', 'true'); setErr('That email doesn’t look right.'); el('acct-mail').focus(); return; }
    if (pass.length < 8) { passHint(true); el('acct-pass').focus(); return; }
    busy(true);
    saveReturn();
    db.signUp(mail, pass, name).then(function (data) {
      // with "Confirm email" on, an email that already has an account comes back without identities
      if (data.user && data.user.identities && !data.user.identities.length) return mailTaken();
      if (data.session) return setUser(data.session.user);
      V.view = 'check'; V.err = ''; startCool(); render();
    }).catch(function (x) {
      var m = msg(x);
      if (/already (been )?registered|already exists/i.test(m)) mailTaken();
      else if (/database error|username_/i.test(m)) { V.check = null; checkName(true).then(function () { el('acct-name').focus(); }); }
      else if (/password/i.test(m)) { passHint(true); setErr(esc(m)); }
      else if (/rate limit|security purposes|too many/i.test(m)) setErr('That’s a lot of tries in a row. Wait a minute, then try again.');
      else setErr(esc(m || 'Signing up didn’t work. Try again in a moment.'));
    }).then(function () { busy(false); });
  });
}
function mailTaken() {
  var i = el('acct-mail'); if (i) i.setAttribute('aria-invalid', 'true');
  setErr('There’s already an account with this email. <button class="acct-link" type="button" data-acct="in">Sign in</button> instead, or <button class="acct-link" type="button" data-acct="forgot">reset your password</button>.');
}

function submitIn() {
  remember();
  var mail = V.mail, pass = val('acct-pass');
  setErr('');
  if (!MAIL_RE.test(mail)) { setErr('That email doesn’t look right.'); el('acct-mail').focus(); return; }
  if (!pass) { setErr('Fill in your password.'); el('acct-pass').focus(); return; }
  busy(true);
  db.signInWithEmail(mail, pass).then(function (u) {
    return setUser(u).then(function () { if (A.name) toast('Welcome back, ' + A.name + '.'); });
  }).catch(function (x) {
    var m = msg(x);
    if (/not confirmed/i.test(m)) { V.notice = 'unconfirmed'; render(); el('acct-pass').value = pass; }
    else if (/invalid/i.test(m)) setErr('That email and password don’t match an account. Check them, or reset your password.');
    else if (/rate limit|too many/i.test(m)) setErr('That’s a lot of tries in a row. Wait a minute, then try again.');
    else setErr(esc(m || 'Signing in didn’t work. Try again in a moment.'));
  }).then(function () { busy(false); });
}

function submitForgot() {
  remember();
  if (!MAIL_RE.test(V.mail)) { setErr('That email doesn’t look right.'); el('acct-mail').focus(); return; }
  busy(true);
  db.requestReset(V.mail).then(function () { V.notice = 'sent'; render(); }).catch(function (x) {
    var m = msg(x);
    setErr(/rate limit|security purposes|too many/i.test(m) ? 'We just sent one. Wait a minute before asking for another.' : esc(m || 'That didn’t work. Try again in a moment.'));
  }).then(function () { busy(false); });
}

function submitName() {
  remember();
  var name = V.name;
  setErr('');
  checkName(true).then(function (res) {
    if (!name) { setErr('Fill in your name: it’s how you show up in the credits.'); el('acct-name').focus(); return; }
    if (res && !res.ok) { el('acct-name').focus(); return; }
    busy(true);
    db.pickUsername(name).then(function (picked) {
      return setUser(A.user).then(function () { toast('You’re ' + picked + ' on Stakkato now.'); });
    }).catch(function (x) { V.check = null; checkName(true); setErr(esc(msg(x) || 'That didn’t work. Try again.')); }).then(function () { busy(false); });
  });
}

function resend() {
  remember();
  var mail = V.mail;
  if (!MAIL_RE.test(mail)) { setErr('Fill in your email first.'); return; }
  db.resendConfirmation(mail).then(function () {
    if (V.view !== 'check') { V.view = 'check'; V.err = ''; render(); }
    startCool(); toast('We sent the link again.');
  }).catch(function (x) {
    var m = msg(x);
    setErr(/rate limit|security purposes|too many/i.test(m) ? 'We just sent one. Wait a minute before asking for another.' : esc(m || 'Sending it again didn’t work. Try again in a moment.'));
  });
}

/* ---------- events ---------- */
document.addEventListener('click', function (e) {
  var t = e.target.closest && e.target.closest('[data-acct], [data-acct-close], [data-acct-signout], [data-acct-google], [data-acct-show], [data-acct-sugg], [data-acct-resend]');
  if (!t) {
    if (e.target.id === 'acct-scrim' && V.view !== 'name') close();
    // a click outside the account menu folds it
    [].forEach.call(document.querySelectorAll('.acct-me[open]'), function (d) { if (!d.contains(e.target)) d.open = false; });
    return;
  }
  if (t.hasAttribute('data-acct')) {
    e.preventDefault();
    var v = t.getAttribute('data-acct');
    var d = t.closest('.acct-me'); if (d) d.open = false;
    if (t.hasAttribute('data-acct-other')) V.mail = '';
    // the tabs and links inside the pop-up keep its reason; the header starts afresh
    openView(v, scrim().contains(t) ? undefined : null);
    return;
  }
  if (t.hasAttribute('data-acct-close')) { close(); return; }
  if (t.hasAttribute('data-acct-signout')) {
    var dd = t.closest('.acct-me'); if (dd) dd.open = false;
    if (V.show) { V.pending = []; V.show = false; scrim().classList.remove('on'); }
    signOutNow();
    return;
  }
  if (t.hasAttribute('data-acct-google')) {
    t.disabled = true;
    saveReturn();
    db.signInWithGoogle().catch(function (x) { t.disabled = false; setErr(esc(msg(x) || 'Google didn’t answer. Try again, or use your email.')); });
    return;
  }
  if (t.hasAttribute('data-acct-show')) {
    var input = t.parentNode.querySelector('input'), shown = input.type === 'password';
    input.type = shown ? 'text' : 'password';
    t.textContent = shown ? 'Hide' : 'Show'; t.setAttribute('aria-pressed', String(shown));
    return;
  }
  if (t.hasAttribute('data-acct-sugg')) { el('acct-name').value = t.getAttribute('data-acct-sugg'); checkName(true); el('acct-name').focus(); return; }
  if (t.hasAttribute('data-acct-resend')) { resend(); return; }
});
document.addEventListener('input', function (e) {
  if (e.target.id === 'acct-name') checkName(false);
  else if (e.target.id === 'acct-pass' && el('acct-pass-hint')) passHint(false);
});
document.addEventListener('focusout', function (e) { if (e.target.id === 'acct-name' && V.show) checkName(true); });
document.addEventListener('submit', function (e) {
  if (e.target.id !== 'acct-form') return;
  e.preventDefault();
  if (V.view === 'up') submitUp();
  else if (V.view === 'in') submitIn();
  else if (V.view === 'forgot') submitForgot();
  else if (V.view === 'name') submitName();
});
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && V.show) close(); });
window.addEventListener('focus', function () { if (V.view === 'check' && V.show) db.ensureUser().then(function (u) { if (u) setUser(u); }).catch(function () {}); });

/* ---------- start ---------- */
function cleanUrl(drop) {
  var q = new URLSearchParams(location.search);
  drop.forEach(function (k) { q.delete(k); });
  var s = q.toString();
  history.replaceState(history.state, '', location.pathname + (s ? '?' + s : '') + (/error_description/.test(location.hash) ? '' : location.hash));
}

function start() {
  var q = new URLSearchParams(location.search), flag = q.get('auth');
  paintHeader();

  // an email link the gate couldn't check (npm run dev, or no Supabase variables on Cloudflare)
  if (location.pathname === '/auth/confirm') {
    var th = q.get('token_hash'), type = q.get('type') || 'signup';
    history.replaceState(null, '', '/');
    if (th) {
      return db.verifyLink(th, type).then(function () {
        if (type === 'recovery') { location.replace('/reset'); return; }
        return arrive();
      }).catch(function () { openExpired(type); return db.ensureUser().then(setUser); });
    }
  }
    // supabase-js takes the session out of the hash (and clears it) before ensureUser() answers
  if (flag === 'confirmed') return db.ensureUser().then(function () { cleanUrl(['auth', 'type']); return arrive(); });
  if (flag === 'expired') { var ty = q.get('type'); cleanUrl(['auth', 'type']); openExpired(ty); }
  if (flag === 'forgot') { cleanUrl(['auth']); openView('forgot', null); }
  if (flag === 'password') { cleanUrl(['auth']); toast('Your new password is saved. You’re signed in.'); }
  if (/error_description=/.test(location.hash)) {
    var err = new URLSearchParams(location.hash.slice(1)).get('error_description');
    cleanUrl([]);
    setTimeout(function () { openView('in', null); setErr(esc(err || 'Signing in didn’t work.') + ' Try again, or use your email.'); }, 0);
  }
  return db.ensureUser().then(setUser);
}

/* signed in from the email link: back to where they signed up, or welcome here */
function arrive() {
  return db.ensureUser().then(function (u) {
    var back = takeReturn(), here = location.pathname + location.search;
    if (u && back && back !== here) { location.replace(back); return; }
    return setUser(u).then(function () { if (A.name) toast('You’re in. Welcome to Stakkato, ' + A.name + '.'); });
  });
}

function openExpired(type) {
  setTimeout(function () {
    if (type === 'recovery') { openView('forgot', null); setErr('That link has expired or was already used. Ask for a new one here.'); }
    else { openView('in', null); setErr('That link has expired or was already used. Sign in, and if your email isn’t confirmed yet we’ll offer to send a new one.'); }
  }, 0);
}

if (configured) {
  start().catch(function (e) { console.error(e); A.ready = true; paintHeader(); subs.forEach(function (fn) { fn(null, null); }); });
  db.onAuthChange(function (u, ev) {
    if (ev === 'INITIAL_SESSION' || ev === 'TOKEN_REFRESHED' || ev === 'PASSWORD_RECOVERY') return;
    if (!A.ready) return;
    if ((A.user && A.user.id) !== (u && !u.is_anonymous ? u.id : null) || ev === 'USER_UPDATED') setUser(u);
  });
} else {
  A.ready = true;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paintHeader); else paintHeader();
}

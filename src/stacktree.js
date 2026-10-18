/* The stack view: a jam's thread drawn as a tree of stacks, shared by the homepage and the
   project. The original track is the root; every take is a node that hangs on the take it was
   played on, so a path from the root to a node is a stack, and where two people played on the
   same take the tree branches. A node's dots are the instruments in its stack (the newest one
   bigger); clicking a node plays that stack. The pages build the nodes from their own data
   and handle the clicks through the attributes they pass in.

   A node: { title (html, escaped by the page), sub (html), dots: [css colours], attrs: the
   button's data attributes, on: it plays now, here: it is on the path you hear, song: it is in
   the song, wait: it waits for the creator, root, gone: a deleted take others played on,
   kids: [nodes] } */

import './stacktree.css';

var KEY = 'stackato:tview';
export function savedView() { try { return localStorage.getItem(KEY) === 'stacks' ? 'stacks' : 'thread'; } catch (e) { return 'thread'; } }
export function rememberView(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }

/* "Thread | Stacks": the same replies, as a conversation or as a tree */
export function viewToggle(cur) {
  return '<div class="tview" role="group" aria-label="How to show the replies">' +
    '<button type="button" data-tview="thread" aria-pressed="' + (cur !== 'stacks') + '">Thread</button>' +
    '<button type="button" data-tview="stacks" aria-pressed="' + (cur === 'stacks') + '">Stacks</button></div>';
}

export function stackTree(roots, hint) {
  if (!roots.length) return '';
  return '<div class="stree-wrap"><ul class="stree" role="list">' + roots.map(item).join('') + '</ul></div>' +
    (hint ? '<p class="stree-hint">' + hint + '</p>' : '');
}
function item(n) {
  var ks = n.kids || [];
  return '<li' + (n.here ? ' class="here"' : '') + '>' + card(n) + (ks.length ? '<ul role="list">' + ks.map(item).join('') + '</ul>' : '') + '</li>';
}
function card(n) {
  var cls = 'sn' + (n.root ? ' root' : '') + (n.on ? ' on' : '') + (n.here ? ' here' : '') + (n.song ? ' song' : '');
  if (n.gone) return '<span class="sn gone">' + (n.title || 'Deleted take') + '</span>';
  var dots = n.dots || [];
  return '<button class="' + cls + '" type="button" ' + (n.attrs || '') + ' aria-pressed="' + !!n.on + '">' +
    '<span class="sn-top"><span class="sn-dots" aria-hidden="true">' + dots.map(function (c, i) {
      return '<i' + (i === dots.length - 1 && !n.root ? ' class="new"' : '') + ' style="background:' + c + '"></i>';
    }).join('') + '</span><span class="sn-play" aria-hidden="true">' + (n.on ? '&#10074;&#10074;' : '&#9654;') + '</span></span>' +
    '<span class="sn-t">' + n.title + '</span>' + (n.sub ? '<small>' + n.sub + '</small>' : '') +
    (n.song ? '<em class="sn-tag">In the song</em>' : n.wait ? '<em class="sn-tag wait">To review</em>' : '') + '</button>';
}

/* Amps for DI guitar: real amp captures run by Neural Amp Modeler (NAM, compiled to
   WebAssembly and run in an AudioWorklet), into a real speaker cabinet impulse response,
   with a little room on the clean amp. The take itself stays dry; the amp is only heard
   on playback, so it can be changed or switched off any time.

   A NAM model is heavy (a WaveNet per sample), and every AudioWorklet in a page shares one
   audio thread, so takes are not run through the amp live. renderAmp() renders a take
   through its amp once, in an OfflineAudioContext (its own thread, faster than real
   time), and the app plays the result. Only hearing yourself while recording runs the
   amp live (liveAmp()), one instance.

   The captures, cabinets and room are in public/amps/, with their credits and licences
   (public/amps/CREDITS.md). */

import { NamNode } from '@happysoftware/nam-web';
import namWorkletUrl from '@happysoftware/nam-web/worklet?url';
import namWasmUrl from 'nam-web-dist/nam-wasm.wasm?url';

export var AMPS = [
  { id:'clean',  label:'Clean',  long:'Clean: a Fender Twin Reverb into a 2x12, with a little room' },
  { id:'crunch', label:'Crunch', long:'Crunch: a Marshall JCM2000 on the edge, into a vintage 4x12' },
  { id:'metal',  label:'Metal',  long:'Metal: a boosted Peavey 6505+ for modern metal, into a 4x12, with a noise gate' }
];
export function ampLabel(id) {
  var a = AMPS.filter(function (x) { return x.id === id; })[0];
  return a ? a.label : 'Off';
}

/* model and cabinet files in public/amps, the EQ after the cabinet (type, Hz, Q, dB),
   a noise gate for the high gain amp, the room level, and the level for live monitoring */
var BASE = '/amps/';
var P = {
  clean:  { model:'clean.nam',  cab:'cab-clean.wav',  eq:[['highpass', 80, .7], ['lowshelf', 250, 0, -6], ['peaking', 340, .9, -5], ['highshelf', 3500, 0, -3]], room:.05, live:20 },
  crunch: { model:'crunch.nam', cab:'cab-crunch.wav', eq:[['highpass', 90, .7], ['lowshelf', 250, 0, -9], ['peaking', 3000, 1, -3]], live:.7 },
  metal:  { model:'metal.nam',  cab:'cab-metal.wav',  eq:[['highpass', 95, .8], ['lowshelf', 220, 0, -5]], gate:{ open:.0045, closed:.0018 }, live:.9 }
};
/* the DI's loudest moment goes into the amp at this level, like a guitar into a real input */
var DI_PEAK = .35;
/* a rendered take is brought to this loudness (RMS of its louder half), peaks kept below .9 */
var OUT_RMS = .1;
var SR = 48000; /* the captures' own rate: no resampling, no added latency */

/* ---------- loading: every file once per page ---------- */
var FILES = {};
function bytes(name) {
  if (!FILES[name]) FILES[name] = fetch(name).then(function (r) {
    if (!r.ok) throw new Error('Could not load ' + name + ' (' + r.status + ')');
    return r.arrayBuffer();
  }).catch(function (e) { delete FILES[name]; throw e; });
  return FILES[name].then(function (b) { return b.slice(0); });
}
/* fetch everything an amp needs ahead of time, so the first render doesn't wait on it */
export function preloadAmp(id) {
  var p = P[id];
  if (!p) return Promise.resolve();
  return Promise.all([bytes(namWasmUrl), bytes(BASE + p.model), bytes(BASE + p.cab), p.room ? bytes(BASE + 'room.wav') : null]).catch(function () {});
}
function decoded(ctx, name) {
  var key = '__amp:' + name;
  if (!ctx[key]) ctx[key] = bytes(name).then(function (b) { return ctx.decodeAudioData(b); });
  return ctx[key];
}
function worklet(ctx) {
  if (!ctx.__namWorklet) ctx.__namWorklet = ctx.audioWorklet.addModule(namWorkletUrl);
  return ctx.__namWorklet;
}
/* a NAM node with the model loaded */
function namNode(ctx, id) {
  return Promise.all([worklet(ctx), bytes(namWasmUrl), bytes(BASE + P[id].model)]).then(function (r) {
    var node = new AudioWorkletNode(ctx, 'nam-processor', {
      numberOfInputs:1, numberOfOutputs:1, outputChannelCount:[1],
      processorOptions:{ wasmBinary:r[1], initialModel:r[2], quantum:128 }
    });
    var nam = new NamNode(node);
    return new Promise(function (resolve, reject) {
      var off = nam.on(function (e) {
        if (e.type === 'loaded') { off(); resolve(nam); }
        else if (e.type === 'error') { off(); reject(new Error(e.message)); }
      });
    });
  });
}

/* ---------- the parts around the model, all plain Web Audio nodes ---------- */
function biquad(ctx, f) {
  var b = ctx.createBiquadFilter();
  b.type = f[0]; b.frequency.value = f[1];
  if (f[0] === 'lowshelf' || f[0] === 'highshelf') b.gain.value = f[3];
  else { b.Q.value = f[2]; if (f[0] === 'peaking') b.gain.value = f[3]; }
  return b;
}
var GATES = {}, ABS = null;
/* the gate's gain for an envelope value: shut below `closed`, open above `open` */
function gateCurve(g) {
  var key = g.open + ':' + g.closed;
  if (GATES[key]) return GATES[key];
  var n = 65536, c = new Float32Array(n);
  for (var i = 0; i < n; i++) {
    var x = i / (n - 1) * 2 - 1, u = Math.max(0, Math.min(1, (x - g.closed) / (g.open - g.closed)));
    c[i] = u * u * (3 - 2 * u);
  }
  return (GATES[key] = c);
}
function absCurve() {
  if (ABS) return ABS;
  var n = 4097; ABS = new Float32Array(n);
  for (var i = 0; i < n; i++) ABS[i] = Math.abs(i / (n - 1) * 2 - 1);
  return ABS;
}
/* Builds input -> [gate] -> NAM -> cabinet -> EQ -> output (+ room) in ctx, once the model
   and the impulse responses are ready. Returns the nodes right away; until then the input
   goes nowhere (silence, never the raw DI). */
function chain(ctx, id, inGain) {
  var p = P[id], nodes = [], input = ctx.createGain(), output = ctx.createGain();
  function add(n) { nodes.push(n); return n; }
  nodes.push(input, output);
  input.gain.value = inGain;
  var ready = Promise.all([namNode(ctx, id), decoded(ctx, BASE + p.cab), p.room ? decoded(ctx, BASE + 'room.wav') : null]).then(function (r) {
    var nam = r[0], last = input;
    nodes.push(nam.node);
    if (p.gate) {
      /* the envelope of the input drives the gate's gain: |x| -> smoothing -> gate curve */
      var g = add(ctx.createGain()); g.gain.value = 0;
      var rect = add(ctx.createWaveShaper()); rect.curve = absCurve();
      var env = add(ctx.createBiquadFilter()); env.type = 'lowpass'; env.frequency.value = 40; env.Q.value = .6;
      var shape = add(ctx.createWaveShaper()); shape.curve = gateCurve(p.gate);
      input.connect(rect); rect.connect(env); env.connect(shape); shape.connect(g.gain);
      input.connect(g); last = g;
    }
    last.connect(nam.node);
    var cab = add(ctx.createConvolver());
    cab.normalize = false; cab.buffer = r[1];
    nam.node.connect(cab); last = cab;
    p.eq.forEach(function (f) { var b = add(biquad(ctx, f)); last.connect(b); last = b; });
    last.connect(output);
    if (r[2]) {
      var room = add(ctx.createConvolver()), wet = add(ctx.createGain());
      room.normalize = false; room.buffer = r[2]; wet.gain.value = p.room;
      last.connect(room); room.connect(wet); wet.connect(output);
    }
  });
  return { input:input, output:output, nodes:nodes, ready:ready };
}

/* ---------- rendering a take through an amp ---------- */
function peakOf(buf) {
  var m = 0;
  for (var c = 0; c < buf.numberOfChannels; c++) {
    var d = buf.getChannelData(c);
    for (var i = 0; i < d.length; i++) { var v = d[i] < 0 ? -d[i] : d[i]; if (v > m) m = v; }
  }
  return m;
}
/* bring a rendered take to a steady loudness: RMS over the louder half of 50 ms windows */
function level(buf) {
  var n = buf.length, ch = buf.numberOfChannels, w = Math.round(buf.sampleRate * .05), rms = [], i, c;
  for (var s = 0; s + w <= n; s += w) {
    var e = 0;
    for (c = 0; c < ch; c++) { var d = buf.getChannelData(c); for (i = s; i < s + w; i++) e += d[i] * d[i]; }
    rms.push(e / (w * ch));
  }
  rms.sort(function (a, b) { return b - a; });
  var top = rms.slice(0, Math.max(1, Math.ceil(rms.length / 2))), mean = 0;
  top.forEach(function (v) { mean += v; });
  mean = Math.sqrt(mean / top.length);
  if (!(mean > 1e-6)) return buf;
  var k = Math.min(OUT_RMS / mean, .9 / (peakOf(buf) || 1));
  for (c = 0; c < ch; c++) { var x = buf.getChannelData(c); for (i = 0; i < n; i++) x[i] *= k; }
  return buf;
}
/* one render at a time: each runs on its own thread, but several at once would compete */
var queue = Promise.resolve();
/* Renders buf (the dry take) through amp id. Resolves with a new AudioBuffer of the same
   length (stereo when the amp has a room), at a steady loudness. */
export function renderAmp(buf, id) {
  if (!P[id]) return Promise.reject(new Error('Unknown amp ' + id));
  var job = queue.then(function () {
    var len = Math.max(1, Math.ceil(buf.duration * SR));
    var oc = new OfflineAudioContext(P[id].room ? 2 : 1, len, SR);
    var pk = peakOf(buf);
    var amp = chain(oc, id, pk > 1e-4 ? DI_PEAK / pk : 1);
    return amp.ready.then(function () {
      var src = oc.createBufferSource();
      src.buffer = buf;
      src.connect(amp.input); amp.output.connect(oc.destination);
      src.start(0);
      return oc.startRendering();
    }).then(level);
  });
  queue = job.catch(function () {});
  return job;
}

/* ---------- live, for hearing yourself while recording ---------- */
/* An amp in a running AudioContext: { input, output, nodes, ready }. Give the peak of what
   goes in when it is known (a finished take); a live input goes in as it is. It is silent
   for the moment it takes to load the first time. */
export function liveAmp(ctx, id, peak) {
  if (!P[id]) return null;
  var a = chain(ctx, id, peak > 1e-4 ? DI_PEAK / peak : 1);
  a.output.gain.value = P[id].live;
  a.ready.catch(function (e) { console.warn('The amp could not load', e); });
  return a;
}
export function dropAmp(a) {
  if (!a) return;
  a.nodes.forEach(function (n) { try { n.disconnect(); } catch (e) {} });
}

/* Amp sims for DI guitar (and anything else that wants one), built from plain Web Audio
   nodes so they run in every browser and need nothing loaded: a gate, a boost/pre-EQ, one
   or two clipping stages (oversampled WaveShapers), a tone stack, a speaker cabinet made of
   filters, and a short room. The take itself stays dry; the amp is only heard on playback,
   so it can be changed or switched off at any time.

   buildAmp(ctx, id, level) returns { input, output, nodes } or null for 'off'.
   level is the take's peak (0..1): the input is scaled so the amp reacts the same whether
   the DI was recorded hot or quiet. Leave it out for a live input. */

export var AMPS = [
  { id:'clean',  label:'Clean',  long:'Clean: sparkly, a little compressed, with some room' },
  { id:'crunch', label:'Crunch', long:'Crunch: an amp on the edge of breaking up, classic rock' },
  { id:'metal',  label:'Metal',  long:'Metal: tight, boosted high gain for modern metal, with a noise gate' }
];
export function ampLabel(id) {
  var a = AMPS.filter(function (x) { return x.id === id; })[0];
  return a ? a.label : 'Off';
}

/* f: filter type, q: Q, g: gain in dB */
var P = {
  clean: {
    comp: { th:-26, ratio:3, knee:10, att:.004, rel:.18 },
    pre: [['highpass', 70, .7]],
    stages: [{ k:1.6, bias:0, gain:1 }],
    tone: [['lowshelf', 140, 0, 2], ['peaking', 450, .8, -2.5], ['highshelf', 3200, 0, 3.5]],
    cab: [['highpass', 75, .7], ['peaking', 160, 1, 2], ['peaking', 2400, 1.2, 1.5], ['lowpass', 7200, .8], ['lowpass', 9500, .5]],
    room: .2, out: .6
  },
  crunch: {
    pre: [['highpass', 90, .7], ['peaking', 900, .7, 3]],
    stages: [{ k:3.2, bias:.12, gain:1, lp:7000 }, { k:2.4, bias:.05, gain:1 }],
    tone: [['lowshelf', 150, 0, 1], ['peaking', 650, .9, 2], ['highshelf', 3000, 0, 2]],
    cab: [['highpass', 85, .8], ['peaking', 120, 1, 3], ['peaking', 420, 1, -2.5], ['peaking', 2600, 1.2, 3], ['lowpass', 5200, .9], ['lowpass', 6500, .6]],
    room: .11, out: .3
  },
  metal: {
    gate: { open:.0045, closed:.0018 },
    pre: [['highpass', 180, .7], ['peaking', 760, .8, 7], ['lowpass', 6500, .7]],
    stages: [{ k:9, bias:0, gain:1, hp:110, lp:5600 }, { k:5, bias:.08, gain:1 }],
    tone: [['lowshelf', 100, 0, 3.5], ['peaking', 480, 1, -3.5], ['highshelf', 3200, 0, 2.5]],
    cab: [['highpass', 90, 1], ['peaking', 110, 1.1, 3], ['peaking', 400, 1, -3], ['peaking', 2800, 1.3, 4], ['lowpass', 5000, 1], ['lowpass', 6000, .7]],
    room: .05, out: .16
  }
};

function biquad(ctx, f) {
  var b = ctx.createBiquadFilter();
  b.type = f[0]; b.frequency.value = f[1];
  if (f[0] === 'lowshelf' || f[0] === 'highshelf') b.gain.value = f[3];
  else { b.Q.value = f[2]; if (f[0] === 'peaking') b.gain.value = f[3]; }
  return b;
}
/* tanh clipping; a bias makes it asymmetric like a tube (even harmonics), and the curve is
   shifted so silence stays silence */
var CURVES = {};
function curve(k, bias) {
  var key = k + ':' + bias;
  if (CURVES[key]) return CURVES[key];
  var n = 4096, c = new Float32Array(n), off = Math.tanh(k * bias), max = 0, i, x;
  for (i = 0; i < n; i++) { x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * (x + bias)) - off; if (Math.abs(c[i]) > max) max = Math.abs(c[i]); }
  for (i = 0; i < n; i++) c[i] /= max;
  return (CURVES[key] = c);
}
/* the gate's gain for an envelope value: shut below `closed`, open above `open` */
var GATES = {};
function gateCurve(g) {
  var key = g.open + ':' + g.closed;
  if (GATES[key]) return GATES[key];
  var n = 65536, c = new Float32Array(n);
  for (var i = 0; i < n; i++) {
    var x = i / (n - 1) * 2 - 1, u = (x - g.closed) / (g.open - g.closed);
    u = Math.max(0, Math.min(1, u));
    c[i] = u * u * (3 - 2 * u);
  }
  return (GATES[key] = c);
}
var ABS = null;
function absCurve() {
  if (ABS) return ABS;
  var n = 4097; ABS = new Float32Array(n);
  for (var i = 0; i < n; i++) ABS[i] = Math.abs(i / (n - 1) * 2 - 1);
  return ABS;
}
/* a small room: decaying stereo noise, darker as it fades, made once per context */
function roomIR(ctx) {
  if (ctx.__ampRoom) return ctx.__ampRoom;
  var sr = ctx.sampleRate, len = Math.round(sr * 1.3), pre = Math.round(sr * .012);
  var b = ctx.createBuffer(2, len, sr);
  for (var ch = 0; ch < 2; ch++) {
    var d = b.getChannelData(ch), lp = 0;
    for (var i = pre; i < len; i++) {
      var t = (i - pre) / sr, a = .25 + .7 * Math.min(1, t / .6);
      lp += (Math.random() * 2 - 1 - lp) * (1 - a);
      d[i] = lp * Math.exp(-t * 4.2);
    }
  }
  return (ctx.__ampRoom = b);
}

export function buildAmp(ctx, id, level) {
  var p = P[id];
  if (!p) return null;
  var nodes = [], input = ctx.createGain();
  function add(n) { nodes.push(n); return n; }
  nodes.push(input);
  /* DI in: bring the loudest moment to about half scale */
  input.gain.value = level ? Math.max(.5, Math.min(30, .5 / level)) : 1.6;
  var last = input;
  function chain(n) { last.connect(n); last = n; return n; }

  if (p.gate) {
    /* the envelope of the input drives the gate's gain: |x| -> smoothing -> gate curve */
    var g = add(ctx.createGain()); g.gain.value = 0;
    var rect = add(ctx.createWaveShaper()); rect.curve = absCurve();
    var env = add(ctx.createBiquadFilter()); env.type = 'lowpass'; env.frequency.value = 40; env.Q.value = .6;
    var shape = add(ctx.createWaveShaper()); shape.curve = gateCurve(p.gate);
    last.connect(rect); rect.connect(env); env.connect(shape); shape.connect(g.gain);
    chain(g);
  }
  if (p.comp) {
    var c = add(ctx.createDynamicsCompressor());
    c.threshold.value = p.comp.th; c.ratio.value = p.comp.ratio; c.knee.value = p.comp.knee;
    c.attack.value = p.comp.att; c.release.value = p.comp.rel;
    chain(c);
  }
  p.pre.forEach(function (f) { chain(add(biquad(ctx, f))); });
  p.stages.forEach(function (s) {
    if (s.gain !== 1) { var sg = add(ctx.createGain()); sg.gain.value = s.gain; chain(sg); }
    var ws = add(ctx.createWaveShaper());
    ws.curve = curve(s.k, s.bias); ws.oversample = '4x';
    chain(ws);
    if (s.hp) chain(add(biquad(ctx, ['highpass', s.hp, .7])));
    if (s.lp) chain(add(biquad(ctx, ['lowpass', s.lp, .7])));
  });
  p.tone.forEach(function (f) { chain(add(biquad(ctx, f))); });
  p.cab.forEach(function (f) { chain(add(biquad(ctx, f))); });

  var output = add(ctx.createGain());
  output.gain.value = p.out;
  last.connect(output);
  if (p.room) {
    var conv = add(ctx.createConvolver()), wet = add(ctx.createGain());
    conv.buffer = roomIR(ctx); wet.gain.value = p.room;
    last.connect(conv); conv.connect(wet); wet.connect(output);
  }
  return { input:input, output:output, nodes:nodes };
}

export function dropAmp(a) {
  if (!a) return;
  a.nodes.forEach(function (n) { try { n.disconnect(); } catch (e) {} });
}

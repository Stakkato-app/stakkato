/* Recording, shared by the song view (app.js) and the reply pop-up on the homepage (home.js).
   Everything here is independent of either page's state: the microphone and its worklet, the
   click, finding the click in a take, lining the blocks up into one take, the per-browser
   settings (input, amp, "Hear yourself") and the notes shown about a finished take.
   The pages keep their own screens and their own audio graph around it. */

import { liveAmp, dropAmp } from './amp.js';

/* ---------- per-browser settings (the keys keep the old product name on purpose) ---------- */
var MIC_KEY = 'stackato:mic', AMP_KEY = 'stackato:amp', MON_KEY = 'stackato:monitor';
/* only guitar-like layers go through an amp */
export var AMP_ROLES = ['guitar', 'lead', 'bass'];
function get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
function put(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} }
export function savedMic() { return get(MIC_KEY); }
export function rememberMic(id) { put(MIC_KEY, id); }
export function savedAmp() { return get(AMP_KEY); }
export function rememberAmp(id) { put(AMP_KEY, id); }
export function savedMon() { return get(MON_KEY) === '1'; }
export function rememberMon(on) { try { localStorage.setItem(MON_KEY, on ? '1' : '0'); } catch (e) {} }
/* the amp a recording for this layer gets: only guitar-like layers use one */
export function recAmpFor(roleId) { return AMP_ROLES.indexOf(roleId) > -1 ? savedAmp() : ''; }

/* ---------- the audio context ----------
   Asks for the smallest buffer the device allows (latencyHint 0; the browser clamps it to its
   minimum) instead of the default, so "Hear yourself" answers a little faster. Browsers that
   don't take options get the default. The sample rate stays the device's own: forcing 48 kHz on
   a 44.1 kHz device would only move the resampling to the output, with no time saved. */
export function newContext() {
  var C = window.AudioContext || window.webkitAudioContext;
  try { return new C({ latencyHint:0 }); } catch (e) { return new C(); }
}
/* The amps are captured at 48 kHz; at 44.1 kHz the live amp resamples, which costs a few ms. */
export function rateTip(a) {
  return a && a.sampleRate && a.sampleRate !== 48000
    ? 'Your audio runs at ' + (a.sampleRate / 1000).toFixed(1).replace(/\.0$/, '') + ' kHz. Set your interface (and your computer’s sound settings) to 48 kHz and the amp answers a few ms faster.'
    : '';
}

/* ---------- the microphone ---------- */
/* Captured by an AudioWorklet (off the page's main thread, so redrawing the page can't make it
   drop audio). Browsers without it fall back to ScriptProcessorNode. The worklet hands over
   blocks of 2048 samples with the context time of their first sample. */
var REC_WORKLET = "class StakkatoRec extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(2048);this.n=0;this.t=0}" +
  "process(inputs){var ch=inputs[0]&&inputs[0][0];if(!ch)return true;for(var i=0;i<ch.length;i++){if(this.n===0)this.t=currentTime+i/sampleRate;" +
  "this.b[this.n++]=ch[i];if(this.n===this.b.length){this.port.postMessage({t:this.t,d:this.b},[this.b.buffer]);this.b=new Float32Array(2048);this.n=0}}return true}}" +
  "registerProcessor('stackato-rec',StakkatoRec);";
export function recWorklet(a) {
  if (!a.audioWorklet || typeof AudioWorkletNode === 'undefined') return Promise.reject(new Error('no worklet'));
  if (!a.__stackatoRec) {
    var url = URL.createObjectURL(new Blob([REC_WORKLET], { type:'application/javascript' }));
    a.__stackatoRec = a.audioWorklet.addModule(url);
  }
  return a.__stackatoRec;
}
/* the chosen input, without any of the browser's voice processing */
export function openMic() {
  var base = { echoCancellation:false, noiseSuppression:false, autoGainControl:false };
  var id = savedMic();
  var want = id ? Object.assign({ deviceId:{ exact:id } }, base) : base;
  return navigator.mediaDevices.getUserMedia({ audio:want }).catch(function (err) {
    /* the chosen input is gone: forget it and use the default */
    if (id && err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) { rememberMic(''); return navigator.mediaDevices.getUserMedia({ audio:base }); }
    throw err;
  });
}
/* The input list; labels only show once the browser has been allowed to use a microphone. */
export function listMics() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return Promise.resolve([]);
  return navigator.mediaDevices.enumerateDevices().then(function (list) {
    return list.filter(function (d) { return d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications'; })
      .map(function (d) { return { id:d.deviceId, label:d.label }; });
  }).catch(function () { return []; });
}
/* Starts capturing `stream` in context `a`. Every block goes to onChunk(samples, time, sampleRate).
   Returns the nodes to disconnect afterwards, and `src` for anything else that wants the input. */
export function capture(a, stream, useWorklet, onChunk) {
  var src = a.createMediaStreamSource(stream);
  var sink = a.createGain(); sink.gain.value = 0;
  if (useWorklet) {
    var node = new AudioWorkletNode(a, 'stackato-rec', { numberOfInputs:1, numberOfOutputs:1, channelCount:1, channelCountMode:'explicit' });
    node.port.onmessage = function (e) { onChunk(e.data.d, e.data.t, a.sampleRate); };
    src.connect(node); node.connect(sink); sink.connect(a.destination);
    return { src:src, nodes:[src, node, sink] };
  }
  var proc = a.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = function (e) {
    var d = e.inputBuffer.getChannelData(0);
    onChunk(new Float32Array(d), e.playbackTime - d.length / e.inputBuffer.sampleRate, e.inputBuffer.sampleRate);
  };
  src.connect(proc); proc.connect(sink); sink.connect(a.destination);
  return { src:src, nodes:[src, proc, sink] };
}
/* ---------- "Hear yourself": the input armed, like a track in a DAW ----------
   Ticking it opens the input right away and plays it to `dest` (through the amp when one is
   given), so you hear yourself before and while you record. It stays on until it is unticked
   or disarmed; a recording takes its own stream next to it, so nothing is heard twice. */
var MON = null;
export function monitorOn() { return !!MON; }
export function armMonitor(a, ampId, dest) {
  disarmMonitor();
  var me = { nodes:[], stream:null };
  MON = me;
  a.resume();
  return openMic().then(function (stream) {
    if (MON !== me) { stream.getTracks().forEach(function (tr) { tr.stop(); }); return; }
    me.stream = stream;
    var src = a.createMediaStreamSource(stream), la = ampId ? liveAmp(a, ampId, 0) : null;
    me.nodes.push(src);
    if (la) { src.connect(la.input); la.output.connect(dest); me.nodes.push({ disconnect:function () { dropAmp(la); } }); }
    else src.connect(dest);
  }, function (err) { if (MON === me) MON = null; throw err; });
}
export function disarmMonitor() {
  var m = MON; MON = null;
  if (!m) return;
  m.nodes.forEach(function (n) { try { n.disconnect(); } catch (e) {} });
  if (m.stream) m.stream.getTracks().forEach(function (tr) { tr.stop(); });
}
/* asks for the microphone once, so the browser tells us the names of the inputs */
export function allowInputs() {
  return navigator.mediaDevices.getUserMedia({ audio:true }).then(function (s) { s.getTracks().forEach(function (tr) { tr.stop(); }); return listMics(); });
}

/* the input's own delay, where the browser reports it */
export function inputLatency(stream) {
  var ts = stream.getAudioTracks()[0], st = ts && ts.getSettings ? ts.getSettings() : {};
  return typeof st.latency === 'number' && st.latency > 0 && st.latency < 0.5 ? st.latency : 0;
}
/* peak of a block, and eight sub-peaks for drawing the take finely while it comes in */
export function blockPeaks(d) {
  var pk = 0, i;
  for (i = 0; i < d.length; i++) { var v = Math.abs(d[i]); if (v > pk) pk = v; }
  var pks = [], seg = Math.ceil(d.length / 8);
  for (var q = 0; q < 8; q++) { var m = 0; for (var k = q * seg; k < Math.min(d.length, (q + 1) * seg); k++) { var u = Math.abs(d[k]); if (u > m) m = u; } pks.push(m); }
  return { peak:pk, pks:pks };
}

/* ---------- the click ---------- */
/* beats per bar, seconds per beat and per bar for a tempo and a time signature */
export function beatInfoFor(bpm, time) {
  var sig = time === 'odd' || !time ? '4/4' : time, p = sig.split('/');
  var beats = +p[0] || 4, unit = +p[1] || 4, tempo = bpm || 120;
  var beat = (60 / tempo) * (4 / unit);
  return { beats:beats, beat:beat, bar:beats * beat };
}
/* click samples: count-in bars first, then the song, accent on every bar's first beat */
export function clickSamples(sr, countBars, songSec, b) {
  var total = countBars * b.bar + songSec + 0.05;
  var out = new Float32Array(Math.ceil(total * sr)), blip = Math.round(0.045 * sr);
  var nBeats = Math.ceil((countBars * b.bar + songSec) / b.beat);
  for (var k = 0; k < nBeats; k++) {
    var at = Math.round(k * b.beat * sr), first = k % b.beats === 0, counting = k < countBars * b.beats;
    var f = first ? (counting ? 1760 : 1500) : 1000, amp = first ? 0.9 : 0.55;
    for (var i = 0; i < blip && at + i < out.length; i++)
      out[at + i] += amp * Math.sin(2 * Math.PI * f * i / sr) * Math.exp(-i / (sr * 0.012));
  }
  return out;
}
/* Looks for the click in a recording. The count-in bars are the place to look: nobody plays
   there yet, so anything shaped like a click is the click. Returns how many samples late it is
   and how loud, or null when the click isn't in there. */
export function findClick(all, sr, countIn, len, b) {
  var ref = clickSamples(sr, countIn, len, b), T = Math.round(0.02 * sr);
  var beats = [], k;
  var nCount = countIn * b.beats;
  for (k = 0; k < Math.min(nCount, 8); k++) beats.push(Math.round(k * b.beat * sr));
  var quiet = beats.length >= 3;
  if (!quiet) for (k = nCount; beats.length < 8 && k * b.beat < countIn * b.bar + len - 0.5; k++) beats.push(Math.round(k * b.beat * sr));
  if (beats.length < 3) return null;
  var lo = -Math.round(0.03 * sr), hi = Math.round(0.3 * sr);
  /* running energy of the recording, for normalised correlation */
  var e2 = new Float64Array(all.length + 1);
  for (var i = 0; i < all.length; i++) e2[i + 1] = e2[i] + all[i] * all[i];
  var lags = [], gains = [];
  /* the window starts a little before each click: the silence there is what pins the onset
     (a click is a short sine, so without it every period of the sine would fit) */
  var P = Math.round(0.008 * sr);
  beats.forEach(function (at0) {
    var at = Math.max(0, at0 - P), c = ref.subarray(at, at + T + P), cc = 0, W = c.length;
    for (var j = 0; j < W; j++) cc += c[j] * c[j];
    if (!cc) return;
    var best = 0, bestLag = 0, bestDot = 0;
    for (var L = lo; L <= hi; L++) {
      var p = at + L;
      if (p < 0 || p + W > all.length) continue;
      var xx = e2[p + W] - e2[p];
      if (xx < 1e-9) continue;
      var dot = 0;
      for (var m = 0; m < W; m++) dot += all[p + m] * c[m];
      var r = dot / Math.sqrt(xx * cc);
      if (r > best) { best = r; bestLag = L; bestDot = dot; }
    }
    if (best > (quiet ? 0.6 : 0.75)) { lags.push(bestLag); gains.push(bestDot / cc); }
  });
  if (lags.length < Math.ceil(beats.length * 0.75)) return null;
  var sorted = lags.slice().sort(function (x, y) { return x - y; }), lag = sorted[sorted.length >> 1];
  if (lags.filter(function (l) { return Math.abs(l - lag) <= Math.round(0.002 * sr); }).length < Math.ceil(beats.length * 0.75)) return null;
  var g = gains.slice().sort(function (x, y) { return x - y; })[gains.length >> 1];
  /* how much is left on the count-in beats once it's taken out: next to nothing for a click
     that came back digitally, more for one picked up by a microphone */
  var before = 0, after = 0;
  beats.slice(0, quiet ? beats.length : 0).forEach(function (at) {
    for (var j = 0; j < T * 2; j++) {
      var p = at + lag + j; if (p < 0 || p >= all.length) continue;
      var x = all[p], y = x - g * (ref[at + j] || 0);
      before += x * x; after += y * y;
    }
  });
  return { lag:lag, gain:g, clean: quiet ? after < before * 0.05 : false };
}

/* ---------- from blocks to one take ---------- */
/* Blocks are laid back to back, sample-exact: only the first block's timestamp places the take
   (timestamps jitter a little, and placing every block by its own left tiny gaps and overlaps
   you could hear). If a block really went missing, the next one resyncs to its time.
     o.chunks    the blocks: { t, d }
     o.sr        sample rate
     o.t0        context time of the first count-in click
     o.songStart context time of bar 1
     o.lat       output + base + input latency, in seconds
     o.len       how long the take is, in seconds
     o.countIn   count-in bars
     o.click     the click was playing (so it may have got into the recording)
     o.beat      beatInfoFor() of the song
   Returns { out, bleed }: the take starting exactly at bar 1, and what was found of the click
   (with the click taken out and the take lined up by it). */
export function assembleTake(o) {
  var sr = o.sr, preN = Math.round((o.songStart - o.t0) * sr), from = o.t0 + o.lat;
  /* everything from the first count-in click on, plus some room to line the take up later */
  var room = Math.round(0.4 * sr);
  var all = new Float32Array(preN + Math.round(o.len * sr) + room), cursor = null;
  o.chunks.forEach(function (c) {
    var at = Math.round((c.t - from) * sr);
    if (cursor === null || Math.abs(at - cursor) > c.d.length) cursor = at;
    for (var i = 0; i < c.d.length; i++) { var j = cursor + i; if (j >= 0 && j < all.length) all[j] = c.d[i]; }
    cursor += c.d.length;
  });
  /* If the click got into the recording (speakers, or an interface that sends the computer's
     sound back in), it shows exactly how late the recording runs: line the take up by it and
     take the click back out. */
  var shift = 0, bleed = o.click ? findClick(all, sr, o.countIn, o.len, o.beat) : null;
  if (bleed) {
    shift = bleed.lag;
    var ref = clickSamples(sr, o.countIn, o.len + 0.4, o.beat);
    for (var q = 0; q < all.length - shift && q < ref.length; q++) if (q + shift >= 0) all[q + shift] -= bleed.gain * ref[q];
  }
  var from0 = Math.max(0, preN + shift);
  return { out: all.slice(from0, from0 + Math.round(o.len * sr)), bleed: bleed };
}

/* ---------- what to tell about a finished take ---------- */
export function bleedNote(bleed) {
  return 'The click was in your recording' + (bleed.clean ? '' : ' (some of it may still be audible)') + ', so your input also picks up the computer’s sound. ' +
    'We took it out and lined the take up with the beat. To keep it out next time, wear headphones and turn off the computer’s sound on the input you record from (Quad Cortex: don’t send USB playback to USB 1/2).';
}
/* a very quiet take usually means the wrong input or channel (a DI channel, for one);
   a dry guitar through one of our amps is fine quiet: the amp brings it up */
export function quietNote(peak, amped, roleId) {
  if (!(peak > 0 && peak < (amped ? 0.004 : 0.06))) return '';
  return 'This came in very quiet (peak ' + Math.round(20 * Math.log10(peak)) + ' dB). On an interface with many channels, like a Quad Cortex, ' +
    'the browser records the first channel, which is often the dry DI. Send your processed sound there (Quad Cortex: I/O settings, DRY/WET for USB 1/2) or pick another input.' +
    (amped || AMP_ROLES.indexOf(roleId) < 0 ? '' : ' If it is a dry guitar on purpose, pick an amp for it.');
}
export function micError(err) {
  return (err && err.name === 'NotAllowedError')
    ? 'The microphone was blocked. Allow it in your browser, or upload a file instead.'
    : 'No microphone could be opened here. Upload a file instead.';
}

/* ---------- a take as a wav file ---------- */
export function encodeWav(buf) {
  var ch = buf.numberOfChannels, sr = buf.sampleRate, n = buf.length;
  var dv = new DataView(new ArrayBuffer(44 + n * ch * 2));
  function str(o, s){ for (var i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); }
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * ch * 2, true); dv.setUint16(32, ch * 2, true);
  dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, n * ch * 2, true);
  var data = []; for (var c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  var o = 44;
  for (var i = 0; i < n; i++) for (var c2 = 0; c2 < ch; c2++) {
    var v = Math.max(-1, Math.min(1, data[c2][i]));
    dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7FFF, true); o += 2;
  }
  return new Blob([dv.buffer], { type:'audio/wav' });
}

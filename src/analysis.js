/* Tempo and key detection. Runs entirely in the browser with Web Audio, no server.
   Carried over unchanged from the original artifact, apart from the exports. */

export var PCS = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  var KS_MAJ = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
  var KS_MIN = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
  var actx = null;
  function ctx() {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    return actx;
  }

  function fft(re, im) {
    var n = re.length, i, j = 0, k, m, t, ur, ui, wr, wi, tr, ti, step, half, ang;
    for (i = 1; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (step = 2; step <= n; step <<= 1) {
      half = step >> 1; ang = -2 * Math.PI / step;
      wr = Math.cos(ang); wi = Math.sin(ang);
      for (i = 0; i < n; i += step) {
        ur = 1; ui = 0;
        for (k = 0; k < half; k++) {
          m = i + k + half;
          tr = re[m] * ur - im[m] * ui;
          ti = re[m] * ui + im[m] * ur;
          re[m] = re[i + k] - tr; im[m] = im[i + k] - ti;
          re[i + k] += tr; im[i + k] += ti;
          t = ur * wr - ui * wi; ui = ur * wi + ui * wr; ur = t;
        }
      }
    }
  }

  function pearson(a, b) {
    var n = a.length, ma = 0, mb = 0, i;
    for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    var num = 0, da = 0, db = 0;
    for (i = 0; i < n; i++) {
      var x = a[i] - ma, y = b[i] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    return (da && db) ? num / Math.sqrt(da * db) : 0;
  }

  function detectTempo(mono, sr) {
    var hop = 256, win = 1024, frames = Math.floor((mono.length - win) / hop);
    if (frames < 40) return null;
    var env = new Float32Array(frames), i, k, s;
    for (i = 0; i < frames; i++) {
      s = 0;
      for (k = 0; k < win; k++) { var v = mono[i * hop + k]; s += v * v; }
      env[i] = Math.sqrt(s / win);
    }
    var flux = new Float32Array(frames);
    for (i = 1; i < frames; i++) flux[i] = Math.max(0, env[i] - env[i - 1]);
    var mean = 0;
    for (i = 0; i < frames; i++) mean += flux[i];
    mean /= frames;
    for (i = 0; i < frames; i++) flux[i] = Math.max(0, flux[i] - mean);

    var fps = sr / hop;
    var minLag = Math.floor(fps * 60 / 200), maxLag = Math.ceil(fps * 60 / 60);
    var best = 0, bestLag = 0, lag, all = 0, cnt = 0;
    for (lag = minLag; lag <= maxLag && lag < frames; lag++) {
      var sum = 0;
      for (i = 0; i + lag < frames; i++) sum += flux[i] * flux[i + lag];
      sum /= (frames - lag);
      all += sum; cnt++;
      if (sum > best) { best = sum; bestLag = lag; }
    }
    if (!bestLag || !cnt) return null;
    var bpm = 60 * fps / bestLag;
    while (bpm < 70) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    var avg = all / cnt;
    var conf = avg > 0 ? Math.max(0, Math.min(1, (best / avg - 1) / 3)) : 0;
    return { bpm: Math.round(bpm), conf: conf };
  }

  function detectKey(mono, sr) {
    var N = 4096, hop = 2048, chroma = new Float32Array(12);
    var frames = Math.floor((mono.length - N) / hop);
    if (frames < 4) return null;
    var win = new Float32Array(N), i;
    for (i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    var re = new Float32Array(N), im = new Float32Array(N);
    for (var f = 0; f < frames; f++) {
      for (i = 0; i < N; i++) { re[i] = mono[f * hop + i] * win[i]; im[i] = 0; }
      fft(re, im);
      for (var k = 2; k < N / 2; k++) {
        var freq = k * sr / N;
        if (freq < 65 || freq > 2100) continue;
        var mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        if (mag <= 0) continue;
        var pc = Math.round(69 + 12 * Math.log2(freq / 440)) % 12;
        if (pc < 0) pc += 12;
        chroma[pc] += mag;
      }
    }
    var total = 0;
    for (i = 0; i < 12; i++) total += chroma[i];
    if (!total) return null;
    for (i = 0; i < 12; i++) chroma[i] /= total;

    var results = [];
    for (var r = 0; r < 12; r++) {
      var rot = [];
      for (i = 0; i < 12; i++) rot.push(chroma[(i + r) % 12]);
      results.push({ name: PCS[r] + ' maj', score: pearson(rot, KS_MAJ) });
      results.push({ name: PCS[r] + ' min', score: pearson(rot, KS_MIN) });
    }
    results.sort(function (a, b) { return b.score - a.score; });
    var gap = results[0].score - results[1].score;
    return { key: results[0].name, conf: Math.max(0, Math.min(1, gap * 4)), runnerUp: results[1].name };
  }

  function analyse(file) {
    return file.arrayBuffer().then(function (buf) {
      return ctx().decodeAudioData(buf);
    }).then(function (ab) {
      var src = ab.getChannelData(0), sr = ab.sampleRate;
      if (ab.numberOfChannels > 1) {
        var b = ab.getChannelData(1), mix = new Float32Array(src.length);
        for (var i = 0; i < src.length; i++) mix[i] = (src[i] + b[i]) / 2;
        src = mix;
      }
      var factor = Math.max(1, Math.round(sr / 22050));
      var len = Math.floor(Math.min(src.length, sr * 45) / factor);
      var mono = new Float32Array(len);
      for (var j = 0; j < len; j++) mono[j] = src[j * factor];
      var lowSr = sr / factor;
      return { tempo: detectTempo(mono, lowSr), key: detectKey(mono, lowSr), dur: ab.duration };
    });
  }

  function sureness(c) { return c > .35 ? 'fairly sure' : (c > .15 ? 'not certain' : 'a wild guess'); }

export { analyse, sureness };

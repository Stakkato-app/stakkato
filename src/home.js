/* The landing page (/home). The project feed is the open sessions in Supabase
   (read-only and without sign-in: sessions and takes are readable by everyone under
   RLS). The centred card loads its project -- the original track plus every layer in
   the project -- draws the real waveform and plays it once the visitor turns sound on.
   Only the centred card downloads audio, so swiping through the feed stays light. */

import { configured } from './supabase.js';
import * as db from './data.js';
import { ROLES, role } from './roles.js';

(function(){
  var ICON = {
    layers:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 8l10 5 10-5-10-5z"/><path d="m2 13 10 5 10-5"/></svg>',
    mute:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9v6h4l5 5V4L9 9H5z"/><line x1="17.5" y1="8.5" x2="21.5" y2="15.5"/><line x1="21.5" y1="8.5" x2="17.5" y2="15.5"/></svg>',
    unmute:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9v6h4l5 5V4L9 9H5z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a8 8 0 0 1 0 11"/></svg>'
  };
  var BARS = 46;
  var INSTRUMENTS = ROLES.map(function(r){ return r.id; });

  var carousel = document.getElementById('carousel');
  var dotsWrap = document.getElementById('dots');
  var feedEmpty = document.getElementById('feedEmpty');
  var feedControls = document.getElementById('feedControls');
  var toastEl = document.getElementById('toast');
  var soundBtn = document.getElementById('soundToggle');

  var PROJECTS = [], cards = [], dots = [];

  function esc(t){ return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  /* ---------- sessions -> feed cards ---------- */

  function songName(s){
    var by = s.seed && s.seed.author_name;
    if (s.title && s.title !== 'Untitled') return s.title;
    return by ? by + '’s track' : 'Untitled';
  }
  function byOrder(a, b){ return INSTRUMENTS.indexOf(a) - INSTRUMENTS.indexOf(b); }

  function toProject(s){
    /* layers in the project on the original track (layers on a new part are left out
       of the preview, which loops the original track's length) */
    var layers = (s.layers || []).filter(function(t){
      return t.status === 'in' && !t.section_id && INSTRUMENTS.indexOf(t.role_id) >= 0;
    });
    var has = [];
    if (s.seed_role && INSTRUMENTS.indexOf(s.seed_role) >= 0) has.push(s.seed_role);
    layers.forEach(function(t){ if (has.indexOf(t.role_id) < 0) has.push(t.role_id); });
    has.sort(byOrder);
    /* every instrument has open slots, so "still needs" = instruments nobody plays yet */
    var needs = INSTRUMENTS.filter(function(id){ return id !== 'wild' && has.indexOf(id) < 0; }).slice(0, 3);
    var people = {};
    if (s.seed && s.seed.author_name) people[s.seed.author_name] = 1;
    layers.forEach(function(t){ people[t.author_name] = 1; });
    var lead = s.seed_role || has[0];
    return {
      slug: s.slug,
      title: songName(s),
      by: s.seed && s.seed.author_name,
      bpm: s.bpm, key: s.music_key,
      has: has, needs: needs,
      layers: layers.length,
      people: Object.keys(people).length,
      accent: lead && role(lead) ? 'var(' + role(lead).color + ')' : 'var(--ember)',
      dur: s.seed ? s.seed.duration_sec : 8,
      urls: [s.seed.storage_path].concat(layers.map(function(t){ return t.storage_path; })).map(db.publicUrl),
      bufs: null, peaks: null, load: null, failed: false
    };
  }

  /* placeholder waveform until the real one is decoded: a stable shape per title */
  function seeded(n){ var x = Math.sin(n) * 10000; return x - Math.floor(x); }
  function placeholderHeights(p){
    var seed = 0, out = [];
    for (var c = 0; c < p.title.length; c++) seed += p.title.charCodeAt(c) * (c + 1);
    for (var i = 0; i < BARS; i++) {
      var swell = 0.5 + 0.5 * Math.sin(i / BARS * Math.PI * 2.4 + (seed % 7));
      out.push(Math.min(100, Math.max(12, 16 + swell * 54 + seeded(seed + i * 12.9898) * 26)));
    }
    return out;
  }
  function barsHtml(heights){
    return heights.map(function(h){ return '<i style="height:' + h.toFixed(0) + '%"></i>'; }).join('');
  }
  function chip(id){
    var r = role(id);
    return '<span class="chip" style="--c:var(' + r.color + ')"><span class="dot"></span>' + esc(r.label) + '</span>';
  }

  function cardHtml(p){
    var facts = [];
    if (p.bpm) facts.push(p.bpm + ' BPM');
    if (p.key) facts.push(esc(p.key));
    var bars = barsHtml(placeholderHeights(p));
    return '<div class="card-stage">' +
        '<span class="now-playing"><span class="dot"></span><span class="np-label">Playing</span></span>' +
        '<button class="sound-ico" data-mute-toggle aria-label="Sound">' + ICON.mute + '</button>' +
        '<div class="viz" style="--cycle:' + Math.max(1, p.dur).toFixed(2) + 's">' +
          '<div class="wf-bars wf-muted">' + bars + '</div>' +
          '<div class="wf-progress"><div class="wf-bars">' + bars + '</div></div>' +
          '<div class="wf-playhead"></div>' +
        '</div>' +
      '</div>' +
      '<div class="card-body">' +
        '<h3>&ldquo;' + esc(p.title) + '&rdquo;</h3>' +
        '<div class="byline">' + (p.by ? 'by <b>' + esc(p.by) + '</b>' : 'Original track') +
          (facts.length ? ' · <span class="tabular">' + facts.join(' · ') + '</span>' : '') + '</div>' +
        (p.needs.length ? '<div class="needs">Still needs: ' + p.needs.map(function(id){ return esc(role(id).label); }).join(', ') + '</div>' : '') +
        '<div class="chips"><span class="has-label">Has</span>' +
          (p.has.length ? p.has.map(chip).join('') : '<span class="chip" style="--c:var(--ember)"><span class="dot"></span>Original track</span>') +
        '</div>' +
        '<div class="card-foot">' +
          '<span class="likes tabular">' + ICON.layers +
            (p.layers ? p.layers + ' layer' + (p.layers > 1 ? 's' : '') + ' in' : 'Be the first layer') + '</span>' +
          '<a class="btn btn-sm" href="/s/' + encodeURIComponent(p.slug) + '">Join this project</a>' +
        '</div>' +
      '</div>';
  }

  function renderFeed(){
    carousel.innerHTML = ''; dotsWrap.innerHTML = '';
    PROJECTS.forEach(function(p, i){
      var card = document.createElement('article');
      card.className = 'card';
      card.dataset.i = i;
      card.style.setProperty('--accent', p.accent);
      card.innerHTML = cardHtml(p);
      carousel.appendChild(card);
      var dot = document.createElement('button');
      dot.setAttribute('aria-label', 'Go to ' + p.title);
      dot.addEventListener('click', function(){ scrollToCard(i); });
      dotsWrap.appendChild(dot);
    });
    cards = Array.prototype.slice.call(carousel.querySelectorAll('.card'));
    dots = Array.prototype.slice.call(dotsWrap.querySelectorAll('button'));
  }

  function showEmpty(html){
    feedEmpty.innerHTML = html;
    feedEmpty.hidden = false;
    carousel.hidden = true; dotsWrap.hidden = true; feedControls.hidden = true;
  }

  function loadFeed(){
    if (!configured) {
      showEmpty('<p>The projects can’t load here: Supabase isn’t configured.</p>');
      return;
    }
    showEmpty('<p>Loading the projects…</p>');
    db.listFeed().then(function(rows){
      PROJECTS = rows.filter(function(s){ return s.seed && s.seed.storage_path; }).map(toProject);
      if (!PROJECTS.length) {
        showEmpty('<p>No open projects yet. Drop a track and start the first one.</p><a class="btn btn-ember" href="/">Start a session</a>');
        return;
      }
      feedEmpty.hidden = true;
      carousel.hidden = false; dotsWrap.hidden = false; feedControls.hidden = false;
      renderFeed();
      activeIdx = -1;
      setActive(0);
    }).catch(function(e){
      console.error(e);
      showEmpty('<p>Couldn’t load the projects. Check your connection and reload the page.</p>');
    });
  }

  /* ---------- audio: only the centred card loads and plays ---------- */
  var ctx = null, soundOn = false, activeIdx = -1, currentLoop = null;

  function ac(){ if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); return ctx; }

  function decode(ab){
    return new Promise(function(resolve, reject){
      var r = ac().decodeAudioData(ab, resolve, reject);
      if (r && r.then) r.then(resolve, reject);
    });
  }

  function loadProject(p){
    if (p.load) return p.load;
    p.load = Promise.all(p.urls.map(function(u){
      return fetch(u).then(function(r){
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }).then(decode).catch(function(e){ console.warn('Could not load', u, e); return null; });
    })).then(function(bufs){
      bufs = bufs.filter(Boolean);
      if (!bufs.length) throw new Error('no playable audio');
      p.bufs = bufs;
      p.peaks = mixPeaks(bufs);
      return p;
    }).catch(function(e){ p.failed = true; throw e; });
    return p.load;
  }

  /* the waveform of the whole project: per bucket, the loudest sample of each track, summed */
  function mixPeaks(bufs){
    var len = bufs[0].length, step = Math.max(1, Math.floor(len / BARS)), sums = [], max = 0;
    for (var i = 0; i < BARS; i++) {
      var sum = 0;
      bufs.forEach(function(b){
        var d = b.getChannelData(0), peak = 0, end = Math.min(d.length, (i + 1) * step);
        for (var j = i * step; j < end; j += 4) { var v = Math.abs(d[j]); if (v > peak) peak = v; }
        sum += peak;
      });
      sums.push(sum); if (sum > max) max = sum;
    }
    return sums.map(function(v){ return 12 + 88 * (max ? v / max : 0); });
  }

  function drawWave(i){
    var p = PROJECTS[i], card = cards[i];
    if (!p || !card || !p.peaks) return;
    var html = barsHtml(p.peaks);
    Array.prototype.forEach.call(card.querySelectorAll('.wf-bars'), function(el){ el.innerHTML = html; });
    card.querySelector('.viz').style.setProperty('--cycle', p.bufs[0].duration.toFixed(3) + 's');
  }

  function makeLoop(p){
    var a = ac(), master = a.createGain(), srcs = [];
    master.gain.value = 0;
    master.connect(a.destination);
    var level = 0.9 / Math.sqrt(p.bufs.length), loopEnd = p.bufs[0].duration;
    return {
      start: function(){
        var t = a.currentTime + 0.05;
        p.bufs.forEach(function(b){
          var s = a.createBufferSource(), g = a.createGain();
          s.buffer = b; s.loop = true; s.loopStart = 0; s.loopEnd = Math.min(loopEnd, b.duration);
          g.gain.value = level;
          s.connect(g); g.connect(master);
          s.start(t);
          srcs.push(s);
        });
        master.gain.setTargetAtTime(1, t, 0.04);
      },
      stop: function(){
        master.gain.setTargetAtTime(0, a.currentTime, 0.06);
        setTimeout(function(){
          srcs.forEach(function(s){ try { s.stop(); } catch (e) {} });
          try { master.disconnect(); } catch (e) {}
        }, 350);
      }
    };
  }

  /* restart the playhead so it lines up with the start of the loop */
  function restartPlayhead(card){
    Array.prototype.forEach.call(card.querySelectorAll('.wf-progress,.wf-playhead'), function(el){
      el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    });
  }

  function stopLoop(){
    if (currentLoop) currentLoop.stop();
    currentLoop = null;
  }

  function play(i){
    if (!soundOn || i !== activeIdx || currentLoop) return;
    var p = PROJECTS[i];
    if (!p.bufs) return;
    ac().resume();
    currentLoop = makeLoop(p);
    currentLoop.start();
    restartPlayhead(cards[i]);
  }

  function updatePlaying(){
    cards.forEach(function(c, i){
      var p = PROJECTS[i], on = soundOn && i === activeIdx;
      c.classList.toggle('playing', on && !!currentLoop);
      c.classList.toggle('waiting', on && !currentLoop);
      var label = c.querySelector('.np-label');
      if (label) label.textContent = currentLoop ? 'Playing' : p.failed ? 'No audio' : 'Loading';
    });
  }

  function setActive(idx){
    if (idx === activeIdx || !cards[idx]) return;
    cards.forEach(function(c, i){ c.classList.toggle('active', i === idx); });
    dots.forEach(function(d, i){ d.classList.toggle('on', i === idx); });
    stopLoop();
    activeIdx = idx;
    var p = PROJECTS[idx];
    loadProject(p).then(function(){
      drawWave(idx);
      play(idx);
      updatePlaying();
    }).catch(function(){ updatePlaying(); });
    play(idx);
    updatePlaying();
  }

  function centerFromScroll(){
    if (!cards.length) return;
    var rect = carousel.getBoundingClientRect(), mid = rect.left + rect.width / 2;
    var best = 0, bestD = Infinity;
    cards.forEach(function(c, i){
      var r = c.getBoundingClientRect(), cmid = r.left + r.width / 2, d = Math.abs(cmid - mid);
      if (d < bestD) { bestD = d; best = i; }
    });
    setActive(best);
  }

  var scrollTicking = false;
  carousel.addEventListener('scroll', function(){
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(function(){ centerFromScroll(); scrollTicking = false; });
  });

  function scrollToCard(i){
    if (cards[i]) cards[i].scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }
  document.getElementById('prevBtn').addEventListener('click', function(){ scrollToCard(Math.max(0, activeIdx - 1)); });
  document.getElementById('nextBtn').addEventListener('click', function(){ scrollToCard(Math.min(cards.length - 1, activeIdx + 1)); });

  /* drag-to-scroll on desktop; touch keeps native swipe + snap */
  var dragging = false, dragX = 0, dragScroll = 0, moved = false;
  carousel.addEventListener('pointerdown', function(e){
    if (e.pointerType === 'touch' || e.target.closest('a,button')) return;
    dragging = true; moved = false; dragX = e.clientX; dragScroll = carousel.scrollLeft;
    carousel.classList.add('dragging');
    carousel.setPointerCapture(e.pointerId);
  });
  carousel.addEventListener('pointermove', function(e){
    if (!dragging) return;
    var dx = e.clientX - dragX;
    if (Math.abs(dx) > 4) moved = true;
    carousel.scrollLeft = dragScroll - dx;
  });
  function endDrag(){
    if (!dragging) return;
    dragging = false; carousel.classList.remove('dragging');
    centerFromScroll();
    scrollToCard(activeIdx);
  }
  carousel.addEventListener('pointerup', endDrag);
  carousel.addEventListener('pointerleave', function(){ if (dragging) endDrag(); });

  /* sound gate: browsers only play audio after a tap */
  function enableSound(){
    if (soundOn) return;
    soundOn = true;
    ac().resume();
    soundBtn.classList.add('on');
    soundBtn.setAttribute('aria-pressed', 'true');
    soundBtn.querySelector('span').textContent = 'Sound on';
    soundBtn.querySelector('svg').outerHTML = ICON.unmute;
    updateCardIcons();
    if (activeIdx < 0) setActive(0); else play(activeIdx);
    updatePlaying();
  }
  function disableSound(){
    soundOn = false;
    stopLoop();
    updatePlaying();
    soundBtn.classList.remove('on');
    soundBtn.setAttribute('aria-pressed', 'false');
    soundBtn.querySelector('span').textContent = 'Tap for sound';
    soundBtn.querySelector('svg').outerHTML = ICON.mute;
    updateCardIcons();
  }
  function updateCardIcons(){
    cards.forEach(function(c){
      c.querySelector('[data-mute-toggle]').innerHTML = soundOn ? ICON.unmute : ICON.mute;
    });
  }
  soundBtn.addEventListener('click', function(){ soundOn ? disableSound() : enableSound(); });
  carousel.addEventListener('click', function(e){
    if (moved) { e.preventDefault(); moved = false; return; }
    var mb = e.target.closest('[data-mute-toggle]');
    if (mb) { soundOn ? disableSound() : enableSound(); return; }
    if (e.target.closest('a')) return;
    var card = e.target.closest('.card');
    if (card) scrollToCard(cards.indexOf(card));
  });

  /* start-a-session CTAs */
  var toastTimer = null;
  function showToast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.classList.remove('on'); }, 2600);
  }
  Array.prototype.slice.call(document.querySelectorAll('[data-start]')).forEach(function(b){
    b.addEventListener('click', function(){ location.href = '/'; });
  });


  /* ---------- create-your-own-song: upload a file ---------- */
  var dropzone = document.getElementById('dropzone');
  var fileInput = document.getElementById('fileInput');
  var filePreview = document.getElementById('filePreview');
  var fileViz = document.getElementById('fileViz');
  var fileName = document.getElementById('fileName');
  var dropzoneLabel = document.getElementById('dropzoneLabel');

  function miniBars(n){
    var out = '';
    for (var i = 0; i < n; i++) out += '<i style="height:' + (15 + Math.random() * 85).toFixed(0) + '%"></i>';
    return out;
  }

  function handleFile(file){
    if (!file) return;
    if (file.type && file.type.indexOf('audio') !== 0) {
      showToast('That doesn’t look like an audio file.');
      return;
    }
    dropzoneLabel.textContent = 'Reading ' + file.name + '…';
    var reader = new FileReader();
    reader.onload = function(e){
      ac().decodeAudioData(e.target.result.slice(0), function(buf){
        renderFilePeaks(buf);
        showFilePreview(file.name);
      }, function(){
        /* couldn't decode client-side; still let them use it */
        fileViz.innerHTML = miniBars(24);
        showFilePreview(file.name);
      });
    };
    reader.onerror = function(){ showToast('Couldn’t read that file — try another.'); resetDropzone(); };
    reader.readAsArrayBuffer(file);
  }
  function renderFilePeaks(buf){
    var data = buf.getChannelData(0), buckets = 24, step = Math.floor(data.length / buckets) || 1;
    var out = '';
    for (var i = 0; i < buckets; i++) {
      var peak = 0;
      for (var j = i * step; j < i * step + step && j < data.length; j++) {
        var v = Math.abs(data[j]); if (v > peak) peak = v;
      }
      out += '<i style="height:' + Math.max(10, peak * 100).toFixed(0) + '%"></i>';
    }
    fileViz.innerHTML = out;
  }
  function showFilePreview(name){
    dropzoneLabel.textContent = 'Drop an audio file here, or click to browse';
    fileName.textContent = name;
    filePreview.hidden = false;
  }
  function resetDropzone(){
    dropzoneLabel.textContent = 'Drop an audio file here, or click to browse';
  }
  dropzone.addEventListener('click', function(){ fileInput.click(); });
  dropzone.addEventListener('keydown', function(e){ if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener('change', function(){ handleFile(fileInput.files[0]); });
  ['dragover','dragenter'].forEach(function(ev){
    dropzone.addEventListener(ev, function(e){ e.preventDefault(); dropzone.classList.add('hover'); });
  });
  ['dragleave','drop'].forEach(function(ev){
    dropzone.addEventListener(ev, function(e){ e.preventDefault(); dropzone.classList.remove('hover'); });
  });
  dropzone.addEventListener('drop', function(e){
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  document.getElementById('useFileBtn').addEventListener('click', function(){
    showToast('Uploading takes you into a new Stackato session with this track dropped in.');
  });

  /* ---------- create-your-own-song: record a take, 2-bar count-in + click track ---------- */
  var bpmInput = document.getElementById('bpmInput');
  var timesigInput = document.getElementById('timesigInput');
  var recordBtn = document.getElementById('recordBtn');
  var recordStatus = document.getElementById('recordStatus');
  var recording = false, activeStream = null, activeRecorder = null;

  /* beats: clicks per bar on the click track. accentEvery: how often the accented
     (higher-pitched) click lands -- every beat for simple meters, every 3rd
     eighth-note for the compound feel of 6/8. */
  var TIME_SIGS = {
    '4/4': { beats: 4, accentEvery: 4 },
    '3/4': { beats: 3, accentEvery: 3 },
    '2/4': { beats: 2, accentEvery: 2 },
    '6/8': { beats: 6, accentEvery: 3 }
  };

  function playClick(t, accent){
    var a = ac();
    var o = a.createOscillator(), g = a.createGain();
    o.type = 'square';
    o.frequency.value = accent ? 1600 : 1000;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g); g.connect(a.destination);
    o.start(t); o.stop(t + 0.06);
  }

  function countIn(bpm, bars, sig, onBeat, onDone){
    var a = ac();
    var beat = 60 / bpm;
    var beatsPerBar = sig.beats, totalBeats = bars * beatsPerBar;
    var start = a.currentTime + 0.12;
    for (var i = 0; i < totalBeats; i++) playClick(start + i * beat, i % sig.accentEvery === 0);
    for (var j = 0; j < totalBeats; j++) {
      (function(bi){
        setTimeout(function(){ onBeat(bi); }, Math.max(0, (start + bi * beat - a.currentTime) * 1000));
      })(j);
    }
    setTimeout(onDone, Math.max(0, (start + totalBeats * beat - a.currentTime) * 1000));
  }

  function beatDotsMarkup(n){
    var out = '';
    for (var i = 0; i < n; i++) out += '<i></i>';
    return out;
  }

  function startCountdown(bpm, sigName){
    var sig = TIME_SIGS[sigName] || TIME_SIGS['4/4'];
    recordStatus.hidden = false;
    recordStatus.innerHTML = '<div class="countdown"><span class="beatdots" id="beatDots">' + beatDotsMarkup(sig.beats * 2) + '</span><span id="countLabel">Get ready…</span></div>';
    var dots = recordStatus.querySelectorAll('.beatdots i');
    var label = document.getElementById('countLabel');
    countIn(bpm, 2, sig, function(bi){
      dots.forEach(function(d, i){ d.classList.toggle('hit', i === bi); });
      label.textContent = 'Bar ' + (Math.floor(bi / sig.beats) + 1) + ', beat ' + (bi % sig.beats + 1) + ' of ' + sigName;
    }, function(){
      beginRecording();
    });
  }

  function beginRecording(){
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      recordStatus.innerHTML = '<p class="note">Recording isn’t available in this preview — try uploading a file instead.</p>';
      recordBtn.disabled = false;
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream){
      activeStream = stream;
      var chunks = [];
      var mr;
      try { mr = new MediaRecorder(stream); } catch (e) {
        recordStatus.innerHTML = '<p class="note">This browser can’t record here — try uploading a file instead.</p>';
        recordBtn.disabled = false;
        stream.getTracks().forEach(function(t){ t.stop(); });
        return;
      }
      activeRecorder = mr;
      recording = true;
      var startedAt = Date.now();
      var timerId = setInterval(function(){
        var secs = Math.floor((Date.now() - startedAt) / 1000);
        var el = document.getElementById('recTime');
        if (el) el.textContent = Math.floor(secs / 60) + ':' + (secs % 60 < 10 ? '0' : '') + (secs % 60);
      }, 250);
      recordStatus.innerHTML = '<div class="recording"><span class="dot"></span>Recording… <span id="recTime" class="tabular">0:00</span></div>' +
        '<button class="btn btn-sm" id="stopRecordBtn" type="button">Stop</button>';
      mr.ondataavailable = function(e){ if (e.data && e.data.size) chunks.push(e.data); };
      mr.onstop = function(){
        clearInterval(timerId);
        recording = false;
        stream.getTracks().forEach(function(t){ t.stop(); });
        recordStatus.innerHTML = '<div class="filepreview"><div class="viz-mini">' + miniBars(24) + '</div>' +
          '<span class="fname">Your take is ready</span>' +
          '<button class="btn btn-sm btn-ember" id="useTakeBtn" type="button">Use this take</button></div>';
        document.getElementById('useTakeBtn').addEventListener('click', function(){
          showToast('Sending this take takes you into a new Stackato session.');
        });
        recordBtn.disabled = false;
      };
      mr.start();
      document.getElementById('stopRecordBtn').addEventListener('click', function(){
        if (activeRecorder && activeRecorder.state !== 'inactive') activeRecorder.stop();
      });
    }).catch(function(){
      recordStatus.innerHTML = '<p class="note">Microphone access isn’t available in this preview — try uploading a file instead.</p>';
      recordBtn.disabled = false;
    });
  }

  recordBtn.addEventListener('click', function(){
    if (recording) return;
    ac().resume();
    var bpm = Math.max(40, Math.min(220, parseInt(bpmInput.value, 10) || 100));
    var sigName = timesigInput.value || '4/4';
    recordBtn.disabled = true;
    startCountdown(bpm, sigName);
  });

  window.addEventListener('resize', centerFromScroll);
  loadFeed();
})();

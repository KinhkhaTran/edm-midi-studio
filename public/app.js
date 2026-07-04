/* Loopsmith frontend: arrangement rendering, layered Tone.js audio with a
   mix/mastering chain, MIDI I/O, and the AI chat panel. */

const $ = (sel) => document.querySelector(sel);

const TRACK_COLORS = {
  kick: '#f5a623', snare: '#e8842c', hats: '#d9c34a', perc: '#b0893a',
  sub: '#c23b5c', bass: '#f0506e', chords: '#38b6d9', pads: '#2f7fa8',
  arp: '#58c98b', lead: '#a78bfa', counter: '#8a6fd6', fx: '#9aa0a8',
  drums: '#f5a623',
};
const DRUM_TYPES = new Set(['kick', 'snare', 'hats', 'perc', 'drums']);
const DRUM_ORDER = [49, 75, 70, 64, 63, 54, 51, 47, 46, 45, 42, 39, 38, 37, 36];
const DRUM_NAMES = {
  36: 'kick', 37: 'rim', 38: 'snare', 39: 'clap', 42: 'hat', 45: 'tom', 46: 'o-hat', 47: 'tom h',
  49: 'crash', 51: 'ride', 54: 'tamb', 63: 'conga', 64: 'conga l', 70: 'shaker', 75: 'clave',
};

let meta = null;
let state = null;
let parts = [];
let playing = false;
let audioReady = false;
let chatHistory = [];
let engine = null; // audio engine (instruments + mix bus)

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  meta = await (await fetch('/api/meta')).json();

  const genreSel = $('#genre');
  for (const [id, g] of Object.entries(meta.genres)) genreSel.add(new Option(g.label, id));
  const keySel = $('#key');
  for (const k of meta.keys) keySel.add(new Option(k, k));
  keySel.value = 'A';
  const scaleSel = $('#scale');
  for (const s of meta.scales) scaleSel.add(new Option(s, s));

  applyGenreDefaults();
  genreSel.addEventListener('change', applyGenreDefaults);
  $('#structure').addEventListener('change', () => {
    $('#bars-ctl').hidden = $('#structure').value !== 'loop';
  });

  $('#generate').addEventListener('click', () => generatePattern());
  $('#dice').addEventListener('click', () => generatePattern());
  $('#play').addEventListener('click', togglePlay);
  $('#export-all').addEventListener('click', () => exportMidi(null));
  $('#import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', importMidi);
  $('#tempo').addEventListener('change', () => {
    if (state) { state.tempo = clampTempo(); if (playing) Tone.Transport.bpm.value = state.tempo; setStatus(); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !/TEXTAREA|INPUT|SELECT/.test(document.activeElement.tagName)) {
      e.preventDefault();
      togglePlay();
    }
  });

  if (!meta.aiEnabled) {
    $('#chat-status').textContent = 'offline — set ANTHROPIC_API_KEY';
    $('#chat-text').disabled = true;
    $('#chat-send').disabled = true;
  }
  $('#render').addEventListener('click', startRender);
  if (!meta.renderEnabled) $('#render').title = 'Set REPLICATE_API_TOKEN to enable neural audio renders';
  $('#chat-form').addEventListener('submit', sendChat);
  $('#chat-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chat-form').requestSubmit(); }
  });

  requestAnimationFrame(playheadLoop);
}

function applyGenreDefaults() {
  const g = meta.genres[$('#genre').value];
  $('#tempo').value = g.bpm;
  $('#scale').value = g.scale;
}

function clampTempo() {
  return Math.max(60, Math.min(200, parseInt($('#tempo').value, 10) || 120));
}

function setStatus(msg) {
  if (msg) $('#status-left').textContent = msg;
  if (state) {
    const mins = (state.bars * 4 * 60) / state.tempo;
    const len = `${Math.floor(mins / 60)}:${String(Math.round(mins % 60)).padStart(2, '0')}`;
    $('#status-right').textContent =
      `${state.genre || 'import'} · ${state.key || '?'} ${state.scale || ''} · ${state.tempo} bpm · ${state.bars} bars (${len}) · seed ${state.seed ?? '—'}`;
  }
}

// ---------------------------------------------------------------------------
// Generation & state
// ---------------------------------------------------------------------------

async function generatePattern(tracks = null) {
  const body = {
    genre: $('#genre').value,
    key: $('#key').value,
    scale: $('#scale').value,
    tempo: clampTempo(),
    bars: parseInt($('#bars').value, 10),
    structure: $('#structure').value,
    tracks,
  };
  setStatus('composing…');
  const res = await fetch('/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const fresh = await res.json();
  if (!res.ok) { setStatus('error: ' + fresh.error); return; }

  if (tracks && state) {
    for (const nt of fresh.tracks) {
      const i = state.tracks.findIndex(t => t.id === nt.id);
      if (i >= 0) state.tracks[i] = nt; else state.tracks.push(nt);
    }
    state.seed = fresh.seed;
    setState(state);
  } else {
    setState(fresh);
  }
  setStatus(tracks ? `regenerated ${tracks.join(', ')}` : 'composed');
}

function setState(next) {
  state = next;
  $('#tempo').value = state.tempo;
  if (state.genre && meta.genres[state.genre]) $('#genre').value = state.genre;
  if (state.key) $('#key').value = state.key;
  if (state.scale && meta.scales.includes(state.scale)) $('#scale').value = state.scale;
  if (state.structure) {
    $('#structure').value = state.structure;
    $('#bars-ctl').hidden = state.structure !== 'loop';
  }
  renderTimeline();
  renderLanes();
  if (playing) schedule();
  setStatus();
}

// ---------------------------------------------------------------------------
// Timeline (section strip) + lanes
// ---------------------------------------------------------------------------

function renderTimeline() {
  const tl = $('#timeline');
  const sections = state?.sections;
  if (!sections || sections.length <= 1) { tl.hidden = true; tl.innerHTML = ''; return; }
  tl.hidden = false;
  tl.innerHTML = '';
  for (const sec of sections) {
    const el = document.createElement('button');
    el.className = `tl-section tl-${sec.name}`;
    el.style.flexGrow = sec.bars;
    el.innerHTML = `<span>${sec.name}</span><span class="tl-bars">${sec.bars}</span>`;
    el.title = `Jump to ${sec.name} (bar ${sec.start + 1})`;
    el.addEventListener('click', () => seekTo(sec.start));
    tl.appendChild(el);
  }
  const ph = document.createElement('div');
  ph.className = 'playhead';
  tl.appendChild(ph);
}

function seekTo(bar) {
  if (!playing) togglePlay().then(() => { Tone.Transport.position = `${bar}:0:0`; });
  else Tone.Transport.position = `${bar}:0:0`;
}

function renderLanes() {
  const lanes = $('#lanes');
  lanes.innerHTML = '';
  if (!state?.tracks?.length) return;

  for (const track of state.tracks) {
    const color = TRACK_COLORS[track.type] || '#9aa0a8';
    const lane = document.createElement('div');
    lane.className = 'lane';

    const head = document.createElement('div');
    head.className = 'lane-head';
    head.innerHTML = `
      <span class="lane-chip" style="background:${color}"></span>
      <span class="lane-name">${escapeHtml(track.name)}</span>
      <span class="lane-meta">${track.notes.length} notes</span>
      <button class="lane-btn mute ${track.muted ? 'on' : ''}" title="Mute">M</button>
      ${TRACK_COLORS[track.type] && track.type !== 'fx' ? `<button class="lane-btn regen" title="Regenerate this stem">⟳</button>` : ''}
      <button class="lane-btn export" title="Export this stem as .mid">⤓ mid</button>
    `;
    head.querySelector('.mute').addEventListener('click', (e) => {
      track.muted = !track.muted;
      e.target.classList.toggle('on', track.muted);
    });
    head.querySelector('.regen')?.addEventListener('click', () => generatePattern([track.type]));
    head.querySelector('.export').addEventListener('click', () => exportMidi([track.name]));

    const body = document.createElement('div');
    body.className = 'lane-body';
    const canvas = document.createElement('canvas');
    const ph = document.createElement('div');
    ph.className = 'playhead';
    body.append(canvas, ph);

    lane.append(head, body);
    lanes.appendChild(lane);
    drawTrack(canvas, track, color);
  }
}

function drawTrack(canvas, track, color) {
  const beats = state.bars * 4;
  const isDrums = DRUM_TYPES.has(track.type);
  const pxPerBar = Math.max(30, Math.min(200, 2400 / state.bars));
  const cssW = Math.max(600, state.bars * pxPerBar);
  const pitches = isDrums
    ? DRUM_ORDER.filter(p => track.notes.some(n => n.pitch === p))
        .concat([...new Set(track.notes.map(n => n.pitch))].filter(p => !DRUM_ORDER.includes(p)))
    : null;
  let lo = 0, hi = 0, rows = 0;
  if (isDrums) {
    rows = Math.max(1, pitches.length);
  } else {
    const ps = track.notes.map(n => n.pitch);
    lo = (ps.length ? Math.min(...ps) : 48) - 2;
    hi = (ps.length ? Math.max(...ps) : 72) + 2;
    rows = hi - lo + 1;
  }
  const rowH = isDrums ? 14 : Math.max(3, Math.min(9, 110 / rows));
  const cssH = Math.max(42, Math.min(140, rows * rowH));

  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#17181c';
  ctx.fillRect(0, 0, cssW, cssH);

  // Section shading (song mode) makes the arrangement legible at a glance.
  if (state.sections?.length > 1) {
    for (const sec of state.sections) {
      if (sec.name === 'drop') {
        ctx.fillStyle = 'rgba(255,255,255,0.028)';
        ctx.fillRect((sec.start * 4 / beats) * cssW, 0, (sec.bars * 4 / beats) * cssW, cssH);
      }
    }
  }

  const barStep = state.bars > 24 ? 4 : 1;
  for (let b = 0; b <= beats; b += barStep === 4 ? 4 : 1) {
    const x = (b / beats) * cssW;
    const isBar = b % 4 === 0;
    if (!isBar && state.bars > 24) continue;
    ctx.strokeStyle = b % 16 === 0 ? '#3a4048' : isBar ? '#2b2f35' : '#1f2328';
    ctx.lineWidth = b % 16 === 0 ? 1 : 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cssH); ctx.stroke();
  }

  for (const n of track.notes) {
    const x = (n.start / beats) * cssW;
    const w = Math.max(2, (n.dur / beats) * cssW - 0.5);
    let y, h;
    if (isDrums) {
      const row = pitches.indexOf(n.pitch);
      y = row * (cssH / rows) + 1.5;
      h = cssH / rows - 3;
    } else {
      y = cssH - ((n.pitch - lo + 1) / rows) * cssH + 0.5;
      h = Math.max(2.5, cssH / rows - 1.5);
    }
    const alpha = 0.35 + (n.vel / 127) * 0.6;
    ctx.fillStyle = hexAlpha(color, alpha);
    ctx.fillRect(x, y, isDrums ? Math.min(w, 8) : w, h);
  }

  if (isDrums && rows <= 8) {
    ctx.font = '600 8px JetBrains Mono, monospace';
    ctx.fillStyle = '#565b63';
    pitches.forEach((p, i) => ctx.fillText(DRUM_NAMES[p] || '#' + p, 3, i * (cssH / rows) + (cssH / rows) / 2 + 3));
  }
}

function hexAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(2)})`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Audio engine: layered synthesis + mix bus + mastering chain
// ---------------------------------------------------------------------------

function buildEngine() {
  // --- Mastering chain: HP -> EQ -> glue comp -> saturation -> limiter ---
  const limiter = new Tone.Limiter(-1).toDestination();
  const saturator = new Tone.Distortion(0.06).connect(limiter);
  saturator.wet.value = 0.25;
  const glue = new Tone.Compressor({ threshold: -16, ratio: 3, attack: 0.01, release: 0.2 }).connect(saturator);
  const eq = new Tone.EQ3({ low: 1.5, mid: -1, high: 1.5 }).connect(glue);
  const dcCut = new Tone.Filter(24, 'highpass').connect(eq);
  const master = new Tone.Gain(0.9).connect(dcCut);

  // --- Sends ---
  const reverb = new Tone.Reverb({ decay: 2.8, preDelay: 0.02, wet: 1 }).connect(master);
  const bigverb = new Tone.Reverb({ decay: 5.5, preDelay: 0.04, wet: 1 }).connect(master);
  const pingpong = new Tone.PingPongDelay('8n.', 0.3).connect(master);
  pingpong.wet.value = 1;
  const send = (node, target, level) => {
    const g = new Tone.Gain(level).connect(target);
    node.connect(g);
  };

  // --- Sidechain pump: everything musical ducks under the kick ---
  const pump = new Tone.Gain(1).connect(master);
  const duck = (time) => {
    const g = pump.gain;
    g.cancelScheduledValues(time);
    g.setValueAtTime(1, time);
    g.linearRampToValueAtTime(0.22, time + 0.02);
    g.linearRampToValueAtTime(1, time + 0.26);
  };

  // --- Drums ---
  const drumBus = new Tone.Gain(1).connect(master);
  const kick = new Tone.MembraneSynth({ pitchDecay: 0.045, octaves: 7, oscillator: { type: 'sine' }, envelope: { attack: 0.001, decay: 0.4, sustain: 0 } }).connect(drumBus);
  const kickClick = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.015, sustain: 0 } });
  kickClick.volume.value = -14;
  kickClick.connect(new Tone.Filter(4000, 'highpass').connect(drumBus));
  const snare = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.17, sustain: 0 } });
  snare.connect(new Tone.Filter(1700, 'highpass').connect(drumBus));
  send(snare, reverb, 0.12);
  const snareBody = new Tone.MembraneSynth({ pitchDecay: 0.02, octaves: 2, envelope: { attack: 0.001, decay: 0.09, sustain: 0 } }).connect(drumBus);
  snareBody.volume.value = -8;
  const clap = new Tone.NoiseSynth({ noise: { type: 'pink' }, envelope: { attack: 0.002, decay: 0.2, sustain: 0 } });
  const clapChain = new Tone.Filter(1100, 'bandpass', -12).connect(drumBus);
  clap.connect(clapChain);
  send(clap, reverb, 0.18);
  const hat = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.045, sustain: 0 } });
  hat.connect(new Tone.Filter(8500, 'highpass').connect(drumBus));
  const ohat = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.32, sustain: 0 } });
  ohat.volume.value = -4;
  ohat.connect(new Tone.Filter(7000, 'highpass').connect(drumBus));
  const ride = new Tone.MetalSynth({ envelope: { attack: 0.001, decay: 0.4, release: 0.1 }, harmonicity: 4.1, resonance: 3200, octaves: 1 }).connect(drumBus);
  ride.volume.value = -24;
  const crash = new Tone.MetalSynth({ envelope: { attack: 0.001, decay: 1.8, release: 0.5 }, harmonicity: 5.1, resonance: 4000, octaves: 1.4 });
  crash.volume.value = -16;
  crash.connect(drumBus);
  send(crash, bigverb, 0.2);
  const tom = new Tone.MembraneSynth({ pitchDecay: 0.06, octaves: 3, envelope: { attack: 0.001, decay: 0.25, sustain: 0 } }).connect(drumBus);
  const shaker = new Tone.NoiseSynth({ noise: { type: 'pink' }, envelope: { attack: 0.008, decay: 0.055, sustain: 0 } });
  shaker.volume.value = -12;
  shaker.connect(new Tone.Filter(6500, 'highpass').connect(drumBus));
  const percSynth = new Tone.MembraneSynth({ pitchDecay: 0.03, octaves: 2.5, envelope: { attack: 0.001, decay: 0.12, sustain: 0 } });
  percSynth.volume.value = -6;
  percSynth.connect(drumBus);
  send(percSynth, reverb, 0.1);

  const drumTrigger = (pitch, time, vel) => {
    const v = vel / 127;
    switch (pitch) {
      case 36: kick.triggerAttackRelease('C1', 0.3, time, v); kickClick.triggerAttackRelease(0.015, time, v * 0.8); duck(time); break;
      case 37: percSynth.triggerAttackRelease('E4', 0.05, time, v * 0.6); break;
      case 38: snare.triggerAttackRelease(0.17, time, v); snareBody.triggerAttackRelease('A2', 0.08, time, v * 0.5); break;
      case 39: clap.triggerAttackRelease(0.2, time, v);
               clap.triggerAttackRelease(0.15, time + 0.012, v * 0.7); break; // double-hit clap
      case 42: hat.triggerAttackRelease(0.045, time, v); break;
      case 45: tom.triggerAttackRelease('G1', 0.2, time, v); break;
      case 46: ohat.triggerAttackRelease(0.32, time, v); break;
      case 47: tom.triggerAttackRelease('C2', 0.18, time, v); break;
      case 49: crash.triggerAttackRelease(1.6, time, v * 0.8); break;
      case 51: ride.triggerAttackRelease(0.3, time, v * 0.55); break;
      case 54: shaker.triggerAttackRelease(0.04, time, v * 0.9); break;
      case 63: percSynth.triggerAttackRelease('D3', 0.1, time, v); break;
      case 64: percSynth.triggerAttackRelease('A2', 0.12, time, v); break;
      case 70: shaker.triggerAttackRelease(0.05, time, v); break;
      case 75: percSynth.triggerAttackRelease('A4', 0.04, time, v * 0.7); break;
      default: hat.triggerAttackRelease(0.05, time, v * 0.5);
    }
  };

  // --- Sub: pure sine with gentle drive, sidechained ---
  const sub = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 3,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.01, decay: 0.1, sustain: 0.9, release: 0.12 },
  });
  const subDrive = new Tone.Distortion(0.15).connect(pump);
  subDrive.wet.value = 0.4;
  sub.connect(subDrive);
  sub.volume.value = -5;

  // --- Bass variants (picked per genre at trigger time) ---
  const bassLP = new Tone.Filter(700, 'lowpass', -24).connect(pump);
  const bassStd = new Tone.PolySynth(Tone.MonoSynth, {
    maxPolyphony: 4,
    oscillator: { type: 'fatsawtooth', count: 3, spread: 18 },
    envelope: { attack: 0.004, decay: 0.18, sustain: 0.65, release: 0.08 },
    filterEnvelope: { attack: 0.004, decay: 0.14, sustain: 0.35, baseFrequency: 140, octaves: 2.6 },
  }).connect(bassLP);
  bassStd.volume.value = -7;

  const wobbleFilter = new Tone.AutoFilter({ frequency: '8n', baseFrequency: 90, octaves: 3.2, filter: { type: 'lowpass', rolloff: -24, Q: 4 } }).connect(pump);
  wobbleFilter.start();
  const bassWobble = new Tone.PolySynth(Tone.MonoSynth, {
    maxPolyphony: 3,
    oscillator: { type: 'fatsawtooth', count: 3, spread: 30 },
    envelope: { attack: 0.01, decay: 0.1, sustain: 0.9, release: 0.1 },
    filterEnvelope: { attack: 0.01, decay: 0.1, sustain: 1, baseFrequency: 2000, octaves: 0 },
  }).connect(wobbleFilter);
  bassWobble.volume.value = -8;

  const dist808 = new Tone.Distortion(0.35).connect(pump);
  dist808.wet.value = 0.5;
  const bass808 = new Tone.MembraneSynth({
    pitchDecay: 0.09, octaves: 1.6,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.002, decay: 0.9, sustain: 0.35, release: 0.4 },
  }).connect(dist808);
  bass808.volume.value = -2;

  // --- Chords: supersaw with body filters ---
  const chordChain = new Tone.Filter(140, 'highpass').connect(new Tone.Filter(3800, 'lowpass').connect(pump));
  const chords = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 24,
    oscillator: { type: 'fatsawtooth', count: 5, spread: 32 },
    envelope: { attack: 0.015, decay: 0.28, sustain: 0.45, release: 0.22 },
  }).connect(chordChain);
  chords.volume.value = -18;
  send(chords, reverb, 0.16);

  // --- Pads: slow, wide, drenched ---
  const padWide = new Tone.Chorus({ frequency: 0.4, delayTime: 4.5, depth: 0.6, spread: 160 }).start();
  const padChain = new Tone.Filter(160, 'highpass').connect(padWide);
  padWide.connect(pump);
  const pads = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 24,
    oscillator: { type: 'fatsawtooth', count: 3, spread: 40 },
    envelope: { attack: 0.6, decay: 0.5, sustain: 0.8, release: 1.4 },
  }).connect(padChain);
  pads.volume.value = -22;
  send(pads, bigverb, 0.35);

  // --- Arp: FM pluck through ping-pong ---
  const arp = new Tone.PolySynth(Tone.FMSynth, {
    maxPolyphony: 10,
    harmonicity: 2, modulationIndex: 8,
    envelope: { attack: 0.002, decay: 0.14, sustain: 0.05, release: 0.1 },
    modulationEnvelope: { attack: 0.002, decay: 0.08, sustain: 0, release: 0.1 },
  }).connect(pump);
  arp.volume.value = -14;
  send(arp, pingpong, 0.25);
  send(arp, reverb, 0.12);

  // --- Lead: detuned saw stack, delay + verb ---
  const leadChain = new Tone.Filter(5200, 'lowpass').connect(master);
  const lead = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 6,
    oscillator: { type: 'fatsawtooth', count: 4, spread: 22 },
    envelope: { attack: 0.012, decay: 0.2, sustain: 0.5, release: 0.18 },
  }).connect(leadChain);
  lead.volume.value = -11;
  send(lead, pingpong, 0.2);
  send(lead, reverb, 0.2);

  // --- Counter: softer, panned, further back ---
  const counterPan = new Tone.Panner(0.35).connect(master);
  const counter = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 4,
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.03, decay: 0.2, sustain: 0.4, release: 0.3 },
  }).connect(counterPan);
  counter.volume.value = -15;
  send(counter, bigverb, 0.3);

  // --- FX: riser blips / impacts / sweeps ---
  const fxNoise = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.01, decay: 0.16, sustain: 0 } });
  const fxFilter = new Tone.Filter(800, 'bandpass', -12).connect(master);
  fxNoise.volume.value = -10;
  fxNoise.connect(fxFilter);
  send(fxNoise, bigverb, 0.4);
  const impact = new Tone.MembraneSynth({ pitchDecay: 0.1, octaves: 4, envelope: { attack: 0.001, decay: 1.4, sustain: 0 } }).connect(master);
  impact.volume.value = -4;

  const melodic = { sub, chords, pads, arp, lead, counter };

  return {
    drumTrigger,
    play(track, note, time, genre) {
      if (track.muted) return;
      const v = note.vel / 127;
      const dur = Math.max(0.03, ((note.dur * 60) / Tone.Transport.bpm.value) * 0.95);
      const freq = Tone.Frequency(note.pitch, 'midi');

      if (DRUM_TYPES.has(track.type)) return drumTrigger(note.pitch, time, note.vel);

      if (track.type === 'bass') {
        if (genre === 'trap') return bass808.triggerAttackRelease(freq, dur, time, v);
        if (genre === 'dubstep') return bassWobble.triggerAttackRelease(freq, dur, time, v);
        return bassStd.triggerAttackRelease(freq, dur, time, v);
      }
      if (track.type === 'fx') {
        if (note.pitch === 49) return drumTrigger(49, time, note.vel);
        if (note.pitch <= 30) return impact.triggerAttackRelease('C1', 1.4, time, v);
        fxFilter.frequency.setValueAtTime(freq.toFrequency() * 6, time);
        return fxNoise.triggerAttackRelease(0.14, time, v * 0.7);
      }
      const synth = melodic[track.type] || lead;
      synth.triggerAttackRelease(freq, dur, time, v);
    },
  };
}

function beatsToBBS(beats) {
  const bar = Math.floor(beats / 4);
  const quarter = Math.floor(beats % 4);
  const sixteenth = ((beats % 1) * 4).toFixed(3);
  return `${bar}:${quarter}:${sixteenth}`;
}

function schedule() {
  for (const p of parts) p.dispose();
  parts = [];
  Tone.Transport.bpm.value = state.tempo;
  Tone.Transport.loop = true;
  Tone.Transport.loopStart = 0;
  Tone.Transport.loopEnd = `${state.bars}m`;

  for (const track of state.tracks) {
    const events = track.notes.map(n => [beatsToBBS(n.start), n]);
    const part = new Tone.Part((time, note) => engine.play(track, note, time, state.genre), events);
    part.start(0);
    parts.push(part);
  }
}

async function togglePlay() {
  if (!state) { setStatus('generate a pattern first'); return; }
  if (!audioReady) {
    await Tone.start();
    engine = buildEngine();
    audioReady = true;
  }
  if (playing) {
    Tone.Transport.stop();
    Tone.Transport.cancel();
    for (const p of parts) p.dispose();
    parts = [];
    playing = false;
  } else {
    schedule();
    Tone.Transport.start('+0.05');
    playing = true;
  }
  document.body.classList.toggle('playing', playing);
  const btn = $('#play');
  btn.textContent = playing ? '■' : '▶';
  btn.classList.toggle('on', playing);
  setStatus(playing ? 'playing' : 'stopped');
}

function playheadLoop() {
  if (playing && state) {
    const loopTicks = state.bars * 4 * Tone.Transport.PPQ;
    const progress = (Tone.Transport.ticks % loopTicks) / loopTicks;
    for (const ph of document.querySelectorAll('.playhead')) {
      ph.style.left = (progress * 100).toFixed(3) + '%';
    }
  }
  requestAnimationFrame(playheadLoop);
}

// ---------------------------------------------------------------------------
// MIDI import / export
// ---------------------------------------------------------------------------

async function exportMidi(tracks) {
  if (!state) return;
  const res = await fetch('/api/export', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, tracks }),
  });
  if (!res.ok) { setStatus('export failed'); return; }
  const blob = await res.blob();
  const name = res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] || 'pattern.mid';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus(`exported ${name} — drag it into Ableton`);
}

async function importMidi(e) {
  const file = e.target.files[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const res = await fetch('/api/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: btoa(bin) }),
  });
  const imported = await res.json();
  if (!res.ok) { setStatus('import failed: ' + imported.error); return; }
  setState({ ...imported, genre: state?.genre, key: state?.key, scale: state?.scale, seed: null, structure: 'loop', sections: null });
  setStatus(`imported ${file.name}`);
  e.target.value = '';
}

// ---------------------------------------------------------------------------
// Neural audio render (Stable Audio 2.5 via the server)
// ---------------------------------------------------------------------------

async function startRender() {
  if (!state?.tracks?.length) { setStatus('generate a track first'); return; }
  const res = await fetch('/api/render', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  });
  const data = await res.json();
  if (!res.ok) { setStatus(data.error); showRenderBar(`⚠ ${data.error}`); return; }
  pollRender(data.jobId);
}

function showRenderBar(text) {
  const bar = $('#render-bar');
  bar.hidden = false;
  $('#render-status').textContent = text;
}

async function pollRender(jobId) {
  showRenderBar('rendering with Stable Audio 2.5 — usually 1–2 min…');
  $('#render').disabled = true;
  $('#render-player').hidden = true;
  $('#render-download').hidden = true;
  try {
    while (true) {
      const res = await fetch(`/api/render/${jobId}`);
      const job = await res.json();
      if (job.status === 'done') {
        showRenderBar('render ready — MIDI stems stay the editable source:');
        const player = $('#render-player');
        player.src = job.url;
        player.hidden = false;
        const dl = $('#render-download');
        dl.href = job.url;
        dl.hidden = false;
        if (playing) togglePlay(); // don't fight the synth preview
        player.play().catch(() => {});
        break;
      }
      if (job.status === 'error') { showRenderBar(`⚠ render failed: ${job.error}`); break; }
      await new Promise(r => setTimeout(r, 3000));
    }
  } finally {
    $('#render').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// AI chat
// ---------------------------------------------------------------------------

async function sendChat(e) {
  e.preventDefault();
  const input = $('#chat-text');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  addMsg('user', text);
  const typing = document.createElement('div');
  typing.className = 'typing';
  typing.textContent = 'producing';
  $('#chat-log').appendChild(typing);
  scrollChat();
  $('#chat-send').disabled = true;

  try {
    if (!state) {
      state = {
        genre: $('#genre').value, key: $('#key').value, scale: $('#scale').value,
        tempo: clampTempo(), bars: 8, structure: $('#structure').value, seed: null, tracks: [],
      };
    }
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: chatHistory, message: text, state }),
    });
    const data = await res.json();
    typing.remove();
    if (!res.ok) {
      addMsg('error', data.error || 'Request failed');
      return;
    }
    chatHistory.push({ role: 'user', text });
    chatHistory.push({ role: 'assistant', text: data.reply });
    if (chatHistory.length > 24) chatHistory = chatHistory.slice(-24);
    addMsg('assistant', data.reply, data.actions);
    if (data.actions?.length) setState(data.state);
    if (data.state?.renderJobId) {
      const jobId = data.state.renderJobId;
      delete state.renderJobId;
      pollRender(jobId);
    }
  } catch (err) {
    typing.remove();
    addMsg('error', String(err));
  } finally {
    $('#chat-send').disabled = !meta.aiEnabled;
  }
}

function addMsg(role, text, actions) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  for (const para of String(text).split(/\n{2,}/)) {
    const p = document.createElement('p');
    p.textContent = para;
    div.appendChild(p);
  }
  if (actions?.length) {
    const chips = document.createElement('div');
    chips.className = 'action-chips';
    for (const a of actions) {
      const chip = document.createElement('span');
      chip.className = 'action-chip';
      chip.textContent = a;
      chips.appendChild(chip);
    }
    div.appendChild(chips);
  }
  $('#chat-log').appendChild(div);
  scrollChat();
}

function scrollChat() {
  const log = $('#chat-log');
  log.scrollTop = log.scrollHeight;
}

boot();

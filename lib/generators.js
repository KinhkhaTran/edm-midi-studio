// Genre-aware EDM composition engine.
//
// Times are in beats (quarter notes). One bar = 4 beats, one 16th step = 0.25.
// Note shape: { pitch: <midi 0-127>, start: <beats>, dur: <beats>, vel: <1-127> }
//
// How a song is built:
//   1. Generate 8 bars of core *materials* (progression, drum grids, motif-based
//      melody, counter-melody, bass, chords, pads, arp) — this is the hook.
//   2. structure "loop"  -> render just the core materials.
//      structure "song"  -> tile the materials across an arranged energy curve
//      (intro → build → drop → break → build → drop → outro) with per-section
//      stem masks, velocity scaling, snare rolls, risers, impacts and crashes.

import {
  noteToMidi, scalePitch, chordPitches, voiceLead, snapToScale,
  mulberry32, rngHelpers, swing16, grooveVel,
} from './theory.js';

export const DRUMS = {
  kick: 36, rim: 37, snare: 38, clap: 39, chh: 42, tomL: 45, ohh: 46, tomH: 47,
  crash: 49, ride: 51, tamb: 54, congaH: 63, congaL: 64, shaker: 70, clave: 75,
};

export const STEMS = ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'chords', 'pads', 'arp', 'lead', 'counter', 'fx'];
export const DRUM_STEMS = new Set(['kick', 'snare', 'hats', 'perc', 'drums']);
export const TRACK_TYPES = STEMS;

const CORE_BARS = 8;

// ---------------------------------------------------------------------------
// Genre definitions
// ---------------------------------------------------------------------------
// progression: 8 chord specs {d: degree, q: quality} — one per bar of the core.
// drums: per-stem 16-step strings ('X' accent, 'x' hit, 'o' ghost, '.' rest).
// comp: chord-stab rhythm [start, dur, velScale][]; pads: sustained layer flag.
// lead: rhythm-cell weights + register. swing: 0 = straight, ~0.56 = MPC feel.

export const GENRES = {
  house: {
    label: 'House', bpm: 124, scale: 'minor', bassOct: 2, swing: 0.54,
    progressions: [
      [{ d: 0, q: '7' }, { d: 5, q: '7' }, { d: 3, q: '9' }, { d: 4, q: '7' }, { d: 0, q: '7' }, { d: 5, q: '9' }, { d: 3, q: '7' }, { d: 4, q: 'sus4' }],
      [{ d: 0, q: '9' }, { d: 3, q: '7' }, { d: 5, q: '7' }, { d: 4, q: '7' }, { d: 0, q: '9' }, { d: 3, q: '7' }, { d: 5, q: '9' }, { d: 6, q: '7' }],
    ],
    drums: {
      kick:  { kick: 'x...x...x...x...' },
      snare: { clap: '....x.......x...' },
      hats:  { chh: 'xoxoXoxoxoxoXoxo', ohh: '..x...x...x...x.' },
      perc:  { shaker: 'oxooxooxooxooxoo', congaH: '.......x......x.', rim: '..........x.....' },
    },
    bass: 'offbeat8',
    comp: [[1.5, 0.3, 1.0], [3.5, 0.3, 0.9]],
    pads: true,
    lead: { cells: { two8: 3, dot: 2, offbeat: 2, sustain: 2, rest: 1.5 }, octave: 5, range: 7 },
    stems: ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'chords', 'pads', 'lead', 'counter', 'fx'],
  },
  deep_house: {
    label: 'Deep House', bpm: 120, scale: 'dorian', bassOct: 2, swing: 0.57,
    progressions: [
      [{ d: 0, q: '9' }, { d: 3, q: '9' }, { d: 4, q: 'shell' }, { d: 3, q: '9' }, { d: 0, q: '9' }, { d: 6, q: 'shell' }, { d: 3, q: '9' }, { d: 4, q: '7' }],
      [{ d: 1, q: 'shell' }, { d: 4, q: '9' }, { d: 0, q: '9' }, { d: 3, q: '7' }, { d: 1, q: '9' }, { d: 4, q: '9' }, { d: 0, q: '9' }, { d: 4, q: 'sus4' }],
    ],
    drums: {
      kick:  { kick: 'x...x...x...x...' },
      snare: { clap: '....x.......x..o', snare: '..............o.' },
      hats:  { chh: 'o.oox.ooo.oox.oo', ohh: '..x...x...x...x.' },
      perc:  { shaker: 'xoooxoooxoooxooo', rim: '.......x......x.', congaL: '..o.......o...o.' },
    },
    bass: 'rolling',
    comp: [[0.5, 0.35, 0.85], [2.5, 0.6, 0.95]],
    pads: true,
    lead: { cells: { sustain: 3, dot: 2, two8: 1.5, rest: 2.5 }, octave: 5, range: 6 },
    stems: ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'chords', 'pads', 'lead', 'counter', 'fx'],
  },
  techno: {
    label: 'Techno', bpm: 132, scale: 'phrygian', bassOct: 1, swing: 0,
    progressions: [
      [{ d: 0, q: '5' }, { d: 0, q: '5' }, { d: 0, q: '5' }, { d: 1, q: '5' }, { d: 0, q: '5' }, { d: 0, q: '5' }, { d: 5, q: '5' }, { d: 0, q: '5' }],
    ],
    drums: {
      kick:  { kick: 'x...x...x...x...' },
      snare: { clap: '....x.......x...' },
      hats:  { chh: '..x...x...x...x.', ride: 'x.x.x.x.x.x.x.x.' },
      perc:  { tomL: '.......o..o.....', rim: '..o...........o.', clave: '......x.........' },
    },
    bass: 'rumble16',
    comp: [[3.5, 0.25, 0.85]],
    pads: false,
    lead: { cells: { six: 3, two8: 2, offbeat: 1.5, rest: 1 }, octave: 4, range: 5, acid: true },
    stems: ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'chords', 'arp', 'lead', 'fx'],
  },
  trance: {
    label: 'Trance', bpm: 138, scale: 'minor', bassOct: 2, swing: 0,
    progressions: [
      [{ d: 0, q: 'triad' }, { d: 5, q: 'add9' }, { d: 2, q: 'triad' }, { d: 6, q: 'triad' }, { d: 0, q: 'triad' }, { d: 5, q: 'add9' }, { d: 3, q: 'add9' }, { d: 4, q: 'sus4' }],
      [{ d: 0, q: 'add9' }, { d: 4, q: 'triad' }, { d: 5, q: 'add9' }, { d: 3, q: 'triad' }, { d: 0, q: 'add9' }, { d: 4, q: 'triad' }, { d: 5, q: 'add9' }, { d: 6, q: 'triad' }],
    ],
    drums: {
      kick:  { kick: 'x...x...x...x...' },
      snare: { clap: '....x.......x...' },
      hats:  { chh: 'xoxoxoxoxoxoxoxo', ohh: '..x...x...x...x.' },
      perc:  { ride: '..x...x...x...x.', tamb: 'x.x.x.x.x.x.x.x.' },
    },
    bass: 'offbeat8',
    comp: [[0, 3.8, 0.8]],
    pads: true,
    arp: { pattern: 'up', rate: 0.25, octave: 4, span: 2 },
    lead: { cells: { sustain: 3, dot: 2.5, two8: 2, rest: 1 }, octave: 5, range: 8, soaring: true },
    stems: ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'chords', 'pads', 'arp', 'lead', 'counter', 'fx'],
  },
  progressive: {
    label: 'Progressive House', bpm: 126, scale: 'minor', bassOct: 2, swing: 0,
    progressions: [
      [{ d: 0, q: 'add9' }, { d: 3, q: '7' }, { d: 5, q: 'add9' }, { d: 4, q: 'sus4' }, { d: 0, q: 'add9' }, { d: 3, q: '7' }, { d: 5, q: 'add9' }, { d: 6, q: '7' }],
      [{ d: 3, q: 'add9' }, { d: 0, q: 'triad' }, { d: 5, q: '9' }, { d: 4, q: 'triad' }, { d: 3, q: 'add9' }, { d: 0, q: 'triad' }, { d: 5, q: '9' }, { d: 4, q: 'sus4' }],
    ],
    drums: {
      kick:  { kick: 'x...x...x...x...' },
      snare: { clap: '....x.......x...' },
      hats:  { chh: 'x.xox.xox.xox.xo', ohh: '..x...x...x...x.' },
      perc:  { shaker: 'oxooxooxooxooxoo', rim: '......x.......x.' },
    },
    bass: 'rolling8',
    comp: [[0.5, 0.25, 0.8], [1.5, 0.25, 0.9], [2.5, 0.25, 0.8], [3.5, 0.25, 0.95]],
    pads: true,
    arp: { pattern: 'updown', rate: 0.25, octave: 4, span: 2 },
    lead: { cells: { dot: 3, sustain: 2, two8: 2, rest: 1.5 }, octave: 5, range: 7 },
    stems: ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'chords', 'pads', 'arp', 'lead', 'counter', 'fx'],
  },
  dubstep: {
    label: 'Dubstep', bpm: 140, scale: 'harmonicMinor', bassOct: 1, swing: 0,
    progressions: [
      [{ d: 0, q: '5' }, { d: 0, q: '5' }, { d: 3, q: '5' }, { d: 4, q: '5' }, { d: 0, q: '5' }, { d: 5, q: '5' }, { d: 3, q: '5' }, { d: 4, q: '5' }],
    ],
    drums: {
      kick:  { kick: 'x.........x.....' },
      snare: { snare: '........x.......' },
      hats:  { chh: 'x..x..x...x..x..', ohh: '..............x.' },
      perc:  { rim: '.....x.......x..', tomL: '...........o....' },
    },
    bass: 'wobble',
    comp: [[0, 2, 0.55]],
    pads: true,
    lead: { cells: { sustain: 3, dot: 2, rest: 2 }, octave: 4, range: 6 },
    stems: ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'chords', 'pads', 'lead', 'fx'],
    halftime: true,
  },
  dnb: {
    label: 'Drum & Bass', bpm: 174, scale: 'minor', bassOct: 1, swing: 0,
    progressions: [
      [{ d: 0, q: '9' }, { d: 3, q: '7' }, { d: 5, q: '9' }, { d: 4, q: '7' }, { d: 0, q: '9' }, { d: 3, q: '7' }, { d: 5, q: '9' }, { d: 6, q: 'shell' }],
    ],
    drums: {
      kick:  { kick: 'x.........x.....' },
      snare: { snare: '....x.......x...' },
      hats:  { chh: 'x.xxx.xxx.xxx.xx', ride: '..x...x...x...x.' },
      perc:  { shaker: 'x.x.x.x.x.x.x.x.', rim: '.......x..o.....' },
    },
    bass: 'reese',
    comp: [[0, 4, 0.6]],
    pads: true,
    lead: { cells: { two8: 3, offbeat: 2, dot: 2, rest: 2 }, octave: 5, range: 7 },
    stems: ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'chords', 'pads', 'lead', 'counter', 'fx'],
  },
  future_bass: {
    label: 'Future Bass', bpm: 150, scale: 'major', bassOct: 2, swing: 0,
    progressions: [
      [{ d: 3, q: '9' }, { d: 4, q: 'add9' }, { d: 2, q: '7' }, { d: 5, q: '9' }, { d: 3, q: '9' }, { d: 4, q: 'add9' }, { d: 5, q: '9' }, { d: 4, q: 'sus4' }],
      [{ d: 0, q: 'add9' }, { d: 4, q: '9' }, { d: 5, q: '9' }, { d: 3, q: 'add9' }, { d: 0, q: 'add9' }, { d: 4, q: '9' }, { d: 5, q: '9' }, { d: 4, q: '7' }],
    ],
    drums: {
      kick:  { kick: 'x......x..x.....' },
      snare: { snare: '........x.......', clap: '........x.......' },
      hats:  { chh: 'x..x.x..x..x.x..', ohh: '......x.......x.' },
      perc:  { shaker: '..x...x...x...x.', tamb: '........x.......' },
    },
    bass: 'sub',
    comp: [[0, 0.5, 1.0], [0.75, 0.5, 0.85], [1.5, 0.4, 0.9], [2, 0.5, 1.0], [2.75, 0.5, 0.85], [3.5, 0.45, 0.95]],
    pads: true,
    lead: { cells: { two8: 3, dot: 2, sustain: 2, rest: 1 }, octave: 5, range: 6, pentatonic: true },
    stems: ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'chords', 'pads', 'lead', 'counter', 'fx'],
    halftime: true,
  },
  trap: {
    label: 'Trap', bpm: 140, scale: 'harmonicMinor', bassOct: 1, swing: 0,
    progressions: [
      [{ d: 0, q: 'triad' }, { d: 0, q: 'triad' }, { d: 3, q: 'shell' }, { d: 4, q: 'triad' }, { d: 0, q: 'triad' }, { d: 5, q: 'shell' }, { d: 3, q: 'shell' }, { d: 4, q: 'triad' }],
    ],
    drums: {
      kick:  { kick: 'x.....x....x....' },
      snare: { snare: '........x.......' },
      hats:  { chh: 'xxxxxxxxxxxxxxxx' },
      perc:  { rim: '......x.......x.', congaL: '...o............' },
    },
    bass: '808',
    comp: [[0, 3.5, 0.5]],
    pads: true,
    lead: { cells: { dot: 3, sustain: 2, offbeat: 1.5, rest: 2.5 }, octave: 5, range: 6, dark: true },
    stems: ['kick', 'snare', 'hats', 'perc', 'bass', 'chords', 'pads', 'lead', 'fx'],
    halftime: true, hatRolls: true,
  },
};

// ---------------------------------------------------------------------------
// Drums
// ---------------------------------------------------------------------------

const VEL = { X: 118, x: 96, o: 52 };

function stepsToNotes(pattern, pitch, barOffset, rng, swing) {
  const notes = [];
  for (let i = 0; i < 16; i++) {
    const c = pattern[i];
    if (c === '.' || c === undefined) continue;
    const start = swing16(barOffset + i * 0.25, swing);
    const vel = Math.max(20, Math.min(127, VEL[c] + Math.floor((rng() - 0.5) * 12)));
    notes.push({ pitch, start, dur: 0.22, vel });
  }
  return notes;
}

function makeDrumStem(stemPatterns, g, bars, rng) {
  const { chance } = rngHelpers(rng);
  const notes = [];
  for (let bar = 0; bar < bars; bar++) {
    const off = bar * 4;
    for (const [inst, pattern] of Object.entries(stemPatterns)) {
      let pat = pattern;
      if (inst !== 'kick' && inst !== 'snare' && chance(0.3)) {
        const i = Math.floor(rng() * 16);
        pat = pat.slice(0, i) + (pat[i] === '.' ? 'o' : '.') + pat.slice(i + 1);
      }
      notes.push(...stepsToNotes(pat, DRUMS[inst], off, rng, g.swing));
    }
  }
  return notes;
}

function makeHatRolls(bars, rng) {
  const { chance, pick } = rngHelpers(rng);
  const notes = [];
  for (let bar = 0; bar < bars; bar++) {
    if (!chance(0.65)) continue;
    const off = bar * 4 + pick([2.5, 3, 3.5]);
    const rate = pick([0.125, 0.125, 0.0625]);
    const count = pick([4, 6, 8]);
    for (let i = 0; i < count; i++) {
      notes.push({ pitch: DRUMS.chh, start: off + i * rate, dur: rate * 0.8, vel: 52 + Math.round((i / count) * 46) });
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Harmony: voice-led chords + pads + sub
// ---------------------------------------------------------------------------

function makeChordLayers(g, ctx) {
  const { root, scale, progression, bars, rng } = ctx;
  const comp = [], pads = [], sub = [];
  let prevVoicing = null;

  for (let bar = 0; bar < bars; bar++) {
    const off = bar * 4;
    const spec = progression[bar % progression.length];
    const raw = chordPitches(root + 24, scale, spec);
    const voicing = voiceLead(raw, prevVoicing, 62);
    prevVoicing = voicing;

    // Comp layer: rhythmic hits.
    for (const [start, dur, velScale] of g.comp) {
      const vel = Math.max(30, Math.min(127, Math.round(96 * velScale + (rng() - 0.5) * 8)));
      for (const p of voicing) comp.push({ pitch: p, start: off + start, dur, vel });
    }
    // Pad layer: sustained, wider (root doubled below), softer.
    if (g.pads) {
      const padVoicing = [voicing[0] - 12, ...voicing];
      for (const p of padVoicing) pads.push({ pitch: p, start: off, dur: 3.9, vel: 62 });
    }
    // Sub: root of each chord, held.
    const subPitch = scalePitch(root - 12, scale, spec.d);
    sub.push({ pitch: Math.max(24, subPitch), start: off, dur: 3.8, vel: 104 });
  }
  return { comp, pads, sub };
}

// ---------------------------------------------------------------------------
// Bass archetypes (with approach notes into the next chord)
// ---------------------------------------------------------------------------

function makeBass(style, ctx) {
  const { root, scale, progression, bars, rng, swing } = ctx;
  const { chance, pick } = rngHelpers(rng);
  const notes = [];
  const rootAt = (bar) => scalePitch(root, scale, progression[bar % progression.length].d);

  for (let bar = 0; bar < bars; bar++) {
    const off = bar * 4;
    const rootPitch = rootAt(bar);
    const nextRoot = rootAt(bar + 1);
    const approach = nextRoot + (nextRoot > rootPitch ? -1 : 1); // chromatic approach

    switch (style) {
      case 'offbeat8':
        for (let b = 0; b < 4; b++) {
          const last = b === 3;
          notes.push({
            pitch: last && chance(0.4) ? approach : rootPitch,
            start: off + b + 0.5, dur: 0.4, vel: grooveVel(b + 0.5, 102, rng),
          });
        }
        break;
      case 'rolling': {
        const grid = [0, 0.75, 1.5, 2, 2.75, 3.5];
        grid.forEach((t, i) => {
          const isLast = i === grid.length - 1;
          const oct = chance(0.25) ? 12 : 0;
          const pitch = isLast && chance(0.5) ? approach : rootPitch + oct;
          notes.push({ pitch, start: swing16(off + t, swing), dur: 0.35, vel: oct ? 84 : grooveVel(t, 102, rng) });
        });
        break;
      }
      case 'rolling8':
        for (let i = 0; i < 8; i++) {
          let pitch = rootPitch;
          if (i === 6 && chance(0.5)) pitch += 7;
          if (i === 7 && chance(0.5)) pitch = approach;
          notes.push({ pitch, start: off + i * 0.5, dur: 0.42, vel: i % 2 ? 88 : 104 });
        }
        break;
      case 'rumble16':
        for (let i = 0; i < 16; i++) {
          if (i % 4 === 0) continue;
          notes.push({ pitch: rootPitch, start: off + i * 0.25, dur: 0.2, vel: i % 2 ? 66 : 86 });
        }
        break;
      case 'wobble': {
        const grid = pick([[0, 1, 1.5, 2.5, 3], [0, 0.75, 1.5, 2, 3, 3.5], [0, 1.5, 2, 3, 3.75]]);
        for (const t of grid) {
          const move = pick([0, 0, 7, 12, -12, 3]);
          notes.push({ pitch: rootPitch + move, start: off + t, dur: pick([0.4, 0.65, 0.9]), vel: 110 });
        }
        break;
      }
      case 'reese':
        notes.push({ pitch: rootPitch, start: off, dur: 2.4, vel: 104 });
        notes.push({ pitch: chance(0.4) ? approach : rootPitch + pick([0, 5, 7, -2]), start: off + 2.5, dur: 1.4, vel: 96 });
        break;
      case 'sub':
        notes.push({ pitch: rootPitch, start: off, dur: 3, vel: 106 });
        if (chance(0.6)) notes.push({ pitch: rootPitch + 12, start: off + 3.25, dur: 0.5, vel: 80 });
        break;
      case '808':
        notes.push({ pitch: rootPitch, start: off, dur: chance(0.5) ? 3.9 : 2.4, vel: 112 });
        if (chance(0.5)) notes.push({ pitch: rootPitch + pick([7, 12, -5, 3]), start: off + 2.5, dur: 1.2, vel: 96 });
        break;
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Arp
// ---------------------------------------------------------------------------

function makeArp(cfg, ctx) {
  const { root, scale, progression, bars } = ctx;
  const notes = [];
  for (let bar = 0; bar < bars; bar++) {
    const off = bar * 4;
    const spec = progression[bar % progression.length];
    const base = chordPitches(root + 12 * (cfg.octave - 1), scale, { d: spec.d, q: 'triad' });
    let seq = [...base, ...base.map(p => p + 12)];
    if (cfg.pattern === 'updown') seq = [...seq, ...seq.slice(1, -1).reverse()];
    const stepsPerBar = Math.round(4 / cfg.rate);
    for (let i = 0; i < stepsPerBar; i++) {
      notes.push({
        pitch: seq[i % seq.length], start: off + i * cfg.rate,
        dur: cfg.rate * 0.8, vel: i % 4 === 0 ? 92 : 72,
      });
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Melody: motif-based phrase construction (A A' B A'' with development)
// ---------------------------------------------------------------------------

// Rhythm cells: one beat each, [offsetInBeat, dur][] — gaps are rests.
const CELLS = {
  sustain: [[0, 1]],
  two8:    [[0, 0.5], [0.5, 0.5]],
  dot:     [[0, 0.75], [0.75, 0.25]],
  gallop:  [[0, 0.5], [0.5, 0.25], [0.75, 0.25]],
  six:     [[0, 0.25], [0.25, 0.25], [0.5, 0.25], [0.75, 0.25]],
  offbeat: [[0.5, 0.5]],
  syncop:  [[0, 0.25], [0.5, 0.25]],
  rest:    [],
};

// Build a 1-bar motif: rhythm from weighted cells + a stepwise contour.
function buildMotif(cfg, rng) {
  const { weighted } = rngHelpers(rng);
  const cellPairs = Object.entries(cfg.cells).map(([k, w]) => [k, w]);
  const slots = [];
  for (let beat = 0; beat < 4; beat++) {
    const cell = CELLS[weighted(cellPairs)] || [];
    for (const [o, d] of cell) slots.push({ beat: beat + o, dur: d });
  }
  // Contour: random walk in scale degrees, small steps, starting on a chord tone.
  const { weighted: w2, pick } = rngHelpers(rng);
  let deg = pick([0, 2, 4]);
  const degs = slots.map((_, i) => {
    if (i > 0) {
      deg += w2([[0, 1.5], [1, 3], [-1, 3], [2, 1.5], [-2, 1.5], [3, 0.6], [-3, 0.6]]);
      deg = Math.max(-3, Math.min(cfg.range, deg));
    }
    return deg;
  });
  return slots.map((s, i) => ({ ...s, deg: degs[i] }));
}

const CHORD_TONE_OFFSETS = [0, 2, 4, 6];

// Render a motif over a specific chord with optional transforms.
function renderMotif(motif, spec, barOffset, cfg, ctx, opts = {}) {
  const { root, scale, rng } = ctx;
  const notes = [];
  const melodyRoot = root + 12 * cfg.octave;
  const bias = opts.bias || 0;

  motif.forEach((slot, i) => {
    if (opts.skipLast && i === motif.length - 1) return;
    let deg = spec.d + slot.deg + bias;
    // Strong beats land on chord tones: snap to the nearest chord-tone offset.
    if (slot.beat % 1 === 0) {
      const rel = slot.deg + bias;
      const nearest = CHORD_TONE_OFFSETS.reduce((a, b) =>
        Math.abs(b - (((rel % 7) + 7) % 7)) < Math.abs(a - (((rel % 7) + 7) % 7)) ? b : a);
      deg = spec.d + Math.floor(rel / 7) * 7 + nearest;
    }
    let pitch = scalePitch(melodyRoot, scale, deg);
    pitch = snapToScale(pitch, root, scale);
    const start = barOffset + slot.beat + (opts.shift || 0);
    let dur = slot.dur;
    // Resolution: final slot of a resolving bar becomes a long chord-root note.
    if (opts.resolve && i === motif.length - 1) {
      pitch = scalePitch(melodyRoot, scale, spec.d + (rngHelpers(rng).chance(0.5) ? 0 : 4));
      dur = Math.max(dur, 1.5);
    }
    const vel = grooveVel(slot.beat, cfg.acid ? 88 : 94, rng);
    notes.push({ pitch, start, dur: dur * 0.92, vel });
    // Ornament: occasional 16th approach note before a beat-1 note.
    if (opts.ornament && slot.beat === 0 && rngHelpers(rng).chance(0.5)) {
      notes.push({ pitch: pitch - (scale === 'major' ? 1 : 2), start: start - 0.25, dur: 0.2, vel: vel - 24 });
    }
  });
  return notes.filter(n => n.start >= barOffset - 0.26);
}

// 8-bar phrase: A A' B A(resolve) | A A' B climax→resolve
function makeLead(cfg, ctx) {
  const { progression, rng } = ctx;
  const motifA = buildMotif(cfg, rng);
  const motifB = buildMotif(cfg, rng);
  const plan = [
    { m: motifA, opts: {} },
    { m: motifA, opts: { ornament: true } },
    { m: motifB, opts: { bias: cfg.soaring ? 2 : 1 } },
    { m: motifA, opts: { skipLast: true, resolve: true } },
    { m: motifA, opts: {} },
    { m: motifA, opts: { shift: 0, ornament: true } },
    { m: motifB, opts: { bias: cfg.soaring ? 3 : 2 } },      // climax bar
    { m: motifA, opts: { resolve: true } },
  ];
  const notes = [];
  plan.forEach((step, bar) => {
    const spec = progression[bar % progression.length];
    notes.push(...renderMotif(step.m, spec, bar * 4, cfg, ctx, step.opts));
  });
  return notes.sort((a, b) => a.start - b.start);
}

// Counter-melody: answers in the lead's gaps, harmonized a third below, octave down.
function makeCounter(leadNotes, cfg, ctx) {
  const { root, scale, progression, bars, rng } = ctx;
  const { chance } = rngHelpers(rng);
  const notes = [];
  for (let bar = 0; bar < bars; bar++) {
    const off = bar * 4;
    const spec = progression[bar % progression.length];
    const inBar = leadNotes.filter(n => n.start >= off && n.start < off + 4);
    // Find gaps of at least 3/4 beat.
    const gaps = [];
    let cursor = off;
    for (const n of [...inBar].sort((a, b) => a.start - b.start)) {
      if (n.start - cursor >= 0.75) gaps.push([cursor, n.start]);
      cursor = Math.max(cursor, n.start + n.dur);
    }
    if (off + 4 - cursor >= 0.75) gaps.push([cursor, off + 4]);

    for (const [g0, g1] of gaps) {
      if (!chance(0.65)) continue;
      const pitch = snapToScale(
        scalePitch(root + 12 * (cfg.octave - 1), scale, spec.d + (chance(0.5) ? 2 : 4)),
        root, scale,
      );
      notes.push({ pitch, start: g0 + 0.25, dur: Math.min(1.2, g1 - g0 - 0.25), vel: 72 });
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Arrangement: tile core materials across an energy curve
// ---------------------------------------------------------------------------

export const SONG_SECTIONS = [
  { name: 'intro', bars: 8 },
  { name: 'build', bars: 8 },
  { name: 'drop', bars: 16 },
  { name: 'break', bars: 8 },
  { name: 'build', bars: 8 },
  { name: 'drop', bars: 16 },
  { name: 'outro', bars: 8 },
];

// Which stems play in each section, and how loud.
const SECTION_PLAN = {
  intro: { stems: ['hats', 'perc', 'pads', 'arp', 'chords'], energy: 0.78, thin: { hats: 0.5, chords: 0.35 } },
  build: { stems: ['kick', 'snare', 'hats', 'perc', 'bass', 'chords', 'pads', 'arp', 'fx'], energy: 0.9 },
  drop:  { stems: ['kick', 'snare', 'hats', 'perc', 'sub', 'bass', 'chords', 'arp', 'lead', 'fx'], energy: 1.0 },
  break: { stems: ['pads', 'chords', 'lead', 'perc', 'sub'], energy: 0.72, thin: { perc: 0.4 } },
  outro: { stems: ['kick', 'hats', 'perc', 'pads'], energy: 0.75, thin: { hats: 0.6 } },
};

// Copy the notes of `sourceBar` (mod core length) into `destBar`.
function tileBars(notes, coreBars, destStartBar, sectionBars, velScale, thinProb, rng) {
  const out = [];
  for (let b = 0; b < sectionBars; b++) {
    const src = (b % coreBars) * 4;
    const dst = (destStartBar + b) * 4;
    for (const n of notes) {
      if (n.start < src || n.start >= src + 4) continue;
      if (thinProb && rng() > thinProb) continue;
      out.push({
        ...n,
        start: n.start - src + dst,
        vel: Math.max(16, Math.min(127, Math.round(n.vel * velScale))),
      });
    }
  }
  return out;
}

function makeSnareRoll(sectionStartBar, sectionBars) {
  const notes = [];
  const end = (sectionStartBar + sectionBars) * 4;
  // Accelerating roll over the last 4 bars: 8ths -> 16ths -> 16ths -> 32nds, velocity ramp.
  const rates = [0.5, 0.25, 0.25, 0.125];
  for (let bar = 0; bar < 4; bar++) {
    const off = (sectionStartBar + sectionBars - 4 + bar) * 4;
    const rate = rates[bar];
    for (let t = 0; t < 4; t += rate) {
      const progress = ((off + t) - (end - 16)) / 16;
      notes.push({ pitch: DRUMS.snare, start: off + t, dur: rate * 0.7, vel: Math.round(48 + progress * 72) });
    }
  }
  return notes;
}

function makeFx(sections) {
  const notes = [];
  for (const s of sections) {
    const startBeat = s.start * 4;
    const endBeat = (s.start + s.bars) * 4;
    if (s.name === 'build') {
      // Riser: chromatic 16th climb over the last 4 bars, up two octaves.
      const riseBeats = 16;
      const steps = riseBeats / 0.25;
      for (let i = 0; i < steps; i++) {
        notes.push({ pitch: 48 + Math.round((i / steps) * 24), start: endBeat - riseBeats + i * 0.25, dur: 0.24, vel: 40 + Math.round((i / steps) * 70) });
      }
    }
    if (s.name === 'drop') {
      notes.push({ pitch: 24, start: startBeat, dur: 2, vel: 120 }); // impact
      notes.push({ pitch: DRUMS.crash, start: startBeat, dur: 1, vel: 110 });
    }
    if (s.name === 'break') {
      // Downlifter: descending 8ths over the first 2 bars.
      for (let i = 0; i < 16; i++) {
        notes.push({ pitch: 72 - i * 2, start: startBeat + i * 0.5, dur: 0.4, vel: 70 - i * 3 });
      }
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const STEM_NAMES = {
  kick: 'Kick', snare: 'Snare/Clap', hats: 'Hats', perc: 'Percussion',
  sub: 'Sub Bass', bass: 'Bass', chords: 'Chords', pads: 'Pads',
  arp: 'Arp', lead: 'Lead', counter: 'Counter', fx: 'FX',
};

export function generate({
  genre = 'house', key = 'A', scale, tempo, bars = 8, seed, tracks, structure = 'loop',
} = {}) {
  const g = GENRES[genre];
  if (!g) throw new Error(`Unknown genre "${genre}". Available: ${Object.keys(GENRES).join(', ')}`);
  seed = seed ?? Math.floor(Math.random() * 1e9);
  const rng = mulberry32(seed);
  scale = scale || g.scale;
  tempo = tempo || g.bpm;
  const root = noteToMidi(key, g.bassOct);
  const progression = rngHelpers(rng).pick(g.progressions);
  const ctx = { root, scale, progression, bars: CORE_BARS, rng, swing: g.swing };

  // --- 1. Core materials (8 bars) ---
  const materials = {};
  materials.kick = makeDrumStem(g.drums.kick, g, CORE_BARS, rng);
  materials.snare = makeDrumStem(g.drums.snare, g, CORE_BARS, rng);
  materials.hats = makeDrumStem(g.drums.hats, g, CORE_BARS, rng);
  if (g.hatRolls) materials.hats.push(...makeHatRolls(CORE_BARS, rng));
  materials.perc = makeDrumStem(g.drums.perc, g, CORE_BARS, rng);
  const layers = makeChordLayers(g, ctx);
  materials.chords = layers.comp;
  materials.pads = layers.pads;
  materials.sub = layers.sub;
  materials.bass = makeBass(g.bass, ctx);
  if (g.arp) materials.arp = makeArp(g.arp, ctx);
  materials.lead = makeLead(g.lead, ctx);
  materials.counter = makeCounter(materials.lead, { octave: g.lead.octave }, ctx);

  // fx has no core material — it is synthesized from the section layout below.
  const activeStems = STEMS.filter(s => g.stems.includes(s) && (s === 'fx' || Array.isArray(materials[s])));

  // --- 2. Assemble ---
  let totalBars, sections, stemNotes = {};

  if (structure === 'song') {
    sections = [];
    let cursor = 0;
    for (const s of SONG_SECTIONS) {
      sections.push({ name: s.name, start: cursor, bars: s.bars });
      cursor += s.bars;
    }
    totalBars = cursor;
    for (const stem of activeStems) stemNotes[stem] = [];

    let dropCount = 0;
    for (const sec of sections) {
      const plan = SECTION_PLAN[sec.name];
      if (sec.name === 'drop') dropCount++;
      for (const stem of activeStems) {
        if (stem === 'fx') continue;
        if (!plan.stems.includes(stem)) continue;
        // Second drop earns the counter-melody for contrast.
        if (stem === 'counter' && !(sec.name === 'drop' && dropCount === 2)) continue;
        const thin = plan.thin?.[stem];
        stemNotes[stem].push(...tileBars(materials[stem], CORE_BARS, sec.start, sec.bars, plan.energy, thin, rng));
      }
      // Counter joins drop 2.
      if (sec.name === 'drop' && dropCount === 2 && activeStems.includes('counter')) {
        stemNotes.counter.push(...tileBars(materials.counter, CORE_BARS, sec.start, sec.bars, 1, null, rng));
      }
      if (sec.name === 'build' && activeStems.includes('snare')) {
        stemNotes.snare.push(...makeSnareRoll(sec.start, sec.bars));
      }
    }
    if (activeStems.includes('fx')) stemNotes.fx = makeFx(sections);
  } else {
    totalBars = [4, 8].includes(bars) ? bars : 8;
    sections = [{ name: 'loop', start: 0, bars: totalBars }];
    for (const stem of activeStems) {
      if (stem === 'fx') continue; // FX only make sense in an arrangement
      stemNotes[stem] = totalBars === CORE_BARS
        ? materials[stem]
        : materials[stem].filter(n => n.start < totalBars * 4);
    }
  }

  // --- 3. Build track list ---
  const wanted = tracks && tracks.length ? tracks : null;
  const out = [];
  for (const stem of STEMS) {
    if (!(stem in stemNotes)) continue;
    if (wanted && !wanted.includes(stem)) continue;
    if (!stemNotes[stem].length) continue;
    out.push({
      id: stem, name: STEM_NAMES[stem], type: stem,
      notes: stemNotes[stem].sort((a, b) => a.start - b.start),
    });
  }

  return { genre, key, scale, tempo, bars: totalBars, seed, structure, progression, sections, tracks: out };
}

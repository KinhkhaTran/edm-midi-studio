// Music theory primitives: scales, extended chords, voice-leading, seeded randomness.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const SCALES = {
  minor:         [0, 2, 3, 5, 7, 8, 10],
  major:         [0, 2, 4, 5, 7, 9, 11],
  dorian:        [0, 2, 3, 5, 7, 9, 10],
  phrygian:      [0, 1, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  mixolydian:    [0, 2, 4, 5, 7, 9, 10],
  lydian:        [0, 2, 4, 6, 7, 9, 11],
};

export function noteToMidi(name, octave) {
  const idx = NOTE_NAMES.indexOf(name);
  if (idx === -1) throw new Error(`Unknown note name: ${name}`);
  return idx + (octave + 1) * 12;
}

// Scale degree (0-indexed, any integer incl. negative) -> MIDI pitch.
export function scalePitch(rootMidi, scaleName, degree) {
  const scale = SCALES[scaleName] || SCALES.minor;
  const oct = Math.floor(degree / scale.length);
  const idx = ((degree % scale.length) + scale.length) % scale.length;
  return rootMidi + oct * 12 + scale[idx];
}

// Snap an arbitrary MIDI pitch to the nearest scale note.
export function snapToScale(pitch, rootMidi, scaleName) {
  const scale = SCALES[scaleName] || SCALES.minor;
  const rel = ((pitch - rootMidi) % 12 + 12) % 12;
  let best = scale[0], bestDist = 12;
  for (const s of scale) {
    for (const cand of [s, s - 12, s + 12]) {
      const d = Math.abs(cand - rel);
      if (d < bestDist) { bestDist = d; best = cand; }
    }
  }
  return pitch + (best - rel);
}

// ---------------------------------------------------------------------------
// Chords: diatonic stacked thirds + quality-based extensions.
// A chord spec: { degree, quality, borrowed? } where quality picks intervals
// relative to the *diatonic* chord tones, so extensions stay in key.
// ---------------------------------------------------------------------------

// Which stacked-third offsets (in scale degrees above the chord degree) to include.
export const CHORD_QUALITIES = {
  triad:  [0, 2, 4],
  '7':    [0, 2, 4, 6],
  '9':    [0, 2, 4, 6, 8],
  '6':    [0, 2, 4, 5],
  add9:   [0, 2, 4, 8],
  sus2:   [0, 1, 4],
  sus4:   [0, 3, 4],
  '5':    [0, 4, 7],       // power chord + octave — big room sounds
  shell:  [0, 2, 6],       // root, third, seventh — jazzy and open
};

export function chordPitches(rootMidi, scaleName, spec) {
  const degree = typeof spec === 'number' ? spec : spec.degree;
  const quality = (typeof spec === 'object' && spec.quality) || 'triad';
  const offsets = CHORD_QUALITIES[quality] || CHORD_QUALITIES.triad;
  let pitches = offsets.map(o => scalePitch(rootMidi, scaleName, degree + o));
  // Modal interchange: flatten/raise specific chord tones for borrowed color.
  if (typeof spec === 'object' && spec.alter) {
    pitches = pitches.map((p, i) => p + (spec.alter[i] || 0));
  }
  return pitches;
}

// ---------------------------------------------------------------------------
// Voice leading: revoice a chord so each voice moves as little as possible
// from the previous voicing. Keeps progressions smooth instead of jumpy.
// ---------------------------------------------------------------------------

export function voiceLead(pitches, prevVoicing, center = 60) {
  if (!prevVoicing || !prevVoicing.length) {
    // First chord: park the voicing around the center.
    const centroid = pitches.reduce((a, b) => a + b, 0) / pitches.length;
    const shift = Math.round((center - centroid) / 12) * 12;
    return pitches.map(p => p + shift).sort((a, b) => a - b);
  }
  // For each chord tone choose the octave closest to any previous voice,
  // with a soft pull toward the center so voicings don't drift away.
  const voiced = pitches.map(p => {
    let best = p, bestScore = Infinity;
    for (let oct = -2; oct <= 2; oct++) {
      const cand = p + oct * 12;
      const nearest = Math.min(...prevVoicing.map(v => Math.abs(cand - v)));
      const score = nearest + Math.abs(cand - center) * 0.15;
      if (score < bestScore) { bestScore = score; best = cand; }
    }
    return best;
  });
  // Collapse unisons that can appear after octave folding.
  return [...new Set(voiced)].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Randomness & feel
// ---------------------------------------------------------------------------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rngHelpers = (rng) => ({
  pick: (arr) => arr[Math.floor(rng() * arr.length)],
  weighted: (pairs) => { // [[value, weight], ...]
    const total = pairs.reduce((a, [, w]) => a + w, 0);
    let r = rng() * total;
    for (const [v, w] of pairs) { r -= w; if (r <= 0) return v; }
    return pairs[pairs.length - 1][0];
  },
  chance: (p) => rng() < p,
  int: (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1)),
});

// Swing: delay every off-16th. amount 0..1 (0.55-0.62 is a musical MPC-ish zone).
export function swing16(start, amount) {
  if (!amount) return start;
  const pos = start % 0.5;
  return Math.abs(pos - 0.25) < 0.01 ? start + (amount - 0.5) * 0.5 : start;
}

// Velocity accent map for 16th grid positions within a beat (downbeat strongest).
export function grooveVel(start, base, rng) {
  const step = Math.round((start % 1) / 0.25) % 4;
  const accent = [1.0, 0.82, 0.92, 0.78][step];
  const jitter = (rng() - 0.5) * 10;
  return Math.max(20, Math.min(127, Math.round(base * accent + jitter)));
}

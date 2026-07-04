// Pattern state <-> Standard MIDI File, via @tonejs/midi.
// Exported .mid files drag straight into Ableton Live (or any DAW).

import MidiPkg from '@tonejs/midi';
import { DRUM_STEMS } from './generators.js';
const { Midi } = MidiPkg;

// Build a multitrack SMF from project state. `trackNames` filters which tracks to include.
export function stateToMidi(state, trackNames = null) {
  const midi = new Midi();
  midi.header.setTempo(state.tempo || 120);
  const ppq = midi.header.ppq;

  let channel = 0;
  for (const t of state.tracks) {
    if (trackNames && !trackNames.includes(t.name) && !trackNames.includes(t.id)) continue;
    const track = midi.addTrack();
    track.name = t.name;
    track.channel = DRUM_STEMS.has(t.type) ? 9 : channel++;
    if (channel === 9) channel++; // skip the GM drum channel for melodic tracks
    for (const n of t.notes) {
      track.addNote({
        midi: Math.max(0, Math.min(127, Math.round(n.pitch))),
        ticks: Math.max(0, Math.round(n.start * ppq)),
        durationTicks: Math.max(1, Math.round(n.dur * ppq)),
        velocity: Math.max(0.05, Math.min(1, (n.vel ?? 96) / 127)),
      });
    }
  }
  return Buffer.from(midi.toArray());
}

// Parse an uploaded .mid into project-state tracks (times converted to beats).
export function midiToState(buffer) {
  const midi = new Midi(buffer);
  const ppq = midi.header.ppq;
  const tempo = Math.round(midi.header.tempos[0]?.bpm ?? 120);

  const tracks = midi.tracks
    .filter(t => t.notes.length > 0)
    .map((t, i) => ({
      id: `import-${i}`,
      name: t.name || `Imported ${i + 1}`,
      type: t.channel === 9 ? 'drums' : 'lead',
      notes: t.notes.map(n => ({
        pitch: n.midi,
        start: n.ticks / ppq,
        dur: Math.max(0.05, n.durationTicks / ppq),
        vel: Math.round(n.velocity * 127),
      })),
    }));

  const lastBeat = Math.max(4, ...tracks.flatMap(t => t.notes.map(n => n.start + n.dur)));
  return { tempo, bars: Math.max(1, Math.ceil(lastBeat / 4)), tracks };
}

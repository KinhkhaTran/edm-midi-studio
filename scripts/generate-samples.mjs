import fs from 'node:fs';
import path from 'node:path';
import { generate } from '../lib/generators.js';
import { stateToMidi } from '../lib/midi.js';

const outDir = path.resolve('exports');
fs.mkdirSync(outDir, { recursive: true });

const presets = [
  { genre: 'melodic_house', key: 'A', scale: 'minor', structure: 'loop', seed: 240713 },
  { genre: 'future_rave', key: 'F#', scale: 'minor', structure: 'loop', seed: 240714 },
  { genre: 'afro_house', key: 'D', scale: 'dorian', structure: 'loop', seed: 240715 },
  { genre: 'tech_house', key: 'G', scale: 'minor', structure: 'loop', seed: 240716 },
];

for (const opts of presets) {
  const state = generate(opts);
  const stemCounts = Object.fromEntries(state.tracks.map(t => [t.id, t.notes.length]));
  if (!stemCounts.lead || !stemCounts.guide) throw new Error(`${opts.genre} missing lead/guide notes`);
  const filename = `${opts.genre}-${opts.key.replace('#', 'sharp')}-${state.tempo}bpm-${opts.seed}.mid`;
  fs.writeFileSync(path.join(outDir, filename), stateToMidi(state));
  console.log(`${filename} :: ${Object.entries(stemCounts).map(([k, v]) => `${k}:${v}`).join(' ')}`);
}

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { generate, GENRES, TRACK_TYPES } from './lib/generators.js';
import { stateToMidi, midiToState } from './lib/midi.js';
import { NOTE_NAMES, SCALES } from './lib/theory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3123;

// ---------------------------------------------------------------------------
// Pattern engine endpoints
// ---------------------------------------------------------------------------

app.post('/api/generate', (req, res) => {
  try {
    res.json(generate(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/export', (req, res) => {
  try {
    const { state, tracks } = req.body;
    const buf = stateToMidi(state, tracks || null);
    const label = tracks?.length === 1 ? tracks[0].toLowerCase() : 'all';
    const name = `${state.genre || 'pattern'}-${state.key || ''}${state.scale || ''}-${state.tempo}bpm-${label}.mid`;
    res.setHeader('Content-Type', 'audio/midi');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(buf);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/import', (req, res) => {
  try {
    const buf = Buffer.from(req.body.data, 'base64');
    res.json(midiToState(buf));
  } catch (err) {
    res.status(400).json({ error: 'Could not parse MIDI file: ' + err.message });
  }
});

app.get('/api/meta', (_req, res) => {
  res.json({
    genres: Object.fromEntries(Object.entries(GENRES).map(([k, g]) => [k, { label: g.label, bpm: g.bpm, scale: g.scale }])),
    keys: NOTE_NAMES,
    scales: Object.keys(SCALES),
    trackTypes: TRACK_TYPES,
    aiEnabled: Boolean(process.env.ANTHROPIC_API_KEY),
    renderEnabled: Boolean(process.env.REPLICATE_API_TOKEN),
  });
});

// ---------------------------------------------------------------------------
// Neural audio rendering: Stable Audio 2.5 via Replicate
// A render is a *produced interpretation* of the project's style — the MIDI
// stems remain the editable source of truth for Ableton.
// ---------------------------------------------------------------------------

const STABLE_AUDIO_VERSION = 'a61ac8edbb27cd2eda1b2eff2bbc03dcff1131f5560836ff77a052df05b77491';
const RENDERS_DIR = path.join(__dirname, 'public', 'renders');
fs.mkdirSync(RENDERS_DIR, { recursive: true });
const renderJobs = new Map(); // id -> { status, url?, error?, prompt }

const GENRE_RENDER_HINTS = {
  house: 'classic house, warm analog stabs, groovy shuffled hats, punchy sidechained kick',
  deep_house: 'deep house, smoky Rhodes-style chords, rolling sub bass, laid-back shuffle groove',
  techno: 'driving peak-time techno, rumbling bass, hypnotic percussion, dark warehouse atmosphere',
  trance: 'uplifting trance, supersaw chords, euphoric arpeggios, soaring lead melody',
  progressive: 'melodic progressive house, emotional plucks, wide pads, driving groove',
  melodic_house: 'modern melodic house like Lane 8 and Ben Boehmer inspiration, nostalgic extended chords, organic hook, emotional arp, warm piano guide melody',
  future_rave: 'modern future rave festival energy, detuned saw lead, dark minor progression, punchy offbeat bass, mainstage tension and release',
  tech_house: 'modern tech house club groove, rolling bassline, hypnotic vocal-like lead stab, tight shuffled percussion, DJ-ready loop',
  afro_house: 'afro organic house, syncopated percussion, warm minor/dorian harmony, marimba-like plucks, spacious emotional vocal-style lead',
  dubstep: 'heavy dubstep, aggressive wobble bass, cinematic tension, half-time drums',
  dnb: 'liquid drum and bass, fast breakbeats, deep reese bass, atmospheric pads',
  future_bass: 'future bass, lush detuned supersaw chord chops, bright plucks, punchy half-time drums',
  trap: 'dark trap, booming 808 glides, crisp hi-hat rolls, sparse haunting melody',
};

function buildRenderPrompt(state, extra = '') {
  const g = GENRES[state.genre];
  const hint = GENRE_RENDER_HINTS[state.genre] || 'electronic dance music';
  const parts = [
    `${g?.label || state.genre || 'EDM'} instrumental, ${state.tempo} BPM, ${state.key} ${state.scale}`,
    hint,
  ];
  if (state.sections?.length > 1) {
    parts.push('full arrangement: atmospheric intro, tension build with snare rolls and a riser, powerful main drop, stripped-back breakdown, bigger second drop, outro');
  }
  parts.push('professional club master, punchy low end, wide stereo image, clean mix');
  if (extra) parts.push(extra);
  return parts.join('. ');
}

async function runRenderJob(jobId, prompt, durationSec) {
  const job = renderJobs.get(jobId);
  try {
    const headers = {
      Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json',
    };
    const create = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST', headers,
      body: JSON.stringify({
        version: STABLE_AUDIO_VERSION,
        input: { prompt, duration: durationSec, steps: 8, cfg_scale: 6 },
      }),
    });
    const prediction = await create.json();
    if (!create.ok) throw new Error(prediction.detail || `Replicate error ${create.status}`);

    // Poll until terminal (typically well under 2 minutes).
    let result = prediction;
    const deadline = Date.now() + 5 * 60 * 1000;
    while (!['succeeded', 'failed', 'canceled'].includes(result.status)) {
      if (Date.now() > deadline) throw new Error('Render timed out');
      await new Promise(r => setTimeout(r, 2500));
      const poll = await fetch(result.urls.get, { headers });
      result = await poll.json();
    }
    if (result.status !== 'succeeded') throw new Error(result.error || `Render ${result.status}`);

    const audioUrl = Array.isArray(result.output) ? result.output[0] : result.output;
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) throw new Error('Could not download rendered audio');
    const ext = (new URL(audioUrl).pathname.match(/\.(mp3|wav|flac|ogg)$/i) || [, 'mp3'])[1];
    const filename = `render-${jobId}.${ext}`;
    fs.writeFileSync(path.join(RENDERS_DIR, filename), Buffer.from(await audioRes.arrayBuffer()));
    job.status = 'done';
    job.url = `/renders/${filename}`;
  } catch (err) {
    console.error('render job failed:', err);
    job.status = 'error';
    job.error = err.message;
  }
}

app.post('/api/render', (req, res) => {
  if (!process.env.REPLICATE_API_TOKEN) {
    return res.status(503).json({ error: 'Audio rendering is disabled — set the REPLICATE_API_TOKEN environment variable (get one at replicate.com/account/api-tokens) and restart.' });
  }
  const { state, stylePrompt } = req.body;
  if (!state) return res.status(400).json({ error: 'Missing project state' });
  const prompt = buildRenderPrompt(state, stylePrompt || '');
  const durationSec = Math.max(20, Math.min(190, Math.round((state.bars * 4 * 60) / state.tempo)));
  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  renderJobs.set(jobId, { status: 'running', prompt });
  runRenderJob(jobId, prompt, durationSec);
  res.json({ jobId, prompt, durationSec });
});

app.get('/api/render/:jobId', (req, res) => {
  const job = renderJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown render job' });
  res.json(job);
});

// ---------------------------------------------------------------------------
// AI chat: Claude with tool use, operating directly on the project state
// ---------------------------------------------------------------------------

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

const NOTE_SCHEMA = {
  type: 'object',
  properties: {
    pitch: { type: 'integer', description: 'MIDI pitch 0-127 (60 = middle C / C4). Drum tracks use GM pitches: 36 kick, 38 snare, 39 clap, 42 closed hat, 46 open hat, 51 ride, 70 shaker.' },
    start: { type: 'number', description: 'Start time in beats (quarter notes). Bar 1 starts at 0, bar 2 at 4. A 16th note step is 0.25.' },
    dur: { type: 'number', description: 'Duration in beats.' },
    vel: { type: 'integer', description: 'Velocity 1-127.' },
  },
  required: ['pitch', 'start', 'dur', 'vel'],
};

const TOOLS = [
  {
    name: 'set_params',
    description: 'Change project-level parameters: tempo, key, scale, genre, or bar count. Call this when the user asks to change tempo/key/genre. Does not regenerate any patterns by itself.',
    input_schema: {
      type: 'object',
      properties: {
        tempo: { type: 'integer', description: 'BPM, 60-200' },
        key: { type: 'string', enum: NOTE_NAMES },
        scale: { type: 'string', enum: Object.keys(SCALES) },
        genre: { type: 'string', enum: Object.keys(GENRES) },
        bars: { type: 'integer', enum: [4, 8] },
        structure: { type: 'string', enum: ['loop', 'song'], description: '"loop" = a short repeating pattern; "song" = a full arranged track (intro → build → drop → break → build → drop → outro, 72 bars).' },
      },
    },
  },
  {
    name: 'generate_tracks',
    description: 'Run the genre engine to (re)generate one or more tracks using current project params. Call this when the user wants fresh patterns, a new groove, or to regenerate a specific part. Pass a seed to make results reproducible; omit for a fresh random result.',
    input_schema: {
      type: 'object',
      properties: {
        tracks: { type: 'array', items: { type: 'string', enum: TRACK_TYPES }, description: 'Which track types to regenerate. Omit for all.' },
        seed: { type: 'integer', description: 'Optional RNG seed.' },
      },
    },
  },
  {
    name: 'write_notes',
    description: 'Write MIDI notes directly into a track — use this to compose custom melodies, basslines, chord voicings, or drum patterns yourself, note by note. mode "replace" clears the track first; "merge" adds to existing notes. Creates the track if it does not exist.',
    input_schema: {
      type: 'object',
      properties: {
        track: { type: 'string', description: 'Track name or id (e.g. "lead", "bass", or a new name like "Pluck 2").' },
        type: { type: 'string', enum: TRACK_TYPES, description: 'Track type — controls which synth previews it. Required when creating a new track.' },
        notes: { type: 'array', items: NOTE_SCHEMA },
        mode: { type: 'string', enum: ['replace', 'merge'], description: 'Default "replace".' },
      },
      required: ['track', 'notes'],
    },
  },
  {
    name: 'get_track_notes',
    description: 'Read the full note list of a track. Call this before modifying an existing pattern so you can build on what is there.',
    input_schema: {
      type: 'object',
      properties: { track: { type: 'string' } },
      required: ['track'],
    },
  },
  {
    name: 'remove_track',
    description: 'Delete a track from the project.',
    input_schema: {
      type: 'object',
      properties: { track: { type: 'string' } },
      required: ['track'],
    },
  },
  {
    name: 'render_audio',
    description: 'Start a neural audio render (Stable Audio 2.5) — a professionally-produced audio interpretation of the current project. Use when the user wants to hear a polished/produced/"real" version of the track. The render runs in the background (~1-2 min); the player appears in the UI when done. Pass style_prompt to steer the sound (textures, mood, reference vibes).',
    input_schema: {
      type: 'object',
      properties: {
        style_prompt: { type: 'string', description: 'Extra style direction appended to the auto-built prompt, e.g. "analog warmth, tape saturation, festival main-stage energy".' },
      },
    },
  },
];

function findTrack(state, ref) {
  const q = String(ref).toLowerCase();
  return state.tracks.find(t => t.id.toLowerCase() === q || t.name.toLowerCase() === q || t.type === q);
}

function summarizeState(state) {
  return {
    genre: state.genre, key: state.key, scale: state.scale, tempo: state.tempo,
    bars: state.bars, seed: state.seed, structure: state.structure,
    sections: state.sections?.map(s => `${s.name}@${s.start}+${s.bars}`),
    tracks: state.tracks.map(t => ({
      id: t.id, name: t.name, type: t.type, noteCount: t.notes.length,
      pitchRange: t.notes.length
        ? [Math.min(...t.notes.map(n => n.pitch)), Math.max(...t.notes.map(n => n.pitch))]
        : null,
    })),
  };
}

// Execute one tool call against the working state. Returns [resultString, actionSummary|null].
function runTool(name, input, state) {
  switch (name) {
    case 'set_params': {
      const applied = {};
      for (const k of ['tempo', 'key', 'scale', 'genre', 'bars', 'structure']) {
        if (input[k] !== undefined) { state[k] = input[k]; applied[k] = input[k]; }
      }
      return [JSON.stringify({ ok: true, applied }), `set ${Object.entries(applied).map(([k, v]) => `${k}=${v}`).join(', ')}`];
    }
    case 'generate_tracks': {
      const fresh = generate({
        genre: state.genre, key: state.key, scale: state.scale,
        tempo: state.tempo, bars: state.bars, seed: input.seed,
        structure: state.structure || 'loop',
        tracks: input.tracks,
      });
      state.seed = fresh.seed;
      state.progression = fresh.progression;
      state.bars = fresh.bars;
      state.sections = fresh.sections;
      for (const nt of fresh.tracks) {
        const idx = state.tracks.findIndex(t => t.id === nt.id);
        if (idx >= 0) state.tracks[idx] = nt; else state.tracks.push(nt);
      }
      const names = fresh.tracks.map(t => t.name).join(', ');
      return [JSON.stringify({ ok: true, regenerated: names, seed: fresh.seed, state: summarizeState(state) }), `regenerated ${names}`];
    }
    case 'write_notes': {
      let track = findTrack(state, input.track);
      if (!track) {
        track = { id: input.track.toLowerCase().replace(/\s+/g, '-'), name: input.track, type: input.type || 'lead', notes: [] };
        state.tracks.push(track);
      }
      const clean = input.notes.map(n => ({
        pitch: Math.max(0, Math.min(127, Math.round(n.pitch))),
        start: Math.max(0, n.start), dur: Math.max(0.05, n.dur),
        vel: Math.max(1, Math.min(127, Math.round(n.vel))),
      }));
      if ((input.mode || 'replace') === 'replace') track.notes = clean;
      else track.notes = [...track.notes, ...clean].sort((a, b) => a.start - b.start);
      return [JSON.stringify({ ok: true, track: track.name, noteCount: track.notes.length }), `wrote ${clean.length} notes to ${track.name}`];
    }
    case 'get_track_notes': {
      const track = findTrack(state, input.track);
      if (!track) return [JSON.stringify({ error: `No track "${input.track}". Tracks: ${state.tracks.map(t => t.name).join(', ')}` }), null];
      return [JSON.stringify({ track: track.name, type: track.type, notes: track.notes }), null];
    }
    case 'remove_track': {
      const track = findTrack(state, input.track);
      if (!track) return [JSON.stringify({ error: `No track "${input.track}"` }), null];
      state.tracks = state.tracks.filter(t => t !== track);
      return [JSON.stringify({ ok: true, removed: track.name }), `removed ${track.name}`];
    }
    case 'render_audio': {
      if (!process.env.REPLICATE_API_TOKEN) {
        return [JSON.stringify({ error: 'Rendering disabled: REPLICATE_API_TOKEN is not set. Tell the user to add a Replicate API token.' }), null];
      }
      const prompt = buildRenderPrompt(state, input.style_prompt || '');
      const durationSec = Math.max(20, Math.min(190, Math.round((state.bars * 4 * 60) / state.tempo)));
      const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      renderJobs.set(jobId, { status: 'running', prompt });
      runRenderJob(jobId, prompt, durationSec);
      state.renderJobId = jobId; // frontend picks this up and polls
      return [JSON.stringify({ ok: true, jobId, prompt, note: 'Render started; takes ~1-2 minutes. The player appears in the UI automatically.' }), `render started (${durationSec}s of audio)`];
    }
    default:
      return [JSON.stringify({ error: `Unknown tool ${name}` }), null];
  }
}

const SYSTEM_PROMPT = `You are the resident producer inside Loopsmith, an EDM MIDI sketching studio. The user builds loops here, previews them in the browser, and exports .mid files into Ableton Live.

You work on the project through tools — every change you make is applied to the user's session immediately and they will hear it on the next play. Prefer acting over describing: when the user asks for music, make it, then briefly say what you did and why it fits.

Musical context:
- Times are in beats (quarter notes). One bar = 4 beats. A 16th step = 0.25. The project is bars × 4 beats long.
- Stems: kick, snare, hats, perc (GM drum pitches: 36 kick, 38 snare, 39 clap, 42 closed hat, 46 open hat, 51 ride, 54 tamb, 63/64 congas, 70 shaker, 75 clave), plus sub, bass, chords, pads, arp, lead, counter, and fx (risers/impacts).
- structure "song" = a full arranged track with sections (intro → build → drop → break → build → drop → outro); "loop" = a short repeating pattern. The project_state lists sections as name@startBar+length.
- The genre engine (generate_tracks) produces idiomatic, arranged material fast; write_notes gives you full authorship. Use write_notes when the user asks for something specific (a melody idea, a chord voicing, a fill, a variation) and generate_tracks for broad "give me a groove / full track" requests.
- Before editing an existing pattern, call get_track_notes so you build on it instead of guessing. In song mode a stem's notes span the whole arrangement — when writing a melody by hand, write 8 bars and tell the user it lands where that stem plays.
- Composition craft: build melodies from a repeated motif with variations (repeat, transpose to the next chord, ornament, invert), land strong beats on chord tones, place the climax note late in the phrase, and resolve to root or fifth. Use extensions (7ths/9ths/sus) for warmth. Keep basslines mostly monophonic and below MIDI 48.

When the user wants to hear a polished, produced, "real" version of the track (not the browser synth preview), call render_audio — it sends the project's style to Stable Audio 2.5 and returns studio-quality audio. Add a style_prompt describing textures and mood. Remind them the MIDI stems stay the editable source for Ableton.

When the user asks about production techniques, sound design, or Ableton workflow, answer directly — you don't need tools for advice. Keep replies tight: a couple of sentences on what changed, one production tip max.`;

app.post('/api/chat', async (req, res) => {
  if (!anthropic) {
    return res.status(503).json({
      error: 'AI chat is disabled — set the ANTHROPIC_API_KEY environment variable and restart the server.',
    });
  }
  try {
    const { history = [], message, state } = req.body;
    const workingState = structuredClone(state);
    const actions = [];

    // Prior turns come back as plain text; tool blocks live only within a single request.
    const messages = [
      ...history.map(m => ({ role: m.role, content: m.text })),
      {
        role: 'user',
        content: `${message}\n\n<project_state>\n${JSON.stringify(summarizeState(workingState))}\n</project_state>`,
      },
    ];

    let reply = '';
    for (let turn = 0; turn < 12; turn++) {
      const response = await anthropic.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 8000,
        thinking: { type: 'adaptive' },
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });

      if (response.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content });
        const results = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;
          let result, action;
          try {
            [result, action] = runTool(block.name, block.input, workingState);
          } catch (err) {
            result = JSON.stringify({ error: err.message });
          }
          if (action) actions.push(action);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        }
        messages.push({ role: 'user', content: results });
        continue;
      }

      reply = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      break;
    }

    res.json({ reply: reply || '(done)', state: workingState, actions });
  } catch (err) {
    console.error('chat error:', err);
    const status = err.status && err.status >= 400 ? err.status : 500;
    res.status(status).json({ error: err.message || 'Chat request failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Loopsmith running at http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('Note: ANTHROPIC_API_KEY not set — AI chat panel will be disabled.');
  }
});

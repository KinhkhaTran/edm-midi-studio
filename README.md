# Loopsmith — EDM MIDI Studio

A local web studio for sketching EDM loops: genre-aware MIDI generation, instant audio
preview in the browser, an AI producer chat that edits your patterns directly, and
`.mid` export that drags straight into Ableton Live.

## Quick start

```sh
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # optional — enables the AI chat panel
npm start
# open http://localhost:3123
```

Without `ANTHROPIC_API_KEY` everything works except the chat panel.

## What it does

- **Composition engine** — house, deep house, techno, trance, progressive, melodic house,
  future rave, tech house, afro/organic house, dubstep, drum & bass, future bass, trap.
  Motif-based melodies (A A' B A'' phrase structure, chord-tone
  targeting, climax placement, resolution), counter-melodies that answer in the lead's gaps,
  extended harmony (7ths/9ths/sus/add9/shell voicings) with real voice leading, bass
  archetypes with chromatic approach notes, swing/groove velocity maps. Seeded RNG: the same
  seed always reproduces the same track.
- **Modern hook generator** — newer style presets write the chords first, use visible chord
  tones as rails for the melody, repeat a two-bar hook, ornament connectors, place the climax
  late, then resolve. Every modern preset also exports a **Piano Hook Guide** stem so you can
  drag a simple piano melody into Ableton even before synth/sound design is finished.
- **Full song arrangement** — intro → build → drop → break → build → drop → outro (72 bars)
  with per-section energy masks, accelerating snare rolls, risers, impacts, downlifters, and
  a counter-melody that only enters on the second drop. Or generate a plain loop.
- **12 stems** — kick, snare/clap, hats, percussion, sub bass, bass, chords, pads, arp, lead,
  counter, FX. Each exports as its own MIDI track.
- **Audio preview with a real mix** — layered synthesis (supersaw stacks, FM plucks, 808 with
  drive, wobble bass with synced filter LFO, sine sub), sidechain pump under every kick,
  reverb/delay sends, and a mastering chain (HP → EQ → glue compressor → saturation →
  limiter). Space bar toggles play; click a section in the timeline to jump there.
- **AI chat** — Claude (Opus 4.8) with tool use. It can change tempo/key/genre, regenerate
  tracks through the engine, read your patterns, and write custom notes directly
  (melodies, chord voicings, fills). Every change lands in the UI immediately.
- **MIDI I/O** — export the whole loop as a multitrack `.mid` or any single track; import
  existing `.mid` files to preview and rework them.

## Neural audio renders (Stable Audio 2.5)

The **✦ Render** button (or asking the AI to "render a produced version") sends your
project's style — genre, BPM, key, arrangement arc, plus any style prompt — to
Stability's official **Stable Audio 2.5** model on Replicate and returns studio-quality
audio (~$0.20 and ~1–2 min per render, up to 190 s).

```sh
export REPLICATE_API_TOKEN=r8_...   # replicate.com/account/api-tokens
```

The render is a produced *interpretation* of your track's style — it won't note-for-note
match the MIDI. The stems remain the editable source of truth for Ableton; the render is
the "how it could sound fully produced" reference.

## Ableton workflow

1. Generate / chat until the loop sounds right.
2. **Export .mid** (whole project) or `⤓ mid` on a single lane.
3. Drag the file into Ableton — each track arrives as its own MIDI clip. Drums use GM
   pitches, so they map cleanly onto a Drum Rack.
4. Start with **Piano Hook Guide** if you only need inspiration: put Ableton Piano/Keys on it,
   then layer the Lead MIDI into Serum/Vital/stock Wavetable once the melody feels right.
5. Swap the sketch synths for your own instruments and arrange.

## Research notes baked into the generator

This pass used current EDM production sources and YouTube transcripts as design constraints:

- **EDM lead writing**: start by laying down the chord progression, then use the chord notes as
  ghost notes/rails for the lead so the melody stays in key while still allowing flashy passing
  notes and connectors. The hook should feel catchy through rhythm + repetition first, not just
  random scale motion.
- **Melodic house**: reference-track structure, 8-bar sections, four-on-the-floor kick, simple
  long-note bass movement, nostalgic extended chords, arps, organic leads, delay/reverb space,
  and percussion that grows after the core idea is established.
- **Progressive/festival EDM**: detuned saw/add9/sus harmony, late-phrase climax notes, call and
  response, and a clear resolution so the exported MIDI points you toward a usable drop lead.

Useful commands:

```sh
npm test       # syntax checks + writes sample Ableton-ready MIDI files to exports/
npm run samples
```

## Architecture

```
server.js          Express: engine endpoints + Claude chat (tool-use loop)
lib/theory.js      scales, chords, voice-leading, seeded RNG
lib/generators.js  genre definitions + drum/bass/chord/arp/lead builders
lib/midi.js        pattern state <-> Standard MIDI File (@tonejs/midi)
public/            UI: canvas piano rolls, Tone.js playback, chat panel
```

Pattern state is plain JSON — notes are `{ pitch, start, dur, vel }` with times in beats —
so it's easy to extend (new genres, new tools for the AI, new export targets).

## Roadmap: driving Ableton directly (MCP)

The natural next step is wiring this to [ahujasid/ableton-mcp](https://github.com/ahujasid/ableton-mcp),
an existing MCP server + Ableton Remote Script that exposes Live over a local socket
(create tracks, write clips, load instruments, set tempo). Two integration paths:

1. **Loopsmith as an MCP client** — add a "Send to Ableton" button that pushes the current
   pattern state into Live as clips via the ableton-mcp socket protocol, skipping the
   file drag entirely.
2. **Loopsmith as an MCP server** — expose the genre engine itself as MCP tools
   (`generate_pattern`, `export_midi`) so Claude Desktop / Claude Code can use it alongside
   ableton-mcp in one session: generate here, place into Live there.

Both reuse `lib/generators.js` and `lib/midi.js` unchanged.

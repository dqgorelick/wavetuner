---
name: verify
description: Build/launch/drive recipe for verifying wavetuner changes live in a headless browser
---

# Verifying wavetuner changes

Web-audio synth (React + vite). No test suite worth running for UI/engine
behavior — verify by driving the real app in headless Chrome.

## Launch

- The user's own dev server often runs on 5173/5174 — NEVER touch those, and
  never `pkill -f vite` (it killed the user's server once). Kill by port PID.
- Run your own: `npx vite --port 5175 --strictPort` (background).

## Drive (puppeteer-core)

- `npm i puppeteer-core` in the scratchpad; launch
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` with
  `headless: 'new'`, a `mkdtempSync` userDataDir (fresh localStorage = default
  user), and `--autoplay-policy=no-user-gesture-required`.
- First click the **Start** button (audio graph is down until then; most
  panels, including `.scope-chip`, only render after it).
- Console-test handles on `window` (see src/main.jsx): `audioEngine`, `tuning`,
  `kbd` (KeyboardVoiceManager), `midi`, `midiOut`, `fm` (FrequencyManager),
  `conductor`. Use them to observe state; drive actions through the DOM.
- Simulate a controller-held note: `kbd.spawnVoiceAt(hz, {source:'midi'})`
  (latched — no hardware needed).

## Gotchas

- Computer-kbd notes (page.keyboard down 'a'/'d') do NOT release on keyup —
  the expressive-ramp mechanic freezes them. Release via the mixer voice rows:
  click `.mixer-row-voice:not(.released) .mixer-btn-mute`.
- Default recall glide is 2750 ms and note-offs are DEFERRED to glide end —
  wait ≥4 s after GO before counting voices.
- `page.reload()`/`goto()` hangs once audio is running (30 s nav timeout).
  For reload-style probes (localStorage migration), seed storage in one page,
  close it, and open a fresh `browser.newPage()`.
- Opening panels: `localStorage.tuningOpen='1'` (set + reload before Start) —
  but note the app re-persists panel state on mount, so set it in the SAME
  page you'll use, not a throwaway seed page.
- Useful selectors: `.scope-chip` (params tracked), `.cap-slot-wrap.empty/.filled
  .cap-slot-main` (save slots), `.cap-slot-notes` (♪ badge), `.cap-launch`
  (GO = the one with text 'GO'), `.mixer-row-voice` / `.mixer-row-drone`.
- GO's disabled attr mirrors `fm.stagedIsDirty()` — a cheap observable for
  "does the recall see a difference".

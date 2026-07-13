# Wavetuner

## Save states, transitions, and held notes — design position (2026-07-05)

- **The core UI serves drone transitions.** Save states, the capture bar,
  and the generative transition engine (GENERATIVE.md) are about moving the
  ≤ 12 loaded drone voices between chords — that's the primary instrument
  and what the visible UI should stay focused on. The current UI is already
  dense; new surface area should earn its place.
- **Held-note saves (HELD_NOTES.md) are a super-user layer.** Capturing
  notes played on the computer keyboard or a MIDI controller into save
  states is for players who perform on top of the drones. What it buys:
  saves can hold pitches in octaves *outside the spectrum bar's visible
  range* — the drone slots show one register, held notes extend the chord
  beyond it.
- **Capture is unconditional, application is scoped.** Every save is a
  lossless photograph (drones + held chord); the tracked-parameters list
  (PARAMETER_LOCK.md) decides what a recall *applies*. The future `notes`
  toggle — off by default — is the switch between "saves steer the drone
  landscape, playing stays live on top" and "saves are consolidated
  performance states." Turning it on later retroactively animates old
  saves' held chords, since capture never skipped them.
- Status: held-note **capture and recall are built** (snapshots, save
  slots and patches carry the chord; the ♪-count badge on capture-bar
  numerals shows it; enable the "notes ♪" chip in the tuning menu's
  tracked parameters and GO/undo replay the chord — missing notes attack,
  surplus notes release at the recall's end). Voice-led *transitions* over
  held notes and the spectrum-bar markers are specced in HELD_NOTES.md
  but not yet implemented.

---

# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

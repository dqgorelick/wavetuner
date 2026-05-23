# Floating / dockable windows

Spec for a macOS-inspired window system where panels can be dragged around,
snap to screen edges/corners (and eventually to each other), and toggle
between a docked CSS-slot layout and a free-floating layout. Behavior-only
spec — no visual design decisions yet.

## Goal

Each window has:
- A **drag handle** (top bar).
- A **dock/undock button** to switch modes deterministically.

Two modes per window:
- **Docked** — current behavior. Panel lives inside a CSS-defined slot
  (`.left-stack`, `.right-stack`, etc.). Layout managed by existing rules.
- **Floating** — absolutely positioned at user-controlled coordinates,
  draggable, snaps to viewport edges/corners and (eventually) to other
  floating windows.

## Scope (v1)

- Only `Mixer` and `TuningPanel` get the floating/dock treatment.
- Other panels (`SettingsPanel`, `HydraPanel`, `PatchesPanel`, `KeyboardTray`)
  keep current behavior — no chrome, no drag.
- Mobile (`isMobile === true`): force docked, hide the dock toggle entirely.
  Same code path the iOS port inherits.

## Architecture

A single generic wrapper `<FloatingWindow id="mixer" defaultDock="right-stack">`
that:

1. Reads/writes per-window state from a `useWindowState(id)` hook backed by
   `localStorage` (`{ mode, x, y, snap, z }`).
2. When `mode === 'docked'`: renders children inline so the existing CSS slot
   (`.right-stack > .mixer-panel`) keeps working — zero layout change.
3. When `mode === 'floating'`: renders into a portal (`#window-layer`),
   `position: fixed; left: x; top: y`, with pointer drag handlers on the
   title bar.
4. Exposes a `<WindowChrome />` slot — the title bar + dock/undock button —
   that panels render at the top of their content.

This keeps the existing CSS for docked mode untouched. Only adds new code
paths.

## State model

```ts
// One entry per window id, persisted to localStorage as a single blob
// under key `windowLayout`.
type WindowState = {
  mode: 'docked' | 'floating';
  x: number; y: number;          // floating only, in px from viewport top-left
  w?: number; h?: number;        // optional — panels are content-sized for now
  snap?: 'left' | 'right' | 'top' | 'bottom'
       | 'tl' | 'tr' | 'bl' | 'br' // corner snaps
       | null;                     // null = free-floating
  z: number;                      // last-focused window gets max+1
};
```

Snap value drives positioning, not raw x/y, so a resized viewport keeps a
snapped window pinned to the same edge. Free-floating windows store
absolute pixels (and on resize, get clamped back on-screen).

Mobile read ignores `mode` and forces `docked`.

## Drag + snap behavior

- Pointer-down on the title bar starts a drag. If currently docked, the first
  drag implicitly undocks (transitions `mode: 'floating'`, captures the docked
  panel's bounding rect as start position so it doesn't teleport).
- During drag, compute candidate snap targets:
  - **Viewport edges**: within 12px → snap edge, full-height/width along that
    edge.
  - **Viewport corners**: within 24px of a corner (Apple-style "magic corner"
    priority over edges) → corner snap.
  - **Other floating windows** (v2): within 8px of an opposing edge → align
    edges. v1 ships without this — keep snap logic small and easy to read.
- Render a translucent preview rect at the candidate snap region during drag
  (simple outline, no aesthetic decisions yet).
- Release → commit snap or land at free coordinates.

## Dock button

Independent from the drag — clicking the dock toggle in the chrome either:

- If floating → return to the panel's `defaultDock` slot. The last floating
  position (`x`, `y`, `snap`) is preserved in state, not cleared, so the
  next undock restores exactly where the user left it.
- If docked → undock to the last-known floating position and snap state. On
  first-ever undock (no remembered coords), use a sensible default offset
  from the dock location.

This gives users a deterministic "put it back" round-trip — dock and undock
become opposites that don't lose layout work.

## Focus / z-order

Pointer-down on any floating window calls `bringToFront(id)` which assigns
it `z = ++topZ`. Docked windows stay at their CSS-defined z-index. Single
shared counter in the manager.

## Constraints

- Mobile (width ≤ 768px): force `mode: 'docked'`, hide undock button.
  Floating windows on a phone are a usability dead end. Same path the iOS
  port will use.
- Off-screen recovery: on mount and on `window.resize`, clamp floating
  x/y so at least the title bar stays in view.
- The `kbd-tray-open` class currently shifts bottom-anchored docked panels
  up — floating windows should be unaffected, *unless* snapped to bottom,
  in which case they should respect the tray height too.

## Files to add / change

**New**
- `src/components/FloatingWindow.jsx` — wrapper that handles drag, snap, and
  mode switching. Renders into a portal when floating; renders inline when
  docked.
- `src/components/WindowChrome.jsx` — the title bar (drag handle +
  dock/undock button). `Mixer` and `TuningPanel` render this at their top.
- `src/state/windowManager.js` — `useWindowState(id, defaults)` hook +
  localStorage persistence under key `windowLayout`.

**Modified**
- `App.jsx`: wrap the two panels:
  ```
  <FloatingWindow id="tuning" defaultDock="left-stack">
    <TuningPanel ... />
  </FloatingWindow>
  <FloatingWindow id="mixer" defaultDock="right-stack">
    <Mixer ... />
  </FloatingWindow>
  ```
- `Mixer.jsx` + `FrequencyManager.jsx` (TuningPanel): add
  `<WindowChrome title="Mixer" />` / `<WindowChrome title="Tuning" />` at
  the top of the panel content. No other internal changes.
- `App.css`: add `.window-floating`, `.window-chrome`, `.window-snap-preview`
  rules. Leave `.left-stack` / `.right-stack` / `.mixer-panel` /
  `.tuning-panel` alone — they only apply in docked mode.

## Relationship to the iOS port

The iOS port inherits the **docked** layout path exactly as-is. The floating
mode is a desktop-only progressive enhancement; mobile and the iOS port
never see it. This lets us iterate on window-management on web without
blocking the port or introducing iOS-specific drag/snap code.

## Open questions

1. Snap-to-each-other in v1, or just edges/corners? Punting to v2 keeps the
   snap logic small.

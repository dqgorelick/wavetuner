/**
 * Palette - Singleton color theme for oscillator orbs and per-osc UI.
 *
 * Three themes:
 *   'duo' (default) - sparse two-accent layout. Index 0 is blue; one
 *     orange position lands at the spot furthest from blue (Euclidean
 *     round(N/2), with a music-theory tweak at N=12 → index 7 for the
 *     perfect fifth). All other slots are white. Both accents are
 *     guaranteed regardless of oscillator count, so even an N=2 patch
 *     reads as a clear blue/orange pair.
 *   'classic' - the original 12-color rainbow palette.
 *   'mono' - the orbs are the whole show, and the UI has NO hue in it at
 *     all. Every voice draws the same neutral, the chrome is capped at a
 *     mid gray by the --ink-rgb token (spent at ~440 sites in App.css),
 *     and voices are told apart by their numbers and their position, not
 *     by color. Only the visualizer keeps its own palette — it's the
 *     art, not the chrome.
 *   'simple' - mono's chrome with the controls reduced to LINES. No dots
 *     or balls anywhere: the pan pots read from a radial tick, the
 *     faders from their fill's rounded end, the master meter is two
 *     thin capsules. Labels retreat to the edges, the ruler thins out,
 *     the frequency menus drop their outlines. The NON-voice chrome
 *     inherits mono's gray cap (monoLike below), but every per-voice
 *     site — orbs AND the console lanes under them — draws the full
 *     classic spectrum (Dan, round 4: "the full spectrum, not just
 *     the duo").
 *
 * Two color roles, because mono splits what the other two themes fuse:
 *   oscColor - the general per-voice color. Chrome: note readouts,
 *              faders, pan dots, patch bay, keyboard glow.
 *   orbColor - the orb glyph and its drag readout specifically. Same as
 *              oscColor except in mono, where it stays bright while the
 *              chrome recedes — that gap IS the theme.
 *
 * Singleton with a subscribe pattern, mirroring `tuning` / `audioEngine`
 * so non-React callers (canvas rAF loops) can read the active theme
 * synchronously without prop drilling. React components subscribe via
 * `useTheme()` to re-render when the theme changes.
 */
import { useEffect, useState } from 'react';

export const CLASSIC_PALETTE = [
  '#ff4136', '#2ecc40', '#0074d9', '#ffdc00', '#bb8fce',
  '#85c1e9', '#82e0aa', '#f8b500', '#e74c3c', '#1abc9c',
  '#ff7eb6', '#a78bfa',
];

// Duo accents. Blue is the primary (always at index 0); orange is the
// secondary (always at the round(N/2) Euclidean spot, regardless of
// count). White is the "rest" color — soft enough not to compete with
// accents but bright enough to read against the dark UI background.
export const DUO_BLUE   = '#4a9eff';
export const DUO_ORANGE = '#ff8c1a';
export const DUO_WHITE  = '#e8edf5';

// Mono neutrals.
//   MONO_ORB    - the orb glyph. The brightest thing in the theme; sits
//                 well above the chrome cap so the orbs read as lit.
//   MONO_CHROME - every other per-voice site, mute cells included.
//                 Deliberately at the ink cap so a fader ball can't
//                 out-shout the orb it belongs to.
export const MONO_ORB    = '#ebebeb';
export const MONO_CHROME = 'rgba(150, 150, 150, 0.9)';

// The ink cap each theme imposes on the chrome, mirrored onto <body> as
// --ink-rgb. duo and classic keep the historical pure white (so they
// render exactly as they always did); mono is the whole point.
const INK_RGB = {
  duo: '255, 255, 255',
  classic: '255, 255, 255',
  mono: '150, 150, 150',
  simple: '150, 150, 150',
};

const VALID_THEMES = new Set(['duo', 'classic', 'mono', 'simple']);

/**
 * Blend a #rrggbb hex toward white by `amt` (0..1), returning plain hex.
 * Plain hex on purpose: oscColor feeds canvas strokeStyle in places, so
 * the brightened palette can't lean on CSS color-mix() strings.
 */
function lighten(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift) => {
    const c = (n >> shift) & 0xff;
    return Math.round(c + (255 - c) * amt).toString(16).padStart(2, '0');
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

// simple wears the classic hues one step brighter (Dan, round 5: the
// straight classic hexes read subdued there — the theme's washes and
// line-weight dims pull harder than classic's chunkier controls do).
const SIMPLE_PALETTE = CLASSIC_PALETTE.map((c) => lighten(c, 0.18));

/**
 * Is `t` a theme this palette knows? Exported so the URL parser can
 * validate `?t=` against the same set setTheme enforces, rather than
 * keeping its own copy of the list.
 */
export function isValidTheme(t) {
  return VALID_THEMES.has(t);
}

/**
 * Compute the index where the second accent (orange) should land.
 * Closed-form Euclidean placement for K=2 pulses in N positions:
 * position k = round(k * N / K). Pulse 0 is at index 0; pulse 1 lands
 * at round(N/2), giving a roughly half-and-half split.
 *
 * Musical exception at N=12: the strict Euclidean answer is index 6
 * (the tritone). Shift to index 7 — the perfect fifth — since a
 * 12-note layout reads as a chromatic octave and the fifth is the
 * natural "second voice" landmark. Trades perfect symmetry for a
 * harmonically meaningful split.
 */
function secondAccentIndex(count) {
  if (count === 12) return 7;
  return Math.round(count / 2);
}

function duoAccent(index, count, rest) {
  if (index === 0) return DUO_BLUE;
  if (index === secondAccentIndex(count)) return DUO_ORANGE;
  return rest;
}

class Palette {
  constructor() {
    if (Palette.instance) return Palette.instance;
    this._theme = 'duo';
    this._listeners = new Set();
    Palette.instance = this;
    this._stamp();
  }

  get theme() { return this._theme; }

  /**
   * The themes with the gray CHROME cap (--ink-rgb at 150). Covers the
   * non-voice decisions the two share — the desaturated accents, the
   * ink-level master meter, the capped consonance field. It says
   * nothing about VOICE color anymore: mono's voices are gray, simple's
   * carry the classic spectrum — oscColor/orbColor branch per theme.
   */
  get monoLike() { return this._theme === 'mono' || this._theme === 'simple'; }

  /**
   * Mirror the active theme onto <body> — `data-theme` for CSS hooks and
   * `--ink-rgb` for the chrome cap. Done here rather than in a React
   * effect so the URL-restore path (which calls setTheme before mount)
   * and non-React callers land the same styling.
   */
  _stamp() {
    if (typeof document === 'undefined' || !document.body) return;
    document.body.dataset.theme = this._theme;
    document.body.style.setProperty('--ink-rgb', INK_RGB[this._theme]);
  }

  setTheme(t) {
    if (!VALID_THEMES.has(t)) return;
    if (this._theme === t) return;
    this._theme = t;
    this._stamp();
    for (const fn of this._listeners) {
      try { fn(); } catch (e) { console.error('Palette listener error', e); }
    }
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /**
   * Resolve the color for oscillator `index` given a total `count`.
   * `count` matters for the duo theme — the orange accent only appears
   * at count ≥ 5, and its position depends on N.
   */
  oscColor(index, count) {
    // simple: full-spectrum voices over the gray chrome — the console
    // lanes, faders and pan ticks carry the classic colors (lightened a
    // step) while the non-voice chrome stays capped (Dan, rounds 4–5).
    if (this._theme === 'simple') {
      return SIMPLE_PALETTE[index % SIMPLE_PALETTE.length];
    }
    if (this._theme === 'classic') {
      return CLASSIC_PALETTE[index % CLASSIC_PALETTE.length];
    }
    if (this._theme === 'mono') return MONO_CHROME;
    return duoAccent(index, count, DUO_WHITE);
  }

  /**
   * The orb glyph and its drag readout. Identical to oscColor except in
   * mono, where the orbs hold a bright neutral above the gray chrome.
   * (simple's round-3 duo accents became round-4 "full spectrum" — now
   * just oscColor, same as duo/classic.)
   */
  orbColor(index, count) {
    if (this._theme === 'mono') return MONO_ORB;
    return this.oscColor(index, count);
  }

  /**
   * The ink token as a concrete rgba string, for canvas callers that
   * can't spend the CSS variable (they hand strings to strokeStyle).
   */
  ink(alpha = 1) {
    return `rgba(${INK_RGB[this._theme]}, ${alpha})`;
  }
}

const palette = new Palette();
export default palette;

/**
 * React hook — subscribe to palette changes so the calling component
 * re-renders when the theme flips. Returns the current theme name for
 * convenience (most callers don't need it; they just call
 * `palette.oscColor(...)` after the rerender).
 */
export function useTheme() {
  const [theme, setThemeState] = useState(palette.theme);
  useEffect(() => palette.onChange(() => setThemeState(palette.theme)), []);
  return theme;
}

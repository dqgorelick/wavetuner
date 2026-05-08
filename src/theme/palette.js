/**
 * Palette - Singleton color theme for oscillator orbs and per-osc UI.
 *
 * Two themes:
 *   'duo' (default) - sparse two-accent layout. Index 0 is blue; one
 *     orange position lands at the spot furthest from blue (Euclidean
 *     round(N/2), with a music-theory tweak at N=12 → index 7 for the
 *     perfect fifth). All other slots are white. Both accents are
 *     guaranteed regardless of oscillator count, so even an N=2 patch
 *     reads as a clear blue/orange pair.
 *   'classic' - the original 12-color rainbow palette.
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

const VALID_THEMES = new Set(['duo', 'classic']);

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

class Palette {
  constructor() {
    if (Palette.instance) return Palette.instance;
    this._theme = 'duo';
    this._listeners = new Set();
    Palette.instance = this;
  }

  get theme() { return this._theme; }

  setTheme(t) {
    if (!VALID_THEMES.has(t)) return;
    if (this._theme === t) return;
    this._theme = t;
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
    if (this._theme === 'classic') {
      return CLASSIC_PALETTE[index % CLASSIC_PALETTE.length];
    }
    if (index === 0) return DUO_BLUE;
    if (index === secondAccentIndex(count)) return DUO_ORANGE;
    return DUO_WHITE;
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

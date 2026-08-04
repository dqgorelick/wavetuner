// Pitch math for the per-voice frequency panel — web port of the iOS
// PitchMath helpers (wavetuner-native: Models/PitchMath.swift). Kept as
// its own module (rather than growing noteFormat.js) so the panel work
// stays self-contained; noteFormat.js remains the readout-formatting
// home and FrequencyManager.jsx still carries its own richer parse set
// (flagged there as a pending dedup).

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Nearest MIDI note + signed cents deviation for a frequency.
 *  Returns { midi, cents } with cents unrounded (callers round for
 *  display but keep the exact value for cents-preserving commits). */
export function freqToMidiAndCents(freq) {
  if (!Number.isFinite(freq) || freq <= 0) return { midi: 69, cents: 0 };
  const exact = 69 + 12 * Math.log2(freq / 440);
  const midi = Math.max(0, Math.min(127, Math.round(exact)));
  return { midi, cents: (exact - midi) * 100 };
}

export function noteName(midi) {
  const pc = ((midi % 12) + 12) % 12;
  return `${NOTE_NAMES[pc]}${Math.floor(midi / 12) - 1}`;
}

/** Keypad buffer → Hz. Accepts a bare number with an optional trailing
 *  "hz" (case-insensitive). Returns null on anything non-positive or
 *  non-finite — the caller shows the invalid state and keeps the pane
 *  open (iOS setFromBuffer rule). */
export function parseHz(text) {
  const t = String(text).trim().replace(/hz$/i, '').trim();
  if (!t) return null;
  const v = Number(t);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Buffer-seeding format (iOS PitchMath.formatHz): precision steps down
 *  as the value grows so the string stays short but round-trips. */
export function formatHz(hz) {
  if (!Number.isFinite(hz) || hz <= 0) return '';
  if (hz >= 1000) return hz.toFixed(1);
  if (hz >= 100) return hz.toFixed(2);
  return hz.toFixed(3);
}

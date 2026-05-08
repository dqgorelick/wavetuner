/**
 * Tuning - Shared scale derived from the drone's frequency list.
 *
 * The drone's currently-active oscillator frequencies, sorted ascending,
 * become the scale degrees. Mute is intentionally ignored — to remove a
 * pitch from the keyboard, reduce the drone's oscillator count instead.
 * No octave folding, no dedup: two drones at 100/102 Hz become two
 * adjacent scale degrees so beating intent is preserved when both keys
 * are held.
 *
 * Live re-sort: whenever any drone freq changes (or osc count changes),
 * the scale is recomputed and listeners are notified. KeyboardVoiceManager
 * subscribes to push retunes into held voices.
 *
 * MIDI mapping: scale-degree, with `rootMidi` as scale-degree-0 of
 * keyboard-octave-0. degree = (midi - rootMidi) mod N; octave = floor of
 * the same. Held voices store (degree, octave) and re-derive their freq
 * via `pitchForDegreeAndOctave` whenever the scale changes.
 */

import audioEngine from './AudioEngine';

// Standard piano white-key semitone offsets within an octave starting at C.
// Used by white-only key-mapping mode to filter MIDI notes to white keys
// only and to compute a sequential "white key index" for fill mode.
const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11];
const WHITE_INDEX_IN_OCTAVE = (() => {
  const m = {};
  WHITE_OFFSETS.forEach((semi, i) => { m[semi] = i; });
  return m;
})();

class Tuning {
  constructor() {
    if (Tuning.instance) return Tuning.instance;

    this._listeners = new Set();
    this._sorted = [];          // ascending freq list
    this._sortedToSlot = [];    // sorted index → original drone slot index
    this._rootMidi = 60;        // C4. Hardcoded for v1; user-settable later.

    // Key-mapping picker state. Both default to the most permissive
    // option so the keyboard works "fully" out of the box; toggling the
    // pickers in Settings narrows the playable keys.
    this._keyMode = 'chromatic';   // 'chromatic' | 'white-only'
    this._fillMode = 'fill';       // 'fill' | 'jump'

    this._recompute();
    audioEngine.addFrequencyListener(() => this._recompute());

    Tuning.instance = this;
  }

  get keyMode()  { return this._keyMode;  }
  get fillMode() { return this._fillMode; }

  setKeyMode(mode) {
    if (mode !== 'chromatic' && mode !== 'white-only') return;
    if (this._keyMode === mode) return;
    this._keyMode = mode;
    this._fireChange();
  }

  setFillMode(mode) {
    if (mode !== 'fill' && mode !== 'jump') return;
    if (this._fillMode === mode) return;
    this._fillMode = mode;
    this._fireChange();
  }

  _fireChange() {
    for (const fn of this._listeners) {
      try { fn(); } catch (e) { console.error('Tuning listener error', e); }
    }
  }

  /**
   * Read current drone state and rebuild the sorted scale + slot map.
   * Fires listeners only if the sorted list actually changed (so a freq
   * tweak that doesn't reorder anything still notifies for retune, but a
   * volume-only change doesn't reach us at all).
   */
  _recompute() {
    const count = audioEngine.getOscillatorCount();
    const freqs = audioEngine.getAllFrequencies().slice(0, count);

    const indexed = freqs.map((f, i) => ({ f, i }));
    indexed.sort((a, b) => a.f - b.f);

    const sorted = indexed.map(x => x.f);
    const sortedToSlot = indexed.map(x => x.i);

    // Notify on any change to either the freq values or the order
    // (re-orderings without value changes still matter — pan-by-degree
    // looks up the slot index per degree).
    if (this._arraysClose(this._sorted, sorted) &&
        this._arraysEqual(this._sortedToSlot, sortedToSlot)) {
      return;
    }

    this._sorted = sorted;
    this._sortedToSlot = sortedToSlot;
    this._fireChange();
  }

  _arraysClose(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i] - b[i]) > 1e-6) return false;
    }
    return true;
  }

  _arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  get sortedFrequencies() {
    return this._sorted.slice();
  }

  get scaleLength() {
    return this._sorted.length;
  }

  get rootMidi() {
    return this._rootMidi;
  }

  /**
   * For a given MIDI note, return { degree, octave } in this scale —
   * or null if the current key-mapping picker silences this key
   * (black key in white-only mode, or any key past the scale length
   * within an octave in jump mode).
   *
   * Per-mode logic:
   *   chromatic + fill: every key fires; degree = (k mod N), octave =
   *     floor(k / N). Sequence wraps every N semitones.
   *   chromatic + jump: only k%12 < N fires; degree = k%12,
   *     octave = floor(k/12). Each MIDI octave restarts at degree 0.
   *   white-only + fill: only white keys fire; w = sequential white-key
   *     count from root; degree = w mod N, octave = floor(w / N).
   *   white-only + jump: only the first N white keys per octave fire.
   */
  degreeAndOctaveForMidi(midi) {
    const N = this._sorted.length;
    if (N === 0) return null;
    const k = midi - this._rootMidi;
    const semitone = ((k % 12) + 12) % 12;
    const midiOctave = Math.floor(k / 12);

    if (this._keyMode === 'white-only') {
      const wInOctave = WHITE_INDEX_IN_OCTAVE[semitone];
      if (wInOctave === undefined) return null; // black key — silent
      if (this._fillMode === 'jump') {
        if (wInOctave >= N) return null;
        return { degree: wInOctave, octave: midiOctave };
      }
      // white-only + fill: contiguous white-key index across octaves
      const w = midiOctave * WHITE_OFFSETS.length + wInOctave;
      const degree = ((w % N) + N) % N;
      const octave = Math.floor(w / N);
      return { degree, octave };
    }

    // chromatic
    if (this._fillMode === 'jump') {
      if (semitone >= N) return null;
      return { degree: semitone, octave: midiOctave };
    }
    // chromatic + fill (the original behavior)
    const degree = ((k % N) + N) % N;
    const octave = Math.floor(k / N);
    return { degree, octave };
  }

  /**
   * Look up a held voice's current frequency from its (degree, octave)
   * identity. Returns null if the degree no longer exists in the scale
   * (drone count was reduced) — caller should keep the voice's last
   * frequency in that case.
   */
  pitchForDegreeAndOctave(degree, octave) {
    const N = this._sorted.length;
    if (N === 0 || degree < 0 || degree >= N) return null;
    return this._sorted[degree] * Math.pow(2, octave);
  }

  pitchForMidiNote(midi) {
    const dao = this.degreeAndOctaveForMidi(midi);
    if (!dao) return null;
    return this.pitchForDegreeAndOctave(dao.degree, dao.octave);
  }

  /**
   * Look up the live frequency of a drone slot directly, transposed by
   * `octave`. Used by KeyboardVoiceManager so a held voice tracks the
   * SLOT it was bound to at noteOn rather than whatever drone now sorts
   * into the same scale degree — i.e., the held note follows the orb
   * the user originally pressed, even if a drag reorders the scale.
   * Returns null if the slot is out of range or the slot's freq is 0.
   */
  pitchForSlotAndOctave(slot, octave) {
    if (slot < 0) return null;
    const count = audioEngine.getOscillatorCount();
    if (slot >= count) return null;
    const baseFreq = audioEngine.getFrequency(slot);
    if (!baseFreq) return null;
    return baseFreq * Math.pow(2, octave);
  }

  /**
   * Map a scale degree back to the drone slot index that supplies it.
   * Used by the voice manager to derive per-voice pan from the drone's
   * L/R routing for that slot. Returns -1 for out-of-range.
   */
  droneSlotForDegree(degree) {
    if (degree < 0 || degree >= this._sortedToSlot.length) return -1;
    return this._sortedToSlot[degree];
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
}

const tuning = new Tuning();
export default tuning;

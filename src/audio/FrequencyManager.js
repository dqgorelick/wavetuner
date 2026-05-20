/**
 * FrequencyManager — UI-layer state for the right-rail frequency editor.
 *
 * AudioEngine remains the source of truth for slot frequencies in Hz.
 * This singleton layers on top to track:
 *   - which slot is the *anchor* (its Hz acts as 1/1 for ratio display)
 *   - per-slot locked ratio intent ({n, d}) — set when the user types a
 *     ratio, cleared when they drag the slot's slider or type Hz directly
 *   - JI limit (5 / 7 / 11) for the nearest-ratio readout
 *   - a debounced undo stack covering drone freq + ratio changes
 *
 * Anchor handling:
 *   - Editing a NON-anchor slot's Hz frees its lock and sets that slot
 *     alone.
 *   - Editing the anchor's Hz (the "root") *transposes everything* —
 *     every slot's Hz scales by newRoot/oldRoot so all ratios are
 *     preserved (locked or free). The anchor row's Hz cell and the
 *     footer Root field both route to this transposing path.
 *
 * Non-anchor Hz changes from outside (slider drag, patch load) are
 * detected by comparing actual vs expected Hz; any lock that has
 * drifted is cleared. No manual lock toggle.
 *
 * Undo: a 350ms-debounced snapshot scheme records "stable" states. A
 * flurry of changes (slider drag) collapses into one undo entry — the
 * state before the drag started.
 */

import audioEngine from './AudioEngine';
import { SUPPORTED_LIMITS, DEFAULT_LIMIT } from './jiRatios';

// Drift tolerance for locked-ratio detection. Above ±1¢, we consider
// the slot to have been dragged off its locked ratio and unlock it.
// Below the underline-exact threshold (1.5¢) so a freshly-typed ratio
// reliably stays locked.
const DRIFT_TOLERANCE_CENTS = 1.0;

// Idle time before a state change settles into an undo snapshot. Long
// enough to coalesce a slider drag into one entry, short enough that
// the user's next typed change doesn't feel "stuck".
const SNAPSHOT_DEBOUNCE_MS = 350;

// Maximum history depth — older snapshots fall off the bottom.
const UNDO_LIMIT = 30;

class FrequencyManager {
  constructor() {
    if (FrequencyManager.instance) return FrequencyManager.instance;

    this._listeners = new Set();
    this._slotRatios = new Map(); // slot → { n, d }; absent = free
    this._anchorSlot = 0;
    this._limit = DEFAULT_LIMIT;
    this._lastAnchorHz = 0;
    this._inPropagation = false;

    // Undo state
    this._undoStack = [];
    this._lastStable = null;     // most recently captured stable snapshot
    this._snapTimer = null;
    this._inUndoRestore = false;

    audioEngine.addFrequencyListener(() => this._onEngineFreqChange());

    FrequencyManager.instance = this;
  }

  get anchorSlot() { return this._anchorSlot; }
  get limit() { return this._limit; }

  isAnchor(slot) { return slot === this._anchorSlot; }

  // Returns { n, d } for a locked slot, { n: 1, d: 1 } for the anchor,
  // or null when the slot is free.
  getRatio(slot) {
    if (slot === this._anchorSlot) return { n: 1, d: 1 };
    return this._slotRatios.get(slot) || null;
  }

  /**
   * Capture the current engine + manager state as the initial baseline
   * for the undo stack. Safe to call multiple times — only the first
   * call (after the engine is initialized) takes effect.
   */
  ensureInitialSnapshot() {
    if (this._lastStable) return;
    if (!audioEngine.initialized) return;
    this._lastStable = this._takeSnapshot();
  }

  setAnchorSlot(slot) {
    if (slot === this._anchorSlot) return;
    if (!Number.isInteger(slot) || slot < 0) return;
    // The new anchor is by definition 1/1 — drop any stale lock it had
    // against the previous anchor.
    this._slotRatios.delete(slot);
    this._anchorSlot = slot;
    if (audioEngine.initialized) {
      this._lastAnchorHz = audioEngine.getFrequency(slot);
      this._purgeDriftedLocks(this._lastAnchorHz);
    }
    this._scheduleSnapshot();
    this._fire();
  }

  setLimit(limit) {
    if (!SUPPORTED_LIMITS.includes(limit)) return;
    if (limit === this._limit) return;
    this._limit = limit;
    this._scheduleSnapshot();
    this._fire();
  }

  /**
   * Set a non-anchor slot's Hz directly. Frees the slot's ratio lock
   * (typing Hz overrides any prior ratio intent). Anchor edits route
   * to setRootHz, which transposes everything.
   */
  setSlotHz(slot, hz) {
    if (!Number.isFinite(hz) || hz <= 0) return;
    if (slot === this._anchorSlot) {
      this.setRootHz(hz);
      return;
    }
    this._slotRatios.delete(slot);
    audioEngine.setFrequency(slot, hz);
  }

  /**
   * Lock a slot to a ratio. Computes the target Hz from the current
   * anchor and pushes it. Drift check on the next listener fires sees
   * actual === expected → lock survives.
   */
  setSlotRatio(slot, n, d) {
    if (!Number.isFinite(n) || !Number.isFinite(d) || n <= 0 || d <= 0) return;
    if (slot === this._anchorSlot) return; // anchor is implicit 1/1
    if (!audioEngine.initialized) return;
    const anchorHz = audioEngine.getFrequency(this._anchorSlot);
    if (!Number.isFinite(anchorHz) || anchorHz <= 0) return;
    const newHz = anchorHz * (n / d);
    this._slotRatios.set(slot, { n, d });
    audioEngine.setFrequency(slot, newHz);
  }

  /**
   * Set the root (anchor's Hz) — scales every slot's Hz by the same
   * factor so all current relative ratios are preserved (whether locked
   * or free). Locks remain locked since their {n, d} hasn't changed.
   */
  setRootHz(newHz) {
    if (!Number.isFinite(newHz) || newHz <= 0) return;
    if (!audioEngine.initialized) return;
    const oldHz = audioEngine.getFrequency(this._anchorSlot);
    if (!Number.isFinite(oldHz) || oldHz <= 0) return;
    if (Math.abs(newHz - oldHz) < 1e-4) return;
    const factor = newHz / oldHz;
    const count = audioEngine.getOscillatorCount();
    this._inPropagation = true;
    try {
      for (let slot = 0; slot < count; slot++) {
        const cur = audioEngine.getFrequency(slot);
        if (!Number.isFinite(cur) || cur <= 0) continue;
        audioEngine.setFrequency(slot, cur * factor);
      }
    } finally {
      this._inPropagation = false;
    }
    this._lastAnchorHz = newHz;
    // We muted _onEngineFreqChange via _inPropagation, so trigger the
    // snapshot debounce explicitly here.
    this._scheduleSnapshot();
    this._fire();
  }

  // ─── Undo ──────────────────────────────────────────────────────────

  canUndo() { return this._undoStack.length > 0; }

  /**
   * Pop the most recent snapshot off the undo stack and restore engine +
   * manager state to it. The current state is discarded (no redo).
   */
  undo() {
    if (this._undoStack.length === 0) return false;
    const target = this._undoStack.pop();
    this._applySnapshot(target);
    this._lastStable = target;
    this._fire();
    return true;
  }

  _takeSnapshot() {
    return {
      frequencies: audioEngine.getAllFrequencies(),
      slotRatios: new Map(this._slotRatios),
      anchorSlot: this._anchorSlot,
      limit: this._limit,
    };
  }

  _applySnapshot(snap) {
    this._inUndoRestore = true;
    this._inPropagation = true;
    try {
      this._anchorSlot = snap.anchorSlot;
      this._slotRatios = new Map(snap.slotRatios);
      this._limit = snap.limit;
      const count = audioEngine.getOscillatorCount();
      for (let i = 0; i < Math.min(count, snap.frequencies.length); i++) {
        audioEngine.setFrequency(i, snap.frequencies[i]);
      }
      this._lastAnchorHz = audioEngine.getFrequency(this._anchorSlot);
    } finally {
      this._inPropagation = false;
      this._inUndoRestore = false;
    }
  }

  _snapshotsEqual(a, b) {
    if (a.anchorSlot !== b.anchorSlot) return false;
    if (a.limit !== b.limit) return false;
    if (a.frequencies.length !== b.frequencies.length) return false;
    for (let i = 0; i < a.frequencies.length; i++) {
      if (Math.abs(a.frequencies[i] - b.frequencies[i]) > 1e-4) return false;
    }
    if (a.slotRatios.size !== b.slotRatios.size) return false;
    for (const [k, v] of a.slotRatios) {
      const v2 = b.slotRatios.get(k);
      if (!v2 || v2.n !== v.n || v2.d !== v.d) return false;
    }
    return true;
  }

  _scheduleSnapshot() {
    if (this._inUndoRestore) return;
    if (this._snapTimer) clearTimeout(this._snapTimer);
    this._snapTimer = setTimeout(() => this._captureSnapshot(), SNAPSHOT_DEBOUNCE_MS);
  }

  _captureSnapshot() {
    this._snapTimer = null;
    if (!audioEngine.initialized) return;
    const now = this._takeSnapshot();
    if (this._lastStable === null) {
      // First snapshot — establish baseline without pushing.
      this._lastStable = now;
      return;
    }
    if (this._snapshotsEqual(this._lastStable, now)) return;
    this._undoStack.push(this._lastStable);
    if (this._undoStack.length > UNDO_LIMIT) this._undoStack.shift();
    this._lastStable = now;
    this._fire();
  }

  // ─── Engine listener ───────────────────────────────────────────────

  _onEngineFreqChange() {
    if (this._inPropagation) return;
    if (this._inUndoRestore) return;
    if (!audioEngine.initialized) return;

    const anchorHz = audioEngine.getFrequency(this._anchorSlot);
    if (!Number.isFinite(anchorHz) || anchorHz <= 0) {
      this._fire();
      return;
    }

    const anchorChanged = Math.abs(anchorHz - this._lastAnchorHz) > 1e-4;

    if (anchorChanged) {
      // Anchor moved — propagate to locked slots so their {n, d} stays
      // honored. (External anchor changes from the audio engine — e.g.,
      // patch loads or the FrequencySliders strip — flow through here.
      // Manager-driven setRootHz scales every slot itself and uses
      // _inPropagation to suppress this branch.)
      this._inPropagation = true;
      try {
        for (const [slot, ratio] of this._slotRatios) {
          if (slot === this._anchorSlot) continue;
          const expectedHz = anchorHz * (ratio.n / ratio.d);
          audioEngine.setFrequency(slot, expectedHz);
        }
      } finally {
        this._inPropagation = false;
      }
      this._lastAnchorHz = anchorHz;
    } else {
      this._purgeDriftedLocks(anchorHz);
    }

    this._scheduleSnapshot();
    this._fire();
  }

  _purgeDriftedLocks(anchorHz) {
    if (!Number.isFinite(anchorHz) || anchorHz <= 0) return;
    for (const [slot, ratio] of [...this._slotRatios]) {
      if (slot === this._anchorSlot) continue;
      const actual = audioEngine.getFrequency(slot);
      if (!Number.isFinite(actual) || actual <= 0) {
        this._slotRatios.delete(slot);
        continue;
      }
      const expected = anchorHz * (ratio.n / ratio.d);
      const offsetCents = 1200 * Math.log2(actual / expected);
      if (Math.abs(offsetCents) > DRIFT_TOLERANCE_CENTS) {
        this._slotRatios.delete(slot);
      }
    }
  }

  // ─── Subscription ──────────────────────────────────────────────────

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _fire() {
    for (const fn of this._listeners) {
      try { fn(); } catch (e) { console.error('FrequencyManager listener error', e); }
    }
  }
}

const frequencyManager = new FrequencyManager();
export default frequencyManager;

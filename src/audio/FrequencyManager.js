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
import {
  SUPPORTED_SYSTEMS,
  DEFAULT_SYSTEM,
  TUNING_SYSTEMS,
  stepCandidate,
} from './jiRatios';

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

// Maximum number of named save slots. When full, the oldest slot is
// dropped to make room for the new save — keeps the UI grid (4×2)
// from overflowing while still allowing rapid iterative saves.
const SAVE_LIMIT = 8;

// Default glide duration (ms) when recalling a saved state. Matches
// applyPatchSmooth's SMOOTH_GLIDE_MS so save-recalls feel like the
// "return to patch" gesture out of the box. User-tunable via
// setRecallGlideMs() (the slider beneath the save chips in the
// tuning panel; 0 ms = instant snap).
const DEFAULT_RECALL_GLIDE_MS = 800;
const MAX_RECALL_GLIDE_MS = 10000;

class FrequencyManager {
  constructor() {
    if (FrequencyManager.instance) return FrequencyManager.instance;

    this._listeners = new Set();
    this._slotRatios = new Map(); // slot → { n, d }; absent = free
    // Root (1/1) slot persists across reloads — the user's chosen tuning
    // center is part of the instrument's setup, like the tuning system.
    this._anchorSlot = FrequencyManager._loadRootSlot();
    this._tuningSystem = DEFAULT_SYSTEM;
    this._lastAnchorHz = 0;
    this._inPropagation = false;

    // Undo / redo state
    this._undoStack = [];
    this._redoStack = [];
    this._lastStable = null;     // most recently captured stable snapshot
    this._snapTimer = null;
    this._inUndoRestore = false;

    // In-memory named save slots. Lost on reload by design.
    this._saveSlots = [];
    this._saveSeq = 0;           // monotonic counter for auto-names
    this._recallGlideMs = DEFAULT_RECALL_GLIDE_MS;

    audioEngine.addFrequencyListener(() => this._onEngineFreqChange());

    FrequencyManager.instance = this;
  }

  // Root-slot persistence. localStorage may be unavailable (privacy mode,
  // SSR) — both helpers swallow failures and fall back to slot 0.
  static _loadRootSlot() {
    try {
      const v = parseInt(localStorage.getItem('tuningRootSlot'), 10);
      if (Number.isInteger(v) && v >= 0) return v;
    } catch { /* ignore */ }
    return 0;
  }
  _persistRootSlot() {
    try { localStorage.setItem('tuningRootSlot', String(this._anchorSlot)); } catch { /* ignore */ }
  }

  get anchorSlot() { return this._anchorSlot; }
  get tuningSystem() { return this._tuningSystem; }
  // Back-compat alias — old callers read `.limit` for the numeric
  // 5/7/11. Maps the new system keys back to those numbers when
  // possible, falls back to 5 for non-JI systems (since the UI that
  // reads this is for prime-limit display only).
  get limit() {
    const map = { '5-limit': 5, '7-limit': 7, '11-limit': 11 };
    return map[this._tuningSystem] || 5;
  }

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
    this._persistRootSlot();
    if (audioEngine.initialized) {
      this._lastAnchorHz = audioEngine.getFrequency(slot);
      this._purgeDriftedLocks(this._lastAnchorHz);
    }
    this._scheduleSnapshot();
    this._fire();
  }

  setTuningSystem(key) {
    if (!SUPPORTED_SYSTEMS.includes(key)) return;
    if (key === this._tuningSystem) return;
    this._tuningSystem = key;
    this._scheduleSnapshot();
    this._fire();
  }

  // Back-compat: old callers passing 5/7/11. Maps to the equivalent
  // -limit system key.
  setLimit(limit) {
    const map = { 5: '5-limit', 7: '7-limit', 11: '11-limit' };
    const key = map[limit];
    if (key) this.setTuningSystem(key);
  }

  /**
   * Step a slot to the next / previous candidate in the active tuning
   * system. `direction` is +1 (↑) or -1 (↓). For rational systems the
   * slot is locked to the new (n, d); for 12-TET the slot's Hz is set
   * to the candidate's cents value without creating a rational lock
   * (TET notes don't have a clean small-integer ratio).
   */
  stepSlotRatio(slot, direction) {
    if (slot === this._anchorSlot) return; // anchor is 1/1 — no neighbors
    if (!audioEngine.initialized) return;
    const anchorHz = audioEngine.getFrequency(this._anchorSlot);
    if (!Number.isFinite(anchorHz) || anchorHz <= 0) return;
    const curHz = audioEngine.getFrequency(slot);
    if (!Number.isFinite(curHz) || curHz <= 0) return;
    const currentRatio = curHz / anchorHz;
    const next = stepCandidate(currentRatio, this._tuningSystem, direction);
    if (!next) return;
    if (next.n != null && next.d != null) {
      // Rational candidate — lock the ratio so it tracks anchor moves.
      this._slotRatios.set(slot, { n: next.n, d: next.d });
      audioEngine.setFrequency(slot, anchorHz * next.ratio);
    } else {
      // TET-style candidate — set Hz directly, drop any rational lock.
      this._slotRatios.delete(slot);
      audioEngine.setFrequency(slot, anchorHz * next.ratio);
    }
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

  // ─── Undo / Redo ───────────────────────────────────────────────────

  canUndo() { return this._undoStack.length > 0; }
  canRedo() { return this._redoStack.length > 0; }

  /**
   * Pop the most recent snapshot off the undo stack and restore engine +
   * manager state to it. The current state is pushed onto the redo
   * stack so a subsequent redo() can return here.
   */
  undo() {
    if (this._undoStack.length === 0) return false;
    if (this._lastStable) this._redoStack.push(this._lastStable);
    const target = this._undoStack.pop();
    this._applySnapshot(target);
    this._lastStable = target;
    this._fire();
    return true;
  }

  /**
   * Inverse of undo: pop the redo stack, applying that snapshot and
   * pushing the current state back onto the undo stack.
   */
  redo() {
    if (this._redoStack.length === 0) return false;
    if (this._lastStable) {
      this._undoStack.push(this._lastStable);
      if (this._undoStack.length > UNDO_LIMIT) this._undoStack.shift();
    }
    const target = this._redoStack.pop();
    this._applySnapshot(target);
    this._lastStable = target;
    this._fire();
    return true;
  }

  // ─── Save slots ────────────────────────────────────────────────────

  getSlots() {
    return this._saveSlots.map((s) => ({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
    }));
  }

  /**
   * Capture the current state as a named save slot. Returns the slot id.
   * Slots live in memory only — lost on reload.
   */
  saveCurrent({ name } = {}) {
    if (!audioEngine.initialized) return null;
    this._saveSeq += 1;
    const id = `save_${Date.now().toString(36)}_${this._saveSeq}`;
    const slot = {
      id,
      name: name || `Save ${this._saveSeq}`,
      createdAt: Date.now(),
      snapshot: this._takeSnapshot(),
    };
    this._saveSlots.push(slot);
    if (this._saveSlots.length > SAVE_LIMIT) this._saveSlots.shift();
    this._fire();
    return id;
  }

  /**
   * Apply a saved slot's snapshot with a smooth frequency glide. The
   * pre-recall state is pushed onto the undo stack so the user can
   * back out of a recall. Redo is cleared (recall counts as a "new
   * edit" branch).
   */
  recallSlot(id) {
    const slot = this._saveSlots.find((s) => s.id === id);
    if (!slot) return false;
    if (!audioEngine.initialized) return false;
    // Treat the recall as a new edit: capture pre-recall state for undo,
    // wipe redo so its branch doesn't get stranded.
    if (this._lastStable) {
      this._undoStack.push(this._lastStable);
      if (this._undoStack.length > UNDO_LIMIT) this._undoStack.shift();
    }
    this._redoStack = [];
    this._applySnapshotSmooth(slot.snapshot, this._recallGlideMs);
    return true;
  }

  get recallGlideMs() {
    return this._recallGlideMs;
  }

  /**
   * Set the glide duration (ms) used when recalling a saved state.
   * Clamped to [0, MAX_RECALL_GLIDE_MS]. Fires change so the slider
   * UI re-reads the value (and any other listeners observe the new
   * setting).
   */
  setRecallGlideMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(0, Math.min(MAX_RECALL_GLIDE_MS, n));
    if (clamped === this._recallGlideMs) return;
    this._recallGlideMs = clamped;
    this._fire();
  }

  deleteSlot(id) {
    const before = this._saveSlots.length;
    this._saveSlots = this._saveSlots.filter((s) => s.id !== id);
    if (this._saveSlots.length !== before) this._fire();
  }

  renameSlot(id, name) {
    const slot = this._saveSlots.find((s) => s.id === id);
    if (!slot) return;
    const trimmed = String(name || '').trim();
    if (!trimmed || trimmed === slot.name) return;
    slot.name = trimmed;
    this._fire();
  }

  _takeSnapshot() {
    return {
      frequencies: audioEngine.getAllFrequencies(),
      slotRatios: new Map(this._slotRatios),
      anchorSlot: this._anchorSlot,
      tuningSystem: this._tuningSystem,
    };
  }

  _applySnapshot(snap) {
    this._inUndoRestore = true;
    this._inPropagation = true;
    try {
      this._anchorSlot = snap.anchorSlot;
      this._persistRootSlot();
      this._slotRatios = new Map(snap.slotRatios);
      // Tolerate legacy snapshots stored as numeric `limit`.
      this._tuningSystem = snap.tuningSystem
        || ({ 5: '5-limit', 7: '7-limit', 11: '11-limit' }[snap.limit])
        || DEFAULT_SYSTEM;
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

  /**
   * Glide engine frequencies toward the snapshot's targets while
   * setting manager-only fields (anchor / ratios / limit) immediately.
   * The undo-restore guard stays raised for the full duration so the
   * per-frame engine listener doesn't treat the glide as user drift
   * and purge locks. On completion we capture the landed state as
   * `_lastStable` so further edits diff against it.
   */
  _applySnapshotSmooth(snap, durationMs) {
    // Cancel any in-flight glide so back-to-back recalls behave.
    if (audioEngine.cancelFrequencyGlide) audioEngine.cancelFrequencyGlide();

    this._inUndoRestore = true;
    this._anchorSlot = snap.anchorSlot;
    this._persistRootSlot();
    this._slotRatios = new Map(snap.slotRatios);
    this._tuningSystem = snap.tuningSystem
      || ({ 5: '5-limit', 7: '7-limit', 11: '11-limit' }[snap.limit])
      || DEFAULT_SYSTEM;

    const count = audioEngine.getOscillatorCount();
    const targets = snap.frequencies.slice(0, count);

    const finish = () => {
      this._inUndoRestore = false;
      this._lastAnchorHz = audioEngine.getFrequency(this._anchorSlot);
      this._lastStable = this._takeSnapshot();
      this._fire();
    };

    // Fire once now so the UI reflects the new anchor / ratios while
    // the glide is in motion.
    this._fire();
    audioEngine.glideToFrequencies(targets, durationMs, finish);
  }

  _snapshotsEqual(a, b) {
    if (a.anchorSlot !== b.anchorSlot) return false;
    if (a.tuningSystem !== b.tuningSystem) return false;
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
    // A real edit branches history — any pending redo is now stranded.
    if (this._redoStack.length > 0) this._redoStack = [];
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

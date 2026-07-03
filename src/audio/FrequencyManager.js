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

// Default glide duration (ms) when recalling a saved capture slot — a
// long, musical transition out of the box. User-tunable via
// setRecallGlideMs() (the slider beneath the save chips in the
// tuning panel; 0 ms = instant snap).
const DEFAULT_RECALL_GLIDE_MS = 2750;
const MAX_RECALL_GLIDE_MS = 10000;

// Default glide duration (ms) for undo/redo. Snappier than a capture
// recall — undo is a "take that back" gesture, not a musical transition.
const DEFAULT_UNDO_GLIDE_MS = 750;

// Easing curves for the recall glide, cycled via the "curve:" button
// beside the glide slider. `id` is persisted; `fn` maps normalized time
// t∈[0,1] → eased progress. ease-in-out (smooth at both ends) matches the
// engine's historical glide shape and stays the default.
const RECALL_CURVES = [
  { id: 'linear', label: 'linear', fn: (t) => t },
  { id: 'ease-in', label: 'ease in', fn: (t) => t * t },
  { id: 'ease-out', label: 'ease out', fn: (t) => t * (2 - t) },
  {
    id: 'ease-in-out',
    label: 'ease in-out',
    fn: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  },
];
const DEFAULT_RECALL_CURVE = 'ease-in-out';

// ─── Parameter lock (capture scope) ──────────────────────────────────
// The lockable parameters. Capture always stores all of them; a scope is
// a live mask deciding which get APPLIED on recall (recallScope) and which
// are tracked/restored by undo/redo (undoScope). See PARAMETER_LOCK.md.
//   freq  → frequencies + locked ratios + anchor + tuning system (pitch context)
//   vol   → per-voice volume (0..1)
//   onoff → per-voice mute state
const PARAM_KEYS = ['freq', 'vol', 'onoff'];
// Default scope = frequency only. Reproduces the pre-parameter-lock behavior
// (recall/undo move pitch, nothing else) until the user opts into more.
const DEFAULT_SCOPE = ['freq'];

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
    // Follow-root is removed as a user feature: moving the root never drags
    // the other voices along. Only voices with an explicitly locked ratio
    // track the root; free voices stay put. Hardcoded off (the setter/getter
    // remain for internal call sites but there is no UI to turn it on).
    this._followRoot = false;

    // Undo / redo state
    this._undoStack = [];
    this._redoStack = [];
    this._lastStable = null;     // most recently captured stable snapshot
    this._snapTimer = null;
    this._inUndoRestore = false;

    // Named save slots — persisted across reloads so the states the user
    // builds in the tuning panel survive a refresh (see the _load/_persist
    // helpers below). Snapshots are JSON-serialized; the slotRatios Map is
    // stored as an entries array and rehydrated on load.
    this._saveSlots = FrequencyManager._loadSaveSlots();
    this._saveSeq = FrequencyManager._loadSaveSeq(); // monotonic counter for auto-names
    // Staging + launch state. A staged slot is "armed": the spectrum bar shows
    // each voice's target as a marker. Launching a voice (one, or all at once)
    // glides its frequency; `_launching` holds the in-flight voices (index →
    // {startHz, targetHz}). Targets PERSIST after landing as "return here"
    // markers until the user releases them (clearStaged). `_stageVersion` bumps
    // on any staging change so subscribers re-read without churning on every
    // frequency event. None of this is persisted across reloads.
    this._stagedSlotId = null;
    this._stagedTargets = null;
    this._launching = new Map();
    this._stageVersion = 0;
    this._launchRaf = null;      // rAF handle for the in-flight launch tween
    this._recallGlideMs = FrequencyManager._loadRecallGlideMs();
    this._recallCurve = FrequencyManager._loadRecallCurve();

    // Parameter lock. The UI presents ONE parameter set ("Parameters tracked")
    // shared by capture-recall and undo/redo, so `_recallScope` and `_undoScope`
    // stay in lockstep (see toggleParam). Timings are INDEPENDENT — a Capture
    // recall timing and a separate Undo/Redo timing. Default: frequency-only.
    this._recallScope = FrequencyManager._loadScope('tuningRecallScope');
    this._undoScope = new Set(this._recallScope);
    this._scopeLinked = true; // vestigial (params unified); kept for compatibility
    this._undoGlideMs = FrequencyManager._loadUndoGlideMs(DEFAULT_UNDO_GLIDE_MS);

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

  // Follow-root persistence. Defaults to ON when unset/unavailable.
  static _loadFollowRoot() {
    try {
      const v = localStorage.getItem('tuningFollowRoot');
      if (v === '0') return false;
      if (v === '1') return true;
    } catch { /* ignore */ }
    return true;
  }
  _persistFollowRoot() {
    try { localStorage.setItem('tuningFollowRoot', this._followRoot ? '1' : '0'); } catch { /* ignore */ }
  }

  // Save-slot persistence. Snapshots hold a slotRatios Map, which JSON
  // can't represent directly — store it as an entries array and rebuild
  // the Map on load. All reads tolerate missing/corrupt data and fall
  // back to an empty slot list.
  // Normalize a plain (JSON-shaped) slot array into internal slot objects,
  // tolerating missing/corrupt entries. Shared by localStorage load and by
  // patch restore (importSaveSlots) so both paths validate identically.
  static _normalizeSlots(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const s of arr) {
      if (!s || typeof s.id !== 'string' || !s.snapshot) continue;
      const snap = s.snapshot;
      if (!Array.isArray(snap.frequencies)) continue;
      out.push({
        id: s.id,
        name: typeof s.name === 'string' ? s.name : 'Save',
        createdAt: Number(s.createdAt) || Date.now(),
        snapshot: {
          frequencies: snap.frequencies.slice(),
          // volumes/mutes are newer fields — tolerate older saves without them.
          volumes: Array.isArray(snap.volumes) ? snap.volumes.slice() : null,
          mutes: Array.isArray(snap.mutes) ? snap.mutes.slice() : null,
          slotRatios: new Map(Array.isArray(snap.slotRatios) ? snap.slotRatios : []),
          anchorSlot: Number.isInteger(snap.anchorSlot) ? snap.anchorSlot : 0,
          tuningSystem: snap.tuningSystem || DEFAULT_SYSTEM,
        },
      });
    }
    return out.slice(-SAVE_LIMIT);
  }

  // Serialize internal slot objects into a plain JSON-safe array (Maps → entry
  // arrays). Shared by localStorage persist and patch capture (exportSaveSlots).
  static _serializeSlots(slots) {
    return slots.map((s) => ({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      snapshot: {
        frequencies: Array.from(s.snapshot.frequencies),
        volumes: s.snapshot.volumes ? Array.from(s.snapshot.volumes) : null,
        mutes: s.snapshot.mutes ? Array.from(s.snapshot.mutes) : null,
        slotRatios: Array.from(s.snapshot.slotRatios.entries()),
        anchorSlot: s.snapshot.anchorSlot,
        tuningSystem: s.snapshot.tuningSystem,
      },
    }));
  }

  static _loadSaveSlots() {
    try {
      return FrequencyManager._normalizeSlots(JSON.parse(localStorage.getItem('tuningSaveSlots')));
    } catch { return []; }
  }
  static _loadSaveSeq() {
    try {
      const v = parseInt(localStorage.getItem('tuningSaveSeq'), 10);
      if (Number.isInteger(v) && v >= 0) return v;
    } catch { /* ignore */ }
    return 0;
  }
  _persistSaveSlots() {
    try {
      const serial = FrequencyManager._serializeSlots(this._saveSlots);
      localStorage.setItem('tuningSaveSlots', JSON.stringify(serial));
      localStorage.setItem('tuningSaveSeq', String(this._saveSeq));
    } catch { /* ignore */ }
  }

  // ─── Patch integration (export/restore the snapshot slots) ───────────
  // A saved preset carries its snapshot slots so loading it restores the
  // I/II/III/IV capture states alongside the live tuning. Export returns a
  // plain JSON-safe array; import replaces the current slots wholesale.

  exportSaveSlots() {
    return FrequencyManager._serializeSlots(this._saveSlots);
  }

  importSaveSlots(arr) {
    // A preset saved before this field existed passes undefined — leave the
    // user's current slots untouched rather than wiping them.
    if (arr == null) return;
    this.clearStaged();
    this._saveSlots = FrequencyManager._normalizeSlots(arr);
    this._persistSaveSlots();
    this._fire();
  }

  // Recall-glide persistence. Falls back to the default when unset.
  static _loadRecallGlideMs() {
    try {
      const v = parseFloat(localStorage.getItem('tuningRecallGlideMs'));
      if (Number.isFinite(v)) return Math.max(0, Math.min(MAX_RECALL_GLIDE_MS, v));
    } catch { /* ignore */ }
    return DEFAULT_RECALL_GLIDE_MS;
  }
  _persistRecallGlideMs() {
    try { localStorage.setItem('tuningRecallGlideMs', String(this._recallGlideMs)); } catch { /* ignore */ }
  }

  // Recall-curve persistence. Falls back to the default for unknown ids.
  static _loadRecallCurve() {
    try {
      const v = localStorage.getItem('tuningRecallCurve');
      if (RECALL_CURVES.some((c) => c.id === v)) return v;
    } catch { /* ignore */ }
    return DEFAULT_RECALL_CURVE;
  }
  _persistRecallCurve() {
    try { localStorage.setItem('tuningRecallCurve', this._recallCurve); } catch { /* ignore */ }
  }

  // Scope persistence — a scope is stored as a comma-joined key list. Unknown
  // keys are dropped; a missing/corrupt value falls back to the default.
  static _loadScope(storageKey) {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw != null) {
        const keys = raw.split(',').filter((k) => PARAM_KEYS.includes(k));
        return new Set(keys);
      }
    } catch { /* ignore */ }
    return new Set(DEFAULT_SCOPE);
  }
  _persistScope(storageKey, scope) {
    try { localStorage.setItem(storageKey, [...scope].join(',')); } catch { /* ignore */ }
  }
  static _loadScopeLinked() {
    try {
      const v = localStorage.getItem('tuningScopeLinked');
      if (v === '0') return false;
      if (v === '1') return true;
    } catch { /* ignore */ }
    return true; // default: undo mirrors captures
  }
  _persistScopeLinked() {
    try { localStorage.setItem('tuningScopeLinked', this._scopeLinked ? '1' : '0'); } catch { /* ignore */ }
  }
  static _loadUndoGlideMs(fallback) {
    try {
      const v = parseFloat(localStorage.getItem('tuningUndoGlideMs'));
      if (Number.isFinite(v)) return Math.max(0, Math.min(MAX_RECALL_GLIDE_MS, v));
    } catch { /* ignore */ }
    return fallback;
  }
  _persistUndoGlideMs() {
    try { localStorage.setItem('tuningUndoGlideMs', String(this._undoGlideMs)); } catch { /* ignore */ }
  }

  get followRoot() { return this._followRoot; }
  setFollowRoot(on) {
    const next = !!on;
    if (next === this._followRoot) return;
    this._followRoot = next;
    this._persistFollowRoot();
    this._fire();
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
    if (!audioEngine.initialized) return;
    // Seed the anchor reference so follow-root's first transpose factor
    // (anchorHz / lastAnchorHz) is valid from the very first root move.
    if (this._lastAnchorHz <= 0) {
      const hz = audioEngine.getFrequency(this._anchorSlot);
      if (Number.isFinite(hz) && hz > 0) this._lastAnchorHz = hz;
    }
    if (this._lastStable) return;
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
    if (!this._followRoot) {
      // Follow-root OFF: move only the anchor. The engine listener then
      // pulls any locked-ratio slots along; free voices stay put. Keeps
      // the typed-root / octave path consistent with dragging the orb.
      audioEngine.setFrequency(this._anchorSlot, newHz);
      return;
    }
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
    const before = this._lastStable;
    if (before) this._redoStack.push(before);
    let target = this._undoStack.pop();
    // Skip no-op steps: entries that don't change anything in the undo scope
    // (e.g. recorded while a different scope was active) would make undo look
    // broken. Walk back to the first entry that actually differs in-scope.
    while (before && this._scopedEqual(target, before, this._undoScope) && this._undoStack.length) {
      this._redoStack.push(target);
      target = this._undoStack.pop();
    }
    this._lastStable = target;
    this._abortLaunchForRestore();
    // Lerp back to the undo target (only the undo-scope params) rather than snapping.
    this._applySnapshotSmooth(target, this._undoScope, this._undoGlideMs);
    return true;
  }

  /**
   * Inverse of undo: pop the redo stack, applying that snapshot and
   * pushing the current state back onto the undo stack.
   */
  redo() {
    if (this._redoStack.length === 0) return false;
    const before = this._lastStable;
    const pushUndo = (snap) => {
      this._undoStack.push(snap);
      if (this._undoStack.length > UNDO_LIMIT) this._undoStack.shift();
    };
    if (before) pushUndo(before);
    let target = this._redoStack.pop();
    while (before && this._scopedEqual(target, before, this._undoScope) && this._redoStack.length) {
      pushUndo(target);
      target = this._redoStack.pop();
    }
    this._lastStable = target;
    this._abortLaunchForRestore();
    // Lerp forward to the redo target (only the undo-scope params).
    this._applySnapshotSmooth(target, this._undoScope, this._undoGlideMs);
    return true;
  }

  // Stop an in-flight launch tween before an undo/redo glide takes over, so the
  // two don't write frequencies against each other. Staged targets are left
  // armed (their dots just drop back to pending) — only the motion is aborted.
  _abortLaunchForRestore() {
    this._cancelLaunchGlide();
    if (this._launching.size) {
      this._launching.clear();
      this._stageVersion += 1;   // markers re-read as pending
    }
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
    this._persistSaveSlots();
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
    this._applySnapshotSmooth(slot.snapshot, this._recallScope, this._recallGlideMs);
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
    this._persistRecallGlideMs();
    this._fire();
  }

  // ─── Parameter-lock scope API (consumed by the tunings-menu UI) ──────
  getRecallScope() { return [...this._recallScope]; }
  getUndoScope() { return [...this._undoScope]; }
  get undoGlideMs() { return this._undoGlideMs; }

  setUndoGlideMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(0, Math.min(MAX_RECALL_GLIDE_MS, n));
    if (clamped === this._undoGlideMs) return;
    this._undoGlideMs = clamped;
    this._persistUndoGlideMs();
    this._fire();
  }

  // Unified parameter toggle — capture-recall and undo/redo track the SAME
  // parameters ("Parameters tracked"), so flip both scopes together.
  toggleParam(key) {
    if (!PARAM_KEYS.includes(key)) return;
    if (this._recallScope.has(key)) {
      this._recallScope.delete(key);
      this._undoScope.delete(key);
    } else {
      this._recallScope.add(key);
      this._undoScope.add(key);
    }
    this._persistScope('tuningRecallScope', this._recallScope);
    this._persistScope('tuningUndoScope', this._undoScope);
    this._fire();
  }

  // ─── Recall easing curve ─────────────────────────────────────────────
  get recallCurve() { return this._recallCurve; }

  // { id, label } list for building a curve picker (e.g. the Settings menu).
  get recallCurveOptions() {
    return RECALL_CURVES.map((c) => ({ id: c.id, label: c.label }));
  }

  get recallCurveLabel() {
    const c = RECALL_CURVES.find((x) => x.id === this._recallCurve);
    return c ? c.label : this._recallCurve;
  }

  // Select a recall curve directly by id (no-op for unknown ids).
  setRecallCurve(id) {
    if (id === this._recallCurve) return;
    if (!RECALL_CURVES.some((c) => c.id === id)) return;
    this._recallCurve = id;
    this._persistRecallCurve();
    this._fire();
  }

  // The easing function for the current curve, passed to the engine glide.
  _recallCurveFn() {
    const c = RECALL_CURVES.find((x) => x.id === this._recallCurve);
    return c ? c.fn : RECALL_CURVES[RECALL_CURVES.length - 1].fn;
  }

  // Advance to the next curve in the list (wraps). Drives the "curve:"
  // cycle button beside the glide slider.
  cycleRecallCurve() {
    const idx = RECALL_CURVES.findIndex((c) => c.id === this._recallCurve);
    const next = RECALL_CURVES[(idx + 1) % RECALL_CURVES.length];
    this._recallCurve = next.id;
    this._persistRecallCurve();
    this._fire();
  }

  deleteSlot(id) {
    const before = this._saveSlots.length;
    this._saveSlots = this._saveSlots.filter((s) => s.id !== id);
    if (this._stagedSlotId === id) this.clearStaged();
    if (this._saveSlots.length !== before) {
      this._persistSaveSlots();
      this._fire();
    }
  }

  // ─── Staging + launch (preview, then glide) ──────────────────────────
  // A staged slot is "armed": the UI previews where each voice will glide to
  // (target dots on the spectrum bar) without touching audio. Launching then
  // glides frequencies — one voice (a clicked dot) or all at once (the chip).
  get stagedSlotId() { return this._stagedSlotId; }
  get stageVersion() { return this._stageVersion; }
  // True while a launch tween is moving one or more voices. Mirrors
  // audioEngine.isGliding so UI that drops into a cheap render mode during a
  // recall glide (e.g. the tuning panel freezing its per-row inputs) also does
  // so during a staged launch — otherwise every row re-renders its controlled
  // inputs on every tween frame (the recall lag).
  get isLaunching() { return this._launching.size > 0; }

  stageSlot(id) {
    const slot = this._saveSlots.find((s) => s.id === id);
    if (!slot?.snapshot || !Array.isArray(slot.snapshot.frequencies)) return false;
    if (this._stagedSlotId === id) return true;
    // Don't freeze voices that are mid-glide from a previous launch — let them
    // finish their current lerp (the loop keeps running). But their DOTS snap
    // back to the pending/initial position for the new slot rather than carrying
    // the old descent: flag those tweens as "finishing" so the loop still
    // advances them while getLaunchState() hides them (rendered as pending).
    for (const e of this._launching.values()) e.finishing = true;
    this._stagedSlotId = id;
    this._stagedTargets = slot.snapshot.frequencies.slice();
    this._stageVersion += 1;
    this._fire();
    return true;
  }

  clearStaged() {
    if (this._stagedSlotId == null) return;
    this._cancelLaunchGlide();
    this._stagedSlotId = null;
    this._stagedTargets = null;
    this._launching.clear();
    this._stageVersion += 1;
    this._fire();
  }

  // Per-oscillator target Hz for the staged slot, or null if none staged.
  getStagedFrequencies() {
    return this._stagedTargets ? this._stagedTargets.slice() : null;
  }

  // Snapshot of the launch state for the spectrum bar: the per-voice targets
  // and which voices are mid-glide (with start/target so the bar can fade the
  // marker as its orb closes in). Targets persist after landing so they act as
  // "return here" markers until the user releases them (clearStaged).
  getLaunchState() {
    if (!this._stagedTargets) return null;
    const launching = {};
    for (const [i, v] of this._launching) {
      if (v.finishing) continue;   // finishing an old glide — its dot renders as pending
      launching[i] = { startHz: v.startHz, targetHz: v.targetHz };
    }
    return {
      targets: this._stagedTargets.slice(),
      launching,
    };
  }

  // Capture a single undo point when a launch batch starts (nothing in flight)
  // so a whole recall/return can be backed out as one edit.
  _beginLaunch() {
    if (this._launching.size === 0) {
      if (this._lastStable) {
        this._undoStack.push(this._lastStable);
        if (this._undoStack.length > UNDO_LIMIT) this._undoStack.shift();
        this._redoStack = [];
      }
    }
  }

  // Glide one staged voice to its target (frequency only — the tuning context
  // is left as-is). Other in-flight voices keep gliding: a single unified
  // glide always covers every currently-launching voice.
  launchVoice(index) {
    if (!this._stagedTargets || !audioEngine.initialized) return false;
    // Single-dot launch is a frequency gesture; only meaningful when freq is in
    // the recall scope (its markers are hidden otherwise).
    if (!this._recallScope.has('freq')) return false;
    const target = this._stagedTargets[index];
    if (!Number.isFinite(target)) return false;
    const existing = this._launching.get(index);
    if (existing && !existing.finishing) return true;   // already gliding to this target
    this._beginLaunch();
    this._addLaunch(index, target);
    this._stageVersion += 1;
    this._ensureLaunchLoop();
    this._fire();
    return true;
  }

  // Launch/return every not-in-flight staged voice at once (the chip's second
  // click). Restores the slot's tuning context (anchor / ratios / system)
  // immediately, like a full recall, then glides all those frequencies. Works
  // as a "return all" once voices have landed and drifted.
  launchAll() {
    if (!this._stagedTargets || !audioEngine.initialized) return false;
    const scope = this._recallScope;
    if (scope.size === 0) return false;   // empty recall scope → applies nothing
    const slot = this._saveSlots.find((s) => s.id === this._stagedSlotId);
    const snap = slot?.snapshot;
    const count = audioEngine.getOscillatorCount();
    this._beginLaunch();
    let did = false;
    let didFreqLaunch = false;

    // Frequency — the marker-driven glide (restores tuning context too).
    if (scope.has('freq')) {
      let added = false;
      for (let i = 0; i < this._stagedTargets.length; i++) {
        const t = this._stagedTargets[i];
        const existing = this._launching.get(i);
        if (!Number.isFinite(t) || (existing && !existing.finishing)) continue;
        this._addLaunch(i, t);
        added = true;
      }
      if (added) {
        if (snap) this._restoreManagerFields(snap);
        this._ensureLaunchLoop();
        didFreqLaunch = true;
        did = true;
      }
    }

    // Volume — glides silently over the recall timing. When there's no freq
    // launch loop to settle `_lastStable` on arrival, do it in the glide's
    // completion so the post-recall state becomes the new baseline for undo.
    if (scope.has('vol') && snap && Array.isArray(snap.volumes)) {
      if (audioEngine.cancelVolumeGlide) audioEngine.cancelVolumeGlide();
      const onDone = didFreqLaunch ? null : () => {
        this._lastStable = this._takeSnapshot();
        this._fire();
      };
      audioEngine.glideVolumes(snap.volumes.slice(0, count), this._recallGlideMs, onDone);
      did = true;
    }

    // On/off — applied immediately (click-free envelope fade); the drone/mute
    // buttons reflect it.
    if (scope.has('onoff') && snap && Array.isArray(snap.mutes)) {
      for (let i = 0; i < count; i++) {
        const target = !!snap.mutes[i];
        if (audioEngine.isMuted(i) !== target) {
          if (target) audioEngine.muteOscillator(i);
          else audioEngine.unmuteOscillator(i);
        }
      }
      did = true;
    }

    if (!did) return false;   // nothing new to apply
    // On/off-only recall (no freq loop, no vol glide) settles immediately —
    // mutes + volumes are already at rest, so re-baseline now.
    if (!didFreqLaunch && !scope.has('vol')) this._lastStable = this._takeSnapshot();
    this._stageVersion += 1;
    this._fire();
    return true;
  }

  // Restore manager-only fields (anchor / locked ratios / tuning system) from
  // a snapshot without touching frequencies — the immediate half of a recall.
  _restoreManagerFields(snap) {
    this._anchorSlot = snap.anchorSlot;
    this._persistRootSlot();
    this._slotRatios = new Map(snap.slotRatios);
    this._tuningSystem = snap.tuningSystem
      || ({ 5: '5-limit', 7: '7-limit', 11: '11-limit' }[snap.limit])
      || DEFAULT_SYSTEM;
  }

  // Register one voice as launching, stamped with its own start time so it
  // glides on an INDEPENDENT clock — clicking a second dot never resets the
  // first (this is what makes a staggered cascade look right). Eased from the
  // voice's current frequency to its target, in log2 space.
  _addLaunch(index, target) {
    const startHz = audioEngine.getFrequency(index);
    this._launching.set(index, {
      startHz,
      targetHz: target,
      startMs: performance.now(),
      logStart: Math.log2(Math.max(0.001, startHz)),
      logTarget: Math.log2(Math.max(0.001, target)),
    });
  }

  // One rAF loop advances ALL in-flight voices, each on its own clock. It
  // writes ONLY the launching voices (not a full batch), so every other
  // oscillator stays free for the user to drag mid-launch. Voices are removed
  // as they land; the loop stops when none remain.
  _ensureLaunchLoop() {
    if (this._launchRaf != null) return;                 // already running
    if (audioEngine.cancelFrequencyGlide) audioEngine.cancelFrequencyGlide();
    const step = () => {
      this._launchRaf = null;
      if (this._launching.size === 0) return;
      const now = performance.now();
      const dur = this._recallGlideMs;
      const ease = this._recallCurveFn();
      const arrived = [];
      // All engine writes for the frame are wrapped in the propagation guard
      // so they don't trigger follow-root transpose / lock reconciliation.
      this._inPropagation = true;
      try {
        for (const [index, e] of this._launching) {
          const t = dur > 0 ? Math.min(1, (now - e.startMs) / dur) : 1;
          audioEngine.setFrequency(index, Math.pow(2, e.logStart + (e.logTarget - e.logStart) * ease(t)));
          if (t >= 1) arrived.push(index);
        }
      } finally {
        this._inPropagation = false;
      }
      // Keep the transpose reference current if the anchor is among the movers.
      const hz = audioEngine.getFrequency(this._anchorSlot);
      if (Number.isFinite(hz) && hz > 0) this._lastAnchorHz = hz;

      if (arrived.length) {
        for (const index of arrived) this._launching.delete(index);
        this._lastStable = this._takeSnapshot();
        this._stageVersion += 1;
        // Staging PERSISTS after landing: the targets stay as "return here"
        // markers (they fade back in as the user drifts the orbs away). The
        // user releases them explicitly via clearStaged (the X button).
        this._fire();
      }
      if (this._launching.size > 0) this._launchRaf = requestAnimationFrame(step);
    };
    this._launchRaf = requestAnimationFrame(step);
  }

  _cancelLaunchGlide() {
    if (this._launchRaf != null) {
      cancelAnimationFrame(this._launchRaf);
      this._launchRaf = null;
    }
  }

  renameSlot(id, name) {
    const slot = this._saveSlots.find((s) => s.id === id);
    if (!slot) return;
    const trimmed = String(name || '').trim();
    if (!trimmed || trimmed === slot.name) return;
    slot.name = trimmed;
    this._persistSaveSlots();
    this._fire();
  }

  _takeSnapshot() {
    // Always full (lossless capture). Scope is applied at recall/undo time,
    // never here. Volumes read on the raw 0..1 scale (getVolume, NOT
    // getAllVolumes which returns 0-100 percentages).
    const count = audioEngine.getOscillatorCount();
    const volumes = [];
    for (let i = 0; i < count; i++) volumes.push(audioEngine.getVolume(i));
    return {
      frequencies: audioEngine.getAllFrequencies(),
      volumes,
      mutes: audioEngine.getAllMutedStates(),
      slotRatios: new Map(this._slotRatios),
      anchorSlot: this._anchorSlot,
      tuningSystem: this._tuningSystem,
    };
  }

  /**
   * Apply a snapshot through a scope mask, gliding over `durationMs`. Only
   * params in `scope` are written: freq glides in pitch space (and restores
   * the tuning context), vol glides in level space, onoff toggles the mute
   * state (click-free envelope fade — the timing slider governs freq/vol, not
   * the mute fade, which is fixed by the drone envelope). The undo-restore
   * guard stays raised until every started glide finishes so the per-frame
   * engine listener doesn't treat the motion as user drift.
   */
  _applySnapshotSmooth(snap, scope, durationMs) {
    const wantFreq = scope.has('freq');
    const wantVol = scope.has('vol');
    const wantOnoff = scope.has('onoff');

    // Cancel any in-flight glides so back-to-back recalls behave.
    if (wantFreq && audioEngine.cancelFrequencyGlide) audioEngine.cancelFrequencyGlide();
    if (wantVol && audioEngine.cancelVolumeGlide) audioEngine.cancelVolumeGlide();

    this._inUndoRestore = true;

    if (wantFreq) {
      // Restore the tuning context immediately; frequencies glide.
      this._anchorSlot = snap.anchorSlot;
      this._persistRootSlot();
      this._slotRatios = new Map(snap.slotRatios);
      this._tuningSystem = snap.tuningSystem
        || ({ 5: '5-limit', 7: '7-limit', 11: '11-limit' }[snap.limit])
        || DEFAULT_SYSTEM;
    }

    const count = audioEngine.getOscillatorCount();

    // On/off is applied up front (its fade is the engine's, not timed).
    if (wantOnoff && Array.isArray(snap.mutes)) {
      for (let i = 0; i < count; i++) {
        const target = !!snap.mutes[i];
        if (audioEngine.isMuted(i) !== target) {
          if (target) audioEngine.muteOscillator(i);
          else audioEngine.unmuteOscillator(i);
        }
      }
    }

    const finish = () => {
      this._inUndoRestore = false;
      this._lastAnchorHz = audioEngine.getFrequency(this._anchorSlot);
      this._lastStable = this._takeSnapshot();
      this._fire();
    };

    // Fire once now so the UI reflects the restored context / mutes while any
    // glide is in motion.
    this._fire();

    const dur = Math.max(0, Number(durationMs) || 0);
    if (dur <= 0) {
      // Instant: batch-write then settle synchronously.
      if (wantFreq) audioEngine.setAllFrequenciesBatch(snap.frequencies.slice(0, count));
      if (wantVol && Array.isArray(snap.volumes)) audioEngine.setAllVolumesBatch(snap.volumes.slice(0, count));
      finish();
      return;
    }

    // Timed: run the freq + vol glides concurrently; finish once both land.
    let pending = 0;
    const done = () => { pending -= 1; if (pending <= 0) finish(); };
    if (wantFreq) {
      pending += 1;
      audioEngine.glideToFrequencies(snap.frequencies.slice(0, count), dur, done, this._recallCurveFn());
    }
    if (wantVol && Array.isArray(snap.volumes)) {
      pending += 1;
      audioEngine.glideVolumes(snap.volumes.slice(0, count), dur, done);
    }
    if (pending === 0) finish();   // onoff-only (or empty): nothing to glide
  }

  // Equality restricted to a scope's parameters. Used to decide whether an
  // edit is worth an undo entry (compared against `_undoScope`) and to skip
  // no-op undo/redo steps. Param → fields:
  //   freq  → anchor + tuning system + frequencies + locked ratios
  //   vol   → volumes
  //   onoff → mutes
  _scopedEqual(a, b, scope) {
    if (scope.has('freq')) {
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
    }
    if (scope.has('vol')) {
      if (!FrequencyManager._numArraysEqual(a.volumes, b.volumes, 1e-3)) return false;
    }
    if (scope.has('onoff')) {
      if (!FrequencyManager._boolArraysEqual(a.mutes, b.mutes)) return false;
    }
    return true;
  }

  static _numArraysEqual(a, b, tol) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > tol) return false;
    return true;
  }
  static _boolArraysEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!!a[i] !== !!b[i]) return false;
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
    // Only an in-undoScope change is worth an undo entry. An out-of-scope-only
    // change still updates the baseline (so stored snapshots stay current) but
    // does NOT push history — this is what makes undo "follow the scope".
    if (this._scopedEqual(this._lastStable, now, this._undoScope)) {
      this._lastStable = now;
      return;
    }
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

    // A glide (Align / Load / recall) writes every voice's target each
    // frame, so follow-root transpose and lock propagation are both
    // redundant — and running them here would fire setFrequency per voice,
    // re-triggering this whole listener fan-out O(N) times per frame (the
    // source of the glide lag). Skip the work, but keep _lastAnchorHz
    // current so the first user move AFTER the glide computes a sane
    // transpose factor. The per-frame panel/spectrum repaint still happens
    // via the separate bump listener.
    if (audioEngine.isGliding) {
      const hz = audioEngine.getFrequency(this._anchorSlot);
      if (Number.isFinite(hz) && hz > 0) this._lastAnchorHz = hz;
      return;
    }

    const anchorHz = audioEngine.getFrequency(this._anchorSlot);
    if (!Number.isFinite(anchorHz) || anchorHz <= 0) {
      this._fire();
      return;
    }

    const anchorChanged = Math.abs(anchorHz - this._lastAnchorHz) > 1e-4;

    if (anchorChanged) {
      // Anchor moved — propagate. (External anchor changes from the audio
      // engine — orb drags, patch loads, the FrequencySliders strip — flow
      // through here. Manager-driven setRootHz in follow-root mode scales
      // every slot itself and uses _inPropagation to suppress this branch.)
      const factor = this._lastAnchorHz > 0 ? anchorHz / this._lastAnchorHz : null;
      this._inPropagation = true;
      try {
        if (this._followRoot && factor) {
          // Follow-root ON: transpose EVERY other voice by the same factor
          // so the whole chord tracks the root — locked ratios are preserved
          // (factor leaves n/d unchanged) and free voices come along too.
          const count = audioEngine.getOscillatorCount();
          for (let slot = 0; slot < count; slot++) {
            if (slot === this._anchorSlot) continue;
            const cur = audioEngine.getFrequency(slot);
            if (!Number.isFinite(cur) || cur <= 0) continue;
            audioEngine.setFrequency(slot, cur * factor);
          }
        } else {
          // Follow-root OFF: only locked slots track the anchor so their
          // {n, d} stays honored; free voices hold their absolute Hz.
          for (const [slot, ratio] of this._slotRatios) {
            if (slot === this._anchorSlot) continue;
            const expectedHz = anchorHz * (ratio.n / ratio.d);
            audioEngine.setFrequency(slot, expectedHz);
          }
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

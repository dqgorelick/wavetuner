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
import { FREQ_CEIL } from './freqRange';
import keyboardVoiceManager from './KeyboardVoiceManager';
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

// Default overlap window (ms) for step transitions — how long the old and
// new notes sound together when a voice retriggers. Independent of the
// glide time so glide length and step overlap can be dialed separately.
const DEFAULT_STEP_OVERLAP_MS = 2750;

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

// How a launched voice travels to its staged target.
// 'glide'    — the classic portamento tween (pitch bends continuously).
// 'step'     — a retrigger: a fresh note starts at the target while the old
//              note holds through an overlap window and releases (both sound
//              at once). The recall-timing slider doubles as the overlap
//              length. A batch launch (GO) only retriggers voices whose
//              pitch actually changes — voices already at their target keep
//              ringing untouched.
// 'step-all' — same retrigger, but a batch launch re-strikes EVERY staged
//              voice, unchanged pitches included (a full chord re-attack).
const TRANSITION_MODES = ['glide', 'step', 'step-all'];
const DEFAULT_TRANSITION_MODE = 'glide';

// ─── Parameter lock (capture scope) ──────────────────────────────────
// The lockable parameters. Capture always stores all of them; a scope is
// a live mask deciding which get APPLIED on recall (recallScope) and which
// are tracked/restored by undo/redo (undoScope). See PARAMETER_LOCK.md.
//   freq      → frequencies + locked ratios + anchor + tuning system (pitch context)
//   vol       → per-voice volume (0..1)
//   onoff     → per-voice mute state
//   transpose → the global transpose offset (semitones, ±24)
//   notes     → held keyboard/MIDI notes. Always in scope — not a chip in
//               the params UI; recalls simply include the played chord.
const PARAM_KEYS = ['freq', 'vol', 'onoff', 'transpose', 'notes'];

// Pitch tolerance (log2) for matching a live held voice to a saved held
// note in the recall diff — comfortably above float/tuning drift,
// comfortably below any real scale step. Both sides compare NOMINAL
// (detune-free) pitch.
const NOTE_MATCH_EPS = 5e-3; // ≈ 8.6 cents
// Default scope = frequency + held notes. Notes are always tracked (the chip
// is gone — _loadScope force-adds the key); the other params stay opt-in.
const DEFAULT_SCOPE = ['freq', 'notes'];

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
    // Pending deferred note-offs from a GO transition: on/off recall is
    // asymmetric (ONs attack immediately, OFFs release at the END of the
    // transition), so the offs ride a timer that must be cancellable when a
    // new recall/undo supersedes the transition. Held-note releases follow
    // the same asymmetry on their own timer.
    this._deferredMuteTimer = null;
    this._deferredNoteTimer = null;
    this._recallGlideMs = FrequencyManager._loadRecallGlideMs();
    this._stepOverlapMs = FrequencyManager._loadStepOverlapMs();
    this._recallCurve = FrequencyManager._loadRecallCurve();
    this._transitionMode = FrequencyManager._loadTransitionMode();

    // Parameter lock. The UI presents ONE parameter set ("Parameters tracked")
    // shared by capture-recall and undo/redo, so `_recallScope` and `_undoScope`
    // stay in lockstep (see toggleParam). Timings are INDEPENDENT — a Capture
    // recall timing and a separate Undo/Redo timing. Default: frequency-only.
    this._recallScope = FrequencyManager._loadScope('tuningRecallScope');
    this._undoScope = new Set(this._recallScope);
    this._scopeLinked = true; // vestigial (params unified); kept for compatibility
    this._undoGlideMs = FrequencyManager._loadUndoGlideMs(DEFAULT_UNDO_GLIDE_MS);

    audioEngine.addFrequencyListener(() => this._onEngineFreqChange());
    // Transpose edits bypass the frequency listeners by design (they never
    // write frequencyValues), so hook the undo debounce here separately: with
    // 'transpose' in the undo scope a label-strip drag becomes an undoable
    // step; out-of-scope changes still refresh the stored baseline.
    audioEngine.addTransposeListener(() => {
      if (this._inPropagation || this._inUndoRestore) return;
      this._scheduleSnapshot();
    });

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
          // volumes/mutes/transpose are newer fields — tolerate older saves
          // without them.
          volumes: Array.isArray(snap.volumes) ? snap.volumes.slice() : null,
          mutes: Array.isArray(snap.mutes) ? snap.mutes.slice() : null,
          transpose: Number.isFinite(snap.transpose) ? snap.transpose : null,
          slotRatios: new Map(Array.isArray(snap.slotRatios) ? snap.slotRatios : []),
          anchorSlot: Number.isInteger(snap.anchorSlot) ? snap.anchorSlot : 0,
          tuningSystem: snap.tuningSystem || DEFAULT_SYSTEM,
          // heldNotes hz is NOMINAL (transpose-free) as of the notesNominal
          // flag. Earlier saves baked the capture-time transpose into the
          // pitch — divide it back out once here so old saves recall at the
          // right offset-relative pitch.
          heldNotes: FrequencyManager._normalizeHeldNotes(
            snap.heldNotes,
            snap.notesNominal === true || !Number.isFinite(snap.transpose)
              ? 1
              : Math.pow(2, snap.transpose / 12),
          ),
          notesNominal: true,
        },
      });
    }
    return out.slice(-SAVE_LIMIT);
  }

  // Sanitize a snapshot's held-notes array (HELD_NOTES.md §2). Null when the
  // save predates the field; entries with a bad pitch are dropped, the rest
  // clamped into range so a corrupt localStorage/patch value can't inject
  // NaNs into a future recall. `divisor` handles the pre-notesNominal
  // format: the capture-time transpose ratio divides back out so hz lands
  // in nominal (transpose-free) space.
  static _normalizeHeldNotes(arr, divisor = 1) {
    if (!Array.isArray(arr)) return null;
    const out = [];
    for (const n of arr) {
      if (!n || !Number.isFinite(n.hz) || !(n.hz > 0)) continue;
      out.push({
        hz: Math.min(FREQ_CEIL, n.hz / (divisor || 1)),
        level: Number.isFinite(n.level) ? Math.max(0, Math.min(1, n.level)) : 0.5,
        source: n.source === 'kbd' ? 'kbd' : 'midi',
        slot: Number.isFinite(n.slot) ? n.slot : null,
        octave: Number.isFinite(n.octave) ? n.octave : null,
      });
    }
    return out;
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
        transpose: Number.isFinite(s.snapshot.transpose) ? s.snapshot.transpose : null,
        slotRatios: Array.from(s.snapshot.slotRatios.entries()),
        anchorSlot: s.snapshot.anchorSlot,
        tuningSystem: s.snapshot.tuningSystem,
        heldNotes: Array.isArray(s.snapshot.heldNotes)
          ? s.snapshot.heldNotes.map((n) => ({ ...n }))
          : null,
        notesNominal: true,
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

  // Step-overlap persistence. Falls back to the default when unset.
  static _loadStepOverlapMs() {
    try {
      const v = parseFloat(localStorage.getItem('tuningStepOverlapMs'));
      if (Number.isFinite(v)) return Math.max(0, Math.min(MAX_RECALL_GLIDE_MS, v));
    } catch { /* ignore */ }
    return DEFAULT_STEP_OVERLAP_MS;
  }
  _persistStepOverlapMs() {
    try { localStorage.setItem('tuningStepOverlapMs', String(this._stepOverlapMs)); } catch { /* ignore */ }
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

  // Transition-mode persistence. Falls back to glide for unknown values.
  static _loadTransitionMode() {
    try {
      const v = localStorage.getItem('tuningTransitionMode');
      if (TRANSITION_MODES.includes(v)) return v;
    } catch { /* ignore */ }
    return DEFAULT_TRANSITION_MODE;
  }
  _persistTransitionMode() {
    try { localStorage.setItem('tuningTransitionMode', this._transitionMode); } catch { /* ignore */ }
  }

  // Scope persistence — a scope is stored as a comma-joined key list. Unknown
  // keys are dropped; a missing/corrupt value falls back to the default.
  static _loadScope(storageKey) {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw != null) {
        const keys = raw.split(',').filter((k) => PARAM_KEYS.includes(k));
        const scope = new Set(keys);
        // 'notes' is no longer a user-toggleable chip — held notes are always
        // tracked. Scopes persisted before that change migrate forward here.
        scope.add('notes');
        return scope;
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
      this._releaseTravelEntries();
      this._launching.clear();
      this._stageVersion += 1;   // markers re-read as pending
    }
  }

  // Dropping launch entries wholesale would orphan any in-flight travellers
  // — free-floating nodes nobody would ever land or stop. Release them
  // (envelope tail) whenever the map is cleared rather than finished.
  _releaseTravelEntries() {
    for (const e of this._launching.values()) {
      if (e.travelerId != null) audioEngine.releaseTravelVoice(e.travelerId);
    }
  }

  // Drop any note-offs still waiting on a transition's end — a superseding
  // recall/undo/stage-release owns the mute state from here. Held-note
  // releases ride the same lifecycle.
  _cancelDeferredMutes() {
    if (this._deferredMuteTimer != null) {
      clearTimeout(this._deferredMuteTimer);
      this._deferredMuteTimer = null;
    }
    if (this._deferredNoteTimer != null) {
      clearTimeout(this._deferredNoteTimer);
      this._deferredNoteTimer = null;
    }
  }

  // Recall diff for held notes (HELD_NOTES.md §4): match the live held
  // chord to a save's heldNotes by nominal pitch (greedy nearest within
  // NOTE_MATCH_EPS). Matched voices are KEPT untouched; unmatched saved
  // notes spawn; unmatched live voices release.
  _diffHeldNotes(saved) {
    const live = keyboardVoiceManager.getHeldNotesLive();
    const usedLive = new Set();
    const toSpawn = [];
    for (const n of saved) {
      let best = null;
      let bestD = Infinity;
      for (const v of live) {
        if (usedLive.has(v.id)) continue;
        const d = Math.abs(Math.log2(n.hz / v.hz));
        if (d < bestD) { bestD = d; best = v; }
      }
      if (best && bestD <= NOTE_MATCH_EPS) usedLive.add(best.id);
      else toSpawn.push(n);
    }
    const toRelease = live.filter((v) => !usedLive.has(v.id));
    return { toSpawn, toRelease };
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

  get stepOverlapMs() {
    return this._stepOverlapMs;
  }

  /**
   * Set the overlap window (ms) for step transitions — how long the old
   * and new notes sound together on a retrigger. Same clamp range as the
   * glide timing; 0 = instant handoff.
   */
  setStepOverlapMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(0, Math.min(MAX_RECALL_GLIDE_MS, n));
    if (clamped === this._stepOverlapMs) return;
    this._stepOverlapMs = clamped;
    this._persistStepOverlapMs();
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
    if (key === 'notes') return; // always tracked — no chip
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

  // ─── Transition mode (glide vs step) ─────────────────────────────────
  // 'glide' bends pitch to the target; 'step' retriggers a fresh note at
  // the target while the old note overlaps and releases. Drives which
  // primitive the launch UI calls (launchVoice vs stepVoice) and how
  // launchAll moves the batch.
  get transitionMode() { return this._transitionMode; }

  setTransitionMode(mode) {
    if (mode === this._transitionMode) return;
    if (!TRANSITION_MODES.includes(mode)) return;
    this._transitionMode = mode;
    this._persistTransitionMode();
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

  // True while a GO/recall still has deferred note-offs waiting on the end
  // of its glide — with isLaunching and the conductor's `running`, the UI's
  // "a transition is in flight" signal (the pending-on rings pulse then).
  get recallOffsPending() {
    return this._deferredMuteTimer != null || this._deferredNoteTimer != null;
  }

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

  // finishGlides: let in-flight launch tweens complete to their captured
  // targets (each entry carries its own targetHz — the loop doesn't need the
  // staging) instead of freezing voices mid-glide off every save. Used by the
  // capture bar's deselect; the default freeze remains for wholesale state
  // replacement (patch load, slot delete) where a new motion takes over.
  clearStaged({ finishGlides = false } = {}) {
    if (this._stagedSlotId == null) return;
    if (finishGlides) {
      for (const e of this._launching.values()) e.finishing = true;
    } else {
      this._cancelLaunchGlide();
      this._releaseTravelEntries();
      this._launching.clear();
      // Wholesale replacement also drops a transition's pending note-offs;
      // a finishing deselect lets them play out with the glides.
      this._cancelDeferredMutes();
    }
    this._stagedSlotId = null;
    this._stagedTargets = null;
    this._stageVersion += 1;
    this._fire();
  }

  // Per-oscillator target Hz for the staged slot, or null if none staged.
  getStagedFrequencies() {
    return this._stagedTargets ? this._stagedTargets.slice() : null;
  }

  // Staged non-frequency targets — what GO would apply to volume / on-off.
  // Null when nothing is staged, the param isn't tracked, or the save
  // predates the field. The UI previews these: the mixer draws a target dot
  // at each staged volume; the spectrum orbs half-fade on a pending mute
  // flip.
  getStagedVolumes() {
    if (this._stagedSlotId == null || !this._recallScope.has('vol')) return null;
    const snap = this._saveSlots.find((s) => s.id === this._stagedSlotId)?.snapshot;
    return snap && Array.isArray(snap.volumes) ? snap.volumes.slice() : null;
  }

  getStagedMutes() {
    if (this._stagedSlotId == null || !this._recallScope.has('onoff')) return null;
    const snap = this._saveSlots.find((s) => s.id === this._stagedSlotId)?.snapshot;
    return snap && Array.isArray(snap.mutes) ? snap.mutes.slice() : null;
  }

  // Staged held-note targets — the played chord GO would restore. Null when
  // nothing is staged or the save predates capture.
  getStagedNotes() {
    if (this._stagedSlotId == null || !this._recallScope.has('notes')) return null;
    const snap = this._saveSlots.find((s) => s.id === this._stagedSlotId)?.snapshot;
    return snap && Array.isArray(snap.heldNotes)
      ? snap.heldNotes.map((n) => ({ ...n }))
      : null;
  }

  // A slot's saved frequencies without staging it — how the conductor asks
  // "which save are the voices sitting on?" before auto-selecting the next
  // one. Null for an unknown id.
  getSlotFrequencies(id) {
    const slot = this._saveSlots.find((s) => s.id === id);
    return slot?.snapshot?.frequencies ? slot.snapshot.frequencies.slice() : null;
  }

  // A slot's saved mute mask without staging it — the conductor's "which
  // save are the voices on?" check compares chords, not just tunings, once
  // saves can differ by mutes alone. Null for unknown ids / pre-mutes saves.
  getSlotMutes(id) {
    const snap = this._saveSlots.find((s) => s.id === id)?.snapshot;
    return snap && Array.isArray(snap.mutes) ? snap.mutes.slice() : null;
  }

  // Pending held-note preview for the spectrum bar's octave indicators:
  // the staged save's note diff mapped to (slot, octave) marks. 'on' =
  // a note will attack there on GO/transition, 'off' = the note sounding
  // there will release. Null when nothing is staged / notes untracked /
  // the save predates capture. Cheap enough to poll per frame.
  getStagedNoteMarks() {
    const notes = this.getStagedNotes();
    if (!notes) return null;
    const { toSpawn, toRelease } = this._diffHeldNotes(notes);
    if (toSpawn.length === 0 && toRelease.length === 0) return null;
    const count = audioEngine.getOscillatorCount();
    // Resolve a note without slot/octave hints the same way spawnVoiceAt
    // will: nearest current drone pitch, octave from the ratio.
    const resolve = (hz, slot, octave) => {
      let s = Number.isFinite(slot) && slot >= 0 && slot < count ? slot : -1;
      if (s < 0) {
        let bestD = Infinity;
        for (let i = 0; i < count; i++) {
          const f = audioEngine.getFrequency(i);
          if (!(f > 0)) continue;
          const d = Math.abs(Math.log2(hz / f));
          if (d < bestD) { bestD = d; s = i; }
        }
        if (s < 0) return null;
      }
      const slotHz = audioEngine.getFrequency(s);
      const o = Number.isFinite(octave)
        ? octave
        : (slotHz > 0 ? Math.round(Math.log2(hz / slotHz)) : 0);
      return { slot: s, octave: o };
    };
    const on = [];
    const off = [];
    for (const n of toSpawn) {
      const m = resolve(n.hz, n.slot, n.octave);
      if (m) on.push(m);
    }
    for (const v of toRelease) {
      const m = resolve(v.hz, v.slot, v.octave);
      if (m) off.push(m);
    }
    return { on, off };
  }

  // A slot's captured held kbd/MIDI chord (HELD_NOTES.md §2) — read-only
  // feed for the "what's in this save" UI (badge/preview) and, later, the
  // 'notes' recall path. Null for unknown ids / saves predating the field.
  getSlotHeldNotes(id) {
    const snap = this._saveSlots.find((s) => s.id === id)?.snapshot;
    return snap && Array.isArray(snap.heldNotes)
      ? snap.heldNotes.map((n) => ({ ...n }))
      : null;
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
      // Cross-slot travels + held-voice glides have their own viz (later).
      if (v.travelerId != null || v.heldVoiceId != null) continue;
      launching[i] = { startHz: v.startHz, targetHz: v.targetHz };
    }
    return {
      targets: this._stagedTargets.slice(),
      launching,
    };
  }

  // True when launching the staged slot would actually change something the
  // recall scope covers: a voice off its staged frequency, or — with vol /
  // on-off / transpose tracked — any of those params off the slot's saved
  // values. Drives the GO button's lit state; a freq-only check would leave
  // GO dark when only the mix, mutes or transpose had drifted off the save.
  stagedIsDirty() {
    if (!this._stagedTargets || !audioEngine.initialized) return false;
    const scope = this._recallScope;
    if (scope.size === 0) return false;
    if (scope.has('freq')) {
      for (let i = 0; i < this._stagedTargets.length; i++) {
        const t = this._stagedTargets[i];
        if (!Number.isFinite(t)) continue;
        const cur = audioEngine.getFrequency(i);
        if (!Number.isFinite(cur)) continue;
        // Relative tolerance so tiny float noise doesn't count as a move.
        if (Math.abs(cur - t) > Math.max(0.02, t * 1e-4)) return true;
      }
    }
    const slot = this._saveSlots.find((s) => s.id === this._stagedSlotId);
    const snap = slot?.snapshot;
    if (!snap) return false;
    const count = audioEngine.getOscillatorCount();
    if (scope.has('vol') && Array.isArray(snap.volumes)) {
      for (let i = 0; i < count && i < snap.volumes.length; i++) {
        if (Math.abs(audioEngine.getVolume(i) - snap.volumes[i]) > 1e-3) return true;
      }
    }
    if (scope.has('onoff') && Array.isArray(snap.mutes)) {
      for (let i = 0; i < count && i < snap.mutes.length; i++) {
        if (audioEngine.isMuted(i) !== !!snap.mutes[i]) return true;
      }
    }
    if (scope.has('transpose') && Number.isFinite(snap.transpose)) {
      if (Math.abs(audioEngine.getTransposeSemitones() - snap.transpose) > 1e-3) return true;
    }
    if (scope.has('notes') && Array.isArray(snap.heldNotes)) {
      const { toSpawn, toRelease } = this._diffHeldNotes(snap.heldNotes);
      if (toSpawn.length > 0 || toRelease.length > 0) return true;
    }
    return false;
  }

  // One explicit undo point for a compound gesture. The generative transition
  // pushes this ONCE before its staggered launches/steps (which all run
  // noUndo), so undo backs the WHOLE transition out to the pre-transition
  // state instead of stepping through mixed mid-transition chords.
  pushUndoPoint() {
    if (!this._lastStable) return;
    this._undoStack.push(this._lastStable);
    if (this._undoStack.length > UNDO_LIMIT) this._undoStack.shift();
    this._redoStack = [];
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
  // is left as-is). Other in-flight voices keep gliding: each carries its own
  // clock, and optionally its own duration (opts.durMs — used by the generative
  // transition so far notes travel longer; default = the shared recall glide).
  launchVoice(index, { durMs = null, noUndo = false } = {}) {
    if (!this._stagedTargets || !audioEngine.initialized) return false;
    // Single-dot launch is a frequency gesture; only meaningful when freq is in
    // the recall scope (its markers are hidden otherwise).
    if (!this._recallScope.has('freq')) return false;
    const target = this._stagedTargets[index];
    if (!Number.isFinite(target)) return false;
    const existing = this._launching.get(index);
    // Already gliding to this SAME target → no-op. A different target (e.g. a
    // new generative transition superseding a halted one's tail glide) must
    // RETARGET — silently ignoring it would strand the voice on the old save.
    if (existing && !existing.finishing
        && Math.abs(existing.targetHz - target) < 1e-9) return true;
    if (!noUndo) this._beginLaunch();
    this._addLaunch(index, target, durMs);
    this._stageVersion += 1;
    this._ensureLaunchLoop();
    this._fire();
    return true;
  }

  // Step one staged voice to its target: a retrigger (fresh oscillator +
  // envelope attack, old note overlaps then releases) instead of the glide
  // tween. The overlap window is its own timing (stepOverlapMs — "how long
  // both notes sound together"), independent of the glide time; opts.overlapMs
  // overrides it per call (the generative transition rolls one per move).
  // Counterpart to launchVoice; also the primitive the conductor's steps use.
  stepVoice(index, { overlapMs = null, noUndo = false } = {}) {
    if (!this._stagedTargets || !audioEngine.initialized) return false;
    if (!this._recallScope.has('freq')) return false;
    const target = this._stagedTargets[index];
    if (!Number.isFinite(target)) return false;
    if (!noUndo) this._beginLaunch();
    // A step supersedes any in-flight glide on this voice; a re-step of a
    // landed voice is a deliberate re-attack, so no "already there" guard.
    this._launching.delete(index);
    if (audioEngine.cancelFrequencyGlide) audioEngine.cancelFrequencyGlide();
    const overlap = Number.isFinite(overlapMs)
      ? Math.max(0, Math.min(MAX_RECALL_GLIDE_MS, overlapMs))
      : this._stepOverlapMs;
    this._inPropagation = true;
    let did = false;
    try {
      did = audioEngine.stepToFrequency(index, target, overlap);
    } finally {
      this._inPropagation = false;
    }
    if (!did) return false;
    const hz = audioEngine.getFrequency(this._anchorSlot);
    if (Number.isFinite(hz) && hz > 0) this._lastAnchorHz = hz;
    // Steps settle instantly — the post-step state is the new undo baseline.
    this._lastStable = this._takeSnapshot();
    this._stageVersion += 1;
    this._fire();
    return true;
  }

  // ─── Voice-leading primitives (GENERATIVE.md §6.6) ───────────────────
  // Save states with different mute masks transition as VOICE LEADING: the
  // sounding notes are the voices, and a voice may travel ACROSS slot
  // indices (slot = scale degree). The conductor's matcher decides who goes
  // where; these primitives perform one move each. All of them leave every
  // slot exactly on the staged save's frequencies — the journey is
  // cross-index, the landing never is.

  /**
   * Glide the sounding note on slot `fromIndex` to slot `toIndex`'s staged
   * pitch, then hand the audio nodes over — the destination slot ADOPTS the
   * travelling oscillator pair (phase-continuous, no retrigger) and unmutes.
   * The vacated slot goes silent at DEPARTURE and immediately settles on its
   * own staged pitch, so chained travels (0→1 while 1→2) can't collide and a
   * later unmute never surfaces a stray pitch.
   */
  travelVoice(fromIndex, toIndex, { durMs = null, noUndo = false } = {}) {
    if (!this._stagedTargets || !audioEngine.initialized) return false;
    if (!this._recallScope.has('freq')) return false;
    const toHz = this._stagedTargets[toIndex];
    if (!Number.isFinite(toHz)) return false;
    if (!noUndo) this._beginLaunch();
    // A travel supersedes any in-flight glide on the source slot.
    this._launching.delete(fromIndex);
    const startHz = audioEngine.getFrequency(fromIndex);
    const id = audioEngine.detachTravelVoice(fromIndex);
    if (id == null) return false;
    this._settleSlotSilently(fromIndex);
    this._launching.set(`t${id}`, {
      travelerId: id,
      startHz,
      targetHz: toHz,
      startMs: performance.now(),
      durMs: Number.isFinite(durMs) && durMs >= 0 ? durMs : null,
      logStart: Math.log2(Math.max(0.001, startHz)),
      logTarget: Math.log2(Math.max(0.001, toHz)),
      onArrive: () => {
        // A stale (finishing) glide on the destination would keep retuning
        // the slot after adoption, dragging the landed note off-save.
        this._launching.delete(toIndex);
        audioEngine.landTravelVoice(id, toIndex);
      },
    });
    this._stageVersion += 1;
    this._ensureLaunchLoop();
    this._fire();
    return true;
  }

  /**
   * A note the target chord doesn't have: detach it and glide it INTO
   * `intoHz` (its nearest surviving neighbour), releasing on arrival — two
   * voices audibly converging into one. The slot itself settles silently on
   * its staged pitch at departure, exactly like a travel.
   */
  mergeVoice(fromIndex, intoHz, { durMs = null, noUndo = false } = {}) {
    if (!audioEngine.initialized || !Number.isFinite(intoHz)) return false;
    if (!this._recallScope.has('freq')) return false;
    if (!noUndo) this._beginLaunch();
    this._launching.delete(fromIndex);
    const startHz = audioEngine.getFrequency(fromIndex);
    const id = audioEngine.detachTravelVoice(fromIndex);
    if (id == null) return false;
    this._settleSlotSilently(fromIndex);
    this._launching.set(`t${id}`, {
      travelerId: id,
      startHz,
      targetHz: intoHz,
      startMs: performance.now(),
      durMs: Number.isFinite(durMs) && durMs >= 0 ? durMs : null,
      logStart: Math.log2(Math.max(0.001, startHz)),
      logTarget: Math.log2(Math.max(0.001, intoHz)),
      onArrive: () => { audioEngine.releaseTravelVoice(id); },
    });
    this._stageVersion += 1;
    this._ensureLaunchLoop();
    this._fire();
    return true;
  }

  /**
   * The plain exit: note-off. When the slot already sits on its staged pitch
   * this is a classic mute (oscillator keeps running, phase-correlated for a
   * later unmute); when it's off-save the note detaches, releases in place,
   * and the slot silently settles home underneath the tail.
   */
  fadeOutVoice(index, { noUndo = false } = {}) {
    if (!audioEngine.initialized || audioEngine.isMuted(index)) return false;
    if (!noUndo) this._beginLaunch();
    const homeHz = this._stagedTargets ? this._stagedTargets[index] : null;
    const cur = audioEngine.getFrequency(index);
    const offSave = Number.isFinite(homeHz) && cur > 0
      && Math.abs(Math.log2(homeHz / cur)) > 1e-3;
    if (offSave) {
      this._launching.delete(index);
      const id = audioEngine.detachTravelVoice(index);
      if (id == null) return false;
      audioEngine.releaseTravelVoice(id);
      this._settleSlotSilently(index);
      // The slot flipped muted but the detached note is still fading —
      // mark it so the UI shows the note as GOING, not gone.
      audioEngine.markSlotReleasing(index);
    } else {
      audioEngine.muteOscillator(index);
    }
    this._lastStable = this._takeSnapshot();
    this._stageVersion += 1;
    this._fire();
    return true;
  }

  /**
   * The plain entrance: silently place the slot on its staged pitch, then
   * note-on (drone envelope attack).
   */
  fadeInVoice(index, { noUndo = false } = {}) {
    if (!this._stagedTargets || !audioEngine.initialized) return false;
    const target = this._stagedTargets[index];
    if (!Number.isFinite(target) || !audioEngine.isMuted(index)) return false;
    if (!noUndo) this._beginLaunch();
    // A stale (finishing) glide would keep retuning the slot once audible.
    this._launching.delete(index);
    this._inPropagation = true;
    try { audioEngine.setFrequency(index, target); } finally { this._inPropagation = false; }
    audioEngine.unmuteOscillator(index);
    this._lastStable = this._takeSnapshot();
    this._stageVersion += 1;
    this._fire();
    return true;
  }

  /**
   * The voice-led entrance: the new note BLOOMS out of an existing one — a
   * SPAWNED traveller attacks at `fromHz` (the anchor voice's pitch) and
   * glides home to the slot's staged pitch, where the slot adopts its nodes
   * and unmutes. One note audibly splits into two. The slot itself stays
   * muted and parked on its staged pitch throughout, so nothing slot-bound
   * (the spectrum orb) self-animates — the audible bend is traveller-only,
   * same as a travel, and the piano-roll draws it. Falls back to a plain
   * launch when the slot is already sounding.
   */
  bloomVoice(index, fromHz, { durMs = null, noUndo = false } = {}) {
    if (!this._stagedTargets || !audioEngine.initialized) return false;
    if (!this._recallScope.has('freq')) return false;
    const target = this._stagedTargets[index];
    if (!Number.isFinite(target) || !Number.isFinite(fromHz)) return false;
    if (!audioEngine.isMuted(index)) return this.launchVoice(index, { durMs, noUndo });
    if (!noUndo) this._beginLaunch();
    this._settleSlotSilently(index);
    const id = audioEngine.spawnTravelVoice(fromHz, index);
    if (id == null) return false;
    this._launching.set(`t${id}`, {
      travelerId: id,
      startHz: fromHz,
      targetHz: target,
      startMs: performance.now(),
      durMs: Number.isFinite(durMs) && durMs >= 0 ? durMs : null,
      logStart: Math.log2(Math.max(0.001, fromHz)),
      logTarget: Math.log2(Math.max(0.001, target)),
      onArrive: () => {
        // A stale (finishing) glide on the slot would drag the landed note.
        this._launching.delete(index);
        audioEngine.landTravelVoice(id, index);
      },
    });
    this._stageVersion += 1;
    this._ensureLaunchLoop();
    this._fire();
    return true;
  }

  // ─── Held-note transition primitives (HELD_NOTES.md §5) ─────────────
  // The conductor's voice-leading moves for the keyboard/MIDI pool. Held
  // voices are free agents (no slot to vacate, no node adoption): a travel
  // IS a glide, blooms are spawn-at-anchor-then-glide, fades are plain
  // note-on/off. All rendered by the same launch loop / ease / clock as
  // drone moves, so both pools phrase identically.

  /**
   * Glide one live held voice to an absolute nominal pitch. On arrival the
   * voice re-binds to its nearest slot (so orb drags keep tracking it) —
   * or, with releaseOnArrive (the MERGE ending), it releases into the note
   * it converged on.
   */
  glideHeldVoice(voiceId, toHz, { durMs = null, releaseOnArrive = false } = {}) {
    if (!audioEngine.initialized || !Number.isFinite(toHz)) return false;
    const live = keyboardVoiceManager.getHeldNotesLive();
    const v = live.find((x) => x.id === voiceId);
    if (!v) return false;
    this._launching.set(`v${voiceId}`, {
      heldVoiceId: voiceId,
      startHz: v.hz,
      targetHz: toHz,
      startMs: performance.now(),
      durMs: Number.isFinite(durMs) && durMs >= 0 ? durMs : null,
      logStart: Math.log2(Math.max(0.001, v.hz)),
      logTarget: Math.log2(Math.max(0.001, toHz)),
      onArrive: () => {
        if (releaseOnArrive) keyboardVoiceManager.releaseVoiceById(voiceId);
        else keyboardVoiceManager.rebindVoiceToPitch(voiceId);
      },
    });
    this._ensureLaunchLoop();
    return true;
  }

  /**
   * The held-pool bloom: a NEW voice attacks at the anchor pitch (the note
   * the ear is tracking) and glides home to its saved pitch/level.
   */
  bloomHeldNote(note, fromHz, { durMs = null } = {}) {
    if (!audioEngine.initialized || !note || !Number.isFinite(note.hz)) return false;
    if (!Number.isFinite(fromHz)) return this.spawnHeldNote(note);
    const id = keyboardVoiceManager.spawnVoiceAt(fromHz, {
      level: note.level, source: note.source, slot: note.slot, octave: note.octave,
    });
    if (id == null) return false;
    return this.glideHeldVoice(id, note.hz, { durMs });
  }

  /** Plain held-note entrance — note-on at the saved pitch/level. */
  spawnHeldNote(note) {
    if (!audioEngine.initialized || !note || !Number.isFinite(note.hz)) return false;
    return keyboardVoiceManager.spawnVoiceAt(note.hz, {
      level: note.level, source: note.source, slot: note.slot, octave: note.octave,
    }) != null;
  }

  /** Plain held-note exit — envelope release. */
  releaseHeldVoice(voiceId) {
    keyboardVoiceManager.releaseVoiceById(voiceId);
    return true;
  }

  // After a detach, park the vacated (now silent) slot on its staged pitch —
  // instant and inaudible; the fresh pair has gain 0.
  _settleSlotSilently(index) {
    const homeHz = this._stagedTargets ? this._stagedTargets[index] : null;
    if (!Number.isFinite(homeHz)) return;
    this._inPropagation = true;
    try { audioEngine.setFrequency(index, homeHz); } finally { this._inPropagation = false; }
  }

  // Launch/return every not-in-flight staged voice at once (the chip's second
  // click). Restores the slot's tuning context (anchor / ratios / system)
  // immediately, like a full recall, then glides all those frequencies — or
  // steps them all when the transition mode (or the `mode` override) says so.
  // Works as a "return all" once voices have landed and drifted.
  launchAll({ mode = null } = {}) {
    if (!this._stagedTargets || !audioEngine.initialized) return false;
    const scope = this._recallScope;
    if (scope.size === 0) return false;   // empty recall scope → applies nothing
    const slot = this._saveSlots.find((s) => s.id === this._stagedSlotId);
    const snap = slot?.snapshot;
    const count = audioEngine.getOscillatorCount();
    this._beginLaunch();
    // A superseded transition's pending note-offs must not fire into this one.
    this._cancelDeferredMutes();
    let did = false;
    let didFreqLaunch = false;

    // Frequency — the marker-driven glide (restores tuning context too), or
    // a batch retrigger when the transition mode is a step flavor.
    const effMode = TRANSITION_MODES.includes(mode) ? mode : this._transitionMode;
    if (scope.has('freq')) {
      let added = false;
      if (effMode !== 'glide') {
        if (audioEngine.cancelFrequencyGlide) audioEngine.cancelFrequencyGlide();
        this._inPropagation = true;
        try {
          for (let i = 0; i < this._stagedTargets.length; i++) {
            const t = this._stagedTargets[i];
            if (!Number.isFinite(t)) continue;
            // 'step' leaves voices already at their target alone — no
            // re-attack on a pitch that isn't changing. 'step-all'
            // re-strikes the whole chord, unchanged pitches included.
            if (effMode === 'step' && Math.abs(audioEngine.getFrequency(i) - t) < 0.01) continue;
            this._launching.delete(i);
            if (audioEngine.stepToFrequency(i, t, this._stepOverlapMs)) added = true;
          }
        } finally {
          this._inPropagation = false;
        }
        if (added) {
          if (snap) this._restoreManagerFields(snap);
          const hz = audioEngine.getFrequency(this._anchorSlot);
          if (Number.isFinite(hz) && hz > 0) this._lastAnchorHz = hz;
          // Steps settle instantly — didFreqLaunch stays false so the
          // re-baseline below (or the vol glide's onDone) captures the
          // landed state as the new undo baseline.
          did = true;
        }
      } else {
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
    }

    // Timed movers (vol / transpose glides, deferred note-offs). When there's
    // no freq launch loop to settle `_lastStable` on arrival, the LAST of
    // these to land re-baselines undo at the post-recall state.
    let glidesPending = 0;
    const settle = () => {
      glidesPending -= 1;
      if (glidesPending > 0 || didFreqLaunch) return;
      this._lastStable = this._takeSnapshot();
      this._fire();
    };

    // On/off — asymmetric timing: notes coming ON attack immediately; notes
    // going OFF hold through the transition and release at its end. Handled
    // BEFORE the volume glide so an unmuting voice lands its envelope attack
    // directly on the saved level — the glide then sees no delta for that
    // voice and leaves its gain alone. (Re-targeting the gain every glide
    // frame while the attack ramp played is what caused the recall
    // "tremolo".)
    if (scope.has('onoff') && snap && Array.isArray(snap.mutes)) {
      const toMute = [];
      for (let i = 0; i < count; i++) {
        const target = !!snap.mutes[i];
        if (audioEngine.isMuted(i) === target) continue;
        if (target) { toMute.push(i); continue; }
        if (scope.has('vol') && Array.isArray(snap.volumes) && Number.isFinite(snap.volumes[i])) {
          audioEngine.setVolume(i, snap.volumes[i]);
        }
        audioEngine.unmuteOscillator(i);
        did = true;
      }
      if (toMute.length) {
        did = true;
        glidesPending += 1;
        const fire = () => {
          this._deferredMuteTimer = null;
          for (const i of toMute) audioEngine.muteOscillator(i);
          glidesPending -= 1;
          // The note-offs close the transition — re-baseline so undo captures
          // the settled (muted) state, not the held one.
          this._lastStable = this._takeSnapshot();
          this._fire();
        };
        if (this._recallGlideMs <= 0) fire();
        else this._deferredMuteTimer = setTimeout(fire, this._recallGlideMs);
      }
    }

    // Held notes (HELD_NOTES.md §4) — same asymmetry as on/off: missing
    // notes SPAWN at recall start (their source's normal note-on envelope),
    // matching live voices are kept untouched, and surplus voices hold
    // through the transition and release at its end.
    if (scope.has('notes') && snap && Array.isArray(snap.heldNotes)) {
      const { toSpawn, toRelease } = this._diffHeldNotes(snap.heldNotes);
      for (const n of toSpawn) {
        keyboardVoiceManager.spawnVoiceAt(n.hz, {
          level: n.level, source: n.source, slot: n.slot, octave: n.octave,
        });
        did = true;
      }
      if (toRelease.length) {
        did = true;
        glidesPending += 1;
        const fireNotes = () => {
          this._deferredNoteTimer = null;
          for (const v of toRelease) keyboardVoiceManager.releaseVoiceById(v.id);
          glidesPending -= 1;
          this._lastStable = this._takeSnapshot();
          this._fire();
        };
        if (this._recallGlideMs <= 0) fireNotes();
        else this._deferredNoteTimer = setTimeout(fireNotes, this._recallGlideMs);
      }
    }

    // Volume / transpose — glide silently over the recall timing.
    if (scope.has('vol') && snap && Array.isArray(snap.volumes)) {
      if (audioEngine.cancelVolumeGlide) audioEngine.cancelVolumeGlide();
      glidesPending += 1;
      audioEngine.glideVolumes(snap.volumes.slice(0, count), this._recallGlideMs, settle);
      did = true;
    }
    if (scope.has('transpose') && snap && Number.isFinite(snap.transpose)) {
      if (audioEngine.cancelTransposeGlide) audioEngine.cancelTransposeGlide();
      glidesPending += 1;
      audioEngine.glideTranspose(snap.transpose, this._recallGlideMs, settle, this._recallCurveFn());
      did = true;
    }

    if (!did) return false;   // nothing new to apply
    // A recall with no freq loop and no timed glide in flight (on/off only,
    // or a step-mode batch) settles immediately — re-baseline now.
    if (!didFreqLaunch && glidesPending === 0) this._lastStable = this._takeSnapshot();
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
  _addLaunch(index, target, durMs = null) {
    const startHz = audioEngine.getFrequency(index);
    this._launching.set(index, {
      startHz,
      targetHz: target,
      startMs: performance.now(),
      // Per-voice duration override; null = the shared recall glide time.
      durMs: Number.isFinite(durMs) && durMs >= 0 ? durMs : null,
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
      const sharedDur = this._recallGlideMs;
      const ease = this._recallCurveFn();
      const arrived = [];
      // All engine writes for the frame are wrapped in the propagation guard
      // so they don't trigger follow-root transpose / lock reconciliation.
      this._inPropagation = true;
      try {
        for (const [key, e] of this._launching) {
          const dur = e.durMs != null ? e.durMs : sharedDur;
          const t = dur > 0 ? Math.min(1, (now - e.startMs) / dur) : 1;
          const hz = Math.pow(2, e.logStart + (e.logTarget - e.logStart) * ease(t));
          // Three kinds of entry share the loop: slot launches (key = osc
          // index), cross-slot TRAVELS (key = `t${id}`, writing a detached
          // traveller) and HELD-VOICE glides (key = `v${id}`, retuning a
          // keyboard/MIDI voice) — same clock, same ease.
          if (e.travelerId != null) audioEngine.setTravelerFrequency(e.travelerId, hz);
          else if (e.heldVoiceId != null) {
            // Voice released/stolen mid-glide → nothing left to move.
            if (!keyboardVoiceManager.setVoiceFrequency(e.heldVoiceId, hz)) {
              arrived.push(key);
              continue;
            }
          } else audioEngine.setFrequency(key, hz);
          if (t >= 1) arrived.push(key);
        }
      } finally {
        this._inPropagation = false;
      }
      // Keep the transpose reference current if the anchor is among the movers.
      const hz = audioEngine.getFrequency(this._anchorSlot);
      if (Number.isFinite(hz) && hz > 0) this._lastAnchorHz = hz;

      if (arrived.length) {
        for (const key of arrived) {
          const e = this._launching.get(key);
          this._launching.delete(key);
          // Travels resolve at arrival: land on the destination slot (or
          // release, for a merge). Runs before the snapshot below so the
          // landed mute/freq state is what undo captures.
          if (e?.onArrive) {
            try { e.onArrive(); } catch (err) { console.error('FrequencyManager onArrive error', err); }
          }
        }
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
      transpose: audioEngine.getTransposeSemitones(),
      slotRatios: new Map(this._slotRatios),
      anchorSlot: this._anchorSlot,
      tuningSystem: this._tuningSystem,
      // The held kbd/MIDI chord rides EVERY snapshot (HELD_NOTES.md §2 —
      // lossless capture; the future 'notes' scope gates apply, never
      // capture). Recall/undo currently ignore the field.
      heldNotes: keyboardVoiceManager.getHeldNotesSnapshot(),
      // Marks heldNotes hz as NOMINAL (transpose-free) — _normalizeSlots
      // uses its absence to migrate older saves that baked the transpose in.
      notesNominal: true,
    };
  }

  /**
   * Apply a snapshot through a scope mask, gliding over `durationMs`. Only
   * params in `scope` are written: freq glides in pitch space (and restores
   * the tuning context), vol glides in level space, transpose slides in
   * semitone space, onoff toggles the mute state (click-free envelope fade —
   * the timing slider governs freq/vol/transpose, not
   * the mute fade, which is fixed by the drone envelope). The undo-restore
   * guard stays raised until every started glide finishes so the per-frame
   * engine listener doesn't treat the motion as user drift.
   */
  _applySnapshotSmooth(snap, scope, durationMs) {
    const wantFreq = scope.has('freq');
    const wantVol = scope.has('vol');
    const wantOnoff = scope.has('onoff');
    // Transpose only applies when the snapshot actually carries it (older
    // saves persisted before the field existed hold null — leave it alone).
    const wantTranspose = scope.has('transpose') && Number.isFinite(snap.transpose);

    // Cancel any in-flight glides so back-to-back recalls behave. A pending
    // GO transition's deferred note-offs die too — this restore owns the
    // mute state now.
    if (wantFreq && audioEngine.cancelFrequencyGlide) audioEngine.cancelFrequencyGlide();
    if (wantVol && audioEngine.cancelVolumeGlide) audioEngine.cancelVolumeGlide();
    if (wantTranspose && audioEngine.cancelTransposeGlide) audioEngine.cancelTransposeGlide();
    this._cancelDeferredMutes();

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

    // On/off — asymmetric timing: notes coming ON attack up front (landing
    // the envelope attack directly on the snapshot's level when vol is also
    // in scope, so the volume glide sees no delta for that voice and leaves
    // its gain alone — re-targeting the gain mid-attack every frame is what
    // caused the recall tremolo); notes going OFF hold through the glide and
    // release when it lands (inside finish()).
    let deferredMutes = null;
    if (wantOnoff && Array.isArray(snap.mutes)) {
      for (let i = 0; i < count; i++) {
        const target = !!snap.mutes[i];
        if (audioEngine.isMuted(i) === target) continue;
        if (target) {
          (deferredMutes ??= []).push(i);
          continue;
        }
        if (wantVol && Array.isArray(snap.volumes) && Number.isFinite(snap.volumes[i])) {
          audioEngine.setVolume(i, snap.volumes[i]);
        }
        audioEngine.unmuteOscillator(i);
      }
    }

    // Held notes (HELD_NOTES.md §4): spawn the snapshot's missing notes now
    // (attack up front, like unmutes), keep matching live voices, release
    // the surplus at the end of the glide (inside finish(), like mutes).
    let deferredNoteReleases = null;
    if (scope.has('notes') && Array.isArray(snap.heldNotes)) {
      const { toSpawn, toRelease } = this._diffHeldNotes(snap.heldNotes);
      for (const n of toSpawn) {
        keyboardVoiceManager.spawnVoiceAt(n.hz, {
          level: n.level, source: n.source, slot: n.slot, octave: n.octave,
        });
      }
      if (toRelease.length) deferredNoteReleases = toRelease;
    }

    const finish = () => {
      // The transition is over — release the notes going away (their fade is
      // the drone envelope's own note-off, starting now).
      if (deferredMutes) {
        for (const i of deferredMutes) audioEngine.muteOscillator(i);
        deferredMutes = null;
      }
      if (deferredNoteReleases) {
        for (const v of deferredNoteReleases) keyboardVoiceManager.releaseVoiceById(v.id);
        deferredNoteReleases = null;
      }
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
      if (wantTranspose) audioEngine.setTransposeSemitones(snap.transpose);
      finish();
      return;
    }

    // Timed: run the freq / vol / transpose glides concurrently; finish once
    // all of them land.
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
    if (wantTranspose) {
      pending += 1;
      audioEngine.glideTranspose(snap.transpose, dur, done, this._recallCurveFn());
    }
    if (pending === 0) finish();   // onoff-only (or empty): nothing to glide
  }

  // Equality restricted to a scope's parameters. Used to decide whether an
  // edit is worth an undo entry (compared against `_undoScope`) and to skip
  // no-op undo/redo steps. Param → fields:
  //   freq      → anchor + tuning system + frequencies + locked ratios
  //   vol       → volumes
  //   onoff     → mutes
  //   transpose → the global semitone offset
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
    if (scope.has('notes')) {
      // Held chords equal when they pair off by nominal pitch (greedy,
      // NOTE_MATCH_EPS) — levels drift constantly (expressive ramps), so
      // pitch set + count is the undo-worthy identity.
      const an = a.heldNotes || [];
      const bn = b.heldNotes || [];
      if (an.length !== bn.length) return false;
      const used = new Set();
      for (const n of an) {
        let found = false;
        for (let i = 0; i < bn.length; i++) {
          if (used.has(i)) continue;
          if (Math.abs(Math.log2(n.hz / bn[i].hz)) <= NOTE_MATCH_EPS) {
            used.add(i);
            found = true;
            break;
          }
        }
        if (!found) return false;
      }
    }
    if (scope.has('transpose')) {
      // A snapshot missing the field (pre-transpose save) can't be restored,
      // so treat it as equal — otherwise undo would offer dead steps.
      if (Number.isFinite(a.transpose) && Number.isFinite(b.transpose)
          && Math.abs(a.transpose - b.transpose) > 1e-3) return false;
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

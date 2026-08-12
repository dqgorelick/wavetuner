/**
 * AudioEngine - Singleton class managing all Web Audio API operations
 * Supports dynamic oscillator count (2-10), multi-channel routing, and device selection.
 * Isolated from React to prevent re-renders from interfering with audio timing.
 */

import { droneEnvelope } from './Envelope';
import { FREQ_CEIL } from './freqRange';
import { droneWave } from './Wave';
import { droneFold, keyboardFold } from './Fold';
import { noise, getNoiseBuffer } from './Noise';
import { droneStereo, keyboardStereo, midiStereo, dronePanWeights, panWidth } from './StereoMode';
import { getCandidates, getSystem, DEFAULT_SYSTEM, canonicalRatioForVoice } from './jiRatios';

// Topology-change ramp for adding/removing drone slots via the count
// control. Decoupled from droneEnvelope on purpose — see
// research/adsr-envelope.md §7c. A long user attack would silently
// delay added slots; near-zero attack would click. 300 ms threads the
// needle for both.
const FIXED_SLOT_FADE = 0.3;

// Play-on volume ceiling for a drone turned on via its button (unmute).
// Turning a drone on never brings it up louder than this, leaving headroom
// on the summing bus when several drones sound at once. Matches the
// PATCH_LOAD_VOL_CAP used when loading a saved patch (see patches/apply.js).
// Manual volume-slider drags (setVolume) are NOT capped — this only bounds
// the level a drone resumes at when its button is pressed.
const DRONE_PLAY_VOL_CAP = 0.65;

// Global transpose — a DAW-BPM-style master pitch offset. It's a
// playback-only multiplier applied when drones / keyboard voices are tuned;
// it is NEVER folded into the stored nominal Hz (frequencyValues /
// getFrequency), so it lives outside save-states + undo and a saved patch
// round-trips at its written pitch. Canonical value is a semitone float
// (± = up/down), clamped to ±2 octaves; persisted to its own localStorage key.
const TRANSPOSE_MAX_SEMITONES = 24;
const TRANSPOSE_STORAGE_KEY = 'wavetuner.transposeSemitones';
const TRANSPOSE_SNAP_KEY = 'wavetuner.transposeSnap';

// Tape transport (paused time-dilation) tunables — ported from the iOS
// engine's tape-transport section so the two scopes share one feel.
export const TAPE = {
  // Seconds for the HIGHEST sounding drone to complete one cycle at full
  // crawl. Frequency ratios are preserved (that's what keeps the scope
  // tracing the true figure); only absolute speed dilates. Normalizing
  // to the fastest voice bounds the crawl regardless of voice spread.
  baseCycleSeconds: 8.0,
  // Gesture durations (iOS TapeStopPitch defaults): spin-down under the
  // pause fade, spin-up under the resume fade-in.
  rampOffSeconds: 1.65,
  rampOnSeconds: 0.75,
  // End-rate of the gesture S-curve, in multiples of the linear average.
  // Both directions run the SAME symmetric curve — morph =
  // k·u + (1−k)·smoothstep(u) — fast at both extremes and slow through
  // the middle. Since speed = crawl^morph, morph is log-frequency, and
  // the middle morphs are where the slow-down actually reads; the
  // extremes are dead zones (near real speed the motion is a blur, near
  // the crawl it looks static). Must stay < 3 (mid-curve rate is
  // 1.5 − k/2, which hits 0 at 3).
  easeEndRate: 2.2,
  // Speed wander at full crawl: ±35% at ~1/14 Hz — the fairy's float
  // feel. Scales with the morph, so it's absent at real speed.
  wanderDepth: 0.35,
  wanderHz: 0.07,
};

// The gesture S-curve: morph over the normalized clock u ∈ [0, 1].
// Exactly 0 at 0 and 1 at 1 (resume must LAND on real speed).
function tapeEase(u) {
  const s = u * u * (3 - 2 * u);
  return TAPE.easeEndRate * u + (1 - TAPE.easeEndRate) * s;
}

// Inverse of tapeEase, a few Newton steps (monotonic, rate bounded below
// by 1.5 − k/2). Recovering the clock from the CURRENT morph keeps the
// per-frame step stateless, so a mid-flight reversal (play tapped during
// the spin-down) re-enters the opposite curve exactly where the morph
// sits — no progress state to reconcile.
function tapeEaseInv(m) {
  let u = Math.min(1, Math.max(0, m));
  for (let i = 0; i < 6; i++) {
    const f = tapeEase(u) - m;
    const d = TAPE.easeEndRate + (1 - TAPE.easeEndRate) * (6 * u - 6 * u * u);
    u = Math.min(1, Math.max(0, u - f / d));
  }
  return u;
}

// Master-bus soft limiter / saturator curves. Integers match the values
// the worklet expects via port.postMessage({ curve }).
export const SATURATION_CURVES = {
  off: 0,
  tanh: 1,
  cubic: 2,
  sine: 3,
  hard: 4,
};

class AudioEngine {
  // How long expired step tails linger for the visualizers (ms). Must cover
  // the spectrum bar's post-landing hop animation (~200 ms) with margin.
  static STEP_TAIL_VIZ_GRACE_MS = 400;

  constructor() {
    if (AudioEngine.instance) {
      return AudioEngine.instance;
    }
    
    this.AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.audioContext = null;
    this.oscillators = [];
    this.gainNodes = [];         // Volume control per oscillator
    // Partner oscillator + gain per drone slot. In 'stereo' mode the
    // primary plays base+detune/2 → L, partner plays base-detune/2 → R,
    // so each drone is two notes (one per ear) that beat against each
    // other. In 'lr' mode the partner is silenced (gainR=0) and only
    // the primary contributes audibly, routed per routingMap.
    this.oscillatorsR = [];
    this.gainNodesR = [];
    this.routingNodes = [];      // Routing control per oscillator (for channel assignment)
    this.masterGainNode = null;
    // Pre-master summing tap for the visualizers. Sits BEFORE masterGainNode
    // so the final/master fader doesn't scale the scope or spectrum — only the
    // individual source mixers (drone, keyboard, midi) do, since they're
    // upstream of this node.
    this.preMasterTap = null;
    this.analyserNode1 = null;   // Left channel visualization
    this.analyserNode2 = null;   // Right channel visualization
    this.analyserNodeMono = null; // Whole-mix (downmixed) analysis for AudioFeatures
    this.isInitialized = false;
    this.isPaused = false;
    // Drone bus on/off — independent of pause. Effective drone audio
    // requires droneEnabled && !isPaused (see _applyDroneBusGain).
    this.droneEnabled = true;
    
    // Dynamic oscillator management
    this.oscillatorCount = 4;
    this.maxOscillators = 12;
    this.minOscillators = 2;

    // User-controllable master volume multiplier (0..1). Multiplies on top of
    // the count-based clipping scaler in _getScaledMasterGain so fade-in/out
    // and oscillator add/remove transitions naturally honor it.
    // 0.75 default leaves headroom over post-master saturation so transient
    // peaks (e.g. constructive interference on close-tuned drones) don't
    // clip the destination on first launch.
    this.masterVolumeUser = 0.75;
    this._masterMuted = false;
    this._preMuteMaster = 0.75;

    // Keyboard pool's own bus controls. `_kbdEnabled` is the on/off
    // switch (sets keyboardBusGain to 1.0 or 0 to fade held voices).
    // Per-source user volume now lives on kbdBusGain / midiBusGain
    // (see below); _kbdVolume is kept for API back-compat but no longer
    // affects audio.
    this._kbdVolume = 1.0;
    this._kbdEnabled = true;

    // Per-source bus gains. Range 0..2 (unity at midpoint, +1..+2 boost
    // zone on the right half). With droneEnvelope.sustain=1.0 and the
    // HEADROOM stripped from _getDroneCountScale, the engine now hits
    // unity loudness at slider 1.0 for both drone and kbd source — so
    // these bus knobs default to 1.0 and exist for user preference
    // rather than asymmetry compensation. The MIDI bus stays at 1.0
    // by default too; MIDI's keyboardEnvelope.sustain=0.4 is left as
    // a deliberate musical choice (notes decay after attack), and
    // users who want louder held MIDI lift this knob.
    this._droneUserGainValue = 1.0;
    this._kbdUserGainValue = 1.0;
    this._midiUserGainValue = 1.0;
    this.droneUserGain = null;
    this.kbdBusGain = null;
    this.midiBusGain = null;
    // Wave-generator level (0..2, unity 1). One gain over BOTH
    // oscillator pools (drone + kbd/midi), post-fold pre-master;
    // noise is not in this path.
    this._waveUserGainValue = 1.0;
    this.waveBusGain = null;
    this._droneBusMuted = false;
    this._kbdBusMuted = false;
    this._midiBusMuted = false;
    this._preMuteDroneBus = this._droneUserGainValue;
    this._preMuteKbdBus = this._kbdUserGainValue;
    this._preMuteMidiBus = this._midiUserGainValue;

    // Noise source (see Noise.js for the state singleton + buffers).
    // noiseGain carries the user level; _noisePlaying is the live
    // {src, gain, type} so a color change can crossfade instead of
    // hard-swapping buffers. Master pause gates noise via _noisePaused
    // — noise has no per-voice envelope, so without this gate "pause
    // everything" would leave the hiss running.
    this.noiseGain = null;
    this._noisePlaying = null;
    this._noisePaused = false;
    // Noise routing + viz branches (wired in initialize; see the noise
    // branch comment there). Route pre/post crossfade for
    // noise.postSaturation; noisePostMaster mirrors masterGainNode's
    // fades; noiseVizGain gates noise into the pre-master analyser tap.
    this.noiseRoutePre = null;
    this.noiseRoutePost = null;
    this.noisePostMaster = null;
    this.noiseVizGain = null;

    // Master-bus soft limiter / saturator. Inserted between
    // masterGainNode and the visualizer splitter so peaks past unity
    // (e.g. unison-phase constructive interference on close-tuned
    // drones) are soft-clipped instead of hard-clipped at the
    // destination. droneCountScale upstream still serves the WaveShaper
    // input clamp — those two attenuators are independent.
    this.saturationNode = null;
    this.saturationCurve = SATURATION_CURVES.tanh;
    this.saturationDrive = 1.0;
    this.saturationReady = false;
    this.saturationLoadFailed = false;

    // Stack of per-osc state captured when an oscillator is removed via
    // setOscillatorCount. Re-adding pops the most-recently-removed state so
    // the user's freq/volume/mute settings come back instead of being random.
    this.removedSlots = [];

    // Step-transition bookkeeping. slotGenerations[i] bumps every time a
    // slot is retriggered via stepToFrequency; MidiOutput folds it into the
    // drone request id so the MPE reconciler sees a step as a fresh
    // noteOff/noteOn instead of a pitch bend (a glide keeps the id stable).
    // _stepTails records the OLD note during the overlap window —
    // { slot, gen, freq, level, until } — so MIDI can keep it sounding
    // alongside the new one. Web Audio tails manage themselves via
    // scheduled gain ramps and osc.stop(); this list is MIDI-only.
    this.slotGenerations = [];
    this._stepTails = [];

    // Travelling voices (voice-leading transitions, GENERATIVE.md §6.6):
    // a sounding note detached from its slot so it can glide ACROSS slot
    // indices — chord A's note becomes chord B's note on a different
    // oscillator. Each entry owns the detached node pair; the slot it left
    // got a fresh silent pair at detach, and the destination slot adopts
    // these nodes at landing (phase-continuous — the note never restarts).
    // Map id → { fromIndex, osc, gain, oscR, gainR, nominalHz, offset,
    // channels, level }.
    this._travelers = new Map();
    this._travelerSeq = 0;
    // MIDI wire-id aliases (slot index → id string). Normally a slot's
    // outgoing MPE voice is keyed `drone:{slot}:g{gen}`, but a slot that
    // ADOPTED a travelling voice keeps the traveller's id — set at landing —
    // so a detach → glide → land arc reads as ONE continuously-bending note
    // on the wire, mirroring the local phase-continuous gliss. The alias
    // dies whenever the note does (mute, step retrigger, traveller-
    // invalidating rebuilds).
    this._wireAliases = new Map();

    // Per-slot "release tail still sounding" timestamps (performance.now()
    // ms). A mute flips mutedStates immediately but the drone envelope's
    // release keeps the note audible — UI reads isSlotReleasing(i) to show
    // a note as GOING off (pulse) rather than off until the tail ends.
    this._releaseUntilMs = [];

    // Per-slot list of additional partials (ratio-locked sub-oscillators
    // bound to their parent slot). extraPartials[i] is an array of
    // { ratio, vol, muted, _osc, _gain, _oscR, _gainR } — each entry is a
    // real audio osc that sounds at frequencyValues[i] * ratio + detune.
    // The primary oscillator stays in the flat oscillators[i]/gainNodes[i]
    // arrays as before — partials live alongside but don't change any
    // existing per-slot APIs. Initialized empty; grown/shrunk in sync
    // with oscillatorCount through setOscillatorCount, removeOscillatorAt,
    // and cloneOscillator.
    this.extraPartials = [[], [], [], []];
    
    // Generate random default frequencies
    // First two oscillators: 50-130 Hz, 1-4 Hz apart
    const baseFreq1 = 50 + Math.random() * 80; // 50-130 Hz
    const offset1 = 1 + Math.random() * 3; // 1-4 Hz
    const freq1 = baseFreq1;
    const freq2 = baseFreq1 + (Math.random() > 0.5 ? offset1 : -offset1);
    
    // Second two oscillators: 2x the base, also 1-4 Hz apart
    const baseFreq2 = baseFreq1 * 2;
    const offset2 = 1 + Math.random() * 3; // 1-4 Hz
    const freq3 = baseFreq2;
    const freq4 = baseFreq2 + (Math.random() > 0.5 ? offset2 : -offset2);
    
    // Store frequency/volume values separately from oscillator nodes
    this.frequencyValues = [freq1, freq2, freq3, freq4];
    this.volumeValues = [0.5, 0.5, 0.5, 0.5];
    this.mutedStates = [false, false, true, true]; // 3rd and 4th muted by default
    this.preMuteVolumes = [0.5, 0.5, 0.5, 0.5];
    // Per-slot PITCH LOCK (iOS AudioEngine.pitchLocked parity, exposed by
    // the frequency panel's lock button). A locked slot's frequency is
    // frozen: orb drags, dice/generative, root-follow propagation and
    // global transposes all skip it. The escape hatch is `force` on
    // setFrequency / setAllFrequenciesBatch, which the slot's OWN editor
    // and the restore paths (patch apply, undo) pass — the lock protects
    // a voice from everything ELSE moving it, not from being edited
    // directly. Session-only: not persisted to patches or save states.
    this.pitchLocked = [false, false, false, false];

    // Per-oscillator detune offset in Hz, sampled from droneStereo's
    // detuneHz on creation and re-rolled on slider drag. Added to
    // frequencyValues[i] to produce the actual played frequency. Stays
    // 0 when the user hasn't enabled detune.
    this.droneDetuneOffsets = [0, 0, 0, 0];

    // Per-oscillator phase accumulators (radians, 0..2π) mirroring the
    // actual running Web Audio oscillators. Advanced by updatePhases()
    // from the visualizer each frame via an exponentially-smoothed
    // target frequency — the smoothing tau matches setFrequency's
    // setTargetAtTime tau (0.016 s), so the accumulator stays aligned
    // with the audio across frequency slider drags.
    this.phases = [];
    this.smoothedFreqs = [];
    this._lastPhaseUpdate = [];
    // Partner-osc phase state (right channel in 'stereo' mode). Empty
    // arrays in 'lr' mode where the partner is muted; populated and
    // advanced by updatePhases on every frame regardless of audibility
    // so the synth visualizer's phase picks up immediately on mode flip.
    this.phasesR = [];
    this.smoothedFreqsR = [];
    this._lastPhaseUpdateR = [];
    this._phaseSmoothTau = 0.016;

    // Tape transport (paused time-dilation) — visual tier of the iOS
    // record-stop gesture. Pausing doesn't freeze the scope's phase
    // accumulators: one morph parameter (0 = real speed, 1 = full crawl)
    // eases toward its transport-driven target along a symmetric S-curve
    // and dilates every drone phase increment in updatePhases
    // (dθ = 2π·f·dilation·dt), with the dilation lerped in LOG space so
    // the deceleration reads as a smooth unwind across ~3 decades. The
    // model frequencies (orbs, spectrum, mixer) never see the dilation —
    // only the accumulators crawl — and because those accumulators are
    // the only trajectory at every speed, the resume handoff back to the
    // live trace is phase-exact by construction.
    //
    // AUDIO IS UNTOUCHED: the real oscillators keep running at pitch
    // under the drone bus's plain pause fade (iOS's "ramp 0" audible
    // config). calibratePhases would fight the crawl by pulling the
    // accumulators back toward the still-at-speed analyser signal, so
    // the scope gates it off while the gesture is engaged.
    this._tapeMorph = 0;
    this._tapeWanderPhase = 0;
    this._tapeCrawlDilation = 1e-3;
    this._tapeLastStep = null;

    // Per-channel joint-least-squares phase-recovery caches. Each holds
    // { sig, oscs, LL, P, N } where LL is the in-place Cholesky factor
    // of M^T M and `sig` is the routing+frequency signature used to
    // decide whether the factorization is still valid. Re-built lazily
    // inside calibratePhases when sig changes.
    this._lsqCacheL = null;
    this._lsqCacheR = null;
    
    // Multi-channel routing - maps oscillator index to array of output channels
    this.routingMap = {}; // { oscIndex: [outputChannel1, outputChannel2, ...] }
    this.outputChannelCount = 2; // Default stereo

    // Continuous per-voice pan, −1 (hard L) … 0 (mode origin: stereo
    // split / lr ⊙) … +1 (hard R). Source of truth for the L/R image on
    // stereo outputs; routingMap keeps a discrete projection ([0], [1]
    // or [0,1]) in sync for the patch bay, LSQ calibration and legacy
    // consumers. Slots the patch bay routes to channels ≥ 2 bypass pan
    // entirely (discrete multichannel routing wins there).
    this.panValues = [];

    // Device management
    this.currentDeviceId = null;

    // Audio graph nodes for routing
    this.channelGains = [];      // One gain per output channel for final mixing
    this.stereoMerger = null;    // Merges channels to stereo for output

    // Callbacks for state change notifications
    this.onRoutingChange = null;
    // Fired as (index, pan) whenever a voice's continuous pan changes —
    // by the dial, a routing write, a patch load or a defaults reset.
    // `onPanChange` is the App-owned single callback (state mirroring);
    // `_panListeners` lets any other component subscribe independently
    // (e.g. the spectrum bar's PAN status flash on the orbs).
    this.onPanChange = null;
    this._panListeners = new Set();

    // Listeners notified whenever any oscillator's frequency target changes
    // OR the oscillator count changes (which adds/removes scale degrees).
    // The keyboard's Tuning module subscribes here so it can re-sort the
    // scale and propagate retunes to held voices.
    this.frequencyListeners = new Set();

    // Global transpose (playback-only master pitch offset — see the
    // TRANSPOSE_* consts). Canonical value is the semitone offset; the ratio
    // is the derived multiplier the audio math reads. Loaded from localStorage
    // at construction so a persisted transpose applies from the first Start
    // (the create path already tunes through the ratio). Its own listener set
    // fires on change so Tuning re-tunes held voices and the spectrum bar
    // slides its frequency labels — deliberately separate from the frequency
    // listeners so a transpose never wakes FrequencyManager's undo machinery.
    this._transposeSemitones = AudioEngine._loadTranspose();
    this._transposeRatio = Math.pow(2, this._transposeSemitones / 12);
    // When snap is on, transpose quantizes to whole semitones (the tuning
    // menu's checkbox); off = continuous. Persisted alongside the offset.
    this._transposeSnap = AudioEngine._loadTransposeSnap();
    this._transposeListeners = new Set();
    this._transposeGlideRaf = null;   // rAF handle for an in-flight transpose slide
    // rAF handles for in-flight per-voice pan glides, keyed by slot: a
    // PanPot click slides the image over PERFORM's recall glide time
    // instead of jumping (see glideVoicePan).
    this._panGlideRafs = new Map();
    // Optional () => ms hook the app sets so engine-side pan resets (the
    // ⊙/LR mode flip) can lerp at PERFORM's recall glide time without the
    // engine importing FrequencyManager. Unset ⇒ 0 ⇒ the old snap.
    this.getPanGlideMs = null;

    AudioEngine.instance = this;
  }

  addFrequencyListener(fn) {
    this.frequencyListeners.add(fn);
    return () => this.frequencyListeners.delete(fn);
  }

  _notifyFrequencyChange() {
    for (const fn of this.frequencyListeners) {
      try { fn(); } catch (e) { console.error('frequency listener error', e); }
    }
  }

  // ─── Global transpose (playback-only master pitch offset) ─────────────
  static _loadTranspose() {
    try {
      const raw = localStorage.getItem(TRANSPOSE_STORAGE_KEY);
      const v = raw == null ? 0 : parseFloat(raw);
      if (!Number.isFinite(v)) return 0;
      return Math.max(-TRANSPOSE_MAX_SEMITONES, Math.min(TRANSPOSE_MAX_SEMITONES, v));
    } catch { return 0; }
  }
  _persistTranspose() {
    try { localStorage.setItem(TRANSPOSE_STORAGE_KEY, String(this._transposeSemitones)); } catch { /* ignore */ }
  }
  static _loadTransposeSnap() {
    try { return localStorage.getItem(TRANSPOSE_SNAP_KEY) === '1'; } catch { return false; }
  }
  getTransposeSnap() { return this._transposeSnap; }
  setTransposeSnap(on) {
    const next = !!on;
    if (next === this._transposeSnap) return;
    this._transposeSnap = next;
    try { localStorage.setItem(TRANSPOSE_SNAP_KEY, next ? '1' : '0'); } catch { /* ignore */ }
    // Enabling snap lands the current offset on the nearest whole semitone.
    if (next) this.setTransposeSemitones(Math.round(this._transposeSemitones));
    this._notifyTranspose();
  }

  addTransposeListener(fn) {
    this._transposeListeners.add(fn);
    return () => this._transposeListeners.delete(fn);
  }
  _notifyTranspose() {
    for (const fn of this._transposeListeners) {
      try { fn(); } catch (e) { console.error('transpose listener error', e); }
    }
  }

  getTransposeRatio() { return this._transposeRatio; }
  getTransposeSemitones() { return this._transposeSemitones; }

  /**
   * Set the global transpose in semitones (float; ± = up/down). Playback-only:
   * it re-ramps live drone oscillators and (via the transpose listener →
   * Tuning) retunes held keyboard voices, but NEVER writes frequencyValues,
   * so a saved patch round-trips at its written pitch. FrequencyManager
   * snapshots the offset separately (parameter lock — recall/undo move it
   * only when 'transpose' is a tracked param). `persist` defaults to true;
   * pass false during a live drag and persist once on release to avoid
   * localStorage thrash.
   */
  setTransposeSemitones(semitones, { persist = true } = {}) {
    let v = Number(semitones) || 0;
    if (this._transposeSnap) v = Math.round(v);   // quantize to whole semitones
    const clamped = Math.max(-TRANSPOSE_MAX_SEMITONES,
      Math.min(TRANSPOSE_MAX_SEMITONES, v));
    if (Math.abs(clamped - this._transposeSemitones) < 1e-6) {
      if (persist) this._persistTranspose();
      return;
    }
    this._transposeSemitones = clamped;
    this._transposeRatio = Math.pow(2, clamped / 12);
    this._applyTransposeToDrones();
    this._notifyTranspose();
    if (persist) this._persistTranspose();
  }

  /**
   * Re-ramp every live drone oscillator (primary / partner / partials) to its
   * transposed played frequency. Mirrors _applyDroneDetuneCurve's ramp loop
   * but leaves the detune offsets alone — only the transpose multiplier moved.
   * Keyboard voices retune separately via the transpose listener → Tuning.
   */
  _applyTransposeToDrones() {
    if (!this.audioContext) return;
    const t = this.audioContext.currentTime;
    for (let i = 0; i < this.oscillatorCount; i++) {
      if (this.oscillators[i]) {
        this.oscillators[i].frequency.setTargetAtTime(this._dronePrimaryFreq(i), t, 0.016);
      }
      if (this.oscillatorsR[i]) {
        this.oscillatorsR[i].frequency.setTargetAtTime(this._dronePartnerFreq(i), t, 0.016);
      }
      const partials = this.extraPartials[i];
      if (partials) {
        for (const p of partials) {
          if (p._osc) p._osc.frequency.setTargetAtTime(this._partialPrimaryFreq(i, p), t, 0.016);
          if (p._oscR) p._oscR.frequency.setTargetAtTime(this._partialPartnerFreq(i, p), t, 0.016);
        }
      }
    }
  }

  /**
   * Returns the audio bus the keyboard pool should hang itself off:
   * the live AudioContext + the per-source bus gain. Voices route to
   * `kbdBusGain` (computer keyboard) or `midiBusGain` (MIDI), each of
   * which then feeds the shared `keyboardBusGain` → fold → master path.
   * Both fields are null before initialize() has been called.
   */
  getAudioBus({ source = 'midi' } = {}) {
    let bus;
    if (source === 'kbd') bus = this.kbdBusGain;
    else if (source === 'midi') bus = this.midiBusGain;
    else bus = this.keyboardBusGain;
    return {
      audioContext: this.audioContext,
      masterGainNode: bus || this.keyboardBusGain,
    };
  }
  
  /**
   * Initialize the audio context and create all nodes
   * Must be called from a user gesture (click/touch).
   * Async because we await the soft-limiter worklet module before
   * inserting it into the post-master chain — wiring it in while
   * masterGainNode is still ramping up from 0 avoids a click.
   */
  async initialize(initialFrequencies = null, initialVolumes = null) {
    if (this.isInitialized) return;
    
    // Apply initial values if provided (e.g., from URL)
    if (initialFrequencies && initialFrequencies.length >= 2) {
      this.oscillatorCount = Math.min(initialFrequencies.length, this.maxOscillators);
      this.frequencyValues = initialFrequencies.slice(0, this.oscillatorCount);
    }
    if (initialVolumes && initialVolumes.length >= 2) {
      this.volumeValues = initialVolumes.slice(0, this.oscillatorCount).map(v => v / 100);
    }
    
    // Ensure arrays are properly sized
    while (this.frequencyValues.length < this.oscillatorCount) {
      this.frequencyValues.push(60);
    }
    while (this.volumeValues.length < this.oscillatorCount) {
      this.volumeValues.push(0.5);
    }
    while (this.mutedStates.length < this.oscillatorCount) {
      this.mutedStates.push(false);
    }
    while (this.preMuteVolumes.length < this.oscillatorCount) {
      this.preMuteVolumes.push(0.5);
    }
    while (this.pitchLocked.length < this.oscillatorCount) {
      this.pitchLocked.push(false);
    }
    while (this.droneDetuneOffsets.length < this.oscillatorCount) {
      this.droneDetuneOffsets.push(0);
    }
    // Each slot starts with no extra partials. Re-init (URL load with
    // more slots than the constructor's 4) tops up empty arrays.
    while (this.extraPartials.length < this.oscillatorCount) {
      this.extraPartials.push([]);
    }
    // Monotonic id source for partials. The Mixer keys React rows by
    // this so removing partial N doesn't reconcile the row for N+1
    // onto N's component instance.
    if (this._nextPartialId === undefined) this._nextPartialId = 1;
    // Sync per-pool detune curves to the live drone count. Only grows
    // them — values from URL state are preserved.
    droneStereo.resizeCurve(this.oscillatorCount);
    keyboardStereo.resizeCurve(this.oscillatorCount);
    midiStereo.resizeCurve(this.oscillatorCount);

    // Pre-size phase arrays; per-osc values are finalized in
    // _createSingleOscillator once audioContext.currentTime is known.
    this.phases = new Array(this.oscillatorCount).fill(0);
    this.smoothedFreqs = this.frequencyValues.slice(0, this.oscillatorCount);
    this._lastPhaseUpdate = new Array(this.oscillatorCount).fill(null);
    this.phasesR = new Array(this.oscillatorCount).fill(0);
    this.smoothedFreqsR = this.frequencyValues.slice(0, this.oscillatorCount);
    this._lastPhaseUpdateR = new Array(this.oscillatorCount).fill(null);

    this.audioContext = new this.AudioContextClass();
    
    // Create analyser nodes for visualization
    this.analyserNode1 = this.audioContext.createAnalyser();
    this.analyserNode2 = this.audioContext.createAnalyser();
    // 8192 gives calibratePhases() a ~5.4 Hz Goertzel frequency
    // resolution (sampleRate / fftSize) — small enough that oscillators
    // spaced a few Hz apart (typical beating setups) don't smear too
    // badly into each other's bins. Also still fast: 8192 float32 ≈
    // 32 KB per channel analyzer buffer.
    this.analyserNode1.fftSize = 8192;
    this.analyserNode2.fftSize = 8192;
    // Mono analyser for AudioFeatures (dissonance/centroid/etc.). The L/R
    // analysers above each see only ONE channel post-splitter, so in L/R
    // pan mode a two-voice chord never appears in either one — cross-voice
    // roughness was invisible to the meter. AnalyserNode downmixes its
    // input to mono per the Web Audio spec, so feeding it preMasterTap
    // directly analyzes the summed mix, channel-blind.
    this.analyserNodeMono = this.audioContext.createAnalyser();
    this.analyserNodeMono.fftSize = 8192;
    
    // Pre-allocate Float32Arrays for visualization
    this.timeData1 = new Float32Array(this.analyserNode1.fftSize);
    this.timeData2 = new Float32Array(this.analyserNode2.fftSize);
    
    // Create master gain node
    this.masterGainNode = this.audioContext.createGain();
    this.masterGainNode.gain.setValueAtTime(0, this.audioContext.currentTime);

    // Drone bus — sits between the per-channel mix and the master.
    // togglePlayPause / spacebar fade THIS to silence drones only,
    // leaving the keyboard pool unaffected.
    this.droneBusGain = this.audioContext.createGain();
    this.droneBusGain.gain.setValueAtTime(1, this.audioContext.currentTime);

    // Keyboard bus — parallel branch. The bus itself only carries the
    // on/off enable gate (0 or 1). Per-source user volume lives one
    // step upstream on kbdBusGain / midiBusGain (created below), which
    // both feed into this sum point.
    this.keyboardBusGain = this.audioContext.createGain();
    this.keyboardBusGain.gain.setValueAtTime(this._kbdEffectiveGain(), this.audioContext.currentTime);

    // Per-source user gain stages. kbd voices land on kbdBusGain, midi
    // voices on midiBusGain; both feed the shared keyboardBusGain sum
    // point so they share the keyboard fold/enable path. Default 1.0,
    // user-adjustable 0..2 from the mixer for testing balance.
    this.kbdBusGain = this.audioContext.createGain();
    this.kbdBusGain.gain.setValueAtTime(this._kbdUserGainValue, this.audioContext.currentTime);
    this.midiBusGain = this.audioContext.createGain();
    this.midiBusGain.gain.setValueAtTime(this._midiUserGainValue, this.audioContext.currentTime);
    this.kbdBusGain.connect(this.keyboardBusGain);
    this.midiBusGain.connect(this.keyboardBusGain);

    // Per-pool wavefolder. Inserted right after each pool's bus gain,
    // before master, so it sees the post-bus signal but doesn't
    // double-fold across pools. Curve starts as identity (amount=0)
    // and is rebuilt on droneFold/keyboardFold.onChange.
    this.droneFoldShaper = this.audioContext.createWaveShaper();
    droneFold.applyTo(this.droneFoldShaper);
    this.keyboardFoldShaper = this.audioContext.createWaveShaper();
    keyboardFold.applyTo(this.keyboardFoldShaper);

    // Count-based attenuator for the drone bus, applied PRE-shaper so
    // the WaveShaperNode never sees signal exceeding ±1 (it would
    // clamp, and the clamp itself is hard-clipping — audible distortion
    // even at fold=0). Master volume is applied separately at
    // masterGainNode AFTER the shaper. Together they reproduce the
    // original (count × user) attenuation, but the order matters: the
    // shaper must see pre-attenuated signal.
    this.droneCountScale = this.audioContext.createGain();
    this.droneCountScale.gain.setValueAtTime(
      this._getDroneCountScale(), this.audioContext.currentTime
    );

    // Parallel dry/wet gains around each fold shaper. At fold=0 the
    // dry path carries 100% and the shaper's output is muted by wet=0
    // — so any artifacts from WaveShaperNode (input clamp on phase-
    // aligned peaks, oversample filter ringing, etc.) never reach the
    // master. Linear crossfade because dry/wet are correlated:
    //   total_at_fold_0:   dry=1, wet=0 → input passed through
    //   total_at_fold_1:   dry=0, wet=1 → pure folded shape
    //   total_at_fold_0.5: dry=0.5, wet=0.5 → 50/50 mix (matches the
    //                      previous internal-mix behavior)
    this.droneFoldDry = this.audioContext.createGain();
    this.droneFoldWet = this.audioContext.createGain();
    this.keyboardFoldDry = this.audioContext.createGain();
    this.keyboardFoldWet = this.audioContext.createGain();
    {
      const t0 = this.audioContext.currentTime;
      this.droneFoldDry.gain.setValueAtTime(1 - droneFold.amount, t0);
      this.droneFoldWet.gain.setValueAtTime(droneFold.amount, t0);
      this.keyboardFoldDry.gain.setValueAtTime(1 - keyboardFold.amount, t0);
      this.keyboardFoldWet.gain.setValueAtTime(keyboardFold.amount, t0);
    }

    // Create channel gain nodes (one per output channel for mixing)
    this.channelGains = [
      this.audioContext.createGain(), // Left channel
      this.audioContext.createGain()  // Right channel
    ];

    // Create stereo merger
    this.stereoMerger = this.audioContext.createChannelMerger(2);

    // Connect channel gains to stereo merger
    this.channelGains[0].connect(this.stereoMerger, 0, 0); // Left
    this.channelGains[1].connect(this.stereoMerger, 0, 1); // Right


    // Per-source drone user gain (post-fold, pre-master). 0..2 from the
    // mixer; default 1.0 keeps existing balance.
    this.droneUserGain = this.audioContext.createGain();
    this.droneUserGain.gain.setValueAtTime(this._droneUserGainValue, this.audioContext.currentTime);

    // Wave-generator level — the "waves" dial. Both oscillator pools
    // sum into this before the master, so it scales the whole onboard
    // wave engine (but not noise, which joins at masterGainNode).
    this.waveBusGain = this.audioContext.createGain();
    this.waveBusGain.gain.setValueAtTime(this._waveUserGainValue, this.audioContext.currentTime);
    this.waveBusGain.connect(this.masterGainNode);

    //                                              ┌→ droneFoldDry ─┐
    // stereoMerger → droneBusGain → droneCountScale ┤                ├→ droneUserGain → waveBusGain → masterGainNode
    //                                              └→ shaper → wet ─┘
    this.stereoMerger.connect(this.droneBusGain);
    this.droneBusGain.connect(this.droneCountScale);
    this.droneCountScale.connect(this.droneFoldDry);
    this.droneCountScale.connect(this.droneFoldShaper);
    this.droneFoldShaper.connect(this.droneFoldWet);
    this.droneFoldDry.connect(this.droneUserGain);
    this.droneFoldWet.connect(this.droneUserGain);
    this.droneUserGain.connect(this.waveBusGain);

    //                  ┌→ keyboardFoldDry ─┐
    // keyboardBusGain ─┤                    ├→ waveBusGain → masterGainNode
    //                  └→ shaper → wet ─────┘
    this.keyboardBusGain.connect(this.keyboardFoldDry);
    this.keyboardBusGain.connect(this.keyboardFoldShaper);
    this.keyboardFoldShaper.connect(this.keyboardFoldWet);
    this.keyboardFoldDry.connect(this.waveBusGain);
    this.keyboardFoldWet.connect(this.waveBusGain);
    
    // Load the soft-limiter worklet before wiring the post-master chain
    // so the saturator is in place from frame zero — no click from
    // inserting it later. Falls back to direct masterGainNode → splitter
    // on load failure (saturationReady stays false).
    await this._loadSaturationNode();

    // Audio output path: master fader → saturation → destination. The
    // visualizers are NOT in this path (see preMasterTap below), so the
    // master/final fader and the soft-limiter character affect what you
    // hear but not what the scope/spectrum draw.
    const postMaster = this.saturationNode || this.masterGainNode;
    if (this.saturationNode) {
      this.masterGainNode.connect(this.saturationNode);
    }
    postMaster.connect(this.audioContext.destination);

    // Visualizer tap — sits BEFORE masterGainNode. The individual source
    // mixers (drone, keyboard, midi) and the wave-generator level are
    // upstream of this node, so they still scale the scope/spectrum; the
    // final fader does not. waveBusGain feeds masterGainNode AND this tap.
    // The analysers are dead-end side branches — an AnalyserNode reads its
    // input without needing a downstream consumer.
    this.preMasterTap = this.audioContext.createGain();
    this.waveBusGain.connect(this.preMasterTap);

    const splitter = this.audioContext.createChannelSplitter(2);
    this.preMasterTap.connect(splitter);
    splitter.connect(this.analyserNode1, 0);
    splitter.connect(this.analyserNode2, 1);
    // Mono side branch — the analyser downmixes the stereo tap itself.
    this.preMasterTap.connect(this.analyserNodeMono);

    // Noise branch: looped stereo buffer → per-source crossfade gain →
    // noiseGain (user level) → one of two routes (iOS noisePostSaturation
    // parity, crossfaded so toggling is click-free):
    //
    //   pre  (default) — noiseRoutePre → masterGainNode, so noise rides
    //        the master fader and passes THROUGH the saturator.
    //   post — noiseRoutePost → noisePostMaster → destination. Joins
    //        after the chain so it stays clean no matter how hard the
    //        saturator is driven. noisePostMaster mirrors every
    //        masterGainNode fade (see _masterFadeParams) so the noise
    //        still follows the master fader / mute / pause ramps.
    //
    // A third, viz-only branch (noiseVizGain → preMasterTap) is gated by
    // noise.showInViz, default OFF: broadband noise fuzzes the scope
    // trace and adds jitter to everything else reading the analysers
    // (peak meter, LSQ phase calibration, AudioFeatures), so it's
    // opt-in. The source starts immediately even at level 0 — a
    // zero-gain looping buffer is nearly free, and it means the first
    // dial raise is instant with no start() click.
    {
      const t0 = this.audioContext.currentTime;
      const post = noise.postSaturation ? 1 : 0;
      this.noiseGain = this.audioContext.createGain();
      this.noiseGain.gain.setValueAtTime(this._noiseEffectiveGain(), t0);
      this.noiseRoutePre = this.audioContext.createGain();
      this.noiseRoutePre.gain.setValueAtTime(1 - post, t0);
      this.noiseGain.connect(this.noiseRoutePre);
      this.noiseRoutePre.connect(this.masterGainNode);
      this.noiseRoutePost = this.audioContext.createGain();
      this.noiseRoutePost.gain.setValueAtTime(post, t0);
      // Starts at 0 like masterGainNode did above; the master fade-in
      // below ramps both together.
      this.noisePostMaster = this.audioContext.createGain();
      this.noisePostMaster.gain.setValueAtTime(0, t0);
      this.noiseGain.connect(this.noiseRoutePost);
      this.noiseRoutePost.connect(this.noisePostMaster);
      this.noisePostMaster.connect(this.audioContext.destination);
      this.noiseVizGain = this.audioContext.createGain();
      this.noiseVizGain.gain.setValueAtTime(noise.showInViz ? 1 : 0, t0);
      this.noiseGain.connect(this.noiseVizGain);
      this.noiseVizGain.connect(this.preMasterTap);
    }
    this._noisePlaying = this._startNoiseSource(noise.type);

    // Get max channel count from destination
    this.outputChannelCount = this.audioContext.destination.maxChannelCount || 2;
    console.debug('Max output channels available:', this.outputChannelCount);
    
    // Create initial oscillators with default routing
    this._createOscillators();
    
    // Setup default routing (odd → left, even → right)
    this._setupDefaultRouting();
    
    // Fade in master to user volume only — count-scale lives on
    // droneCountScale (already set above). noisePostMaster fades with it
    // (it carries the master level for post-routed noise).
    for (const p of this._masterFadeParams()) {
      p.setTargetAtTime(this.masterVolumeUser, this.audioContext.currentTime, 0.1);
    }

    this.isInitialized = true;
    this.isPaused = false;
    // Sync drone bus to whatever droneEnabled was set to before init
    // (e.g. a patch load that ran before the user clicked "Start").
    this._applyDroneBusGain();

    // Fire one frequency-change notification so the Tuning singleton
    // (and any other addFrequencyListener subscriber) recomputes the
    // scale from the LIVE oscillator count + freqs. Without this, the
    // scale stays at whatever Tuning's constructor saw at module load
    // (default 4) — so loading an autosave with 12 slots leaves the
    // keyboard tracking only the first 4. Subscribers were attached
    // before initialize() ran, so they receive the notification here.
    this._notifyFrequencyChange();

    // Live-retarget held drones whenever the user changes the drone
    // envelope's sustain (or any param via _notify) — every un-muted
    // slot's gain glides to volumeValues[i] × droneEnvelope.sustain.
    if (!this._envelopeUnsubscribe) {
      this._envelopeUnsubscribe = droneEnvelope.onChange(() => this._retargetDronesForSustain());
    }
    // Re-apply the morphed waveform to every running drone when the
    // slider moves. setPeriodicWave on a running oscillator preserves
    // phase in practice on Chrome/Safari.
    if (!this._waveUnsubscribe) {
      this._waveUnsubscribe = droneWave.onChange(() => this._reapplyDroneWave());
    }
    // Two things happen on a fold change: (a) the shaper's curve is
    // rebuilt for the new drive (sin(drive·π·x)), and (b) the dry/wet
    // gains around the shaper crossfade so fold=0 ⇒ pure dry / shaper
    // muted, fold=1 ⇒ pure shaper output. Gain ramp uses ~30 ms tau so
    // a slider drag feels like a smooth fade rather than stepping.
    if (!this._foldUnsubscribe) {
      const apply = (foldInst, shaper, dryNode, wetNode) => {
        if (shaper) foldInst.applyTo(shaper);
        if (dryNode && wetNode && this.audioContext) {
          const t = this.audioContext.currentTime;
          dryNode.gain.setTargetAtTime(1 - foldInst.amount, t, 0.03);
          wetNode.gain.setTargetAtTime(foldInst.amount, t, 0.03);
        }
      };
      const unsubA = droneFold.onChange(() =>
        apply(droneFold, this.droneFoldShaper, this.droneFoldDry, this.droneFoldWet));
      const unsubB = keyboardFold.onChange(() =>
        apply(keyboardFold, this.keyboardFoldShaper, this.keyboardFoldDry, this.keyboardFoldWet));
      this._foldUnsubscribe = () => { unsubA(); unsubB(); };
    }
    // Noise level rides noiseGain; a color change crossfades to a new
    // looped source (see _applyNoise / _swapNoiseSource).
    if (!this._noiseUnsubscribe) {
      this._noiseUnsubscribe = noise.onChange(() => this._applyNoise());
    }
    // Drone stereo mode + detune. The engine is MODE-BLIND (iOS parity):
    // every drone always renders as a detuned pair under the collapse-pan
    // law, so a mode flip is nothing but a batch pan move — each voice
    // glides to the NEW preset's origin (stereo → center split, lr →
    // alternating hard L/R) and the width-coupled math dephases or
    // converges its pair continuously along the way. No reroute, no gain
    // dip, no detune zeroing: the taps carry the whole travel, and the
    // L/R channels stay decorrelated throughout (the old instant
    // detune-zero + deferred glide played every voice mono for the whole
    // glide — the Lissajous flashed a diagonal). The ⊙/LR button in the
    // console's ALL lane is the usual trigger. On detune change, ramp
    // every oscillator to its new frequency so the user hears the curve
    // live. The visualizer's smoothedFreqs follows because updatePhases()
    // reads _dronePrimaryFreq() / _dronePartnerFreq().
    if (!this._droneStereoUnsubscribe) {
      this._droneStereoUnsubscribe = droneStereo.onChange((_inst, info) => {
        if (!this.audioContext) return;
        if (!info) return;
        if (info.kind === 'mode') {
          // Per-voice pan choices don't persist across a mode flip —
          // resetRoutingToDefaults rewrites the discrete map to the new
          // origins (patch-bay slots crossing to/from multichannel still
          // get their click-free swap inside) and hands back the pure-pan
          // moves, which travel over PERFORM's timing (0 = snap).
          const glideMs = Math.max(0, Number(this.getPanGlideMs?.()) || 0);
          const deferred = this.resetRoutingToDefaults({ deferPan: true });
          for (const { index, pan } of deferred) {
            if (glideMs > 0) this.glideVoicePan(index, pan, glideMs);
            else this.setVoicePan(index, pan, { syncRouting: false });
          }
        } else if (info.kind === 'detune' || info.kind === 'curve') {
          this._applyDroneDetuneCurve();
        }
      });
    }
  }

  _retargetDronesForSustain() {
    if (!this.isInitialized || !this.audioContext) return;
    for (let i = 0; i < this.oscillatorCount; i++) {
      const width = panWidth(this.getVoicePan(i));
      if (!this.mutedStates[i]) {
        const gainNode = this.gainNodes[i];
        const gainNodeR = this.gainNodesR[i];
        const peak = this.volumeValues[i];
        if (gainNode) droneEnvelope.retargetSustain(gainNode.gain, this.audioContext, peak);
        if (gainNodeR && this._slotPairActive(i)) {
          droneEnvelope.retargetSustain(gainNodeR.gain, this.audioContext, peak * width);
        }
      }
      // Partials follow the same shared sustain. Each uses its own
      // peak; muted partials skip — _partialTargetGain already returns
      // 0, but explicit-skip avoids scheduling a pointless ramp.
      const partials = this.extraPartials[i];
      if (partials) {
        for (const p of partials) {
          if (p.muted || !p._gain) continue;
          droneEnvelope.retargetSustain(p._gain.gain, this.audioContext, p.vol);
          if (p._gainR && this._slotPairActive(i)) {
            droneEnvelope.retargetSustain(p._gainR.gain, this.audioContext, p.vol * width);
          }
        }
      }
    }
  }

  _reapplyDroneWave() {
    if (!this.isInitialized || !this.audioContext) return;
    const wave = droneWave.getPeriodicWave(this.audioContext);
    if (!wave) return;
    for (let i = 0; i < this.oscillatorCount; i++) {
      if (this.oscillators[i]) this.oscillators[i].setPeriodicWave(wave);
      if (this.oscillatorsR[i]) this.oscillatorsR[i].setPeriodicWave(wave);
      const partials = this.extraPartials[i];
      if (partials) {
        for (const p of partials) {
          if (p._osc) p._osc.setPeriodicWave(wave);
          if (p._oscR) p._oscR.setPeriodicWave(wave);
        }
      }
    }
  }
  
  /**
   * Combined drone-path attenuation = count-scale (pre-shaper) × user
   * master volume (post-shaper). Visualizer + LSQ calibration use this
   * to compute the expected analyzer amplitude for one drone slot.
   */
  _getScaledMasterGain() {
    return this._getDroneCountScale() * this.masterVolumeUser;
  }

  /**
   * Count-based normalization for the drone bus, applied at
   * droneCountScale BEFORE droneFoldShaper.
   *
   * Returns 1.0 (no attenuation). A single drone at slider 1.0 should
   * land at unity loudness so it matches a kbd voice at peak — and
   * the user picks how many drones to layer and how loud to set each
   * slider. Multi-drone summing past unity is caught by the post-
   * master saturator (musical soft-clip) rather than by silently
   * attenuating each drone here, which made a single audible drone in
   * a 4-slot config quieter than a kbd voice for no obvious reason.
   * The gain stage is kept in the graph (droneCountScale stays
   * connected) so we can re-introduce normalization later if multi-
   * drone summing turns out to need it.
   */
  _getDroneCountScale() {
    return 1.0;
  }

  /**
   * Load the soft-limiter worklet module and instantiate the node.
   * Safe to call once per initialize(); on failure saturationReady stays
   * false and the chain falls back to direct masterGain → splitter.
   */
  async _loadSaturationNode() {
    try {
      // /public is served verbatim by Vite with the configured base
      // path prepended (BASE_URL = '/wavetuner/' in prod, '/' in dev).
      const workletUrl = `${import.meta.env.BASE_URL}soft-limiter-worklet.js`;
      await this.audioContext.audioWorklet.addModule(workletUrl);
      this.saturationNode = new AudioWorkletNode(this.audioContext, 'soft-limiter', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      // Apply settings that may have been set before initialize().
      this.saturationNode.port.postMessage({ curve: this.saturationCurve });
      const driveParam = this.saturationNode.parameters.get('drive');
      if (driveParam) {
        driveParam.setValueAtTime(this.saturationDrive, this.audioContext.currentTime);
      }
      this.saturationReady = true;
    } catch (err) {
      console.warn('AudioEngine: soft-limiter worklet failed to load — running without master saturation', err);
      this.saturationNode = null;
      this.saturationReady = false;
      this.saturationLoadFailed = true;
    }
  }

  /**
   * Set the saturation curve. Accepts a string key from SATURATION_CURVES
   * ('off' | 'tanh' | 'cubic' | 'sine' | 'hard') or the matching integer.
   * Safe to call before initialize() — the value is applied when the
   * worklet loads.
   */
  setSaturationCurve(curve) {
    const value = typeof curve === 'string' ? SATURATION_CURVES[curve] : curve;
    if (value === undefined || value === null) return;
    this.saturationCurve = value;
    if (this.saturationNode) {
      this.saturationNode.port.postMessage({ curve: value });
    }
  }

  getSaturationCurve() {
    return this.saturationCurve;
  }

  /**
   * Drive — pre-saturation gain into the curve. 1.0 is neutral, higher
   * pushes more signal into the curve's nonlinear region. Smoothed via
   * setTargetAtTime to avoid zipper noise on slider drags.
   */
  setSaturationDrive(value) {
    const clamped = Math.max(0.1, Math.min(4.0, value));
    this.saturationDrive = clamped;
    if (this.saturationNode && this.audioContext) {
      const param = this.saturationNode.parameters.get('drive');
      if (param) {
        param.setTargetAtTime(clamped, this.audioContext.currentTime, 0.02);
      }
    }
  }

  getSaturationDrive() {
    return this.saturationDrive;
  }

  /**
   * Noise. Level + color live on the `noise` singleton (Noise.js) so the
   * UI can subscribe like Wave/Fold; these engine methods own the nodes.
   * Effective gain = paused ? 0 : level² (square law from Noise.gainValue).
   */
  _noiseEffectiveGain() {
    return this._noisePaused ? 0 : noise.gainValue();
  }

  _applyNoise() {
    if (!this.isInitialized || !this.noiseGain) return;
    const t = this.audioContext.currentTime;
    this.noiseGain.gain.setTargetAtTime(this._noiseEffectiveGain(), t, 0.03);
    // Routing crossfade (saturate vs clean) + viz-tap gate — both live
    // on the singleton like level/color, both click-free by ramp.
    if (this.noiseRoutePre && this.noiseRoutePost) {
      const post = noise.postSaturation ? 1 : 0;
      this.noiseRoutePre.gain.setTargetAtTime(1 - post, t, 0.05);
      this.noiseRoutePost.gain.setTargetAtTime(post, t, 0.05);
    }
    if (this.noiseVizGain) {
      this.noiseVizGain.gain.setTargetAtTime(noise.showInViz ? 1 : 0, t, 0.05);
    }
    if (this._noisePlaying && this._noisePlaying.type !== noise.type) {
      this._swapNoiseSource(noise.type);
    }
  }

  /** Start a looped source for `type`, faded in over ~20 ms. */
  _startNoiseSource(type) {
    const t = this.audioContext.currentTime;
    const src = this.audioContext.createBufferSource();
    src.buffer = getNoiseBuffer(this.audioContext, type);
    src.loop = true;
    const gain = this.audioContext.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.setTargetAtTime(1, t, 0.02);
    src.connect(gain);
    gain.connect(this.noiseGain);
    src.start();
    return { src, gain, type };
  }

  /** Crossfade the running color into the new one — no hard buffer swap. */
  _swapNoiseSource(type) {
    const old = this._noisePlaying;
    this._noisePlaying = this._startNoiseSource(type);
    if (old) {
      const t = this.audioContext.currentTime;
      old.gain.gain.setTargetAtTime(0, t, 0.02);
      const oldSrc = old.src;
      const oldGain = old.gain;
      setTimeout(() => {
        try { oldSrc.stop(); } catch { /* already stopped */ }
        try { oldGain.disconnect(); } catch { /* already gone */ }
      }, 200);
    }
  }

  /**
   * Gain AudioParams that must carry the master fade in lock-step.
   * noisePostMaster is the master-level stand-in for post-saturation
   * routed noise (that path bypasses masterGainNode so it can skip the
   * saturator, but must still follow volume / mute / pause ramps).
   * Every masterGainNode.gain schedule goes through this list.
   */
  _masterFadeParams() {
    const params = [this.masterGainNode.gain];
    if (this.noisePostMaster) params.push(this.noisePostMaster.gain);
    return params;
  }

  /** Master-pause gate for noise — mirrors pauseDrones/setKeyboardEnabled. */
  setNoisePaused(paused) {
    this._noisePaused = !!paused;
    if (this.isInitialized && this.noiseGain) {
      this.noiseGain.gain.setTargetAtTime(
        this._noiseEffectiveGain(), this.audioContext.currentTime, 0.05
      );
    }
  }
  isNoisePaused() { return this._noisePaused; }

  setMasterVolume(value) {
    const clamped = Math.max(0, Math.min(1, value));
    this.masterVolumeUser = clamped;
    // Dragging the master fader auto-unmutes — matches the per-bus
    // mute behavior so the user doesn't have to click unmute first.
    this._masterMuted = false;
    // Master node now carries ONLY user volume; count-scale lives on
    // droneCountScale and is updated independently when oscillator
    // count changes. Pause no longer touches master (it fades the drone
    // bus instead — see pauseDrones), so an isPaused gate here would
    // silently swallow master-fader drags while drones are paused but
    // MIDI / kbd voices are still playing.
    if (this.isInitialized && this.masterGainNode) {
      for (const p of this._masterFadeParams()) {
        p.setTargetAtTime(this.masterVolumeUser, this.audioContext.currentTime, 0.05);
      }
    }
  }

  getMasterVolume() {
    return this.masterVolumeUser;
  }

  /**
   * Keyboard bus controls. Setting either volume or enabled-flag fades
   * the keyboardBusGain to the new effective level via setTargetAtTime
   * so toggling on/off doesn't click. Effective gain = enabled ? vol : 0.
   */
  setKeyboardVolume(value) {
    this._kbdVolume = Math.max(0, Math.min(1, value));
    this._applyKeyboardBusGain();
  }
  getKeyboardVolume() { return this._kbdVolume; }
  setKeyboardEnabled(on) {
    this._kbdEnabled = !!on;
    this._applyKeyboardBusGain();
  }
  getKeyboardEnabled() { return this._kbdEnabled; }

  _kbdEffectiveGain() {
    return this._kbdEnabled ? this._kbdVolume : 0;
  }
  _applyKeyboardBusGain() {
    if (!this.isInitialized || !this.keyboardBusGain) return;
    const t = this.audioContext.currentTime;
    this.keyboardBusGain.gain.setTargetAtTime(this._kbdEffectiveGain(), t, 0.05);
  }

  /**
   * Per-source test bus gains. Range 0..2 (1.0 = unity), exposed as
   * sliders in the Mixer so we can dial in relative loudness between
   * drone / kbd / midi without restructuring the engine. Each setter
   * ramps via setTargetAtTime to avoid clicks.
   *
   * Dragging the slider while the bus is muted unmutes it — matches
   * the drone mute behavior so the user doesn't have to manually
   * unmute before adjusting.
   */
  setDroneBusGain(value) {
    const clamped = Math.max(0, Math.min(2, value));
    this._droneUserGainValue = clamped;
    this._droneBusMuted = false;
    if (this.isInitialized && this.droneUserGain) {
      this.droneUserGain.gain.setTargetAtTime(clamped, this.audioContext.currentTime, 0.03);
    }
  }
  getDroneBusGain() { return this._droneUserGainValue; }
  isDroneBusMuted() { return this._droneBusMuted; }
  toggleDroneBusMute() {
    this._droneBusMuted = !this._droneBusMuted;
    if (this.isInitialized && this.droneUserGain) {
      const target = this._droneBusMuted ? 0 : this._droneUserGainValue;
      this.droneUserGain.gain.setTargetAtTime(target, this.audioContext.currentTime, 0.03);
    }
  }

  setKbdBusGain(value) {
    const clamped = Math.max(0, Math.min(2, value));
    this._kbdUserGainValue = clamped;
    this._kbdBusMuted = false;
    if (this.isInitialized && this.kbdBusGain) {
      this.kbdBusGain.gain.setTargetAtTime(clamped, this.audioContext.currentTime, 0.03);
    }
  }
  getKbdBusGain() { return this._kbdUserGainValue; }
  isKbdBusMuted() { return this._kbdBusMuted; }
  toggleKbdBusMute() {
    this._kbdBusMuted = !this._kbdBusMuted;
    if (this.isInitialized && this.kbdBusGain) {
      const target = this._kbdBusMuted ? 0 : this._kbdUserGainValue;
      this.kbdBusGain.gain.setTargetAtTime(target, this.audioContext.currentTime, 0.03);
    }
  }

  setMidiBusGain(value) {
    const clamped = Math.max(0, Math.min(2, value));
    this._midiUserGainValue = clamped;
    this._midiBusMuted = false;
    if (this.isInitialized && this.midiBusGain) {
      this.midiBusGain.gain.setTargetAtTime(clamped, this.audioContext.currentTime, 0.03);
    }
  }
  getMidiBusGain() { return this._midiUserGainValue; }
  isMidiBusMuted() { return this._midiBusMuted; }
  toggleMidiBusMute() {
    this._midiBusMuted = !this._midiBusMuted;
    if (this.isInitialized && this.midiBusGain) {
      const target = this._midiBusMuted ? 0 : this._midiUserGainValue;
      this.midiBusGain.gain.setTargetAtTime(target, this.audioContext.currentTime, 0.03);
    }
  }

  /** Wave-generator level (0..2, unity 1) — scales both oscillator
   *  pools together, post-fold pre-master. Noise is unaffected. */
  setWaveBusGain(value) {
    const clamped = Math.max(0, Math.min(2, value));
    this._waveUserGainValue = clamped;
    if (this.isInitialized && this.waveBusGain) {
      this.waveBusGain.gain.setTargetAtTime(clamped, this.audioContext.currentTime, 0.03);
    }
  }
  getWaveBusGain() { return this._waveUserGainValue; }

  /** Master mute toggle. Mirrors setMasterVolume's existing 0..1 range
   *  but ramps to 0 (mute) or back to the stored masterVolumeUser
   *  (unmute) without overwriting the user's set value. */
  isMasterMuted() { return this._masterMuted; }
  toggleMasterMute() {
    this._masterMuted = !this._masterMuted;
    if (this.isInitialized && this.masterGainNode) {
      const target = this._masterMuted ? 0 : this.masterVolumeUser;
      for (const p of this._masterFadeParams()) {
        p.setTargetAtTime(target, this.audioContext.currentTime, 0.05);
      }
    }
  }

  /**
   * Read instantaneous post-master peak across L+R. Reads the existing
   * analyserNode1/2 time-domain buffers (already wired post-saturation)
   * and returns max(|sample|) on each channel plus the overall peak.
   * Returns zeros until the audio graph is initialized.
   */
  getMasterPeakLevels() {
    if (!this.isInitialized || !this.analyserNode1 || !this.analyserNode2) {
      return { peakL: 0, peakR: 0, peak: 0 };
    }
    // Short-TTL memo: each call copies 2 × 8192 samples (64 KB) out of the
    // analysers and scans all 16 384 of them, and up to three independent
    // rAF loops (master rail, mixer panel, and callers-to-come) ask for
    // this within the same frame. One read per ~10 ms serves them all —
    // the analyser buffer only advances per audio block anyway.
    const nowMs = performance.now();
    if (this._peakMemo && nowMs - this._peakMemoTs < 10) return this._peakMemo;
    this.analyserNode1.getFloatTimeDomainData(this.timeData1);
    this.analyserNode2.getFloatTimeDomainData(this.timeData2);
    let pL = 0;
    let pR = 0;
    const n = this.timeData1.length;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(this.timeData1[i]);
      const b = Math.abs(this.timeData2[i]);
      if (a > pL) pL = a;
      if (b > pR) pR = b;
    }
    this._peakMemo = { peakL: pL, peakR: pR, peak: Math.max(pL, pR) };
    this._peakMemoTs = nowMs;
    return this._peakMemo;
  }

  /**
   * Effective gain on the path from a drone osc to the destination
   * (master × drone-bus). Visualizer's synth path multiplies drone amps
   * by this so they fade with master volume AND with drone-pause
   * independently from keyboard voices.
   */
  getDroneEffectiveGain() {
    if (!this.isInitialized || !this.masterGainNode || !this.droneBusGain) return 0;
    return this.masterGainNode.gain.value * this.droneBusGain.gain.value;
  }
  /** Same idea for keyboard voices. */
  getKeyboardEffectiveGain() {
    if (!this.isInitialized || !this.masterGainNode || !this.keyboardBusGain) return 0;
    return this.masterGainNode.gain.value * this.keyboardBusGain.gain.value;
  }

  /**
   * Visualizer-only source gains: the same per-source bus contribution as
   * the *EffectiveGain() versions but WITHOUT the master fader (or its
   * count-based clip scale, which lives on masterGainNode). The scopes are
   * sized by the individual source mixers (drone/keyboard/midi), not the
   * final fader — so muting master still leaves the standing-wave, polar
   * and face scopes visible. This mirrors the pre-master analyzer tap that
   * feeds the XY scope.
   */
  getDroneVizGain() {
    if (!this.isInitialized || !this.droneBusGain) return 0;
    return this.droneBusGain.gain.value;
  }
  getKeyboardVizGain() {
    if (!this.isInitialized || !this.keyboardBusGain) return 0;
    return this.keyboardBusGain.gain.value;
  }

  /**
   * Instantaneous master gain as the audio graph currently has it —
   * includes the user's master-volume slider, the count-based clip
   * scale, and any in-flight fadeIn/fadeOut/pause ramp. This is what
   * the analyzer actually sees, so visualizers wanting to match the
   * audio through transitions should multiply their amplitudes by this
   * instead of computing the target scale from masterVolumeUser alone.
   */
  getCurrentMasterGain() {
    if (!this.isInitialized || !this.masterGainNode) return 0;
    return this.masterGainNode.gain.value;
  }


  /**
   * Ramp the drone count-scale gain when the oscillator count changes.
   * This sits PRE-shaper, so adding/removing drones smoothly adjusts
   * the input level the shaper sees rather than scaling its output.
   * Master node is unaffected by count changes — it stays at user
   * volume.
   */
  _updateMasterGainScaling() {
    if (!this.isInitialized || this.isPaused) return;
    if (!this.droneCountScale) return;

    const targetGain = this._getDroneCountScale();
    this.droneCountScale.gain.setTargetAtTime(
      targetGain,
      this.audioContext.currentTime,
      0.1
    );
  }
  
  /**
   * Create oscillators based on current count
   */
  _createOscillators() {
    for (let i = 0; i < this.oscillatorCount; i++) {
      this._createSingleOscillator(i);
    }
  }

  /**
   * Create a single oscillator at the specified index. When `withFade`
   * is true (i.e. called from setOscillatorCount during a runtime add),
   * the gain ramps from 0 to volume × sustain over FIXED_SLOT_FADE so
   * the new slot eases in instead of clicking. The initial-creation
   * path (called from initialize via _createOscillators) skips the
   * ramp because the master gain's fade-in already covers that.
   */
  _createSingleOscillator(index, withFade = false) {
    try {
      if (!this.audioContext) {
        console.error('AudioEngine: Cannot create oscillator - audio context not ready');
        return;
      }

      const oscillator = this.audioContext.createOscillator();
      const gainNode = this.audioContext.createGain();
      const oscillatorR = this.audioContext.createOscillator();
      const gainNodeR = this.audioContext.createGain();

      // Apply the drone pool's current waveform shape to BOTH oscs.
      // Cached per quantized position so dragging the slider doesn't allocate.
      const wave = droneWave.getPeriodicWave(this.audioContext);
      if (wave) {
        oscillator.setPeriodicWave(wave);
        oscillatorR.setPeriodicWave(wave);
      }

      oscillator.connect(gainNode);
      oscillatorR.connect(gainNodeR);

      // Default routing depends on mode (alternating hard-pan in lr, L/R
      // split in stereo). Stash in routingMap; the actual node connect goes
      // through _connectDroneToChannels so stereo mode is honored from the
      // start. Pan seeds from the routing so a slot restored with an
      // overridden route keeps its image; fresh slots get the mode origin.
      if (!this.routingMap[index] || this.routingMap[index].length === 0) {
        this.routingMap[index] = this._defaultRouting(index);
      }
      if (!Number.isFinite(this.panValues[index])) {
        const fromRoute = this._panFromChannels(this.routingMap[index]);
        this.panValues[index] = fromRoute !== null ? fromRoute : this._defaultPan(index);
      }
      this.oscillators[index] = oscillator;
      this.gainNodes[index] = gainNode;
      this.oscillatorsR[index] = oscillatorR;
      this.gainNodesR[index] = gainNodeR;
      this._connectDroneToChannels(index);

      // Detune offset comes from the curve × master Hz (mode-blind
      // nominal — pan width narrows it at play time). Always recompute
      // on (re)create so the offset stays consistent with the curve
      // even after a slot was restored from removedSlots with a stale
      // value or never set.
      this.droneDetuneOffsets[index] = droneStereo.nominalDetuneHzAt(index);
      const primaryFreq = this._dronePrimaryFreq(index);
      const partnerFreq = this._dronePartnerFreq(index);
      const primaryTarget = this._droneTargetGain(index);
      const partnerTarget = this._dronePartnerTargetGain(index);
      const t = this.audioContext.currentTime;

      oscillator.frequency.setValueAtTime(primaryFreq, t);
      oscillatorR.frequency.setValueAtTime(partnerFreq, t);

      if (withFade) {
        gainNode.gain.setValueAtTime(0, t);
        gainNodeR.gain.setValueAtTime(0, t);
        if (primaryTarget > 0) gainNode.gain.linearRampToValueAtTime(primaryTarget, t + FIXED_SLOT_FADE);
        if (partnerTarget > 0) gainNodeR.gain.linearRampToValueAtTime(partnerTarget, t + FIXED_SLOT_FADE);
      } else {
        gainNode.gain.setValueAtTime(primaryTarget, t);
        gainNodeR.gain.setValueAtTime(partnerTarget, t);
      }

      oscillator.start();
      oscillatorR.start();

      // Seed both phase accumulators. Both oscs start at phase 0 from
      // their start() time; updatePhases advances each independently
      // since their freqs may differ in stereo mode.
      this.phases[index] = 0;
      this.smoothedFreqs[index] = primaryFreq;
      this._lastPhaseUpdate[index] = t;
      this.phasesR[index] = 0;
      this.smoothedFreqsR[index] = partnerFreq;
      this._lastPhaseUpdateR[index] = t;
    } catch (err) {
      console.error('AudioEngine: Failed to create oscillator', index, err);
    }
  }
  
  /**
   * Mode-aware origin routing for one slot. In 'lr' mode it's the
   * alternating hard-pan (slot i → i % channelCount). In 'stereo' mode the
   * natural origin is the L/R split — channels [0,1], read as "both" by
   * _connectDroneToChannels — so a fresh stereo load (or device change)
   * gives the proper split rather than collapsing each voice to mono.
   */
  _defaultRouting(index) {
    const n = this.channelGains.length || 2;
    if (droneStereo.mode === 'stereo') return n >= 2 ? [0, 1] : [0];
    return [index % n];
  }

  /**
   * Mode-aware origin pan for one slot — the continuous counterpart of
   * _defaultRouting. 'stereo' origin is the split (center); 'lr' origin
   * is the alternating hard-pan. Slots whose lr default lands beyond
   * the stereo pair (multichannel devices) sit at 0 — pan is inert for
   * them anyway.
   */
  _defaultPan(index) {
    if (droneStereo.mode === 'stereo') return 0;
    const n = this.channelGains.length || 2;
    const ch = index % n;
    if (ch === 0) return -1;
    if (ch === 1) return 1;
    return 0;
  }

  /** Continuous pan for slot i, falling back to the mode origin. */
  getVoicePan(i) {
    const p = this.panValues[i];
    return Number.isFinite(p) ? p : this._defaultPan(i);
  }

  /** Per-slot pans for every live slot (visualizers, patch capture). */
  getVoicePans() {
    return Array.from({ length: this.oscillatorCount }, (_, i) => this.getVoicePan(i));
  }

  /** True when a slot's routing goes beyond the stereo pair — the
   *  patch bay assigned it to channels ≥ 2 on a multichannel device.
   *  Those slots keep the legacy discrete connects; pan is inert. */
  _usesBeyondStereo(channels) {
    return channels.some((ch) => ch >= 2);
  }

  /** True when slot i renders as the collapse-pan detuned pair. Always
   *  true for stereo-pair slots — the drone engine is mode-blind, so
   *  detune and partner gain follow the pan dial, not the mode toggle.
   *  Slots the patch bay routed beyond the stereo pair keep the legacy
   *  discrete behavior, where the pair only sounds in 'stereo' mode
   *  (their pan is inert, so width can't fade the partner for them). */
  _slotPairActive(i) {
    if (!this._usesBeyondStereo(this.routingMap[i] || [])) return true;
    return droneStereo.mode === 'stereo';
  }

  /** Subscribe to per-voice pan changes. Returns an unsubscribe fn. */
  addPanListener(fn) {
    this._panListeners.add(fn);
    return () => this._panListeners.delete(fn);
  }

  /** Notify the App callback and every pan listener of a pan change. */
  _emitPanChange(index, pan) {
    this.onPanChange?.(index, pan);
    for (const fn of this._panListeners) {
      try { fn(index, pan); } catch (e) { console.error('pan listener error', e); }
    }
  }

  /** Discrete → continuous: the pan a routing array projects onto.
   *  null when the array is empty or beyond the stereo pair. */
  _panFromChannels(channels) {
    if (!Array.isArray(channels) || channels.length === 0) return null;
    if (this._usesBeyondStereo(channels)) return null;
    if (channels.length >= 2) return 0;
    return channels[0] === 1 ? 1 : -1;
  }

  /**
   * Setup default routing (odd → left, even → right; stereo → split)
   */
  _setupDefaultRouting() {
    for (let i = 0; i < this.oscillatorCount; i++) {
      this.routingMap[i] = this._defaultRouting(i);
    }
  }

  /**
   * Primary oscillator's played freq: base + offset[i]·width/2 (the
   * half-spread; partner takes −half). Mode-blind — the offset narrows
   * with |pan| (panWidth) so a hard-panned voice converges on its true
   * orb frequency; see setVoicePan. Beyond-stereo patch-bay slots play
   * clean in lr (legacy: their offsets were 0 there).
   */
  _dronePrimaryFreq(i) {
    // Global transpose scales the nominal pitch; the stereo detune `offset`
    // stays additive in Hz (beat rate is a fixed slot property, per below).
    const nominal = (this.frequencyValues[i] || 0) * this._transposeRatio;
    const offset = this.droneDetuneOffsets[i] || 0;
    const shift = this._slotPairActive(i)
      ? (offset * panWidth(this.getVoicePan(i))) / 2
      : 0;
    return Math.max(0.001, Math.min(FREQ_CEIL, nominal + shift));
  }

  /**
   * Partner oscillator's played freq. Always base - offset·width/2 —
   * only audible in 'stereo' mode, but kept current so a mode flip
   * doesn't have to retune the partner before fading it in.
   */
  _dronePartnerFreq(i) {
    const nominal = (this.frequencyValues[i] || 0) * this._transposeRatio;
    const offset = this.droneDetuneOffsets[i] || 0;
    return Math.max(0.001, Math.min(FREQ_CEIL,
      nominal - (offset * panWidth(this.getVoicePan(i))) / 2));
  }

  /**
   * Steady-state gain target for the primary oscillator: 0 if muted,
   * otherwise volume × droneEnvelope.sustain. Used by setVolume,
   * sustain retargets, and the create path.
   */
  _droneTargetGain(i) {
    if (this.mutedStates[i]) return 0;
    return (this.volumeValues[i] || 0.5) * droneEnvelope.sustain * this._slotLoudnessScale(i);
  }

  /**
   * Equal-loudness compensation when switching from LR mode (signal in
   * one channel) to stereo mode (same level in BOTH channels).
   *
   * The textbook -3 dB (1/√2) compensation is correct for uncorrelated
   * signals, but stereo drones run two slightly-detuned oscillators
   * that are PARTIALLY correlated — and listener binaural integration
   * makes centered/spread continuous tones perceptually louder than
   * the equal-power math predicts. Empirically, 1/√2 leaves stereo
   * audibly louder than lr at matched slider settings; 0.5 (-6 dB,
   * equal-amplitude pan law) brings them into rough parity for the
   * drone case. Applied at every drone gain target site (primary,
   * partner, partials).
   *
   * Kbd voices have their own stereo compensation inline in
   * KeyboardVoiceManager.noteOn — see the `peak = isStereo ? ...`
   * line. Kept separate because percussive/transient voices align
   * better with the standard -3 dB rule than continuous drones do.
   *
   * With the per-voice pan dial the compensation lerps 0.5 → 1.0 with
   * |pan|: at center the voice is the classic two-channel split (0.5
   * applies as before); at a full extreme it degenerates to a single
   * oscillator in one channel — exactly an lr hard-pan, whose level is
   * 1.0. Both endpoints therefore match the two pre-pan calibrations.
   */
  _slotLoudnessScale(i) {
    if (!this._slotPairActive(i)) return 1;
    return 0.5 + 0.5 * Math.abs(this.getVoicePan(i));
  }

  /** Public read of the per-slot equal-loudness comp for the synth
   *  visualizer paths (fairy tail, synth XY, Hilbert) — without it a
   *  centered voice draws ~2× the analyser figure and the tape-fairy
   *  takeover/handoff steps in size. */
  getSlotLoudnessScale(i) {
    return this._slotLoudnessScale(i);
  }

  /**
   * Steady-state gain target for the partner oscillator: the primary's
   * target scaled by panWidth — the partner fades out as the voice
   * pans, reaching 0 at the extremes, so a hard-panned voice is one
   * clean oscillator, never two identical-frequency oscs summing at
   * arbitrary phase. Mode-blind: in the 'lr' PRESET the default hard
   * pans give width 0, reproducing the old silent-partner behavior.
   */
  _dronePartnerTargetGain(i) {
    if (!this._slotPairActive(i)) return 0;
    return this._droneTargetGain(i) * panWidth(this.getVoicePan(i));
  }

  /**
   * Partial's primary-side played frequency. Same shape as
   * _dronePrimaryFreq but the nominal is base*ratio. Detune is added
   * AFTER the ratio (additively) so the beat rate between primary and
   * partner stays the same across partials — beating reads as a slot
   * property, not a per-pitch property.
   */
  _partialPrimaryFreq(slotIndex, partial) {
    const nominal = (this.frequencyValues[slotIndex] || 0) * (partial.ratio || 1) * this._transposeRatio;
    const offset = this.droneDetuneOffsets[slotIndex] || 0;
    const shift = this._slotPairActive(slotIndex)
      ? (offset * panWidth(this.getVoicePan(slotIndex))) / 2
      : 0;
    return Math.max(0.001, Math.min(FREQ_CEIL, nominal + shift));
  }

  _partialPartnerFreq(slotIndex, partial) {
    const nominal = (this.frequencyValues[slotIndex] || 0) * (partial.ratio || 1) * this._transposeRatio;
    const offset = this.droneDetuneOffsets[slotIndex] || 0;
    return Math.max(0.001, Math.min(FREQ_CEIL,
      nominal - (offset * panWidth(this.getVoicePan(slotIndex))) / 2));
  }

  /** Steady-state gain target for a partial — its own vol/mute, scaled by
   *  the shared drone-pool envelope's sustain. Primary's mute does NOT
   *  cascade to extras here; the slot-level mute logic in toggleMute
   *  applies to extras separately so the user can mute the whole slot
   *  in one gesture from existing UI without losing per-partial state. */
  _partialTargetGain(partial, slotIndex) {
    if (partial.muted) return 0;
    return (partial.vol || 0) * droneEnvelope.sustain * this._slotLoudnessScale(slotIndex);
  }

  _partialPartnerTargetGain(partial, slotIndex) {
    if (!this._slotPairActive(slotIndex)) return 0;
    return this._partialTargetGain(partial, slotIndex) * panWidth(this.getVoicePan(slotIndex));
  }

  /** Build the audio nodes for a single partial. Mirrors the primary
   *  oscillator path in _createSingleOscillator: dual-osc topology
   *  (primary + partner) so the same lr/stereo modes apply. Routing
   *  inherits the parent slot's routingMap entry via
   *  _connectPartialToChannels. Caller decides `withFade` — passing true
   *  ramps gain from 0 to target over FIXED_SLOT_FADE so user-initiated
   *  partial adds don't click. */
  _createPartialNodes(slotIndex, partial, withFade = false) {
    if (!this.audioContext) return;
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    const oscR = this.audioContext.createOscillator();
    const gainR = this.audioContext.createGain();

    const wave = droneWave.getPeriodicWave(this.audioContext);
    if (wave) {
      osc.setPeriodicWave(wave);
      oscR.setPeriodicWave(wave);
    }

    osc.connect(gain);
    oscR.connect(gainR);

    partial._osc = osc;
    partial._gain = gain;
    partial._oscR = oscR;
    partial._gainR = gainR;
    this._connectPartialToChannels(slotIndex, partial);

    const primaryFreq = this._partialPrimaryFreq(slotIndex, partial);
    const partnerFreq = this._partialPartnerFreq(slotIndex, partial);
    const primaryTarget = this._partialTargetGain(partial, slotIndex);
    const partnerTarget = this._partialPartnerTargetGain(partial, slotIndex);
    const t = this.audioContext.currentTime;

    osc.frequency.setValueAtTime(primaryFreq, t);
    oscR.frequency.setValueAtTime(partnerFreq, t);

    if (withFade) {
      gain.gain.setValueAtTime(0, t);
      gainR.gain.setValueAtTime(0, t);
      if (primaryTarget > 0) gain.gain.linearRampToValueAtTime(primaryTarget, t + FIXED_SLOT_FADE);
      if (partnerTarget > 0) gainR.gain.linearRampToValueAtTime(partnerTarget, t + FIXED_SLOT_FADE);
    } else {
      gain.gain.setValueAtTime(primaryTarget, t);
      gainR.gain.setValueAtTime(partnerTarget, t);
    }

    osc.start();
    oscR.start();
  }

  /** Fade out + tear down a partial's audio nodes. Mirrors the
   *  per-slot fade-and-stop logic in setOscillatorCount's remove path. */
  _destroyPartialNodes(partial) {
    if (!this.audioContext) return;
    const t = this.audioContext.currentTime;
    const fadeStop = (osc, gain) => {
      if (!osc) return;
      try {
        if (gain) {
          const cur = gain.gain.value;
          gain.gain.cancelScheduledValues(t);
          gain.gain.setValueAtTime(cur, t);
          gain.gain.linearRampToValueAtTime(0, t + FIXED_SLOT_FADE);
        }
        osc.onended = () => {
          try { osc.disconnect(); } catch { /* ignore */ }
          try { gain && gain.disconnect(); } catch { /* ignore */ }
        };
        osc.stop(t + FIXED_SLOT_FADE + 0.05);
      } catch (e) {
        console.warn('Error stopping partial osc', e);
      }
    };
    fadeStop(partial._osc, partial._gain);
    fadeStop(partial._oscR, partial._gainR);
    partial._osc = null;
    partial._gain = null;
    partial._oscR = null;
    partial._gainR = null;
  }

  /** Re-wire a partial's primary+partner gains to the channel graph,
   *  honoring the slot's routingMap and current stereo mode. Equivalent
   *  to _connectDroneToChannels for partials, sharing the slot's routing
   *  — partials and primary always go to the same output channels. */
  _connectPartialToChannels(slotIndex, partial) {
    if (!partial._gain) return;
    if (!this.channelGains.length) return;

    const channels = this.routingMap[slotIndex] || [];

    if (this._usesBeyondStereo(channels)) {
      // Legacy discrete multichannel routing — no pan taps.
      const isBoth = channels.length >= 2;
      try { partial._gain.disconnect(); } catch { /* ignore */ }
      partial._gain._tapL = null;
      partial._gain._tapR = null;
      if (droneStereo.mode === 'stereo') {
        const ch = isBoth ? 0 : (channels[0] ?? 0);
        if (this.channelGains[ch]) partial._gain.connect(this.channelGains[ch]);
      } else {
        for (const ch of channels) {
          if (ch >= 0 && ch < this.channelGains.length) {
            partial._gain.connect(this.channelGains[ch]);
          }
        }
      }
      if (partial._gainR) {
        try { partial._gainR.disconnect(); } catch { /* ignore */ }
        partial._gainR._tapL = null;
        partial._gainR._tapR = null;
        if (droneStereo.mode === 'stereo') {
          const ch = isBoth ? 1 : (channels[0] ?? 1);
          if (this.channelGains[ch]) partial._gainR.connect(this.channelGains[ch]);
        } else {
          const right = this.channelGains[1];
          if (right) partial._gainR.connect(right);
        }
      }
      return;
    }

    if (channels.length === 0 && droneStereo.mode !== 'stereo') {
      // lr with no routes = deliberately disconnected (patch bay cleared it).
      this._clearPanTaps(partial._gain);
      this._clearPanTaps(partial._gainR);
      return;
    }

    this._wirePanTaps(partial._gain, partial._gainR, this.getVoicePan(slotIndex));
  }

  /**
   * Re-route both the primary and partner oscillators for drone slot
   * `i` per the current mode and pan.
   *
   * Stereo-pair slots (routing ⊆ {L, R}, the normal case) get the pan-tap
   * topology: each gain node feeds BOTH channel buses through a pair of
   * persistent tap gains whose weights encode the voice's continuous pan
   * (see _wirePanTaps). Pan moves then never touch the graph — setVoicePan
   * just ramps the tap AudioParams, click-free at any drag speed.
   *
   * Slots the patch bay routed to channels ≥ 2 (multichannel devices)
   * keep the legacy discrete connects — pan is inert for them.
   *
   * Called from _createSingleOscillator, addRouting, removeRouting,
   * and the droneStereo mode/phase change subscription. disconnect()
   * only severs OUTGOING edges, so the osc → gain incoming edge
   * survives across the swap. Node-swap paths (stepToFrequency,
   * travellers) rely on taps living ON the gain node (g._tapL/_tapR):
   * a retired gain keeps its taps for its release tail while the
   * slot's new gain gets a fresh pair here.
   */
  _connectDroneToChannels(i) {
    const gainNode = this.gainNodes[i];
    const gainNodeR = this.gainNodesR[i];
    if (!this.channelGains.length) return;

    const channels = this.routingMap[i] || [];

    if (this._usesBeyondStereo(channels)) {
      // Legacy discrete multichannel routing — no pan taps.
      const isBoth = channels.length >= 2;
      if (gainNode) {
        try { gainNode.disconnect(); } catch { /* ignore */ }
        gainNode._tapL = null;
        gainNode._tapR = null;
        if (droneStereo.mode === 'stereo') {
          const ch = isBoth ? 0 : (channels[0] ?? 0);
          if (this.channelGains[ch]) gainNode.connect(this.channelGains[ch]);
        } else {
          for (const ch of channels) {
            if (ch >= 0 && ch < this.channelGains.length) {
              gainNode.connect(this.channelGains[ch]);
            }
          }
        }
      }
      if (gainNodeR) {
        try { gainNodeR.disconnect(); } catch { /* ignore */ }
        gainNodeR._tapL = null;
        gainNodeR._tapR = null;
        if (droneStereo.mode === 'stereo') {
          const ch = isBoth ? 1 : (channels[0] ?? 1);
          if (this.channelGains[ch]) gainNodeR.connect(this.channelGains[ch]);
        } else {
          const right = this.channelGains[1];
          if (right) gainNodeR.connect(right);
        }
      }
      return;
    }

    if (channels.length === 0 && droneStereo.mode !== 'stereo') {
      // lr with no routes = deliberately disconnected (patch bay cleared it).
      this._clearPanTaps(gainNode);
      this._clearPanTaps(gainNodeR);
      return;
    }

    this._wirePanTaps(gainNode, gainNodeR, this.getVoicePan(i));
  }

  /** Disconnect a gain node's outputs and drop its tap refs. */
  _clearPanTaps(g) {
    if (!g) return;
    try { g.disconnect(); } catch { /* ignore */ }
    g._tapL = null;
    g._tapR = null;
  }

  /**
   * (Re)build the pan-tap pair for a primary/partner gain duo: each gain
   * connects to channelGains[0] via a fresh tapL and channelGains[1] via
   * a fresh tapR, weights per dronePanWeights(pan). Fresh taps per
   * call keep the function idempotent across device changes (channelGains
   * get rebuilt) and node swaps; orphaned taps GC once their gain
   * disconnects. Continuous pan moves do NOT come through here — they
   * ramp the existing taps in setVoicePan.
   */
  _wirePanTaps(gainNode, gainNodeR, pan) {
    if (!this.audioContext) return;
    const t = this.audioContext.currentTime;
    const { primary, partner } = dronePanWeights(pan);
    const wire = (g, [wL, wR]) => {
      if (!g) return;
      try { g.disconnect(); } catch { /* ignore */ }
      const tapL = this.audioContext.createGain();
      const tapR = this.audioContext.createGain();
      tapL.gain.setValueAtTime(wL, t);
      tapR.gain.setValueAtTime(wR, t);
      g.connect(tapL);
      g.connect(tapR);
      if (this.channelGains[0]) tapL.connect(this.channelGains[0]);
      if (this.channelGains[1]) tapR.connect(this.channelGains[1]);
      g._tapL = tapL;
      g._tapR = tapR;
    };
    wire(gainNode, primary);
    wire(gainNodeR, partner);
  }

  /**
   * Click-free route-swap for a SINGLE drone slot: fade the voice's
   * gains (primary + partner + partials) to 0, do the synchronous
   * disconnect/reconnect during the silence, then fade back — an
   * abrupt reroute at audible gain reads as a click. (The whole-bus
   * variant died with the mode-blind rework: a ⊙/LR flip is a pure pan
   * glide on the persistent taps now, no reroute needed.) Scoped to one
   * voice, the ~50 ms dip only ducks that slot — the rest of the bed
   * keeps sounding untouched. Used for patch-bay moves to/from
   * multichannel assignments, which genuinely need a graph swap.
   */
  _clickFreeVoiceRouteSwap(i) {
    if (!this.audioContext) return;
    if (i < 0 || i >= this.oscillatorCount) return;
    const RAMP_S = 0.025;
    const ctx = this.audioContext;
    const t = ctx.currentTime;

    const partialsNow = this.extraPartials[i] || [];
    const gains = [];
    if (this.gainNodes[i]) {
      gains.push({ node: this.gainNodes[i], target: () => this._droneTargetGain(i) });
    }
    if (this.gainNodesR[i]) {
      gains.push({ node: this.gainNodesR[i], target: () => this._dronePartnerTargetGain(i) });
    }
    for (const p of partialsNow) {
      if (p._gain) gains.push({ node: p._gain, target: () => this._partialTargetGain(p, i) });
      if (p._gainR) gains.push({ node: p._gainR, target: () => this._partialPartnerTargetGain(p, i) });
    }

    // Nothing to fade (slot has no gain nodes yet) — just reconnect.
    if (!gains.length) {
      this._connectDroneToChannels(i);
      for (const p of partialsNow) this._connectPartialToChannels(i, p);
      return;
    }

    for (const { node } of gains) {
      node.gain.cancelScheduledValues(t);
      node.gain.setValueAtTime(node.gain.value, t);
      node.gain.linearRampToValueAtTime(0, t + RAMP_S);
    }

    setTimeout(() => {
      if (!this.audioContext) return;
      const tAfter = this.audioContext.currentTime;
      this._connectDroneToChannels(i);
      for (const p of (this.extraPartials[i] || [])) this._connectPartialToChannels(i, p);
      for (const { node, target } of gains) {
        const t1 = target();
        node.gain.cancelScheduledValues(tAfter);
        node.gain.setValueAtTime(0, tAfter);
        node.gain.linearRampToValueAtTime(t1, tAfter + RAMP_S);
      }
    }, RAMP_S * 1000 + 5);
  }

  /**
   * Recompute every drone's detune offset from droneStereo.detuneCurve
   * × droneStereo.detuneHz and ramp each oscillator to its new
   * frequency. Called when either the master Hz scale or the curve
   * shape changes. Deterministic — no randomness.
   */
  _applyDroneDetuneCurve() {
    if (!this.audioContext) return;
    const t = this.audioContext.currentTime;
    for (let i = 0; i < this.oscillatorCount; i++) {
      this.droneDetuneOffsets[i] = droneStereo.nominalDetuneHzAt(i);
      if (this.oscillators[i]) {
        this.oscillators[i].frequency.setTargetAtTime(this._dronePrimaryFreq(i), t, 0.016);
      }
      if (this.oscillatorsR[i]) {
        this.oscillatorsR[i].frequency.setTargetAtTime(this._dronePartnerFreq(i), t, 0.016);
      }
      const partials = this.extraPartials[i];
      if (partials) {
        for (const p of partials) {
          if (p._osc) p._osc.frequency.setTargetAtTime(this._partialPrimaryFreq(i, p), t, 0.016);
          if (p._oscR) p._oscR.frequency.setTargetAtTime(this._partialPartnerFreq(i, p), t, 0.016);
        }
      }
    }
  }
  
  /**
   * Set oscillator count (2-10)
   */
  setOscillatorCount(count) {
    try {
      if (!this.isInitialized) {
        this.oscillatorCount = Math.max(this.minOscillators, Math.min(this.maxOscillators, count));
        return;
      }
      
      const newCount = Math.max(this.minOscillators, Math.min(this.maxOscillators, count));

      if (newCount === this.oscillatorCount) return;

      // Slot indices are about to change meaning — no traveller may land.
      this.releaseAllTravelers();

      const oldCount = this.oscillatorCount;
      
      if (newCount > oldCount) {
        // Add oscillators - update count first so arrays are in sync
        this.oscillatorCount = newCount;
        // Grow the per-pool curves to match. New slots default to 0,
        // so adding a drone doesn't surprise-detune anything.
        droneStereo.resizeCurve(newCount);
        keyboardStereo.resizeCurve(newCount);
        midiStereo.resizeCurve(newCount);

        for (let i = oldCount; i < newCount; i++) {
          // Restore the most-recently-removed slot if available; otherwise
          // generate a random pitch near an existing oscillator.
          const restored = this.removedSlots.pop();
          if (restored) {
            this.frequencyValues[i] = restored.freq;
            this.volumeValues[i] = restored.vol;
            this.preMuteVolumes[i] = restored.preMuteVol;
            // undefined pan (pre-pan save) falls through to the seed in
            // _createSingleOscillator.
            this.panValues[i] = Number.isFinite(restored.pan) ? restored.pan : undefined;
          } else {
            const randomIndex = Math.floor(Math.random() * oldCount);
            const basePitch = this.frequencyValues[randomIndex] || 60;
            const newPitch = basePitch + (Math.random() * 6 - 3);
            this.frequencyValues[i] = Math.max(0.1, newPitch);
            this.volumeValues[i] = 0.5;
            this.preMuteVolumes[i] = 0.5;
            this.panValues[i] = undefined; // seed from mode origin at create
          }
          // Added voices arrive MUTED — adding a slot never makes sound on
          // its own. Holds for a restored slot too (its remembered pitch /
          // volume / pan come back, but it waits for a deliberate unmute).
          this.mutedStates[i] = true;
          // Fresh slot starts with no extras. Existing slots' extras
          // (lower indices) are untouched.
          if (!this.extraPartials[i]) this.extraPartials[i] = [];
          this._createSingleOscillator(i, true /* withFade */);
        }
      } else {
        // Remove oscillators - capture state first so re-adding restores it.
        // Fade out over FIXED_SLOT_FADE before stopping so the removal
        // doesn't click. The osc + gain nodes stay connected during the
        // fade; we splice them out of the engine's arrays synchronously
        // so the new count is visible to the rest of the engine
        // immediately, then let the deferred osc.stop()/onended cleanup
        // disconnect the audio graph.
        const t = this.audioContext.currentTime;
        for (let i = oldCount - 1; i >= newCount; i--) {
          this.removedSlots.push({
            freq: this.frequencyValues[i],
            vol: this.volumeValues[i],
            muted: this.mutedStates[i],
            preMuteVol: this.preMuteVolumes[i],
            pan: this.panValues[i],
          });

          const osc = this.oscillators[i];
          const gainNode = this.gainNodes[i];
          const oscR = this.oscillatorsR[i];
          const gainNodeR = this.gainNodesR[i];

          try {
            const fadePair = (g) => {
              if (!g) return;
              const cur = g.gain.value;
              g.gain.cancelScheduledValues(t);
              g.gain.setValueAtTime(cur, t);
              g.gain.linearRampToValueAtTime(0, t + FIXED_SLOT_FADE);
            };
            fadePair(gainNode);
            fadePair(gainNodeR);
            const stopPair = (o, g) => {
              if (!o) return;
              o.onended = () => {
                try { o.disconnect(); } catch { /* ignore */ }
                try { g && g.disconnect(); } catch { /* ignore */ }
              };
              o.stop(t + FIXED_SLOT_FADE + 0.05);
            };
            stopPair(osc, gainNode);
            stopPair(oscR, gainNodeR);
          } catch (e) {
            console.warn('Error stopping oscillator', i, e);
          }

          // Tear down any partials living on this slot before splicing
          // the slot itself — the partials are gone for good (not pushed
          // onto removedSlots, which only restores primary state).
          const extras = this.extraPartials[i] || [];
          for (const p of extras) this._destroyPartialNodes(p);
          this.extraPartials.splice(i, 1);

          this.oscillators.splice(i, 1);
          this.gainNodes.splice(i, 1);
          this.oscillatorsR.splice(i, 1);
          this.gainNodesR.splice(i, 1);
          this.frequencyValues.splice(i, 1);
          this.volumeValues.splice(i, 1);
          this.mutedStates.splice(i, 1);
          this.preMuteVolumes.splice(i, 1);
          this.pitchLocked.splice(i, 1);
          this.droneDetuneOffsets.splice(i, 1);
          this.panValues.splice(i, 1);
          this.phases.splice(i, 1);
          this.smoothedFreqs.splice(i, 1);
          this._lastPhaseUpdate.splice(i, 1);
          this.phasesR.splice(i, 1);
          this.smoothedFreqsR.splice(i, 1);
          this._lastPhaseUpdateR.splice(i, 1);
          delete this.routingMap[i];
        }

        this.oscillatorCount = newCount;
        // Truncate the curves to match the new slot count.
        droneStereo.resizeCurve(newCount);
        keyboardStereo.resizeCurve(newCount);
        midiStereo.resizeCurve(newCount);
      }

      // Update master gain scaling to prevent clipping
      this._updateMasterGainScaling();

      // Scale length changed — let the keyboard tuning re-sort + retune
      // any held voices to whatever degree they're now pointing at.
      this._notifyFrequencyChange();
    } catch (err) {
      console.error('AudioEngine: Failed to set oscillator count', err);
    }
  }

  /**
   * Remove a single oscillator at `index` (not just the highest slot like
   * setOscillatorCount does). Fades out and stops the slot's nodes,
   * splices it out of every per-slot array, and reindexes routingMap so
   * any slots that were above `index` shift down by 1. The removed state
   * is pushed onto removedSlots so a subsequent "+ oscillator" pops it
   * back. Refuses to drop below minOscillators.
   *
   * Note: any held keyboard voice referring to a slot at or above `index`
   * would have a stale slot binding after the reindex (slot 5 played at
   * noteOn but the slot at index 5 is now what was index 6 — a different
   * pitch). Callers should release kbd voices before calling this — the
   * Mixer's remove handler does so via keyboardVoiceManager.releaseAll().
   */
  removeOscillatorAt(index) {
    try {
      if (!this.isInitialized) return;
      if (index < 0 || index >= this.oscillatorCount) return;
      if (this.oscillatorCount <= this.minOscillators) return;

      // Slot indices shift down past the removal point — strand no traveller.
      this.releaseAllTravelers();

      this.removedSlots.push({
        freq: this.frequencyValues[index],
        vol: this.volumeValues[index],
        muted: this.mutedStates[index],
        preMuteVol: this.preMuteVolumes[index],
        pan: this.panValues[index],
      });

      const t = this.audioContext.currentTime;
      const osc = this.oscillators[index];
      const gainNode = this.gainNodes[index];
      const oscR = this.oscillatorsR[index];
      const gainNodeR = this.gainNodesR[index];

      try {
        const fadePair = (g) => {
          if (!g) return;
          const cur = g.gain.value;
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(cur, t);
          g.gain.linearRampToValueAtTime(0, t + FIXED_SLOT_FADE);
        };
        fadePair(gainNode);
        fadePair(gainNodeR);
        const stopPair = (o, g) => {
          if (!o) return;
          o.onended = () => {
            try { o.disconnect(); } catch { /* ignore */ }
            try { g && g.disconnect(); } catch { /* ignore */ }
          };
          o.stop(t + FIXED_SLOT_FADE + 0.05);
        };
        stopPair(osc, gainNode);
        stopPair(oscR, gainNodeR);
      } catch (e) {
        console.warn('Error stopping oscillator', index, e);
      }

      // Same as setOscillatorCount's remove path: tear down extras for
      // the removed slot before splicing. Higher slots' extras come
      // along via the splice and stay bound to their (now-shifted) slot
      // index naturally.
      const extras = this.extraPartials[index] || [];
      for (const p of extras) this._destroyPartialNodes(p);
      this.extraPartials.splice(index, 1);

      this.oscillators.splice(index, 1);
      this.gainNodes.splice(index, 1);
      this.oscillatorsR.splice(index, 1);
      this.gainNodesR.splice(index, 1);
      this.frequencyValues.splice(index, 1);
      this.volumeValues.splice(index, 1);
      this.mutedStates.splice(index, 1);
      this.preMuteVolumes.splice(index, 1);
      this.pitchLocked.splice(index, 1);
      this.droneDetuneOffsets.splice(index, 1);
      this.panValues.splice(index, 1);
      this.phases.splice(index, 1);
      this.smoothedFreqs.splice(index, 1);
      this._lastPhaseUpdate.splice(index, 1);
      this.phasesR.splice(index, 1);
      this.smoothedFreqsR.splice(index, 1);
      this._lastPhaseUpdateR.splice(index, 1);

      // Reindex routing: drop the removed slot's entry and shift any
      // higher slot's key down by 1. Mutating in-place would risk
      // collision (slot 4 → 3 collides with the existing slot 3) so we
      // rebuild from scratch.
      const newRouting = {};
      for (const [slotStr, channels] of Object.entries(this.routingMap)) {
        const slot = Number(slotStr);
        if (slot < index) newRouting[slot] = channels;
        else if (slot > index) newRouting[slot - 1] = channels;
        // slot === index drops
      }
      this.routingMap = newRouting;

      // Same with the per-pool detune curves.
      droneStereo.removeCurveAt(index);
      keyboardStereo.removeCurveAt(index);
      midiStereo.removeCurveAt(index);

      this.oscillatorCount -= 1;

      this._updateMasterGainScaling();
      this._notifyFrequencyChange();
    } catch (err) {
      console.error('AudioEngine: Failed to remove oscillator', err);
    }
  }

  /**
   * Append a new oscillator pre-seeded with `sourceIndex`'s freq/vol/mute
   * state. Differs from setOscillatorCount(count+1) — that path either
   * pops removedSlots or picks a random pitch near an existing one,
   * neither of which is "make a copy of this slot". Refuses to grow past
   * maxOscillators.
   */
  cloneOscillator(sourceIndex) {
    try {
      if (!this.isInitialized) return;
      if (sourceIndex < 0 || sourceIndex >= this.oscillatorCount) return;
      if (this.oscillatorCount >= this.maxOscillators) return;

      const newIndex = this.oscillatorCount;
      this.frequencyValues[newIndex] = this.frequencyValues[sourceIndex];
      this.volumeValues[newIndex] = this.volumeValues[sourceIndex];
      this.mutedStates[newIndex] = this.mutedStates[sourceIndex];
      this.preMuteVolumes[newIndex] = this.preMuteVolumes[sourceIndex];
      // A clone starts free — the lock is a per-voice performance hold,
      // not part of what a voice "is".
      this.pitchLocked[newIndex] = false;
      // Cloned slot starts fresh — the source's partials don't copy
      // over. Use addPartial after clone if you want the same harmonic
      // stack on both.
      this.extraPartials[newIndex] = [];
      this.oscillatorCount = newIndex + 1;

      // Stereo curves need to grow before _createSingleOscillator reads
      // a per-slot detune for the new node.
      droneStereo.resizeCurve(this.oscillatorCount);
      keyboardStereo.resizeCurve(this.oscillatorCount);
      midiStereo.resizeCurve(this.oscillatorCount);

      this._createSingleOscillator(newIndex, true /* withFade */);
      this._updateMasterGainScaling();
      this._notifyFrequencyChange();
    } catch (err) {
      console.error('AudioEngine: Failed to clone oscillator', err);
    }
  }

  // ─── Partial APIs ──────────────────────────────────────────────────
  // partialIndex is 0-based on the slot's extras list — partial 0 is
  // the first extra, NOT the primary. The primary uses the existing
  // setFrequency / setVolume / toggleMute / removeOscillatorAt APIs.

  /** Append a new partial to `slotIndex`. Default ratio 1 (unison) and
   *  vol matching the slot's primary so the new partial is audible at
   *  the same level. Fades in over FIXED_SLOT_FADE — no click. */
  addPartial(slotIndex) {
    if (!this.isInitialized) return;
    if (slotIndex < 0 || slotIndex >= this.oscillatorCount) return;
    const list = this.extraPartials[slotIndex];
    if (!list) return;
    const primaryVol = this.volumeValues[slotIndex] ?? 0.5;
    const partial = {
      id: this._nextPartialId++,
      ratio: 1,
      vol: primaryVol,
      muted: false,
    };
    this._createPartialNodes(slotIndex, partial, true /* withFade */);
    list.push(partial);
    this._updateMasterGainScaling();
  }

  /** Tear down + drop the partial at extras index `partialIndex`. */
  removePartialAt(slotIndex, partialIndex) {
    if (!this.isInitialized) return;
    const list = this.extraPartials[slotIndex];
    if (!list || partialIndex < 0 || partialIndex >= list.length) return;
    const partial = list[partialIndex];
    this._destroyPartialNodes(partial);
    list.splice(partialIndex, 1);
    this._updateMasterGainScaling();
  }

  /** Set a partial's pitch ratio (base*ratio = sounding nominal). Ramps
   *  the live oscs over 16 ms — matches setFrequency's tau so dragging
   *  the ratio feels equivalently smooth. */
  setPartialRatio(slotIndex, partialIndex, ratio) {
    const list = this.extraPartials[slotIndex];
    if (!list || partialIndex < 0 || partialIndex >= list.length) return;
    const partial = list[partialIndex];
    const clamped = Math.max(0.001, Math.min(64, ratio));
    if (Math.abs(clamped - partial.ratio) < 1e-6) return;
    partial.ratio = clamped;
    if (!this.audioContext || !partial._osc) return;
    const t = this.audioContext.currentTime;
    partial._osc.frequency.setTargetAtTime(this._partialPrimaryFreq(slotIndex, partial), t, 0.016);
    if (partial._oscR) {
      partial._oscR.frequency.setTargetAtTime(this._partialPartnerFreq(slotIndex, partial), t, 0.016);
    }
  }

  /** Set a partial's volume (0..1). Ramps to target via setTargetAtTime
   *  like setVolume on the primary path. */
  setPartialVolume(slotIndex, partialIndex, vol) {
    const list = this.extraPartials[slotIndex];
    if (!list || partialIndex < 0 || partialIndex >= list.length) return;
    const partial = list[partialIndex];
    const clamped = Math.max(0, Math.min(1, vol));
    if (Math.abs(clamped - partial.vol) < 0.005) return;
    partial.vol = clamped;
    if (!this.audioContext || !partial._gain) return;
    if (this.audioContext.state === 'suspended') this.audioContext.resume();
    const t = this.audioContext.currentTime;
    partial._gain.gain.setTargetAtTime(this._partialTargetGain(partial, slotIndex), t, 0.016);
    if (partial._gainR) {
      partial._gainR.gain.setTargetAtTime(this._partialPartnerTargetGain(partial, slotIndex), t, 0.016);
    }
  }

  /** Toggle a partial's mute. Same ramp as setPartialVolume — gain goes
   *  to 0 on mute, back to vol*sustain on unmute. */
  togglePartialMute(slotIndex, partialIndex) {
    const list = this.extraPartials[slotIndex];
    if (!list || partialIndex < 0 || partialIndex >= list.length) return;
    const partial = list[partialIndex];
    partial.muted = !partial.muted;
    if (!this.audioContext || !partial._gain) return;
    const t = this.audioContext.currentTime;
    partial._gain.gain.setTargetAtTime(this._partialTargetGain(partial, slotIndex), t, 0.016);
    if (partial._gainR) {
      partial._gainR.gain.setTargetAtTime(this._partialPartnerTargetGain(partial, slotIndex), t, 0.016);
    }
  }

  /** Plain-object view of a slot's extras (excluding primary). Each
   *  entry carries the stable `id` (for React keys) and the position
   *  `partialIndex` (for set/remove API calls). Returns [] for an
   *  out-of-range slot, so callers can iterate without a length check. */
  getExtraPartials(slotIndex) {
    const list = this.extraPartials[slotIndex];
    if (!list) return [];
    return list.map((p, i) => ({
      id: p.id,
      partialIndex: i,
      ratio: p.ratio,
      vol: p.vol,
      muted: p.muted,
    }));
  }

  /** Read-only view of a slot's full partial list: [primary, ...extras].
   *  Primary is synthesized from the existing flat-array state — the
   *  caller (e.g. Mixer) can treat the list uniformly without branching
   *  on primary-vs-extra. */
  getPartials(slotIndex) {
    if (slotIndex < 0 || slotIndex >= this.oscillatorCount) return [];
    const primary = {
      ratio: 1,
      vol: this.volumeValues[slotIndex] ?? 0,
      muted: !!this.mutedStates[slotIndex],
      isPrimary: true,
    };
    const extras = (this.extraPartials[slotIndex] || []).map(p => ({
      ratio: p.ratio,
      vol: p.vol,
      muted: p.muted,
      isPrimary: false,
    }));
    return [primary, ...extras];
  }

  /**
   * Get current oscillator count
   */
  getOscillatorCount() {
    return this.oscillatorCount;
  }
  
  /**
   * Add routing for an oscillator to a specific output channel
   * @param {number} oscIndex - Oscillator index (0-based)
   * @param {number} outputChannel - Output channel to add
   */
  addRouting(oscIndex, outputChannel) {
    if (!this.isInitialized) return;
    if (oscIndex < 0 || oscIndex >= this.oscillatorCount) return;
    if (!this.gainNodes[oscIndex]) return;
    if (outputChannel === null || outputChannel === undefined) return;
    
    const channels = this.routingMap[oscIndex] || [];
    const newChannel = Math.max(0, Math.min(outputChannel, this.channelGains.length - 1));
    
    // Skip if already routed to this channel
    if (channels.includes(newChannel)) return;
    
    try {
      // Update routing map first; the helper consults it (and also
      // checks droneStereo.mode — in 'stereo' the audio stays on L+R
      // regardless and the routingMap update only takes effect when
      // mode flips back to 'lr').
      this.routingMap[oscIndex] = [...channels, newChannel];
      this._syncPanFromRouting(oscIndex);
      this._connectDroneToChannels(oscIndex);
      // Extras inherit the slot's routing — reconnect after the map
      // update so they stay aligned with their parent's channels.
      const partials = this.extraPartials[oscIndex];
      if (partials) {
        for (const p of partials) this._connectPartialToChannels(oscIndex, p);
      }

      // Notify listeners
      if (this.onRoutingChange) {
        this.onRoutingChange(oscIndex, this.routingMap[oscIndex]);
      }
    } catch (err) {
      console.error('AudioEngine: Failed to add routing', err);
    }
  }

  /**
   * After a discrete routing write (patch bay, URL restore, old patches),
   * pull panValues to the projection the new channel set implies so the
   * continuous dial, detune width and gain targets stay coherent with
   * the wiring. Beyond-stereo/empty sets leave pan untouched (inert).
   */
  _syncPanFromRouting(oscIndex) {
    const p = this._panFromChannels(this.routingMap[oscIndex] || []);
    if (p === null) return;
    if (Number.isFinite(this.panValues[oscIndex]) && Math.abs(this.panValues[oscIndex] - p) < 1e-3) return;
    // Full setVoicePan (minus the routing write-back) so detune width,
    // loudness lerp and partner fade follow the discrete change too.
    this.setVoicePan(oscIndex, p, { syncRouting: false });
  }
  
  /**
   * Remove routing for an oscillator from a specific output channel
   * @param {number} oscIndex - Oscillator index (0-based)
   * @param {number} outputChannel - Output channel to remove
   */
  removeRouting(oscIndex, outputChannel) {
    if (!this.isInitialized) return;
    if (oscIndex < 0 || oscIndex >= this.oscillatorCount) return;
    if (!this.gainNodes[oscIndex]) return;
    
    const channels = this.routingMap[oscIndex] || [];
    const channelIndex = channels.indexOf(outputChannel);
    
    if (channelIndex === -1) return;
    
    try {
      // Update routing map - just remove the channel, don't reassign
      const newChannels = channels.filter(ch => ch !== outputChannel);
      this.routingMap[oscIndex] = newChannels;
      this._syncPanFromRouting(oscIndex);
      // Helper handles the disconnect + reconnect per current mode.
      // In 'stereo' mode the audio stays on L+R; the map change only
      // takes effect when mode flips back to 'lr'.
      this._connectDroneToChannels(oscIndex);
      const partials = this.extraPartials[oscIndex];
      if (partials) {
        for (const p of partials) this._connectPartialToChannels(oscIndex, p);
      }

      // If no channels left in lr mode, oscillator is disconnected (silent) - that's okay

      // Notify listeners
      if (this.onRoutingChange) {
        this.onRoutingChange(oscIndex, this.routingMap[oscIndex]);
      }
    } catch (err) {
      console.error('AudioEngine: Failed to remove routing', err);
    }
  }
  
  /**
   * Clear all routings going to a specific output channel
   * @param {number} outputChannel - Output channel to clear
   */
  clearOutputChannel(outputChannel) {
    if (!this.isInitialized) return;
    
    for (let oscIndex = 0; oscIndex < this.oscillatorCount; oscIndex++) {
      const channels = this.routingMap[oscIndex] || [];
      if (channels.includes(outputChannel)) {
        this.removeRouting(oscIndex, outputChannel);
      }
    }
  }
  
  /**
   * Set routing for an oscillator (legacy - now adds to existing routings)
   * @param {number} oscIndex - Oscillator index (0-based)
   * @param {number|null} outputChannel - Output channel to add
   */
  setRouting(oscIndex, outputChannel) {
    this.addRouting(oscIndex, outputChannel);
  }

  /**
   * Set one drone's routing to an exact channel set in a single update.
   * Used by the per-voice L/R/⊙ pan toggle in the drone tray. `channels`
   * is a subset of [0, channelGains.length) — e.g. [0]=L, [1]=R, [0,1]=both.
   * Empty/invalid sets fall back to the slot's alternating default so a
   * voice can never be silenced through this control. In 'stereo' mode the
   * connect helper keeps audio on L+R regardless; the map still updates so
   * the choice takes effect when the user returns to 'lr'.
   */
  setVoiceRouting(oscIndex, channels) {
    if (!this.isInitialized) return;
    if (oscIndex < 0 || oscIndex >= this.oscillatorCount) return;
    if (!this.gainNodes[oscIndex]) return;

    const max = this.channelGains.length;
    const clean = [...new Set(channels)]
      .filter((c) => Number.isInteger(c) && c >= 0 && c < max)
      .sort((a, b) => a - b);
    this.routingMap[oscIndex] = clean.length ? clean : [oscIndex % max];
    const next = this.routingMap[oscIndex];

    try {
      const pan = this._panFromChannels(next);
      if (pan !== null) {
        // Stereo-pair routing is just a pan detent now — setVoicePan
        // ramps the tap weights, so the swap is click-free with no dip.
        this.setVoicePan(oscIndex, pan, { syncRouting: false });
      } else {
        // Multichannel target — legacy dip-and-reroute.
        this._clickFreeVoiceRouteSwap(oscIndex);
      }
      if (this.onRoutingChange) {
        this.onRoutingChange(oscIndex, next);
      }
    } catch (err) {
      console.error('AudioEngine: Failed to set voice routing', err);
    }
  }

  /**
   * Continuous per-voice pan, −1 … +1. Mode-blind: center is the detune
   * split, the extremes are hard L/R. The whole pair slides toward the
   * pan side (collapse model) while the effective detune AND the partner
   * oscillator's gain narrow with panWidth — at a full extreme the voice
   * degenerates to a single clean oscillator at its true orb frequency,
   * exactly the classic lr hard-pan. Everything here is AudioParam ramps
   * on the persistent tap/gain nodes — no graph edits, so dragging the
   * dial is click-free at any speed.
   */
  setVoicePan(oscIndex, pan, { syncRouting = true, cancelGlide = true } = {}) {
    if (oscIndex < 0) return;
    // Any direct write — a drag, a patch load, a mode reset — takes the
    // voice back from an in-flight click glide. The glide's own frames
    // pass cancelGlide:false so they don't cancel themselves.
    if (cancelGlide && this._panGlideRafs.size) this.cancelVoicePanGlide(oscIndex);
    const p = Math.max(-1, Math.min(1, Number(pan) || 0));
    this.panValues[oscIndex] = p;
    if (!this.isInitialized || !this.audioContext || oscIndex >= this.oscillatorCount) {
      this._emitPanChange(oscIndex, p);
      return;
    }

    const t = this.audioContext.currentTime;
    const TAU = 0.03;
    const channels = this.routingMap[oscIndex] || [];
    const beyondStereo = this._usesBeyondStereo(channels);

    if (!beyondStereo) {
      // 1. Image: ramp the tap weights.
      const { primary, partner } = dronePanWeights(p);
      const retap = (g, [wL, wR]) => {
        if (!g || !g._tapL || !g._tapR) return;
        g._tapL.gain.setTargetAtTime(wL, t, TAU);
        g._tapR.gain.setTargetAtTime(wR, t, TAU);
      };
      retap(this.gainNodes[oscIndex], primary);
      retap(this.gainNodesR[oscIndex], partner);
      for (const pt of this.extraPartials[oscIndex] || []) {
        retap(pt._gain, primary);
        retap(pt._gainR, partner);
      }
    }

    if (this._slotPairActive(oscIndex)) {
      // 2. Detune narrows with |pan| — glide the pair (and partials)
      // toward/away from the true orb frequency.
      if (this.oscillators[oscIndex]) {
        this.oscillators[oscIndex].frequency.setTargetAtTime(this._dronePrimaryFreq(oscIndex), t, 0.016);
      }
      if (this.oscillatorsR[oscIndex]) {
        this.oscillatorsR[oscIndex].frequency.setTargetAtTime(this._dronePartnerFreq(oscIndex), t, 0.016);
      }
      // 3. Loudness: primary lerps the equal-loudness comp (0.5 → 1),
      // partner fades out with width. Skip muted slots — their release
      // tail / silence must not be re-targeted.
      if (!this.mutedStates[oscIndex]) {
        if (this.gainNodes[oscIndex]) {
          this.gainNodes[oscIndex].gain.setTargetAtTime(this._droneTargetGain(oscIndex), t, TAU);
        }
        if (this.gainNodesR[oscIndex]) {
          this.gainNodesR[oscIndex].gain.setTargetAtTime(this._dronePartnerTargetGain(oscIndex), t, TAU);
        }
      }
      for (const pt of this.extraPartials[oscIndex] || []) {
        if (pt._osc) pt._osc.frequency.setTargetAtTime(this._partialPrimaryFreq(oscIndex, pt), t, 0.016);
        if (pt._oscR) pt._oscR.frequency.setTargetAtTime(this._partialPartnerFreq(oscIndex, pt), t, 0.016);
        if (!pt.muted) {
          if (pt._gain) pt._gain.gain.setTargetAtTime(this._partialTargetGain(pt, oscIndex), t, TAU);
          if (pt._gainR) pt._gainR.gain.setTargetAtTime(this._partialPartnerTargetGain(pt, oscIndex), t, TAU);
        }
      }
    }

    // 4. Keep the discrete projection in sync for the patch bay, LSQ
    // calibration, kbd fallback and legacy patch/URL consumers.
    if (syncRouting && !beyondStereo) {
      const proj = p <= -0.99 ? [0] : p >= 0.99 ? [1] : [0, 1];
      const changed = proj.length !== channels.length || proj.some((c, k) => channels[k] !== c);
      if (changed) {
        this.routingMap[oscIndex] = proj;
        this.onRoutingChange?.(oscIndex, proj);
      }
    }
    this._emitPanChange(oscIndex, p);
  }

  /**
   * Slide one voice's pan to `targetPan` over `durationMs` — the pan
   * sibling of glideVolumes/glideTranspose. Every frame writes through
   * setVoicePan, so the tap weights, the stereo collapse and the discrete
   * routing projection all follow exactly the path a drag takes, the
   * 30 ms tau still smooths each step, and the dial (which mirrors
   * onPanChange) sweeps along with the sound. Fired by the PanPot's
   * click-to-bounce, which borrows PERFORM's recall glide time so a tap
   * crosses the image at the same rate a recall does.
   */
  glideVoicePan(oscIndex, targetPan, durationMs = 1000, onComplete = null, easing = null) {
    if (oscIndex < 0) return;
    this.cancelVoicePanGlide(oscIndex);
    const target = Math.max(-1, Math.min(1, Number(targetPan) || 0));
    const start = Math.max(-1, Math.min(1, Number(this.panValues[oscIndex]) || 0));
    if (durationMs <= 0 || Math.abs(target - start) < 1e-4) {
      this.setVoicePan(oscIndex, target);
      if (onComplete) onComplete();
      return;
    }
    const startMs = performance.now();
    const ease = typeof easing === 'function'
      ? easing
      : (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    const step = () => {
      const t = Math.min(1, (performance.now() - startMs) / durationMs);
      const p = t >= 1 ? target : start + (target - start) * ease(t);
      this.setVoicePan(oscIndex, p, { cancelGlide: false });
      if (t >= 1) {
        this._panGlideRafs.delete(oscIndex);
        if (onComplete) onComplete();
        return;
      }
      this._panGlideRafs.set(oscIndex, requestAnimationFrame(step));
    };
    this._panGlideRafs.set(oscIndex, requestAnimationFrame(step));
  }

  /** Stop an in-flight pan glide — one voice, or all of them when called
   *  with no index. The pan keeps whatever value the last frame wrote. */
  cancelVoicePanGlide(oscIndex = null) {
    if (oscIndex == null) {
      for (const id of this._panGlideRafs.values()) cancelAnimationFrame(id);
      this._panGlideRafs.clear();
      return;
    }
    const id = this._panGlideRafs.get(oscIndex);
    if (id != null) {
      cancelAnimationFrame(id);
      this._panGlideRafs.delete(oscIndex);
    }
  }

  /**
   * Reset every drone back to its origin image for the CURRENT mode
   * preset: 'lr' → alternating hard-pan (slot i → i % channelCount),
   * 'stereo' → the center split. Fired whenever the drone stereo mode
   * is toggled — under the mode-blind engine that flip is nothing more
   * than this map rewrite plus the pan moves handed back to the caller.
   */
  resetRoutingToDefaults({ deferPan = false } = {}) {
    if (!this.isInitialized) return [];
    // With deferPan the map is rewritten but the pure-pan moves are NOT
    // applied: they're handed back so the caller can glide them home on
    // its own schedule (the ⊙/LR flip travels them over PERFORM's
    // timing). Without it the pans snap, as they always did.
    const deferred = [];
    const max = this.channelGains.length || 2;
    // Origin depends on mode: 'lr' → alternating hard-pan (slot i → i%2);
    // 'stereo' → the L/R split for every voice (channels [0,1], i.e. "both").
    const stereo = droneStereo.mode === 'stereo';
    for (let i = 0; i < this.oscillatorCount; i++) {
      const prev = this.routingMap[i] || [];
      const def = stereo ? [0, 1] : [i % max];
      const defPan = this._defaultPan(i);
      const mapChanged =
        prev.length !== def.length || def.some((c, k) => prev[k] !== c);
      const panChanged = Math.abs(this.getVoicePan(i) - defPan) > 1e-3;
      const wasBeyondStereo = this._usesBeyondStereo(prev);
      this.routingMap[i] = def;
      // Reroute only the voices that actually moved.
      if ((mapChanged || panChanged) && this.gainNodes[i]) {
        try {
          if (wasBeyondStereo || this._usesBeyondStereo(def)) {
            // Crossing to/from a multichannel assignment needs a real
            // graph swap — keep the click-free dip for that.
            this.panValues[i] = defPan;
            this._clickFreeVoiceRouteSwap(i);
            this._emitPanChange(i, defPan);
          } else if (deferPan) {
            deferred.push({ index: i, pan: defPan });
          } else {
            // Pure stereo-pair reset — glide the dial home, no dip.
            this.setVoicePan(i, defPan, { syncRouting: false });
          }
        } catch (err) {
          console.error('AudioEngine: Failed to reset routing', err);
        }
      } else if (panChanged) {
        if (deferPan) {
          deferred.push({ index: i, pan: defPan });
        } else {
          this.panValues[i] = defPan;
          this._emitPanChange(i, defPan);
        }
      }
      if (this.onRoutingChange) this.onRoutingChange(i, this.routingMap[i]);
    }
    return deferred;
  }

  /**
   * Get current routing map
   */
  getRoutingMap() {
    return { ...this.routingMap };
  }
  
  /**
   * Get max output channels available
   */
  getMaxOutputChannels() {
    if (!this.isInitialized) return 2;
    return this.outputChannelCount;
  }
  
  /**
   * Set output device
   */
  async setOutputDevice(deviceId) {
    if (!this.isInitialized) {
      this.currentDeviceId = deviceId;
      return;
    }
    
    if (typeof this.audioContext.setSinkId === 'function') {
      try {
        await this.audioContext.setSinkId(deviceId);
        this.currentDeviceId = deviceId;
        
        // Update channel count after device change
        const newChannelCount = this.audioContext.destination.maxChannelCount || 2;
        console.log('New device channel count:', newChannelCount);
        
        if (newChannelCount !== this.outputChannelCount) {
          this.outputChannelCount = newChannelCount;
          this._rebuildChannelRouting();
        }
      } catch (err) {
        console.error('Failed to set output device:', err);
      }
    } else {
      console.warn('setSinkId not supported in this browser');
    }
  }
  
  /**
   * Rebuild channel routing for new channel count
   */
  _rebuildChannelRouting() {
    if (!this.isInitialized) return;
    
    console.log('Rebuilding channel routing for', this.outputChannelCount, 'channels');
    
    // Disconnect all oscillator gain nodes from current channel gains
    for (let i = 0; i < this.gainNodes.length; i++) {
      if (this.gainNodes[i]) {
        try { this.gainNodes[i].disconnect(); } catch { /* ignore */ }
      }
      if (this.gainNodesR[i]) {
        try { this.gainNodesR[i].disconnect(); } catch { /* ignore */ }
      }
    }
    
    // Disconnect old channel gains from merger
    for (const channelGain of this.channelGains) {
      try {
        channelGain.disconnect();
      } catch (e) {
        // Ignore
      }
    }
    
    // Disconnect old merger
    if (this.stereoMerger) {
      try {
        this.stereoMerger.disconnect();
      } catch (e) {
        // Ignore
      }
    }
    
    // Create new channel gains for all output channels (but we still visualize as stereo)
    // Channels 0,2,4... go to left visualizer, 1,3,5... go to right visualizer
    const numChannels = Math.min(this.outputChannelCount, 32); // Reasonable limit
    
    // Create new channel gains
    this.channelGains = [];
    for (let i = 0; i < numChannels; i++) {
      this.channelGains.push(this.audioContext.createGain());
    }
    
    // Create new merger with correct channel count
    this.stereoMerger = this.audioContext.createChannelMerger(numChannels);
    
    // Connect channel gains to merger
    for (let i = 0; i < numChannels; i++) {
      this.channelGains[i].connect(this.stereoMerger, 0, i);
    }
    
    // Reconnect through the drone bus chain so droneBusGain
    // (spacebar/drone-pause) and droneFoldShaper stay in the path
    // after a device change. Connecting directly to masterGainNode
    // here would silently bypass both — see waveshaping.md.
    this.stereoMerger.connect(this.droneBusGain);

    // Re-setup default routing for current oscillators
    this._setupDefaultRouting();
    
    // Reconnect all oscillator gain nodes to their channel gains via the
    // mode-aware helper so 'stereo' mode survives a device change.
    for (let i = 0; i < this.gainNodes.length; i++) {
      if (!this.gainNodes[i]) continue;
      if (!this.routingMap[i] || this.routingMap[i].length === 0) {
        this.routingMap[i] = this._defaultRouting(i);
      }
      this._connectDroneToChannels(i);
      // Extras share the slot's routing — reconnect alongside.
      const partials = this.extraPartials[i];
      if (partials) {
        for (const p of partials) this._connectPartialToChannels(i, p);
      }
    }
    
    console.log('Channel routing rebuilt for', numChannels, 'channels');
  }
  
  /**
   * Get available audio output devices
   */
  async getAudioOutputDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter(d => d.kind === 'audiooutput');
    } catch (err) {
      console.error('Failed to enumerate devices:', err);
      return [];
    }
  }
  
  /**
   * Set frequency for a specific oscillator.
   *
   * `opts.force` overrides the slot's PITCH LOCK — pass it from the
   * slot's own editor (the frequency panel / tuning menu commit paths)
   * and from whole-state restores (patch apply, undo). Everything else
   * — orb drags, dice, generative, root-follow, transpose — leaves the
   * call unforced so a locked voice holds its pitch.
   */
  setFrequency(index, frequency, { force = false } = {}) {
    if (!this.isInitialized || index < 0 || index >= this.oscillatorCount) return;
    if (!this.oscillators[index]) return;
    if (!force && this.pitchLocked[index]) return;

    const clampedFreq = Math.max(0.001, Math.min(FREQ_CEIL, frequency));
    
    if (Math.abs(clampedFreq - this.frequencyValues[index]) < 0.01) return;
    
    this.frequencyValues[index] = clampedFreq;

    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    const t = this.audioContext.currentTime;
    this.oscillators[index].frequency.setTargetAtTime(this._dronePrimaryFreq(index), t, 0.016);
    if (this.oscillatorsR[index]) {
      this.oscillatorsR[index].frequency.setTargetAtTime(this._dronePartnerFreq(index), t, 0.016);
    }
    // Each partial's nominal freq is base*ratio — retune alongside.
    const partials = this.extraPartials[index];
    if (partials) {
      for (const p of partials) {
        if (p._osc) p._osc.frequency.setTargetAtTime(this._partialPrimaryFreq(index, p), t, 0.016);
        if (p._oscR) p._oscR.frequency.setTargetAtTime(this._partialPartnerFreq(index, p), t, 0.016);
      }
    }

    this._notifyFrequencyChange();
  }

  /**
   * Set volume for a specific oscillator (0-1 range). For un-muted
   * slots, the audio target is volume × droneEnvelope.sustain — so the
   * slider acts as the slot's "peak amplitude" while the envelope's
   * sustain knob decides what fraction of that holds at steady state.
   */
  setVolume(index, volume) {
    if (!this.isInitialized || index < 0 || index >= this.oscillatorCount) return;
    if (!this.gainNodes[index]) return;

    const clampedVol = Math.max(0, Math.min(1, volume));

    if (Math.abs(clampedVol - this.volumeValues[index]) < 0.005) return;

    this.volumeValues[index] = clampedVol;

    if (this.mutedStates[index]) {
      this.preMuteVolumes[index] = clampedVol;
      // Notify so observers (FrequencyManager's undo snapshotter, the
      // parameter-lock scope) see the level change even while muted.
      this._notifyFrequencyChange();
      return;
    }

    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    const t = this.audioContext.currentTime;
    const target = clampedVol * droneEnvelope.sustain * this._slotLoudnessScale(index);
    this.gainNodes[index].gain.setTargetAtTime(target, t, 0.016);
    if (this.gainNodesR[index]) {
      this.gainNodesR[index].gain.setTargetAtTime(this._dronePartnerTargetGain(index), t, 0.016);
    }
    // Volume is a parameter-lock dimension — notify so undo/recall observers
    // record it. (setFrequency and the mute toggles already notify; setVolume
    // historically did not.)
    this._notifyFrequencyChange();
  }
  
  /**
   * Apply frequencies to every oscillator in one pass, scheduling every
   * AudioParam change at the same currentTime so the relative offsets between
   * oscillators stay exactly preserved (critical for beat-preserving drags).
   */
  setAllFrequenciesBatch(frequencies, { force = false } = {}) {
    if (!this.isInitialized) return;
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    const t = this.audioContext.currentTime;
    const count = Math.min(frequencies.length, this.oscillatorCount);
    let changed = false;
    for (let i = 0; i < count; i++) {
      if (!this.oscillators[i]) continue;
      // Same pitch-lock rule as setFrequency, per slot: a locked voice
      // sits out the batch while its neighbours still move together.
      if (!force && this.pitchLocked[i]) continue;
      const clampedFreq = Math.max(0.001, Math.min(FREQ_CEIL, frequencies[i]));
      if (Math.abs(clampedFreq - this.frequencyValues[i]) < 0.01) continue;
      this.frequencyValues[i] = clampedFreq;
      this.oscillators[i].frequency.setTargetAtTime(this._dronePrimaryFreq(i), t, 0.016);
      if (this.oscillatorsR[i]) {
        this.oscillatorsR[i].frequency.setTargetAtTime(this._dronePartnerFreq(i), t, 0.016);
      }
      changed = true;
    }
    if (changed) this._notifyFrequencyChange();
  }

  /**
   * Batch volume update sibling of setAllFrequenciesBatch — single currentTime
   * read so relative volume ratios can't drift during a global drag.
   * Volumes are on the 0-1 scale.
   */
  setAllVolumesBatch(volumes) {
    if (!this.isInitialized) return;
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    const t = this.audioContext.currentTime;
    const sustain = droneEnvelope.sustain;
    const count = Math.min(volumes.length, this.oscillatorCount);
    for (let i = 0; i < count; i++) {
      if (!this.gainNodes[i]) continue;
      const clampedVol = Math.max(0, Math.min(1, volumes[i]));
      if (Math.abs(clampedVol - this.volumeValues[i]) < 0.005) continue;
      this.volumeValues[i] = clampedVol;
      if (this.mutedStates[i]) {
        this.preMuteVolumes[i] = clampedVol;
        continue;
      }
      const target = clampedVol * sustain * this._slotLoudnessScale(i);
      this.gainNodes[i].gain.setTargetAtTime(target, t, 0.016);
      if (this.gainNodesR[i]) {
        this.gainNodesR[i].gain.setTargetAtTime(this._dronePartnerTargetGain(i), t, 0.016);
      }
    }
  }

  /**
   * Compute per-oscillator target frequencies that snap each non-fundamental
   * oscillator to the nearest candidate in the chosen tuning system, relative
   * to the anchor slot (or lowest un-muted osc as fallback). Octave-preserving
   * for octave-reducing systems; absolute for the harmonic series. Pure
   * function — returns targets without touching audio state.
   *
   * @param {number} varianceHz  Random ±Hz detune added per osc after snapping
   *                             (matches iOS alignVariance). 0 = pure JI.
   */
  computeJustIntonationTargets(varianceHz = 0, opts = {}) {
    const out = this.frequencyValues.slice();
    const { systemKey = DEFAULT_SYSTEM, anchorSlot = null } = opts;
    const sys = getSystem(systemKey);
    const candidates = getCandidates(systemKey);
    if (!candidates || candidates.length === 0) return out;

    // Fundamental: explicit anchorSlot if provided (FrequencyManager's
    // 1/1 reference). Otherwise fall back to lowest un-muted, then
    // lowest overall — keeps the button useful when called without
    // anchor context (e.g. legacy code paths).
    let fundamentalIdx = -1;
    if (anchorSlot != null && anchorSlot >= 0 && anchorSlot < this.oscillatorCount
        && this.frequencyValues[anchorSlot] > 0 && !this.mutedStates[anchorSlot]) {
      fundamentalIdx = anchorSlot;
    } else {
      let lowest = Infinity;
      for (let i = 0; i < this.oscillatorCount; i++) {
        if (this.mutedStates[i]) continue;
        if (this.frequencyValues[i] < lowest) { lowest = this.frequencyValues[i]; fundamentalIdx = i; }
      }
      if (fundamentalIdx === -1) {
        for (let i = 0; i < this.oscillatorCount; i++) {
          if (this.frequencyValues[i] < lowest) { lowest = this.frequencyValues[i]; fundamentalIdx = i; }
        }
      }
    }
    const fundamentalFreq = fundamentalIdx >= 0 ? this.frequencyValues[fundamentalIdx] : 0;
    if (!(fundamentalFreq > 0)) return out;

    for (let i = 0; i < this.oscillatorCount; i++) {
      if (i === fundamentalIdx) continue;
      const f = this.frequencyValues[i];
      if (f <= 0) continue;
      const inputCents = 1200 * Math.log2(f / fundamentalFreq);

      let targetCents;
      if (sys.octaveReduced) {
        // Nearest candidate within the current octave, preserving the
        // octave the osc lives in. Duplicate collapses (two oscs on the
        // same pitch) are allowed — if the inputs were already near
        // each other, stacking is the natural result.
        const octave = Math.floor(inputCents / 1200);
        const reducedCents = inputCents - octave * 1200;
        let bestCents = candidates[0].cents;
        let bestDist = Math.abs(bestCents - reducedCents);
        for (let j = 1; j < candidates.length; j++) {
          const d = Math.abs(candidates[j].cents - reducedCents);
          if (d < bestDist) { bestDist = d; bestCents = candidates[j].cents; }
        }
        const wrapDist = Math.abs(1200 - reducedCents);
        let octAdj = 0;
        if (wrapDist < bestDist) { bestCents = 0; octAdj = 1; }
        targetCents = bestCents + (octave + octAdj) * 1200;
      } else {
        // Harmonic series — snap to nearest absolute candidate, no
        // octave shift.
        let bestCents = candidates[0].cents;
        let bestDist = Math.abs(bestCents - inputCents);
        for (let j = 1; j < candidates.length; j++) {
          const d = Math.abs(candidates[j].cents - inputCents);
          if (d < bestDist) { bestDist = d; bestCents = candidates[j].cents; }
        }
        targetCents = bestCents;
      }

      let target = fundamentalFreq * Math.pow(2, targetCents / 1200);
      if (varianceHz > 0) target += (Math.random() * 2 - 1) * varianceHz;
      out[i] = Math.max(0.001, Math.min(FREQ_CEIL, target));
    }
    return out;
  }

  /**
   * Compute per-oscillator target frequencies that lay out the voices as
   * the chosen tuning system's scale, RE-ROOTED on the anchor voice.
   *
   * Voices are never reordered: voice #(slot+1) keeps its fixed keyboard
   * note (slot 0 = C, …). The anchor slot is the JI 1/1 (its Hz is kept);
   * every other slot is tuned to the system's ratio for its semitone
   * distance from the anchor, octave-placed in its natural register. So
   * rooting on the A voice tunes the whole scale to be just-intonation
   * consonant around A while C still plays a (comma-shifted) C. 12-TET is
   * rotation-invariant, so re-rooting it only pins the anchor.
   *
   * Used by the Load button — distinct from Align: Align preserves the
   * rough shape of the current tuning by snapping each voice to its
   * *nearest* candidate; Load rewrites the shape to the system's scale.
   *
   * @param {Object} opts
   * @param {string} opts.systemKey   Tuning system key (e.g. '5-limit')
   * @param {number} opts.anchorSlot  Slot whose Hz is treated as 1/1
   * @param {number} [opts.scaleSize] 7 (diatonic) or 12 (chromatic);
   *                                  defaults to the system's recommended.
   */
  computeLoadTargets(opts = {}) {
    const out = this.frequencyValues.slice();
    const { systemKey = DEFAULT_SYSTEM, anchorSlot = 0, scaleSize } = opts;
    const sys = getSystem(systemKey);
    if (!sys) return out;
    const size = scaleSize === 7 || scaleSize === 12
      ? scaleSize
      : (sys.recommendedScale) || 7;

    const anchorHz = (anchorSlot >= 0 && anchorSlot < this.oscillatorCount)
      ? this.frequencyValues[anchorSlot]
      : 0;
    if (!(anchorHz > 0)) return out;

    // Voices are NEVER reordered: voice #(slot+1) is a fixed keyboard note.
    // Slot 0 = C; the semitone for each slot follows the key-mapping the
    // chosen scale size implies — chromatic (size 12) walks every semitone,
    // white-only (size 7) walks the white-key offsets, wrapping by octave.
    const WHITE = [0, 2, 4, 5, 7, 9, 11];
    const semitoneForSlot = (slot) => (size === 7
      ? WHITE[slot % 7] + 12 * Math.floor(slot / 7)
      : slot);

    // Non-octave-reduced systems (harmonic series) have no 12-tone frame to
    // root against — keep the anchor as the fundamental (1/1) and climb the
    // overtones in slot order. Still no reshuffle.
    if (!sys.octaveReduced) {
      for (let slot = 0; slot < this.oscillatorCount; slot++) {
        if (slot === anchorSlot) { out[slot] = anchorHz; continue; }
        const ratio = canonicalRatioForVoice(systemKey, slot, size);
        if (ratio != null) out[slot] = Math.max(0.001, Math.min(FREQ_CEIL, anchorHz * ratio));
      }
      return out;
    }

    // Octave-reduced systems: RE-ROOT the scale on the anchor voice. Each
    // slot's pitch is the system's JI ratio for its SEMITONE distance from
    // the root, octave-placed nearest its 12-TET position so note letters
    // and register are preserved — C stays a C, only comma-shifted, never a
    // C#. The anchor itself is exactly 1/1 (its Hz is kept). Because we
    // index by semitone (not diatonic degree), this is letter-correct for
    // both chromatic and white-key loads. For 12-TET the ratios are
    // equal-tempered, so re-rooting only pins the anchor and leaves the
    // other pitches put.
    const semiRoot = semitoneForSlot(anchorSlot);
    for (let slot = 0; slot < this.oscillatorCount; slot++) {
      const semi = semitoneForSlot(slot);
      const dist = (((semi - semiRoot) % 12) + 12) % 12; // semitones above root, 0..11
      const ratio = canonicalRatioForVoice(systemKey, dist, 12); // in [1, 2)
      if (ratio == null) continue;
      const raw = anchorHz * ratio;
      // 12-TET reference position for this slot relative to the root; pick
      // the octave of `raw` closest to it so the voice lands in its natural
      // register (notes below the root drop an octave, etc.).
      const ref = anchorHz * Math.pow(2, (semi - semiRoot) / 12);
      const k = Math.round(Math.log2(ref / raw));
      out[slot] = Math.max(0.001, Math.min(FREQ_CEIL, raw * Math.pow(2, k)));
    }
    return out;
  }

  /**
   * Smoothly glide every oscillator's frequency to the provided targets over
   * durationMs. Uses a requestAnimationFrame tween in log2 space so the glide
   * sounds uniformly-paced musically (1 octave per equal slice of time) rather
   * than rushing through the upper registers. Cancels any prior glide so
   * back-to-back tunes behave predictably. Each frame writes via
   * setAllFrequenciesBatch so existing UI pollers pick up the motion for free.
   *
   * @param {number[]} targets       Per-osc target frequencies (Hz)
   * @param {number}   durationMs    Glide length in ms. 0 = instant.
   * @param {Function} [onComplete]  Invoked when the glide finishes or is cancelled.
   */
  glideToFrequencies(targets, durationMs = 1000, onComplete = null, easing = null,
    { force = false } = {}) {
    if (!this.isInitialized) return;
    if (this._glideRaf != null) {
      cancelAnimationFrame(this._glideRaf);
      this._glideRaf = null;
    }
    const count = Math.min(targets.length, this.oscillatorCount);
    const starts = this.frequencyValues.slice(0, count);
    const safeTargets = new Array(count);
    for (let i = 0; i < count; i++) {
      safeTargets[i] = Math.max(0.001, Math.min(FREQ_CEIL, targets[i]));
    }

    if (durationMs <= 0) {
      this.setAllFrequenciesBatch(safeTargets, { force });
      if (onComplete) onComplete();
      return;
    }

    const logStarts = starts.map((f) => Math.log2(Math.max(0.001, f)));
    const logTargets = safeTargets.map((f) => Math.log2(f));
    const startMs = performance.now();
    // Caller may supply an easing function t∈[0,1]→[0,1] (e.g. the
    // recall-curve selector in the tuning panel). Default: the historical
    // smooth ease-in-out cubic — slow departure, fast middle, slow landing.
    const ease = typeof easing === 'function'
      ? easing
      : (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    const step = () => {
      const elapsed = performance.now() - startMs;
      const t = Math.min(1, elapsed / durationMs);
      const k = ease(t);
      const frame = new Array(count);
      for (let i = 0; i < count; i++) {
        frame[i] = Math.pow(2, logStarts[i] + (logTargets[i] - logStarts[i]) * k);
      }
      this.setAllFrequenciesBatch(frame, { force });
      if (t >= 1) {
        this._glideRaf = null;
        if (onComplete) onComplete();
        return;
      }
      this._glideRaf = requestAnimationFrame(step);
    };
    this._glideRaf = requestAnimationFrame(step);
  }

  /**
   * Cancel any in-flight frequency glide without snapping to the final target.
   * Called when the user starts another interaction that conflicts with the
   * tween (e.g. dragging the "all" orb or a per-osc dot).
   */
  cancelFrequencyGlide() {
    if (this._glideRaf != null) {
      cancelAnimationFrame(this._glideRaf);
      this._glideRaf = null;
    }
  }

  /**
   * True while a frequency glide (Align / Load / save-state recall) is in
   * flight. The glide writes every voice's target each frame, so listeners
   * that would otherwise re-derive or re-propagate per-voice state (e.g.
   * FrequencyManager's follow-root transpose) can skip their work and let
   * the glide own the motion — avoids an O(N) listener storm per frame.
   */
  get isGliding() {
    return this._glideRaf != null;
  }

  /**
   * Smoothly tween every oscillator's volume from its current value to a
   * per-osc target over `durationMs`, in linear space (0-1 scale). Same
   * ease curve as glideToFrequencies so a parallel freq+vol glide moves
   * in lockstep — used by the patch "return" button so a revert sounds
   * like a slide back rather than a fade-out / fade-in. Cancels any
   * previous in-flight volume glide.
   */
  glideVolumes(targets, durationMs = 1000, onComplete = null) {
    if (!this.isInitialized) return;
    if (this._volGlideRaf != null) {
      cancelAnimationFrame(this._volGlideRaf);
      this._volGlideRaf = null;
    }
    const count = Math.min(targets.length, this.oscillatorCount);
    const starts = this.volumeValues.slice(0, count);
    const safeTargets = new Array(count);
    for (let i = 0; i < count; i++) {
      safeTargets[i] = Math.max(0, Math.min(1, targets[i]));
    }

    if (durationMs <= 0) {
      this.setAllVolumesBatch(safeTargets);
      if (onComplete) onComplete();
      return;
    }

    const startMs = performance.now();
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    const step = () => {
      const elapsed = performance.now() - startMs;
      const t = Math.min(1, elapsed / durationMs);
      const k = ease(t);
      const frame = new Array(count);
      for (let i = 0; i < count; i++) {
        frame[i] = starts[i] + (safeTargets[i] - starts[i]) * k;
      }
      this.setAllVolumesBatch(frame);
      if (t >= 1) {
        this._volGlideRaf = null;
        if (onComplete) onComplete();
        return;
      }
      this._volGlideRaf = requestAnimationFrame(step);
    };
    this._volGlideRaf = requestAnimationFrame(step);
  }

  cancelVolumeGlide() {
    if (this._volGlideRaf != null) {
      cancelAnimationFrame(this._volGlideRaf);
      this._volGlideRaf = null;
    }
  }

  /**
   * Smoothly slide the global transpose to a target semitone offset over
   * `durationMs` — the transpose sibling of glideToFrequencies/glideVolumes,
   * so a scoped recall/undo can lerp the master pitch offset alongside the
   * per-voice params. Each frame writes through setTransposeSemitones, so
   * clamping applies as usual and, with snap on, the slide lands stepwise on
   * whole semitones. Persistence is deferred to the final frame so a slide
   * doesn't thrash localStorage.
   */
  glideTranspose(targetSemitones, durationMs = 1000, onComplete = null, easing = null) {
    if (this._transposeGlideRaf != null) {
      cancelAnimationFrame(this._transposeGlideRaf);
      this._transposeGlideRaf = null;
    }
    let target = Number(targetSemitones) || 0;
    target = Math.max(-TRANSPOSE_MAX_SEMITONES,
      Math.min(TRANSPOSE_MAX_SEMITONES, target));
    const start = this._transposeSemitones;
    if (durationMs <= 0 || Math.abs(target - start) < 1e-6) {
      this.setTransposeSemitones(target);
      if (onComplete) onComplete();
      return;
    }
    const startMs = performance.now();
    const ease = typeof easing === 'function'
      ? easing
      : (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    const step = () => {
      const elapsed = performance.now() - startMs;
      const t = Math.min(1, elapsed / durationMs);
      const k = ease(t);
      this.setTransposeSemitones(start + (target - start) * k, { persist: t >= 1 });
      if (t >= 1) {
        this._transposeGlideRaf = null;
        if (onComplete) onComplete();
        return;
      }
      this._transposeGlideRaf = requestAnimationFrame(step);
    };
    this._transposeGlideRaf = requestAnimationFrame(step);
  }

  cancelTransposeGlide() {
    if (this._transposeGlideRaf != null) {
      cancelAnimationFrame(this._transposeGlideRaf);
      this._transposeGlideRaf = null;
    }
  }

  // ─── Step transition (retrigger instead of glide) ──────────────────────
  /**
   * Jump a slot to a new pitch by REPLACING its oscillator pair rather than
   * bending it — the "step" counterpart to the glide tween.
   *
   * A fresh primary+partner pair starts at the target pitch with a
   * drone-envelope attack. The slot's references swap to the new nodes
   * immediately, so every per-slot API (setFrequency/setVolume/mute/routing)
   * acts on the new voice from the first frame. The OLD pair becomes an
   * unowned tail: it holds its level through the overlap window, releases
   * per the drone envelope, then stops and disconnects itself. During the
   * overlap both notes sound at once.
   *
   * All 12 slots can step simultaneously — each step transiently doubles
   * that slot's oscillator count (2 → 4 including stereo partners), so a
   * full-board step peaks at 48 short-lived oscillators, well within what
   * Web Audio handles comfortably.
   *
   * Partials (extraPartials) are retuned instantly rather than crossfaded —
   * the primary retrigger carries the step gesture.
   *
   * @param {number} index      Slot to step
   * @param {number} frequency  Target Hz
   * @param {number} overlapMs  How long old + new sound together. 0 = handoff.
   * @returns {boolean} true if the step was applied
   */
  stepToFrequency(index, frequency, overlapMs = 0) {
    if (!this.isInitialized || index < 0 || index >= this.oscillatorCount) return false;
    if (!this.audioContext) return false;
    const oldOsc = this.oscillators[index];
    const oldGain = this.gainNodes[index];
    const oldOscR = this.oscillatorsR[index];
    const oldGainR = this.gainNodesR[index];
    if (!oldOsc || !oldGain) return false;

    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    const clampedFreq = Math.max(0.001, Math.min(FREQ_CEIL, frequency));
    const overlapSec = Math.max(0, overlapMs) / 1000;
    const t = this.audioContext.currentTime;

    // MIDI bookkeeping: the outgoing note becomes a tail for the overlap
    // window, and the generation bump re-keys the slot's request id so the
    // MPE reconciler retriggers. Muted slots weren't sounding over MIDI, so
    // they leave no tail.
    const prevFreq = this.frequencyValues[index];
    const prevGen = this.slotGenerations[index] || 0;
    // The OLD note's wire id (which may be an adopted traveller id) rides
    // out on the tail; the bumped generation keys the fresh note.
    const prevWireId = this.getSlotWireId(index);
    this.slotGenerations[index] = prevGen + 1;
    this._wireAliases.delete(index);
    this._pruneStepTails();
    if (!this.mutedStates[index] && Number.isFinite(prevFreq) && prevFreq > 0) {
      const nowMs = performance.now();
      this._stepTails.push({
        slot: index,
        gen: prevGen,
        wireId: prevWireId,
        freq: prevFreq,
        level: this.volumeValues[index] ?? 0.5,
        startMs: nowMs,                          // viz: descent progress origin
        until: nowMs + Math.max(0, overlapMs),
      });
    }

    // Commit the pitch first so the freq/gain helpers below read the target.
    this.frequencyValues[index] = clampedFreq;

    // Fresh replacement pair — mirrors _createSingleOscillator.
    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();
    const oscillatorR = this.audioContext.createOscillator();
    const gainNodeR = this.audioContext.createGain();

    const wave = droneWave.getPeriodicWave(this.audioContext);
    if (wave) {
      oscillator.setPeriodicWave(wave);
      oscillatorR.setPeriodicWave(wave);
    }

    oscillator.connect(gainNode);
    oscillatorR.connect(gainNodeR);

    // Swap the slot's references BEFORE wiring so _connectDroneToChannels
    // connects the NEW pair. The old pair keeps its channel connections for
    // the tail — disconnect() there only ever severs the node it's called
    // on, and we never call it on the old nodes until their osc ends.
    this.oscillators[index] = oscillator;
    this.gainNodes[index] = gainNode;
    this.oscillatorsR[index] = oscillatorR;
    this.gainNodesR[index] = gainNodeR;
    this._connectDroneToChannels(index);

    oscillator.frequency.setValueAtTime(this._dronePrimaryFreq(index), t);
    oscillatorR.frequency.setValueAtTime(this._dronePartnerFreq(index), t);

    // Fresh attack on the new voice. Peak is the slider level (vol ×
    // loudness comp); applyNoteOn's decay then settles on peak·sustain,
    // which equals the steady-state target used at every other gain site.
    //
    // The attack is capped at the total handoff window (overlap + release):
    // a drone attack LONGER than that would leave a hole — the old voice
    // reaches silence while the new one is still swelling in, which reads
    // as the audio pausing on every step. Capping keeps the crossfade
    // continuous; attacks that already fit are respected verbatim.
    const peak = this.mutedStates[index]
      ? 0
      : (this.volumeValues[index] ?? 0.5) * this._slotLoudnessScale(index);
    const attackCap = Math.max(0.02, overlapSec + droneEnvelope.release);
    const stepAttack = droneEnvelope.attack > attackCap ? attackCap : null;
    droneEnvelope.applyNoteOn(gainNode.gain, this.audioContext, peak, stepAttack);
    if (this._slotPairActive(index)) {
      // Partner fades with panWidth — silent at the pan extremes.
      droneEnvelope.applyNoteOn(gainNodeR.gain, this.audioContext,
        peak * panWidth(this.getVoicePan(index)), stepAttack);
    } else {
      gainNodeR.gain.setValueAtTime(0, t);
    }

    oscillator.start();
    oscillatorR.start();

    // Reseed the visual phase accumulators for the new pair.
    this.phases[index] = 0;
    this.smoothedFreqs[index] = this._dronePrimaryFreq(index);
    this._lastPhaseUpdate[index] = t;
    this.phasesR[index] = 0;
    this.smoothedFreqsR[index] = this._dronePartnerFreq(index);
    this._lastPhaseUpdateR[index] = t;

    // Old pair: hold at its current level through the overlap window, then
    // release per the drone envelope, then stop + disconnect itself.
    const releaseAt = t + overlapSec;
    const stopAt = releaseAt + droneEnvelope.release + 0.05;
    const tailPair = (o, g) => {
      if (!o) return;
      try {
        if (g) {
          const cur = g.gain.value;
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(cur, t);
          g.gain.setValueAtTime(cur, releaseAt);
          g.gain.linearRampToValueAtTime(0, releaseAt + droneEnvelope.release);
        }
        o.onended = () => {
          try { o.disconnect(); } catch { /* ignore */ }
          try { g && g.disconnect(); } catch { /* ignore */ }
        };
        o.stop(stopAt);
      } catch (e) {
        console.warn('Error stopping stepped oscillator', index, e);
      }
    };
    tailPair(oldOsc, oldGain);
    tailPair(oldOscR, oldGainR);

    // Partials follow the new pitch instantly (16 ms smoothing).
    const partials = this.extraPartials[index];
    if (partials) {
      for (const p of partials) {
        if (p._osc) p._osc.frequency.setTargetAtTime(this._partialPrimaryFreq(index, p), t, 0.016);
        if (p._oscR) p._oscR.frequency.setTargetAtTime(this._partialPartnerFreq(index, p), t, 0.016);
      }
    }

    this._notifyFrequencyChange();
    return true;
  }

  /** Drop step tails whose overlap window has passed. */
  _pruneStepTails(nowMs = performance.now()) {
    if (this._stepTails.length === 0) return;
    // Keep records a grace period past their audible window: the spectrum
    // bar plays a post-landing hop animation off the expired tail. Audible
    // consumers (MIDI, waterfall) read getStepTails, which re-filters to
    // the live window.
    this._stepTails = this._stepTails.filter(
      (tail) => tail.until + AudioEngine.STEP_TAIL_VIZ_GRACE_MS > nowMs
    );
  }

  /** Live step tails (old notes still inside their overlap window). */
  getStepTails() {
    this._pruneStepTails();
    const now = performance.now();
    return this._stepTails.filter((tail) => tail.until > now);
  }

  /**
   * All step-tail records including just-expired ones (up to the viz grace
   * period past their window) — the spectrum bar reads these to run the
   * descent AND the post-landing hop, including for 0 ms handoffs whose
   * audible window never spans a frame.
   */
  getStepTailsViz() {
    this._pruneStepTails();
    return this._stepTails;
  }

  /** Retrigger generation for a slot — folded into MIDI request ids. */
  getSlotGeneration(index) {
    return this.slotGenerations[index] || 0;
  }

  /**
   * Stable wire id for a slot's outgoing MPE voice. Usually derived from
   * slot + step generation; a slot that adopted a travelling voice answers
   * with the traveller's inherited id instead (see _wireAliases), so the
   * external synth hears the travel as one bending note, not off+on.
   */
  getSlotWireId(index) {
    return this._wireAliases.get(index)
      || `drone:${index}:g${this.slotGenerations[index] || 0}`;
  }

  // ─── Travelling voices (cross-slot voice-leading) ─────────────────────
  // A travel is: detachTravelVoice(i) → [tween setTravelerFrequency] →
  // landTravelVoice(id, j)  (or releaseTravelVoice(id) for a merge/exit).
  // The note itself never restarts — the same oscillator pair keeps running
  // through detach, flight and adoption, so the gliss is phase-continuous.

  /**
   * Detach slot `index`'s sounding node pair into a free-floating traveller
   * and give the slot a fresh SILENT pair (the slot reads as muted from this
   * moment — its bookkeeping settles at departure, not arrival, so chained
   * travels through the same slot can't collide). Returns the traveller id,
   * or null if the slot isn't audible. The caller owns retuning the vacated
   * slot to wherever it should silently sit.
   */
  detachTravelVoice(index) {
    if (!this.isInitialized || index < 0 || index >= this.oscillatorCount) return null;
    if (!this.audioContext || this.mutedStates[index]) return null;
    const osc = this.oscillators[index];
    const gain = this.gainNodes[index];
    if (!osc || !gain) return null;

    this._travelerSeq += 1;
    const id = this._travelerSeq;
    this._travelers.set(id, {
      id,
      fromIndex: index,
      osc,
      gain,
      oscR: this.oscillatorsR[index],
      gainR: this.gainNodesR[index],
      nominalHz: this.frequencyValues[index],
      offset: this.droneDetuneOffsets[index] || 0,
      pan: this.getVoicePan(index),
      channels: (this.routingMap[index] || []).slice(),
      level: this.volumeValues[index] ?? 0.5,
      // The traveller INHERITS the slot's wire id: over MIDI the departure
      // is NOT a note-off — the same wire voice keeps sounding and its
      // pitch bends through the flight (MidiOutput requests travellers by
      // this id). The landing slot inherits it back in landTravelVoice.
      wireId: this.getSlotWireId(index),
    });

    // The slot goes muted NOW; its wire id travels with the detached voice,
    // so the next note this slot sounds on its own is a fresh one.
    this.mutedStates[index] = true;
    this._wireAliases.delete(index);
    this.preMuteVolumes[index] = this.volumeValues[index];

    // Fresh silent pair for the slot, mirroring stepToFrequency's swap: the
    // detached pair keeps its channel connections (disconnect is only ever
    // called on the node it's severing), the new pair wires up its own.
    const t = this.audioContext.currentTime;
    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();
    const oscillatorR = this.audioContext.createOscillator();
    const gainNodeR = this.audioContext.createGain();
    const wave = droneWave.getPeriodicWave(this.audioContext);
    if (wave) {
      oscillator.setPeriodicWave(wave);
      oscillatorR.setPeriodicWave(wave);
    }
    oscillator.connect(gainNode);
    oscillatorR.connect(gainNodeR);
    this.oscillators[index] = oscillator;
    this.gainNodes[index] = gainNode;
    this.oscillatorsR[index] = oscillatorR;
    this.gainNodesR[index] = gainNodeR;
    this._connectDroneToChannels(index);
    oscillator.frequency.setValueAtTime(this._dronePrimaryFreq(index), t);
    oscillatorR.frequency.setValueAtTime(this._dronePartnerFreq(index), t);
    gainNode.gain.setValueAtTime(0, t);
    gainNodeR.gain.setValueAtTime(0, t);
    oscillator.start();
    oscillatorR.start();
    this.phases[index] = 0;
    this.smoothedFreqs[index] = this._dronePrimaryFreq(index);
    this._lastPhaseUpdate[index] = t;
    this.phasesR[index] = 0;
    this.smoothedFreqsR[index] = this._dronePartnerFreq(index);
    this._lastPhaseUpdateR[index] = t;

    this._notifyFrequencyChange();
    return id;
  }

  /**
   * Spawn a NEW travelling voice out of silence — the bloom entrance. A
   * fresh pair attacks at `hz` (drone note-on envelope) and is meant to be
   * tweened to `forSlot`'s pitch and landed there. It borrows the slot's
   * routing (so the landing reconnects the same edges — seamless), detune
   * offset and volume; the slot itself stays muted and PARKED until
   * landing, so nothing slot-bound (orbs, spectrum) moves during the bloom.
   * Returns the traveller id, or null pre-init.
   */
  spawnTravelVoice(hz, forSlot) {
    if (!this.isInitialized || !this.audioContext) return null;
    if (forSlot < 0 || forSlot >= this.oscillatorCount) return null;
    const clamped = Math.max(0.001, Math.min(FREQ_CEIL, hz));
    const t = this.audioContext.currentTime;

    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    const oscR = this.audioContext.createOscillator();
    const gainR = this.audioContext.createGain();
    const wave = droneWave.getPeriodicWave(this.audioContext);
    if (wave) {
      osc.setPeriodicWave(wave);
      oscR.setPeriodicWave(wave);
    }
    osc.connect(gain);
    oscR.connect(gainR);

    // Wire to the destination slot's channels (mirrors
    // _connectDroneToChannels, which only works on slot-registered nodes).
    const channels = (this.routingMap[forSlot] || []).slice();
    const pan = this.getVoicePan(forSlot);
    if (this._usesBeyondStereo(channels)) {
      // Legacy discrete multichannel wiring for patch-bay slots.
      const isBoth = channels.length >= 2;
      if (droneStereo.mode === 'stereo') {
        const ch = isBoth ? 0 : (channels[0] ?? 0);
        if (this.channelGains[ch]) gain.connect(this.channelGains[ch]);
        const chR = isBoth ? 1 : (channels[0] ?? 1);
        if (this.channelGains[chR]) gainR.connect(this.channelGains[chR]);
      } else {
        for (const ch of channels) {
          if (ch >= 0 && ch < this.channelGains.length) gain.connect(this.channelGains[ch]);
        }
        if (this.channelGains[1]) gainR.connect(this.channelGains[1]);
      }
    } else {
      this._wirePanTaps(gain, gainR, pan);
    }

    const offset = this.droneDetuneOffsets[forSlot] || 0;
    const w = panWidth(pan);
    const nominal = clamped * this._transposeRatio;
    // Mode-blind: pair travellers always take the width-narrowed
    // half-spread; beyond-stereo slots keep the legacy mode gate.
    const pairActive = !this._usesBeyondStereo(channels) || droneStereo.mode === 'stereo';
    const shift = pairActive ? (offset * w) / 2 : 0;
    osc.frequency.setValueAtTime(Math.max(0.001, Math.min(FREQ_CEIL, nominal + shift)), t);
    oscR.frequency.setValueAtTime(Math.max(0.001, Math.min(FREQ_CEIL, nominal - (offset * w) / 2)), t);

    const level = Math.min(this.volumeValues[forSlot] ?? 0.5, DRONE_PLAY_VOL_CAP);
    const peak = level * this._slotLoudnessScale(forSlot);
    gain.gain.setValueAtTime(0, t);
    gainR.gain.setValueAtTime(0, t);
    droneEnvelope.applyNoteOn(gain.gain, this.audioContext, peak);
    if (pairActive) {
      droneEnvelope.applyNoteOn(gainR.gain, this.audioContext, peak * w);
    }
    osc.start();
    oscR.start();

    this._travelerSeq += 1;
    const id = this._travelerSeq;
    this._travelers.set(id, {
      id,
      fromIndex: forSlot,
      osc,
      gain,
      oscR,
      gainR,
      nominalHz: clamped,
      offset,
      pan,
      channels,
      level,
      // A bloom is a genuinely NEW note (it attacks locally too), so its
      // wire id is fresh — note-on at spawn, then bend through the flight.
      wireId: `travel:${id}`,
    });
    return id;
  }

  /**
   * Retune a traveller mid-flight (the launch loop's per-frame write).
   * Applies transpose and the traveller's frozen detune offset the same way
   * a slot write would, so a travel sounds exactly like a slot glide.
   */
  setTravelerFrequency(id, hz) {
    const tv = this._travelers.get(id);
    if (!tv || !this.audioContext) return;
    const clamped = Math.max(0.001, Math.min(FREQ_CEIL, hz));
    tv.nominalHz = clamped;
    const nominal = clamped * this._transposeRatio;
    const w = panWidth(tv.pan ?? 0);
    const pairActive = !this._usesBeyondStereo(tv.channels || []) || droneStereo.mode === 'stereo';
    const shift = pairActive ? (tv.offset * w) / 2 : 0;
    const t = this.audioContext.currentTime;
    tv.osc.frequency.setTargetAtTime(
      Math.max(0.001, Math.min(FREQ_CEIL, nominal + shift)), t, 0.016);
    if (tv.oscR) {
      tv.oscR.frequency.setTargetAtTime(
        Math.max(0.001, Math.min(FREQ_CEIL, nominal - (tv.offset * w) / 2)), t, 0.016);
    }
  }

  /**
   * Land a traveller on slot `toIndex`: the slot ADOPTS the travelling node
   * pair — same oscillators, continuous phase, no retrigger — and unmutes.
   * The slot's previous pair is discarded (it's silent in the planned flow;
   * if it's somehow still audible it gets a quick release tail instead of a
   * hard stop). Gain ramps from the traveller's in-flight level to the
   * destination slot's own target; when the two slots route to different
   * output channels the reroute hides inside a ~15 ms dip to silence —
   * a synchronous disconnect/connect at audible gain would click.
   */
  landTravelVoice(id, toIndex) {
    const tv = this._travelers.get(id);
    if (!tv) return false;
    if (!this.isInitialized || toIndex < 0 || toIndex >= this.oscillatorCount || !this.audioContext) {
      this.releaseTravelVoice(id);
      return false;
    }
    this._travelers.delete(id);
    const t = this.audioContext.currentTime;

    // Retire the destination's current pair.
    const oldOsc = this.oscillators[toIndex];
    const oldGain = this.gainNodes[toIndex];
    const oldOscR = this.oscillatorsR[toIndex];
    const oldGainR = this.gainNodesR[toIndex];
    const wasAudible = !this.mutedStates[toIndex];
    const retire = (o, g) => {
      if (!o) return;
      try {
        if (g) {
          const cur = g.gain.value;
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(cur, t);
          // Planned flow: silent pair, near-instant fade. Defensive flow
          // (still audible): the drone release so nothing hard-stops.
          g.gain.linearRampToValueAtTime(0, t + (wasAudible ? droneEnvelope.release : 0.02));
        }
        o.onended = () => {
          try { o.disconnect(); } catch { /* ignore */ }
          try { g && g.disconnect(); } catch { /* ignore */ }
        };
        o.stop(t + (wasAudible ? droneEnvelope.release : 0.02) + 0.05);
      } catch (e) {
        console.warn('Error retiring landed-on oscillator', toIndex, e);
      }
    };
    retire(oldOsc, oldGain);
    retire(oldOscR, oldGainR);

    // Adoption: the slot's references now ARE the traveller's nodes.
    this.oscillators[toIndex] = tv.osc;
    this.gainNodes[toIndex] = tv.gain;
    this.oscillatorsR[toIndex] = tv.oscR;
    this.gainNodesR[toIndex] = tv.gainR;
    this.mutedStates[toIndex] = false;
    this.frequencyValues[toIndex] = tv.nominalHz;
    // The slot also adopts the traveller's WIRE id, so the external synth's
    // note continues seamlessly across the landing — no retrigger.
    this._wireAliases.set(toIndex, tv.wireId);

    const primaryTarget = this._droneTargetGain(toIndex);
    const partnerTarget = this._dronePartnerTargetGain(toIndex);
    const ramp = (g, target, secs) => {
      if (!g) return;
      const cur = g.gain.value;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(cur, t);
      g.gain.linearRampToValueAtTime(target, t + secs);
    };

    const destChannels = (this.routingMap[toIndex] || []).slice().sort();
    const sameRoute = String(destChannels) === String(tv.channels.slice().sort())
      && Math.abs((tv.pan ?? 0) - this.getVoicePan(toIndex)) < 0.02;
    if (sameRoute) {
      // Same output edges: reconnect within one task (graph changes apply
      // between render quanta, so this is seamless) and ramp to the slot's
      // own level.
      this._connectDroneToChannels(toIndex);
      ramp(tv.gain, primaryTarget, 0.08);
      ramp(tv.gainR, partnerTarget, 0.08);
    } else {
      // Different sides: dip to silence, reroute there, rise at the new
      // position — same trick as _clickFreeVoiceRouteSwap, ~75 ms total.
      ramp(tv.gain, 0, 0.012);
      ramp(tv.gainR, 0, 0.012);
      setTimeout(() => {
        try {
          this._connectDroneToChannels(toIndex);
          const t2 = this.audioContext.currentTime;
          const rise = (g, target) => {
            if (!g) return;
            g.gain.cancelScheduledValues(t2);
            g.gain.setValueAtTime(0, t2);
            g.gain.linearRampToValueAtTime(target, t2 + 0.06);
          };
          rise(tv.gain, this._droneTargetGain(toIndex));
          rise(tv.gainR, this._dronePartnerTargetGain(toIndex));
        } catch { /* context torn down mid-handoff */ }
      }, 20);
    }

    // Ease onto the destination's own detune offset (a few Hz at most).
    tv.osc.frequency.setTargetAtTime(this._dronePrimaryFreq(toIndex), t, 0.03);
    if (tv.oscR) tv.oscR.frequency.setTargetAtTime(this._dronePartnerFreq(toIndex), t, 0.03);

    // Viz phase accumulators restart for the adopted pair.
    this.phases[toIndex] = 0;
    this.smoothedFreqs[toIndex] = this._dronePrimaryFreq(toIndex);
    this._lastPhaseUpdate[toIndex] = t;
    this.phasesR[toIndex] = 0;
    this.smoothedFreqsR[toIndex] = this._dronePartnerFreq(toIndex);
    this._lastPhaseUpdateR[toIndex] = t;

    this._notifyFrequencyChange();
    return true;
  }

  /**
   * Release a traveller without landing it — the merge/fade-out ending, and
   * the cleanup path. Envelope release (or an explicit shorter one), then
   * self-stop and disconnect.
   */
  releaseTravelVoice(id, releaseS = null) {
    const tv = this._travelers.get(id);
    if (!tv) return;
    this._travelers.delete(id);
    if (!this.audioContext) return;
    const rel = Number.isFinite(releaseS) ? Math.max(0.02, releaseS) : droneEnvelope.release;
    const t = this.audioContext.currentTime;
    const tail = (o, g) => {
      if (!o) return;
      try {
        if (g) {
          const cur = g.gain.value;
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(cur, t);
          g.gain.linearRampToValueAtTime(0, t + rel);
        }
        o.onended = () => {
          try { o.disconnect(); } catch { /* ignore */ }
          try { g && g.disconnect(); } catch { /* ignore */ }
        };
        o.stop(t + rel + 0.05);
      } catch (e) {
        console.warn('Error releasing travel voice', id, e);
      }
    };
    tail(tv.osc, tv.gain);
    tail(tv.oscR, tv.gainR);
  }

  /** Release every in-flight traveller (osc-count changes, patch loads,
   *  launch-state freezes — anything that invalidates slot indices). Wire
   *  aliases go with them: these events restart notes locally, so the wire
   *  must retrigger too. */
  releaseAllTravelers(releaseS = 0.08) {
    for (const id of [...this._travelers.keys()]) this.releaseTravelVoice(id, releaseS);
    this._wireAliases.clear();
  }

  /** In-flight travellers for viz / MIDI: [{ id, fromIndex, hz, level, wireId }]. */
  getTravelers() {
    return [...this._travelers.values()].map((tv) => ({
      id: tv.id,
      fromIndex: tv.fromIndex,
      hz: tv.nominalHz,
      level: tv.level,
      wireId: tv.wireId,
    }));
  }

  /**
   * Get current frequency value for an oscillator
   */
  getFrequency(index) {
    return this.frequencyValues[index] || 0;
  }
  
  /**
   * Get current volume value for an oscillator (0-1)
   */
  getVolume(index) {
    return this.volumeValues[index] || 0;
  }
  
  /**
   * Get all frequencies
   */
  getAllFrequencies() {
    return [...this.frequencyValues];
  }

  /**
   * Actual sounding drone frequencies in Hz — the nominal frequencyValues
   * scaled by the global transpose ratio (which getAllFrequencies omits;
   * transpose is a playback-only offset never folded into the stored
   * nominal Hz). Use this for anything that needs drones to line up with
   * keyboard voice frequencies (which already include transpose), e.g. the
   * timeline visualizer.
   */
  getSoundingFrequencies() {
    const ratio = this._transposeRatio || 1;
    return this.frequencyValues.map(f => f * ratio);
  }

  /**
   * Get all volumes (as percentages 0-100)
   */
  getAllVolumes() {
    return this.volumeValues.map(v => Math.round(v * 100));
  }
  
  /**
   * Get muted state for all oscillators
   */
  getAllMutedStates() {
    return [...this.mutedStates];
  }
  
  /**
   * Check if an oscillator is muted
   */
  isMuted(index) {
    return this.mutedStates[index] || false;
  }

  /**
   * Pitch lock — is this slot's frequency frozen against everything but
   * its own editor? (See the pitchLocked declaration in the constructor.)
   */
  isPitchLocked(index) {
    return this.pitchLocked[index] || false;
  }

  setPitchLocked(index, locked) {
    if (index < 0 || index >= this.oscillatorCount) return;
    const next = !!locked;
    if (this.pitchLocked[index] === next) return;
    this.pitchLocked[index] = next;
    // Rides the frequency-change channel so the panel readouts and the
    // FrequencyManager observers repaint on the same tick they already
    // poll (there is no separate lock listener).
    this._notifyFrequencyChange();
  }

  togglePitchLocked(index) {
    if (index < 0 || index >= this.oscillatorCount) return;
    this.setPitchLocked(index, !this.pitchLocked[index]);
  }
  
  /**
   * Mute a specific oscillator — runs the drone envelope's release tail
   * on the per-slot gain. The oscillator itself keeps running so that
   * un-muting later resumes phase-correlated with other un-muted slots
   * (important for beating).
   */
  muteOscillator(index) {
    if (!this.isInitialized || index < 0 || index >= this.oscillatorCount) return;
    if (this.mutedStates[index]) return;
    if (!this.gainNodes[index]) return;

    this.mutedStates[index] = true;
    // The note is ending — a landed-traveller alias must not survive into
    // whatever this slot sounds next.
    this._wireAliases.delete(index);
    this.preMuteVolumes[index] = this.volumeValues[index];
    this.markSlotReleasing(index);

    droneEnvelope.applyNoteOff(this.gainNodes[index].gain, this.audioContext);
    // Partner runs the same release tail. Harmless on a silent partner
    // (hard pan / inactive pair): the release just ramps 0 → 0.
    if (this.gainNodesR[index]) {
      droneEnvelope.applyNoteOff(this.gainNodesR[index].gain, this.audioContext);
    }
    // Notify listeners so demand-driven UIs (FSB) repaint the muted state.
    // Tuning._recompute is a no-op for mute-only changes since the sorted
    // frequency array doesn't depend on mute — adds one cheap sort and bails.
    this._notifyFrequencyChange();
  }

  /**
   * Unmute a specific oscillator — runs the drone envelope's
   * attack→decay→sustain on the per-slot gain. Steady-state lands at
   * volumeValues[i] × droneEnvelope.sustain.
   */
  unmuteOscillator(index) {
    if (!this.isInitialized || index < 0 || index >= this.oscillatorCount) return;
    if (!this.mutedStates[index]) return;
    if (!this.gainNodes[index]) return;

    this.mutedStates[index] = false;
    this._releaseUntilMs[index] = 0;   // any release tail is superseded
    // Cap the resume level so pressing a drone's button never plays it above
    // DRONE_PLAY_VOL_CAP. Clamp the stored value (not just the envelope peak)
    // so every downstream read — _droneTargetGain, sustain retargets, the
    // volume slider — stays in sync with what's sounding.
    if (this.volumeValues[index] > DRONE_PLAY_VOL_CAP) {
      this.volumeValues[index] = DRONE_PLAY_VOL_CAP;
    }
    // Peak carries the equal-loudness comp like every other gain target
    // site, so the attack's landing level matches the steady-state
    // _droneTargetGain (at the default hard pans the scale is 1 — this
    // only matters for mid-pan voices).
    const peak = this.volumeValues[index] * this._slotLoudnessScale(index);
    droneEnvelope.applyNoteOn(this.gainNodes[index].gain, this.audioContext, peak);
    // Partner mirrors the unmute, scaled by panWidth (silent at the pan
    // extremes, and gated off for legacy multichannel slots).
    if (this.gainNodesR[index] && this._slotPairActive(index)) {
      droneEnvelope.applyNoteOn(this.gainNodesR[index].gain, this.audioContext,
        peak * panWidth(this.getVoicePan(index)));
    }
    this._notifyFrequencyChange();
  }
  
  /**
   * Stamp a slot as "note-off in progress" for the envelope release
   * duration — muteOscillator calls this itself; voice-leading exits that
   * release a DETACHED traveller (the slot flips muted while the sound
   * fades elsewhere) call it explicitly so the UI still shows the note
   * as going, not gone.
   */
  markSlotReleasing(index, seconds = null) {
    const rel = Number.isFinite(seconds) ? seconds : droneEnvelope.release;
    this._releaseUntilMs[index] = performance.now() + Math.max(0, rel) * 1000;
  }

  /** True while a muted slot's release tail is still audible. */
  isSlotReleasing(index) {
    return !!this.mutedStates[index]
      && (this._releaseUntilMs[index] || 0) > performance.now();
  }

  /**
   * Toggle mute for a specific oscillator
   */
  toggleMute(index) {
    if (this.mutedStates[index]) {
      this.unmuteOscillator(index);
    } else {
      this.muteOscillator(index);
    }
    return this.mutedStates[index];
  }
  
  /**
   * Fade out master volume
   * @returns {Promise} Resolves when fade is complete
   */
  fadeOut() {
    if (!this.isInitialized) return Promise.resolve();
    
    const fadeDuration = 0.3; // 300ms fade
    const currentTime = this.audioContext.currentTime;
    for (const p of this._masterFadeParams()) {
      p.cancelScheduledValues(currentTime);
      p.setValueAtTime(Math.max(p.value, 0.001), currentTime);
      p.exponentialRampToValueAtTime(0.001, currentTime + fadeDuration);
      p.setValueAtTime(0, currentTime + fadeDuration);
    }
    
    this.isPaused = true;
    
    return new Promise(resolve => setTimeout(resolve, fadeDuration * 1000));
  }
  
  /**
   * Fade in master volume
   * @returns {Promise} Resolves when fade is complete
   */
  fadeIn() {
    if (!this.isInitialized) return Promise.resolve();
    
    const fadeDuration = 0.5; // 500ms fade
    const currentTime = this.audioContext.currentTime;
    const targetGain = this.masterVolumeUser;

    for (const p of this._masterFadeParams()) {
      p.cancelScheduledValues(currentTime);
      p.setValueAtTime(0.001, currentTime);
      p.exponentialRampToValueAtTime(targetGain, currentTime + fadeDuration);
    }

    this.isPaused = false;

    return new Promise(resolve => setTimeout(resolve, fadeDuration * 1000));
  }
  
  /**
   * Toggle play/pause — DRONES ONLY. Keyboard voices keep playing.
   * Spacebar / pause-button are wired here. The full-master fadeIn /
   * fadeOut methods are still used by routing + device changes (those
   * mute everything for the duration of the change).
   *
   * Pause is independent of droneEnabled — pausing fades drones out
   * regardless, and unpausing restores them to whatever droneEnabled
   * was set to (so a drone-off state survives a pause/unpause cycle).
   */
  togglePlayPause() {
    if (!this.isInitialized) return;
    if (this.isPaused) this.unpauseDrones();
    else this.pauseDrones();
    return this.isPaused;
  }

  pauseDrones() {
    if (!this.isInitialized || this.isPaused) return;
    this.isPaused = true;
    this._applyDroneBusGain();
  }

  unpauseDrones() {
    if (!this.isInitialized || !this.isPaused) return;
    this.isPaused = false;
    // Defensive: if something muted masterGain to 0 (e.g. a device
    // change called fadeOut and the user is now manually unpausing),
    // restore master to user volume so sound actually returns. Skip this
    // when the final-output mute on the mixer is intentionally engaged —
    // unpausing must not silently un-mute it.
    const t = this.audioContext.currentTime;
    if (!this._masterMuted && this.masterGainNode.gain.value < 0.01) {
      for (const p of this._masterFadeParams()) {
        p.cancelScheduledValues(t);
        p.setValueAtTime(0.001, t);
        p.exponentialRampToValueAtTime(this.masterVolumeUser, t + 0.5);
      }
    }
    this._applyDroneBusGain();
  }

  // Drone-on toggle — independent of pause. The visible drone button
  // controls this; pressing it while paused just updates the latent
  // state so the drone is (or isn't) audible on the next unpause.
  setDroneEnabled(on) {
    const next = !!on;
    if (this.droneEnabled === next) return;
    this.droneEnabled = next;
    if (this.isInitialized) this._applyDroneBusGain();
  }

  // Ramp the drone bus gain to match the AND of droneEnabled & !isPaused.
  // Single source of truth so the two booleans can change in any order
  // without leaving the gain stuck.
  _applyDroneBusGain() {
    if (!this.isInitialized) return;
    const t = this.audioContext.currentTime;
    const shouldPlay = this.droneEnabled && !this.isPaused;
    this.droneBusGain.gain.cancelScheduledValues(t);
    const cur = this.droneBusGain.gain.value;
    this.droneBusGain.gain.setValueAtTime(Math.max(cur, 0.001), t);
    if (shouldPlay) {
      this.droneBusGain.gain.exponentialRampToValueAtTime(1, t + 0.5);
    } else {
      this.droneBusGain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      this.droneBusGain.gain.setValueAtTime(0, t + 0.3);
    }
  }
  
  /**
   * Advance per-oscillator phase accumulators to audioContext.currentTime.
   * Call once per visualizer frame. Each phase integrates an
   * exponentially-smoothed target frequency whose smoothing tau mirrors
   * setFrequency's setTargetAtTime(freq, now, 0.016), so the accumulated
   * phase tracks the actual running Web Audio oscillators — including
   * across slider drags where the audio graph is ramping the frequency.
   */
  /**
   * Advance the tape-transport morph/wander clocks to `now` and return
   * the phase dilation factor for the elapsed period (1 = real speed).
   * Called once per frame from updatePhases. Visual-only: the audio
   * graph never sees the dilation — while the gesture is in flight the
   * real oscillators keep playing at pitch under the drone bus's plain
   * pause fade, and the accumulators (the scope's only trajectory)
   * decelerate underneath.
   */
  _stepTapeTransport(now) {
    let dt = this._tapeLastStep === null ? 0 : now - this._tapeLastStep;
    this._tapeLastStep = now;
    // Hidden-tab rAF gaps resume the gesture mid-flight instead of
    // jumping it to completion.
    dt = Math.min(0.1, Math.max(0, dt));

    // Crawl dilation from the highest sounding drone (transposed — the
    // dilation must match what the accumulators integrate), held at its
    // last value while everything is muted so log() never sees 0.
    const ratio = this._transposeRatio || 1;
    let maxF = 0;
    for (let i = 0; i < this.oscillatorCount; i++) {
      if (this.mutedStates[i]) continue;
      if (!((this.volumeValues[i] || 0) > 0)) continue;
      const f = (this.frequencyValues[i] || 0) * ratio;
      if (f > maxF) maxF = f;
    }
    if (isFinite(maxF) && maxF > 0.1) {
      this._tapeCrawlDilation = 1 / (maxF * TAPE.baseCycleSeconds);
    }

    const target = this.isPaused ? 1 : 0;
    if (target > this._tapeMorph) {
      // Record-stop on the S-curve: the visible slow-down plays out in
      // the mid-low morphs for most of the ramp instead of compressing
      // into the last instants (linear speed) or parking in the
      // near-static bottom (plain ease-out).
      this._tapeMorph = Math.min(
        target,
        tapeEase(Math.min(1, tapeEaseInv(this._tapeMorph) + dt / TAPE.rampOffSeconds))
      );
    } else if (target < this._tapeMorph) {
      // Spin-up on the mirrored S-curve (symmetric: ease(1−u) = 1−ease(u)):
      // the reel leaves the crawl at full rate the frame play is tapped
      // and lands exactly on real speed at the end of the ramp.
      this._tapeMorph = Math.max(
        target,
        1 - tapeEase(Math.min(1, tapeEaseInv(1 - this._tapeMorph) + dt / TAPE.rampOnSeconds))
      );
    }

    this._tapeWanderPhase += dt * 2 * Math.PI * TAPE.wanderHz;
    if (this._tapeMorph <= 0) return 1;
    const wander = 1 + TAPE.wanderDepth * this._tapeMorph * Math.sin(this._tapeWanderPhase);
    return Math.exp(this._tapeMorph * Math.log(this._tapeCrawlDilation)) * wander;
  }

  /**
   * Current tape morph (0 = real speed, 1 = full crawl). The scope keys
   * its fairy takeover, tail-window contraction and phase-calibration
   * gating off this.
   */
  getTapeMorph() {
    return this._tapeMorph;
  }

  updatePhases() {
    if (!this.isInitialized || !this.audioContext) return;
    const now = this.audioContext.currentTime;
    const TWO_PI = Math.PI * 2;
    const tau = this._phaseSmoothTau;
    const dilation = this._stepTapeTransport(now);
    for (let i = 0; i < this.oscillatorCount; i++) {
      const last = this._lastPhaseUpdate[i];
      if (last === null || last === undefined) {
        this._lastPhaseUpdate[i] = now;
        continue;
      }
      const dt = now - last;
      if (dt <= 0) continue;
      this._lastPhaseUpdate[i] = now;
      const alpha = 1 - Math.exp(-dt / tau);
      // Track each osc's ACTUAL played freq so the synth visualizer
      // stays in sync with the audio. Primary uses _dronePrimaryFreq
      // (full or half detune depending on mode); partner uses
      // _dronePartnerFreq (always base − offset/2).
      const targetP = this._dronePrimaryFreq(i);
      if (this.smoothedFreqs[i] === undefined) {
        this.smoothedFreqs[i] = targetP;
      } else {
        this.smoothedFreqs[i] += (targetP - this.smoothedFreqs[i]) * alpha;
      }
      this.phases[i] =
        ((this.phases[i] || 0) + TWO_PI * this.smoothedFreqs[i] * dilation * dt) % TWO_PI;

      // Partner phase tracking. _lastPhaseUpdateR is seeded at create
      // time; advancing every frame keeps it ready even while the
      // partner is silent at a hard pan.
      const lastR = this._lastPhaseUpdateR[i];
      if (lastR === null || lastR === undefined) {
        this._lastPhaseUpdateR[i] = now;
      } else {
        const dtR = now - lastR;
        if (dtR > 0) {
          this._lastPhaseUpdateR[i] = now;
          const alphaR = 1 - Math.exp(-dtR / tau);
          const targetR = this._dronePartnerFreq(i);
          if (this.smoothedFreqsR[i] === undefined) {
            this.smoothedFreqsR[i] = targetR;
          } else {
            this.smoothedFreqsR[i] += (targetR - this.smoothedFreqsR[i]) * alphaR;
          }
          this.phasesR[i] =
            ((this.phasesR[i] || 0) + TWO_PI * this.smoothedFreqsR[i] * dilation * dtR) % TWO_PI;
        }
      }
    }
  }

  /**
   * Get the current accumulated phase (radians, 0..2π) for one oscillator.
   */
  getPhase(index) {
    return this.phases[index] || 0;
  }

  /**
   * Get current accumulated phases (radians, 0..2π) for all oscillators.
   */
  getAllPhases() {
    return [...this.phases];
  }

  /**
   * Per-drone partner-osc data for the synth visualizer. Returns a
   * parallel-indexed array of { freq, phase, audible }. Mode-blind:
   * `audible` follows each voice's pan width — the partner sounds
   * whenever the voice isn't hard-panned (legacy multichannel slots
   * still gate on 'stereo' mode via _slotPairActive). The synth path
   * uses this to render the second osc so the visualized lissajous
   * matches the analyzer's L/R split.
   */
  getDronePartnerData() {
    const out = [];
    for (let i = 0; i < this.oscillatorCount; i++) {
      out.push({
        freq: this.smoothedFreqsR[i] || this._dronePartnerFreq(i),
        phase: this.phasesR[i] || 0,
        audible: this._slotPairActive(i) && panWidth(this.getVoicePan(i)) > 1e-3,
      });
    }
    return out;
  }

  /**
   * Measure each oscillator's current phase directly from the analyzer
   * time-domain buffers and overwrite the phase accumulator with the
   * measured value. Called once per visualizer frame (after
   * updatePhases) so phases[] stays locked to what the audio graph is
   * actually producing.
   *
   * Signal model per analyzer channel:
   *   x[s] = Σ_k [ c_k · sin(ω_k·s) + d_k · cos(ω_k·s) ]
   * where (c_k, d_k) = (A_k·cos θ_k, A_k·sin θ_k). Since all ω_k are
   * known, x = M·p is linear in the 2M unknowns p = [c_0,d_0,c_1,d_1,…];
   * we solve the normal equations M^T M · p = M^T x jointly across all
   * oscillators audible on the channel. This is the right approach (vs.
   * per-osc Goertzel) because it EXACTLY accounts for the mutual
   * leakage between oscillators whose frequencies are within the
   * Goertzel bin width — e.g. two oscs 1 Hz apart that beat together.
   *
   * Mode-blind stereo: each channel's oscillator set follows the
   * collapse-pan tap weights, not the discrete routingMap — a centered
   * voice's L channel holds its PRIMARY (base + detune/2) and its R
   * channel holds its PARTNER (base − detune/2), a separate oscillator
   * with its own frequency and accumulator. Partner entries solve as
   * independent columns and write back to phasesR[]. Fitting the old
   * primary-only model against the partner's channel dragged phases[]
   * toward the partner's phase every R pass, which is why the tape
   * fairy's tail matched the live figure at hard pans but not centered.
   *
   * Implementation:
   * • M^T M has a closed-form expression via the Dirichlet kernel
   *   (_sumCos / _sumSin below), so we build it in O(K²) rather than
   *   O(K²N). It depends only on frequencies + routing, so we cache the
   *   Cholesky factor across frames, keyed by a routing+frequency
   *   signature. Recomputed automatically when anything changes.
   * • M^T x requires one pass over the analyzer buffer per oscillator:
   *   O(K·N) per channel per frame, done via sin/cos rotation recurrence.
   * • After solving, θ_k = atan2(d_k, c_k) gives phase at sample 0;
   *   we extrapolate by ω·(N−1) to land on phases[k]'s "phase at
   *   currentTime" convention.
   *
   * Oscillators routed only to output channels > 1 (not visible on
   * analyzers 0/1) are skipped — their phases fall back to
   * updatePhases()'s accumulator. Likewise partners silenced by a hard
   * pan (width ≈ 0): no columns are added for them, so the default lr
   * preset costs exactly what the old primary-only gather did.
   */
  calibratePhases() {
    if (!this.isInitialized || !this.audioContext) return;
    const L = this.getTimeDataLeft();
    const R = this.getTimeDataRight();
    if (!L || !R) return;
    const sampleRate = this.audioContext.sampleRate;
    this._calibrateChannel(L, sampleRate, 0);
    this._calibrateChannel(R, sampleRate, 1);
  }

  _calibrateChannel(signal, sampleRate, channel) {
    const N = signal.length;
    const TWO_PI = Math.PI * 2;

    // Gather every oscillator audible on this analyzer channel. Use
    // smoothedFreqs / smoothedFreqsR (maintained by updatePhases with
    // the same 0.016 s exponential tau Web Audio's setTargetAtTime uses
    // internally) rather than frequencyValues (which is the LATEST
    // scheduled target). During a glide or slider drag the audio buffer
    // the LSQ is fitting contains the smoothed frequency, not the
    // target — using the smoothed values keeps the basis aligned with
    // the signal. At steady state the two are equal.
    //
    // Stereo-pair slots contribute per the collapse-pan tap weights
    // (see setVoicePan): primary at dronePanWeights(pan).primary[ch],
    // partner — its own oscillator, frequency and accumulator — at
    // partner[ch] × panWidth(pan). Both carry _slotLoudnessScale, the
    // same equal-loudness comp the gain targets hold, so `weight` is
    // the slot's true analyzer-side amplitude factor for the expected-
    // amplitude confidence check below. Entries under the gate add no
    // columns — a hard-panned voice is absent from its far channel and
    // its silent partner is absent everywhere, so the lr preset builds
    // the same-size system the old routing-based gather did.
    // Beyond-stereo patch-bay slots keep the legacy discrete model
    // (primary only, on its routed channels — pan is inert for them).
    const WEIGHT_EPS = 1e-3;
    const oscs = [];
    for (let k = 0; k < this.oscillatorCount; k++) {
      const f = this.smoothedFreqs[k];
      if (!(f > 0)) continue;
      const ch = this.routingMap[k] || [];
      if (ch.length === 0) continue; // unrouted → silent, same as the taps
      if (this._usesBeyondStereo(ch)) {
        if (ch.includes(channel)) oscs.push({ k, f, partner: false, weight: 1 });
        continue;
      }
      const pan = this.getVoicePan(k);
      const w = dronePanWeights(pan);
      const loud = this._slotLoudnessScale(k);
      const wPrim = w.primary[channel] * loud;
      if (wPrim > WEIGHT_EPS) oscs.push({ k, f, partner: false, weight: wPrim });
      const fR = this.smoothedFreqsR[k];
      const wPart = w.partner[channel] * panWidth(pan) * loud;
      if (fR > 0 && wPart > WEIGHT_EPS) {
        oscs.push({ k, f: fR, partner: true, weight: wPart });
      }
    }
    const M = oscs.length;
    if (M === 0) return;
    const P = 2 * M;

    // Cache signature: invalidate on any change to the osc set, their
    // frequencies, or the analyzer buffer length. Weights are NOT part
    // of the signature — they never enter M^T M (amplitude lives in the
    // solved coefficients), only the confidence check, which reads the
    // fresh `oscs` each call.
    let sig = N + '|';
    for (let i = 0; i < M; i++) {
      sig += (oscs[i].partner ? 'p' : '') + oscs[i].k + ':' + oscs[i].f.toFixed(6) + ';';
    }

    const cacheKey = channel === 0 ? '_lsqCacheL' : '_lsqCacheR';
    let cache = this[cacheKey];

    if (!cache || cache.sig !== sig) {
      // Build M^T M analytically. Block (i, j) is a 2×2 of the inner
      // products [[<sin_i,sin_j>, <sin_i,cos_j>], [<cos_i,sin_j>,
      // <cos_i,cos_j>]], each reducible via product-to-sum to
      // combinations of _sumCos / _sumSin at (ω_i ± ω_j).
      const MtM = new Float64Array(P * P);
      for (let i = 0; i < M; i++) {
        const wi = TWO_PI * oscs[i].f / sampleRate;
        for (let j = 0; j <= i; j++) {
          const wj = TWO_PI * oscs[j].f / sampleRate;
          const cp = _sumCos(wi + wj, N);
          const cm = _sumCos(wi - wj, N);
          const sp = _sumSin(wi + wj, N);
          const sm = _sumSin(wi - wj, N);
          const ss = (cm - cp) / 2; // <sin_i, sin_j>
          const sc = (sp + sm) / 2; // <sin_i, cos_j>
          const cs = (sp - sm) / 2; // <cos_i, sin_j>
          const cc = (cm + cp) / 2; // <cos_i, cos_j>
          const r0 = 2 * i, r1 = 2 * i + 1;
          const c0 = 2 * j, c1 = 2 * j + 1;
          MtM[r0 * P + c0] = ss;
          MtM[r0 * P + c1] = sc;
          MtM[r1 * P + c0] = cs;
          MtM[r1 * P + c1] = cc;
          if (i !== j) {
            // Mirror to symmetric partner.
            MtM[c0 * P + r0] = ss;
            MtM[c1 * P + r0] = sc;
            MtM[c0 * P + r1] = cs;
            MtM[c1 * P + r1] = cc;
          }
        }
      }

      // Tikhonov regularization — keeps Cholesky well-defined when two
      // oscillators are at nearly identical frequencies (the columns
      // become linearly dependent). 1e-9 × trace is far below the
      // signal level so well-conditioned cases are unaffected.
      let trace = 0;
      for (let d = 0; d < P; d++) trace += MtM[d * P + d];
      const lambda = Math.max(1e-12, 1e-9 * trace);
      for (let d = 0; d < P; d++) MtM[d * P + d] += lambda;

      if (!_choleskyInPlace(MtM, P)) {
        // Factorization failed despite regularization — bail, leaving
        // phases[] as whatever updatePhases produced.
        return;
      }
      cache = { sig, LL: MtM, P, N };
      this[cacheKey] = cache;
    }

    // Build M^T x for the current signal: each pair of entries is
    // (Σ x[s]·sin(ω_i·s), Σ x[s]·cos(ω_i·s)).
    const Mtx = new Float64Array(P);
    for (let i = 0; i < M; i++) {
      const omega = TWO_PI * oscs[i].f / sampleRate;
      const cosStep = Math.cos(omega);
      const sinStep = Math.sin(omega);
      let cosT = 1, sinT = 0;
      let sinSum = 0, cosSum = 0;
      for (let s = 0; s < N; s++) {
        sinSum += signal[s] * sinT;
        cosSum += signal[s] * cosT;
        const nc = cosT * cosStep - sinT * sinStep;
        const ns = sinT * cosStep + cosT * sinStep;
        cosT = nc;
        sinT = ns;
      }
      Mtx[2 * i] = sinSum;
      Mtx[2 * i + 1] = cosSum;
    }

    const p = _choleskySolve(cache.LL, Mtx, P);

    // Extract phases. Model: x[s] = c·sin(ωs) + d·cos(ωs) = A·sin(ωs+θ)
    // with c = A·cos(θ), d = A·sin(θ), so θ = atan2(d, c).
    //
    // BUT during an active tune glide / slider drag / fade-in, each
    // oscillator's frequency is sweeping across the 186 ms analyzer
    // buffer while the LSQ basis is fixed at a single freq per
    // oscillator. The projection magnitudes √(c²+d²) collapse toward
    // zero (chirp doesn't correlate well with a fixed sinusoid) and
    // atan2 returns near-random phase — which makes the synth XY look
    // like it "disappears" because each frame's Lissajous is a
    // different rotation and fade persistence washes them out.
    //
    // Compare the LSQ-recovered amplitude A_lsq = √(c²+d²)·(2/N) to
    // what we expect from the user's volume + master scale. At steady
    // state the ratio is ~1 and we snap to LSQ. During a sweep the
    // ratio collapses toward 0 and we stay on updatePhases()'s
    // accumulator, which integrates smoothedFreqs (matching Web
    // Audio's internal setTargetAtTime tau) and therefore stays
    // coherent during non-stationary periods. Blend continuously
    // through the middle so the handoff is smooth — no thresholds.
    const masterScale = this._getScaledMasterGain();
    const droneSustain = droneEnvelope.sustain;
    for (let i = 0; i < M; i++) {
      const o = oscs[i];
      const oscIdx = o.k;
      const c = p[2 * i];
      const d = p[2 * i + 1];
      // p solves the NORMAL equations, so (c, d) are already in signal
      // amplitude units (M^T M ≈ (N/2)·I absorbs the projection scale).
      // The old extra ×2/N here shrank aLsq ~4000×, pinning confidence
      // below the 1e-3 gate — the calibration never actually fired.
      const aLsq = Math.sqrt(c * c + d * d);
      const muted = this.mutedStates[oscIdx];
      // Steady-state gain at the slot is volume × droneEnvelope.sustain
      // × the entry's channel weight (tap weight × loudness comp ×
      // partner width); multiply by masterScale to land on the
      // analyzer-side amplitude.
      const aExpected = (muted ? 0 : (this.volumeValues[oscIdx] || 0))
        * droneSustain * masterScale * o.weight;
      const confidence = aExpected > 1e-6 ? Math.min(1, aLsq / aExpected) : 0;
      if (confidence < 1e-3) continue; // accumulator owns it this frame

      const thetaAt0 = Math.atan2(d, c);
      const omega = TWO_PI * o.f / sampleRate;
      const phaseAtEnd = thetaAt0 + omega * (N - 1);
      const phaseLsq = ((phaseAtEnd % TWO_PI) + TWO_PI) % TWO_PI;
      // Partner entries correct the partner's own accumulator; an osc
      // audible in BOTH channels gets two ≤0.2 blends toward the same
      // measured truth, which just converges a little faster.
      const acc = o.partner ? this.phasesR : this.phases;
      const phaseAcc = acc[oscIdx] || 0;
      // Shortest signed arc from accumulator toward LSQ, in (−π, π].
      // Scale by confidence so partial trust moves phase only partway.
      // Additionally cap the blend rate at MAX_BLEND so LSQ's
      // frame-to-frame measurement noise (driven by analyzer-quantum vs
      // rAF-frame timing jitter, which can be up to ±1 rad at 100 Hz)
      // gets averaged across ~1/alpha frames instead of pushing a
      // different value into the renderer each tick. The accumulator
      // still advances at the true rate in updatePhases(), so capping
      // only slows the LSQ *correction* — not the tracking of an actual
      // phase change. Effective tracking lag when LSQ is steady is
      // ~1/alpha frames ≈ 5 frames ≈ 83 ms, well under one beat cycle.
      let delta = phaseLsq - phaseAcc;
      delta = ((delta + 3 * Math.PI) % TWO_PI) - Math.PI;
      const MAX_BLEND = 0.2;
      const blend = Math.min(confidence, MAX_BLEND);
      let next = phaseAcc + blend * delta;
      next = ((next % TWO_PI) + TWO_PI) % TWO_PI;
      acc[oscIdx] = next;
    }
  }

  /**
   * Get time domain data for visualization (left channel)
   */
  getTimeDataLeft() {
    if (!this.isInitialized) return null;
    
    this.analyserNode1.getFloatTimeDomainData(this.timeData1);
    return this.timeData1;
  }
  
  /**
   * Get time domain data for visualization (right channel)
   */
  getTimeDataRight() {
    if (!this.isInitialized) return null;

    this.analyserNode2.getFloatTimeDomainData(this.timeData2);
    return this.timeData2;
  }

  /**
   * Coherent stereo snapshot for the XY scope. The two analyser ring
   * buffers advance on the audio thread in 128-sample render quanta,
   * asynchronously to rAF — roughly once every ~10 s a quantum commit
   * lands between the separate L and R reads, leaving R one quantum
   * newer than L. On the Lissajous that 128-sample skew is a large
   * X↔Y relative-phase error (~210° at 220 Hz), so the figure flashes
   * a different phase position for exactly one frame. Bracket the pair
   * with verification re-reads and retry until both channels' tails are
   * unchanged across the bracket, which pins L and R to the same
   * quantum epoch. Measured live: skew fires ~1× per 10 s and one
   * retry always resolves it; each read is a 32 KB copy, so the two
   * extra reads per frame are noise.
   */
  getTimeDataStereo() {
    if (!this.isInitialized) return null;
    const N = this.timeData1.length;
    if (!this._stereoBracketL || this._stereoBracketL.length !== N) {
      this._stereoBracketL = new Float32Array(N);
      this._stereoBracketR = new Float32Array(N);
    }
    const CHECK = Math.min(512, N);
    for (let attempt = 0; attempt < 3; attempt++) {
      this.analyserNode1.getFloatTimeDomainData(this.timeData1);
      this.analyserNode2.getFloatTimeDomainData(this.timeData2);
      this.analyserNode1.getFloatTimeDomainData(this._stereoBracketL);
      this.analyserNode2.getFloatTimeDomainData(this._stereoBracketR);
      let coherent = true;
      for (let i = N - CHECK; i < N; i++) {
        if (this.timeData1[i] !== this._stereoBracketL[i] ||
            this.timeData2[i] !== this._stereoBracketR[i]) {
          coherent = false;
          break;
        }
      }
      if (coherent) break;
    }
    return { L: this.timeData1, R: this.timeData2 };
  }
  
  /**
   * Check if audio is initialized
   */
  get initialized() {
    return this.isInitialized;
  }
  
  /**
   * Check if audio is paused
   */
  get paused() {
    return this.isPaused;
  }
}

// ── Helpers for calibratePhases (joint least-squares phase recovery) ─────

// Σ_{s=0}^{N−1} cos(ω·s) via the Dirichlet-kernel identity:
//   sum = cos((N−1)·ω/2) · sin(N·ω/2) / sin(ω/2)
// Degenerate when sin(ω/2) ≈ 0 (ω is an integer multiple of 2π): every
// term is 1, so the sum is exactly N.
function _sumCos(omega, N) {
  const half = omega / 2;
  const s = Math.sin(half);
  if (Math.abs(s) < 1e-12) return N;
  return Math.cos((N - 1) * half) * Math.sin(N * half) / s;
}

// Σ_{s=0}^{N−1} sin(ω·s). Same identity; degenerate case is 0.
function _sumSin(omega, N) {
  const half = omega / 2;
  const s = Math.sin(half);
  if (Math.abs(s) < 1e-12) return 0;
  return Math.sin((N - 1) * half) * Math.sin(N * half) / s;
}

// In-place Cholesky factorization of a symmetric positive-definite
// n×n matrix A (row-major Float64Array). Writes the lower-triangular
// factor L into the lower triangle of A (the upper triangle is ignored
// by the solve). Returns true on success, false if A turns out not to
// be positive-definite (a diagonal term goes non-positive). Callers
// should regularize the diagonal before calling to avoid that path.
function _choleskyInPlace(A, n) {
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i * n + j];
      for (let k = 0; k < j; k++) {
        sum -= A[i * n + k] * A[j * n + k];
      }
      if (i === j) {
        if (sum <= 0) return false;
        A[i * n + j] = Math.sqrt(sum);
      } else {
        A[i * n + j] = sum / A[j * n + j];
      }
    }
  }
  return true;
}

// Solve L·L^T·x = b, where L is the lower-triangle Cholesky factor
// produced by _choleskyInPlace. Does forward substitution (L·y = b)
// then backward substitution (L^T·x = y); returns x as a fresh
// Float64Array of length n.
function _choleskySolve(L, b, n) {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= L[i * n + k] * y[k];
    y[i] = sum / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= L[k * n + i] * x[k];
    x[i] = sum / L[i * n + i];
  }
  return x;
}

// Export singleton instance
const audioEngine = new AudioEngine();
export default audioEngine;

/**
 * AudioEngine - Singleton class managing all Web Audio API operations
 * Supports dynamic oscillator count (2-10), multi-channel routing, and device selection.
 * Isolated from React to prevent re-renders from interfering with audio timing.
 */

import { droneEnvelope } from './Envelope';
import { droneWave } from './Wave';
import { droneFold, keyboardFold } from './Fold';
import { droneStereo, keyboardStereo } from './StereoMode';

// Topology-change ramp for adding/removing drone slots via the count
// control. Decoupled from droneEnvelope on purpose — see
// research/adsr-envelope.md §7c. A long user attack would silently
// delay added slots; near-zero attack would click. 300 ms threads the
// needle for both.
const FIXED_SLOT_FADE = 0.3;

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
    this.analyserNode1 = null;   // Left channel visualization
    this.analyserNode2 = null;   // Right channel visualization
    this.isInitialized = false;
    this.isPaused = false;
    
    // Dynamic oscillator management
    this.oscillatorCount = 4;
    this.maxOscillators = 12;
    this.minOscillators = 2;

    // User-controllable master volume multiplier (0..1). Multiplies on top of
    // the count-based clipping scaler in _getScaledMasterGain so fade-in/out
    // and oscillator add/remove transitions naturally honor it.
    this.masterVolumeUser = 1.0;

    // Keyboard pool's own bus controls. `_kbdVolume` is the user slider;
    // `_kbdEnabled` is the on/off switch. Effective bus gain is the
    // product (0 when disabled). _kbdEffectiveGain() returns the live
    // value for the audio node.
    this._kbdVolume = 0.75;
    this._kbdEnabled = true;

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
    
    // Device management
    this.currentDeviceId = null;
    
    // Audio graph nodes for routing
    this.channelGains = [];      // One gain per output channel for final mixing
    this.stereoMerger = null;    // Merges channels to stereo for output
    
    // Callbacks for state change notifications
    this.onRoutingChange = null;

    // Listeners notified whenever any oscillator's frequency target changes
    // OR the oscillator count changes (which adds/removes scale degrees).
    // The keyboard's Tuning module subscribes here so it can re-sort the
    // scale and propagate retunes to held voices.
    this.frequencyListeners = new Set();

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

  /**
   * Returns the audio bus the keyboard pool should hang itself off:
   * the live AudioContext + the keyboardBusGain (which then feeds
   * masterGainNode). The keyboard pool connects HERE so its volume +
   * on/off can be controlled independently from the drone pool.
   * Both fields are null before initialize() has been called.
   */
  getAudioBus() {
    return {
      audioContext: this.audioContext,
      masterGainNode: this.keyboardBusGain,
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
    while (this.droneDetuneOffsets.length < this.oscillatorCount) {
      this.droneDetuneOffsets.push(0);
    }
    // Sync per-pool detune curves to the live drone count. Only grows
    // them — values from URL state are preserved.
    droneStereo.resizeCurve(this.oscillatorCount);
    keyboardStereo.resizeCurve(this.oscillatorCount);

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

    // Keyboard bus — parallel branch. Voice pool routes here instead of
    // straight to masterGain so the keyboard can have its own volume +
    // on/off without touching drones.
    this.keyboardBusGain = this.audioContext.createGain();
    this.keyboardBusGain.gain.setValueAtTime(this._kbdEffectiveGain(), this.audioContext.currentTime);

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


    //                                              ┌→ droneFoldDry ─┐
    // stereoMerger → droneBusGain → droneCountScale ┤                ├→ masterGainNode
    //                                              └→ shaper → wet ─┘
    this.stereoMerger.connect(this.droneBusGain);
    this.droneBusGain.connect(this.droneCountScale);
    this.droneCountScale.connect(this.droneFoldDry);
    this.droneCountScale.connect(this.droneFoldShaper);
    this.droneFoldShaper.connect(this.droneFoldWet);
    this.droneFoldDry.connect(this.masterGainNode);
    this.droneFoldWet.connect(this.masterGainNode);

    //                  ┌→ keyboardFoldDry ─┐
    // keyboardBusGain ─┤                    ├→ masterGainNode
    //                  └→ shaper → wet ─────┘
    this.keyboardBusGain.connect(this.keyboardFoldDry);
    this.keyboardBusGain.connect(this.keyboardFoldShaper);
    this.keyboardFoldShaper.connect(this.keyboardFoldWet);
    this.keyboardFoldDry.connect(this.masterGainNode);
    this.keyboardFoldWet.connect(this.masterGainNode);
    
    // Load the soft-limiter worklet before wiring the post-master chain
    // so the saturator is in place from frame zero — no click from
    // inserting it later. Falls back to direct masterGainNode → splitter
    // on load failure (saturationReady stays false).
    await this._loadSaturationNode();

    // Create splitter for visualization (off the post-master tap — after
    // saturation if loaded, else directly off masterGainNode). Analyzers
    // sit on the split-off, so every visualizer sees the full-width
    // signal the listener hears (including saturation character).
    const splitter = this.audioContext.createChannelSplitter(2);
    const finalMerger = this.audioContext.createChannelMerger(2);

    const postMaster = this.saturationNode || this.masterGainNode;
    if (this.saturationNode) {
      this.masterGainNode.connect(this.saturationNode);
    }
    postMaster.connect(splitter);
    splitter.connect(this.analyserNode1, 0);
    splitter.connect(this.analyserNode2, 1);
    this.analyserNode1.connect(finalMerger, 0, 0);
    this.analyserNode2.connect(finalMerger, 0, 1);

    finalMerger.connect(this.audioContext.destination);
    
    // Get max channel count from destination
    this.outputChannelCount = this.audioContext.destination.maxChannelCount || 2;
    console.log('Max output channels available:', this.outputChannelCount);
    
    // Create initial oscillators with default routing
    this._createOscillators();
    
    // Setup default routing (odd → left, even → right)
    this._setupDefaultRouting();
    
    // Fade in master to user volume only — count-scale lives on
    // droneCountScale (already set above).
    this.masterGainNode.gain.setTargetAtTime(this.masterVolumeUser, this.audioContext.currentTime, 0.1);

    this.isInitialized = true;
    this.isPaused = false;

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
    // Drone stereo mode + detune: on mode flip, re-route every drone to
    // either single-channel (lr) or both channels (stereo). On detune
    // change, re-roll every offset and ramp the oscillators to their
    // new actual frequency so the user hears the change live. The
    // visualizer's smoothedFreqs follows because updatePhases() reads
    // _dronePrimaryFreq() / _dronePartnerFreq().
    if (!this._droneStereoUnsubscribe) {
      this._droneStereoUnsubscribe = droneStereo.onChange((_inst, info) => {
        if (!this.audioContext) return;
        if (!info) return;
        if (info.kind === 'mode') {
          // detuneHzAt() returns 0 in lr — recompute offsets first so
          // the primary's freq goes back to nominal when leaving stereo
          // and back to (offset/2) when entering. Then re-route and
          // ramp partner gain in/out.
          this._applyDroneDetuneCurve();
          const t = this.audioContext.currentTime;
          for (let i = 0; i < this.oscillatorCount; i++) {
            this._connectDroneToChannels(i);
            if (this.gainNodesR[i]) {
              this.gainNodesR[i].gain.setTargetAtTime(this._dronePartnerTargetGain(i), t, 0.05);
            }
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
      if (this.mutedStates[i]) continue;
      const gainNode = this.gainNodes[i];
      const gainNodeR = this.gainNodesR[i];
      const peak = this.volumeValues[i];
      if (gainNode) droneEnvelope.retargetSustain(gainNode.gain, this.audioContext, peak);
      // Partner only retargets to peak in stereo mode; lr mode stays muted.
      if (gainNodeR && droneStereo.mode === 'stereo') {
        droneEnvelope.retargetSustain(gainNodeR.gain, this.audioContext, peak);
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
   * Count-based clip-prevention attenuator applied at droneCountScale
   * BEFORE droneFoldShaper. Splits the original combined master gain
   * so the shaper's input clamp ([-1, 1]) doesn't introduce hard
   * clipping when many drones sum past unity.
   */
  _getDroneCountScale() {
    return 1.0 / Math.sqrt(this.oscillatorCount / 2);
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

  setMasterVolume(value) {
    const clamped = Math.max(0, Math.min(1, value));
    this.masterVolumeUser = clamped;
    // Master node now carries ONLY user volume; count-scale lives on
    // droneCountScale and is updated independently when oscillator
    // count changes.
    if (this.isInitialized && !this.isPaused && this.masterGainNode) {
      this.masterGainNode.gain.setTargetAtTime(
        this.masterVolumeUser,
        this.audioContext.currentTime,
        0.05
      );
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
      // Partner always feeds the right channel directly. Audibility is
      // controlled by gainNodeR's value (0 in lr mode, full in stereo).
      gainNodeR.connect(this.channelGains[1]);

      // Default routing: odd indices → left (0), even indices → right (1).
      // Stash in routingMap; the actual node connect goes through
      // _connectDroneToChannels so stereo mode is honored from the start.
      if (!this.routingMap[index] || this.routingMap[index].length === 0) {
        this.routingMap[index] = [index % 2];
      }
      this.oscillators[index] = oscillator;
      this.gainNodes[index] = gainNode;
      this.oscillatorsR[index] = oscillatorR;
      this.gainNodesR[index] = gainNodeR;
      this._connectDroneToChannels(index);

      // Detune offset comes from the curve × master Hz. Always recompute
      // on (re)create so the offset stays consistent with the curve
      // even after a slot was restored from removedSlots with a stale
      // value or never set.
      this.droneDetuneOffsets[index] = droneStereo.detuneHzAt(index);
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
   * Setup default routing (odd → left, even → right)
   */
  _setupDefaultRouting() {
    for (let i = 0; i < this.oscillatorCount; i++) {
      this.routingMap[i] = [i % 2]; // 0=left, 1=right as array
    }
  }

  /**
   * Primary oscillator's played freq.
   * - 'lr' mode:     base + offset[i]   (single osc, full random shift)
   * - 'stereo' mode: base + offset[i]/2 (half-spread; partner takes -half)
   */
  _dronePrimaryFreq(i) {
    const nominal = this.frequencyValues[i] || 0;
    const offset = this.droneDetuneOffsets[i] || 0;
    const shift = droneStereo.mode === 'stereo' ? offset / 2 : offset;
    return Math.max(0.001, Math.min(20000, nominal + shift));
  }

  /**
   * Partner oscillator's played freq. Always base - offset/2 — only
   * audible in 'stereo' mode, but kept current so a mode flip doesn't
   * have to retune the partner before fading it in.
   */
  _dronePartnerFreq(i) {
    const nominal = this.frequencyValues[i] || 0;
    const offset = this.droneDetuneOffsets[i] || 0;
    return Math.max(0.001, Math.min(20000, nominal - offset / 2));
  }

  /**
   * Steady-state gain target for the primary oscillator: 0 if muted,
   * otherwise volume × droneEnvelope.sustain. Used by setVolume,
   * sustain retargets, and the create path.
   */
  _droneTargetGain(i) {
    if (this.mutedStates[i]) return 0;
    return (this.volumeValues[i] || 0.5) * droneEnvelope.sustain;
  }

  /**
   * Steady-state gain target for the partner oscillator: same as the
   * primary in 'stereo' mode, 0 in 'lr' mode (silent partner).
   */
  _dronePartnerTargetGain(i) {
    if (droneStereo.mode !== 'stereo') return 0;
    return this._droneTargetGain(i);
  }

  /**
   * Re-route both the primary and partner oscillators for drone slot
   * `i` per the current mode. Topology:
   *
   *   'lr' mode:
   *     primary → routingMap[i] channels (single channel by default)
   *     partner → channelGains[1]   (silent — gain=0 in this mode)
   *
   *   'stereo' mode:
   *     primary → channelGains[0]                            (L only)
   *     partner → channelGains[1]   (or droneStereoDelay → channelGains[1]
   *                                   when phaseOffsetMs > 0, for an
   *                                   extra delay-based phase shift)
   *
   * Called from _createSingleOscillator, addRouting, removeRouting,
   * and the droneStereo mode/phase change subscription. disconnect()
   * only severs OUTGOING edges, so the osc → gain incoming edge
   * survives across the swap.
   */
  _connectDroneToChannels(i) {
    const gainNode = this.gainNodes[i];
    const gainNodeR = this.gainNodesR[i];
    if (!this.channelGains.length) return;

    if (gainNode) {
      try { gainNode.disconnect(); } catch { /* ignore */ }
      if (droneStereo.mode === 'stereo') {
        if (this.channelGains[0]) gainNode.connect(this.channelGains[0]);
      } else {
        const channels = this.routingMap[i] || [];
        for (const ch of channels) {
          if (ch >= 0 && ch < this.channelGains.length) {
            gainNode.connect(this.channelGains[ch]);
          }
        }
      }
    }

    if (gainNodeR) {
      try { gainNodeR.disconnect(); } catch { /* ignore */ }
      const right = this.channelGains[1];
      if (right) gainNodeR.connect(right);
    }
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
      this.droneDetuneOffsets[i] = droneStereo.detuneHzAt(i);
      if (this.oscillators[i]) {
        this.oscillators[i].frequency.setTargetAtTime(this._dronePrimaryFreq(i), t, 0.016);
      }
      if (this.oscillatorsR[i]) {
        this.oscillatorsR[i].frequency.setTargetAtTime(this._dronePartnerFreq(i), t, 0.016);
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
      
      const oldCount = this.oscillatorCount;
      
      if (newCount > oldCount) {
        // Add oscillators - update count first so arrays are in sync
        this.oscillatorCount = newCount;
        // Grow the per-pool curves to match. New slots default to 0,
        // so adding a drone doesn't surprise-detune anything.
        droneStereo.resizeCurve(newCount);
        keyboardStereo.resizeCurve(newCount);

        for (let i = oldCount; i < newCount; i++) {
          // Restore the most-recently-removed slot if available; otherwise
          // generate a random pitch near an existing oscillator.
          const restored = this.removedSlots.pop();
          if (restored) {
            this.frequencyValues[i] = restored.freq;
            this.volumeValues[i] = restored.vol;
            this.mutedStates[i] = restored.muted;
            this.preMuteVolumes[i] = restored.preMuteVol;
          } else {
            const randomIndex = Math.floor(Math.random() * oldCount);
            const basePitch = this.frequencyValues[randomIndex] || 60;
            const newPitch = basePitch + (Math.random() * 6 - 3);
            this.frequencyValues[i] = Math.max(0.1, newPitch);
            this.volumeValues[i] = 0.5;
            this.mutedStates[i] = false;
            this.preMuteVolumes[i] = 0.5;
          }
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

          this.oscillators.splice(i, 1);
          this.gainNodes.splice(i, 1);
          this.oscillatorsR.splice(i, 1);
          this.gainNodesR.splice(i, 1);
          this.frequencyValues.splice(i, 1);
          this.volumeValues.splice(i, 1);
          this.mutedStates.splice(i, 1);
          this.preMuteVolumes.splice(i, 1);
          this.droneDetuneOffsets.splice(i, 1);
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

      this.removedSlots.push({
        freq: this.frequencyValues[index],
        vol: this.volumeValues[index],
        muted: this.mutedStates[index],
        preMuteVol: this.preMuteVolumes[index],
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

      this.oscillators.splice(index, 1);
      this.gainNodes.splice(index, 1);
      this.oscillatorsR.splice(index, 1);
      this.gainNodesR.splice(index, 1);
      this.frequencyValues.splice(index, 1);
      this.volumeValues.splice(index, 1);
      this.mutedStates.splice(index, 1);
      this.preMuteVolumes.splice(index, 1);
      this.droneDetuneOffsets.splice(index, 1);
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
      this.oscillatorCount = newIndex + 1;

      // Stereo curves need to grow before _createSingleOscillator reads
      // a per-slot detune for the new node.
      droneStereo.resizeCurve(this.oscillatorCount);
      keyboardStereo.resizeCurve(this.oscillatorCount);

      this._createSingleOscillator(newIndex, true /* withFade */);
      this._updateMasterGainScaling();
      this._notifyFrequencyChange();
    } catch (err) {
      console.error('AudioEngine: Failed to clone oscillator', err);
    }
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
      this._connectDroneToChannels(oscIndex);

      // Notify listeners
      if (this.onRoutingChange) {
        this.onRoutingChange(oscIndex, this.routingMap[oscIndex]);
      }
    } catch (err) {
      console.error('AudioEngine: Failed to add routing', err);
    }
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
      // Helper handles the disconnect + reconnect per current mode.
      // In 'stereo' mode the audio stays on L+R; the map change only
      // takes effect when mode flips back to 'lr'.
      this._connectDroneToChannels(oscIndex);

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
        this.routingMap[i] = [i % numChannels];
      }
      this._connectDroneToChannels(i);
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
   * Set frequency for a specific oscillator
   */
  setFrequency(index, frequency) {
    if (!this.isInitialized || index < 0 || index >= this.oscillatorCount) return;
    if (!this.oscillators[index]) return;
    
    const clampedFreq = Math.max(0.001, Math.min(20000, frequency));
    
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
      return;
    }

    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    const t = this.audioContext.currentTime;
    const target = clampedVol * droneEnvelope.sustain;
    this.gainNodes[index].gain.setTargetAtTime(target, t, 0.016);
    if (this.gainNodesR[index]) {
      const partnerTarget = droneStereo.mode === 'stereo' ? target : 0;
      this.gainNodesR[index].gain.setTargetAtTime(partnerTarget, t, 0.016);
    }
  }
  
  /**
   * Apply frequencies to every oscillator in one pass, scheduling every
   * AudioParam change at the same currentTime so the relative offsets between
   * oscillators stay exactly preserved (critical for beat-preserving drags).
   */
  setAllFrequenciesBatch(frequencies) {
    if (!this.isInitialized) return;
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    const t = this.audioContext.currentTime;
    const count = Math.min(frequencies.length, this.oscillatorCount);
    let changed = false;
    for (let i = 0; i < count; i++) {
      if (!this.oscillators[i]) continue;
      const clampedFreq = Math.max(0.001, Math.min(20000, frequencies[i]));
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
      const target = clampedVol * sustain;
      this.gainNodes[i].gain.setTargetAtTime(target, t, 0.016);
      if (this.gainNodesR[i]) {
        const partnerTarget = droneStereo.mode === 'stereo' ? target : 0;
        this.gainNodesR[i].gain.setTargetAtTime(partnerTarget, t, 0.016);
      }
    }
  }

  /**
   * 7-limit just-intonation ratios within one octave, in ascending order.
   * Extends the classical 5-limit major scale (the iOS port) with the
   * "pleasing ratios outside Western scales": subminor/supermajor 3rds,
   * septimal tritone, harmonic 7th, minor-key intervals, and a diatonic
   * semitone. 15 ratios across the octave → ~60-90¢ decision boundaries in
   * log-space nearest-neighbor, so Tune rarely yanks an osc far from where
   * it already lived.
   */
  static JUST_RATIOS = [
    1.0,          // 1/1    0¢    unison
    16.0 / 15.0,  //        112¢  diatonic semitone (minor 2nd)
    9.0 / 8.0,    //        204¢  whole tone (major 2nd)
    7.0 / 6.0,    //        267¢  septimal subminor 3rd
    6.0 / 5.0,    //        316¢  minor 3rd
    5.0 / 4.0,    //        386¢  major 3rd
    9.0 / 7.0,    //        435¢  septimal supermajor 3rd
    4.0 / 3.0,    //        498¢  perfect 4th
    7.0 / 5.0,    //        583¢  septimal tritone
    3.0 / 2.0,    //        702¢  perfect 5th
    8.0 / 5.0,    //        814¢  minor 6th
    5.0 / 3.0,    //        884¢  major 6th
    7.0 / 4.0,    //        969¢  harmonic 7th (barbershop / blues 7th)
    9.0 / 5.0,    //        1018¢ minor 7th
    15.0 / 8.0,   //        1088¢ major 7th
    2.0,          // 2/1    1200¢ octave — same pitch as 1/1 of the next
                  //        octave up; included so a near-octave osc (e.g.
                  //        ratio 1.985) rounds up to 2/1 instead of down to
                  //        15/8 (floor-octave trap otherwise).
  ];

  /**
   * Compute per-oscillator target frequencies that snap each non-fundamental
   * oscillator to the nearest 7-limit JI ratio relative to the lowest un-muted
   * oscillator. Octave-preserving and log-space nearest-neighbor. Pure
   * function — returns targets without touching audio state.
   *
   * @param {number} varianceHz  Random ±Hz detune added per osc after snapping
   *                             (matches iOS alignVariance). 0 = pure JI.
   */
  computeJustIntonationTargets(varianceHz = 0) {
    const out = this.frequencyValues.slice();
    const ratios = AudioEngine.JUST_RATIOS;
    // Fundamental = lowest un-muted oscillator by frequency. Fall back to the
    // lowest overall if every osc is muted so the button still does something.
    let fundamentalIdx = -1;
    let fundamentalFreq = Infinity;
    for (let i = 0; i < this.oscillatorCount; i++) {
      if (this.mutedStates[i]) continue;
      if (this.frequencyValues[i] < fundamentalFreq) {
        fundamentalFreq = this.frequencyValues[i];
        fundamentalIdx = i;
      }
    }
    if (fundamentalIdx === -1) {
      for (let i = 0; i < this.oscillatorCount; i++) {
        if (this.frequencyValues[i] < fundamentalFreq) {
          fundamentalFreq = this.frequencyValues[i];
          fundamentalIdx = i;
        }
      }
    }
    if (fundamentalIdx === -1 || fundamentalFreq <= 0) return out;

    // Simple nearest-neighbor: each non-root osc snaps to whichever ratio in
    // the table is closest in log space, at its current octave. Duplicate
    // collapses (two oscs landing on the same pitch) are allowed — if the
    // inputs were already near each other, stacking is the natural result.
    for (let i = 0; i < this.oscillatorCount; i++) {
      if (i === fundamentalIdx) continue;
      const f = this.frequencyValues[i];
      if (f <= 0) continue;
      const ratio = f / fundamentalFreq;
      const octave = Math.floor(Math.log2(ratio));
      const normalized = ratio / Math.pow(2, octave); // [1, 2)
      const logNorm = Math.log2(normalized);

      let bestRatio = ratios[0];
      let bestDist = Math.abs(Math.log2(ratios[0]) - logNorm);
      for (let j = 1; j < ratios.length; j++) {
        const d = Math.abs(Math.log2(ratios[j]) - logNorm);
        if (d < bestDist) { bestDist = d; bestRatio = ratios[j]; }
      }

      let target = fundamentalFreq * bestRatio * Math.pow(2, octave);
      if (varianceHz > 0) {
        target += (Math.random() * 2 - 1) * varianceHz;
      }
      out[i] = Math.max(0.001, Math.min(20000, target));
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
  glideToFrequencies(targets, durationMs = 1000, onComplete = null) {
    if (!this.isInitialized) return;
    if (this._glideRaf != null) {
      cancelAnimationFrame(this._glideRaf);
      this._glideRaf = null;
    }
    const count = Math.min(targets.length, this.oscillatorCount);
    const starts = this.frequencyValues.slice(0, count);
    const safeTargets = new Array(count);
    for (let i = 0; i < count; i++) {
      safeTargets[i] = Math.max(0.001, Math.min(20000, targets[i]));
    }

    if (durationMs <= 0) {
      this.setAllFrequenciesBatch(safeTargets);
      if (onComplete) onComplete();
      return;
    }

    const logStarts = starts.map((f) => Math.log2(Math.max(0.001, f)));
    const logTargets = safeTargets.map((f) => Math.log2(f));
    const startMs = performance.now();
    // Smooth ease-in-out cubic: slow departure, fast middle, slow landing.
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    const step = () => {
      const elapsed = performance.now() - startMs;
      const t = Math.min(1, elapsed / durationMs);
      const k = ease(t);
      const frame = new Array(count);
      for (let i = 0; i < count; i++) {
        frame[i] = Math.pow(2, logStarts[i] + (logTargets[i] - logStarts[i]) * k);
      }
      this.setAllFrequenciesBatch(frame);
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
    this.preMuteVolumes[index] = this.volumeValues[index];

    droneEnvelope.applyNoteOff(this.gainNodes[index].gain, this.audioContext);
    // Partner runs the same release tail when stereo mode has it audible;
    // skip in lr mode where it's already at 0.
    if (this.gainNodesR[index] && droneStereo.mode === 'stereo') {
      droneEnvelope.applyNoteOff(this.gainNodesR[index].gain, this.audioContext);
    }
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
    const peak = this.volumeValues[index];
    droneEnvelope.applyNoteOn(this.gainNodes[index].gain, this.audioContext, peak);
    // Partner mirrors the unmute when stereo mode has it audible.
    if (this.gainNodesR[index] && droneStereo.mode === 'stereo') {
      droneEnvelope.applyNoteOn(this.gainNodesR[index].gain, this.audioContext, peak);
    }
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
    this.masterGainNode.gain.cancelScheduledValues(currentTime);
    const currentGain = this.masterGainNode.gain.value;
    this.masterGainNode.gain.setValueAtTime(Math.max(currentGain, 0.001), currentTime);
    this.masterGainNode.gain.exponentialRampToValueAtTime(0.001, currentTime + fadeDuration);
    this.masterGainNode.gain.setValueAtTime(0, currentTime + fadeDuration);
    
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

    this.masterGainNode.gain.cancelScheduledValues(currentTime);
    this.masterGainNode.gain.setValueAtTime(0.001, currentTime);
    this.masterGainNode.gain.exponentialRampToValueAtTime(targetGain, currentTime + fadeDuration);

    this.isPaused = false;

    return new Promise(resolve => setTimeout(resolve, fadeDuration * 1000));
  }
  
  /**
   * Toggle play/pause — DRONES ONLY. Keyboard voices keep playing.
   * Spacebar / pause-button are wired here. The full-master fadeIn /
   * fadeOut methods are still used by routing + device changes (those
   * mute everything for the duration of the change).
   */
  togglePlayPause() {
    if (!this.isInitialized) return;
    if (this.isPaused) this.unpauseDrones();
    else this.pauseDrones();
    return this.isPaused;
  }

  pauseDrones() {
    if (!this.isInitialized || this.isPaused) return;
    const t = this.audioContext.currentTime;
    this.droneBusGain.gain.cancelScheduledValues(t);
    const cur = this.droneBusGain.gain.value;
    this.droneBusGain.gain.setValueAtTime(Math.max(cur, 0.001), t);
    this.droneBusGain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    this.droneBusGain.gain.setValueAtTime(0, t + 0.3);
    this.isPaused = true;
  }

  unpauseDrones() {
    if (!this.isInitialized || !this.isPaused) return;
    const t = this.audioContext.currentTime;
    // Ramp drone bus back up.
    this.droneBusGain.gain.cancelScheduledValues(t);
    this.droneBusGain.gain.setValueAtTime(0.001, t);
    this.droneBusGain.gain.exponentialRampToValueAtTime(1, t + 0.5);
    // Defensive: if something muted masterGain to 0 (e.g. a device
    // change called fadeOut and the user is now manually unpausing),
    // restore master to user volume so sound actually returns.
    if (this.masterGainNode.gain.value < 0.01) {
      this.masterGainNode.gain.cancelScheduledValues(t);
      this.masterGainNode.gain.setValueAtTime(0.001, t);
      this.masterGainNode.gain.exponentialRampToValueAtTime(this.masterVolumeUser, t + 0.5);
    }
    this.isPaused = false;
  }
  
  /**
   * Advance per-oscillator phase accumulators to audioContext.currentTime.
   * Call once per visualizer frame. Each phase integrates an
   * exponentially-smoothed target frequency whose smoothing tau mirrors
   * setFrequency's setTargetAtTime(freq, now, 0.016), so the accumulated
   * phase tracks the actual running Web Audio oscillators — including
   * across slider drags where the audio graph is ramping the frequency.
   */
  updatePhases() {
    if (!this.isInitialized || !this.audioContext) return;
    const now = this.audioContext.currentTime;
    const TWO_PI = Math.PI * 2;
    const tau = this._phaseSmoothTau;
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
        ((this.phases[i] || 0) + TWO_PI * this.smoothedFreqs[i] * dt) % TWO_PI;

      // Partner phase tracking. _lastPhaseUpdateR is seeded at create
      // time; advancing every frame keeps it ready for a mode flip
      // even when the partner is silent in lr mode.
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
            ((this.phasesR[i] || 0) + TWO_PI * this.smoothedFreqsR[i] * dtR) % TWO_PI;
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
   * parallel-indexed array of { freq, phase, audible } where `audible`
   * is true only in 'stereo' mode (lr keeps the partner gain at 0). The
   * synth path uses this to render the second osc on the right channel
   * so the visualized lissajous matches the analyzer's L/R split.
   */
  getDronePartnerData() {
    const out = [];
    const audible = droneStereo.mode === 'stereo';
    for (let i = 0; i < this.oscillatorCount; i++) {
      out.push({
        freq: this.smoothedFreqsR[i] || this._dronePartnerFreq(i),
        phase: this.phasesR[i] || 0,
        audible,
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
   * oscillators routed to the channel. This is the right approach (vs.
   * per-osc Goertzel) because it EXACTLY accounts for the mutual
   * leakage between oscillators whose frequencies are within the
   * Goertzel bin width — e.g. two oscs 1 Hz apart that beat together.
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
   * updatePhases()'s accumulator.
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

    // Gather oscillators routed to this analyzer channel. Use
    // smoothedFreqs (maintained by updatePhases with the same 0.016 s
    // exponential tau Web Audio's setTargetAtTime uses internally)
    // rather than frequencyValues (which is the LATEST scheduled
    // target). During a glide or slider drag the audio buffer the LSQ
    // is fitting contains the smoothed frequency, not the target —
    // using smoothedFreqs keeps the LSQ basis aligned with the signal.
    // At steady state the two are equal.
    const oscs = [];
    for (let k = 0; k < this.oscillatorCount; k++) {
      const f = this.smoothedFreqs[k];
      if (!(f > 0)) continue;
      const ch = this.routingMap[k] || [];
      if (ch.includes(channel)) oscs.push({ k, f });
    }
    const M = oscs.length;
    if (M === 0) return;
    const P = 2 * M;

    // Cache signature: invalidate on any change to the osc set, their
    // frequencies, or the analyzer buffer length.
    let sig = N + '|';
    for (let i = 0; i < M; i++) sig += oscs[i].k + ':' + oscs[i].f.toFixed(6) + ';';

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
      cache = { sig, oscs, LL: MtM, P, N };
      this[cacheKey] = cache;
    }

    // Build M^T x for the current signal: each pair of entries is
    // (Σ x[s]·sin(ω_i·s), Σ x[s]·cos(ω_i·s)).
    const Mtx = new Float64Array(P);
    for (let i = 0; i < M; i++) {
      const omega = TWO_PI * cache.oscs[i].f / sampleRate;
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
    const twoOverN = 2 / N;
    for (let i = 0; i < M; i++) {
      const oscIdx = cache.oscs[i].k;
      const c = p[2 * i];
      const d = p[2 * i + 1];
      const aLsq = Math.sqrt(c * c + d * d) * twoOverN;
      const muted = this.mutedStates[oscIdx];
      // Steady-state gain at the slot is volume × droneEnvelope.sustain;
      // multiply by masterScale to land on the analyzer-side amplitude.
      const aExpected = (muted ? 0 : (this.volumeValues[oscIdx] || 0)) * droneSustain * masterScale;
      const confidence = aExpected > 1e-6 ? Math.min(1, aLsq / aExpected) : 0;
      if (confidence < 1e-3) continue; // accumulator owns it this frame

      const thetaAt0 = Math.atan2(d, c);
      const omega = TWO_PI * cache.oscs[i].f / sampleRate;
      const phaseAtEnd = thetaAt0 + omega * (N - 1);
      const phaseLsq = ((phaseAtEnd % TWO_PI) + TWO_PI) % TWO_PI;
      const phaseAcc = this.phases[oscIdx] || 0;
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
      this.phases[oscIdx] = next;
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

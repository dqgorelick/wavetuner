/**
 * KeyboardVoiceManager - Polyphonic transient-voice pool for the keyboard.
 *
 * Each voice = OscillatorNode → GainNode (envelope) → StereoPannerNode
 * → masterGainNode (shared with the drone). Voices are spawned on
 * noteOn and stopped after release tail.
 *
 * Voice identity is (slot, octave) — the drone slot resolved at noteOn
 * from the pressed key's scale degree. Holding a key while the user
 * drags an orb past another lets the held voice track the ORIGINALLY-
 * pressed orb instead of jumping to whichever drone now occupies that
 * scale degree (see `pitchForSlotAndOctave` in Tuning). Degree is also
 * stored, but only as metadata for visualizers — retunes go via slot.
 * midiNote is stored to match noteOff back to the right voice. Pan is
 * captured at note-on from the drone's L/R routing for the slot, then
 * static for the voice's lifetime (per the v1 panning rule).
 *
 * Voice cap is 32. When exceeded, prefer stealing an already-released
 * voice; if none, fast-fade-out the oldest held voice over ~10 ms.
 *
 * Sustain pedal (CC 64): when held, noteOff defers the release until the
 * pedal lifts — held-voice IDs accumulate in `pendingReleases`.
 */

import audioEngine from './AudioEngine';
import tuning from './Tuning';
import { keyboardEnvelope } from './Envelope';
import { keyboardWave } from './Wave';
import { stereoWidth } from './StereoWidth';

const MAX_VOICES = 32;
const RETUNE_TAU = 0.016; // matches drone's setTargetAtTime tau
const STEAL_FADE = 0.01;  // 10 ms fast fade for stolen held voices
// Tau for re-panning live voices on width/mode change. ~50 ms reads as a
// smooth glide rather than a jump but is fast enough that dragging the
// width slider feels live.
const PAN_RAMP_TAU = 0.05;
const TWO_PI = Math.PI * 2;

class KeyboardVoiceManager {
  constructor() {
    if (KeyboardVoiceManager.instance) return KeyboardVoiceManager.instance;

    this.voices = [];
    this.sustainPedalDown = false;
    this.pendingReleases = new Set(); // voice IDs awaiting pedal-up release
    this._nextVoiceId = 0;
    // Hold mode: pressing a key latches it on; pressing the same key
    // again toggles it off. Differs from a sustain pedal in that EACH
    // key independently toggles — there's no global "release all".
    // Voices spawned while hold is on get `_latched = true`; noteOff
    // ignores latched voices (the audio thread's noteOff equivalent is
    // a second noteOn on the same midi).
    this._hold = false;

    // Velocity curve preset. Applied to the 0-1 input velocity before it
    // becomes the envelope peak. 'linear' = identity (pre-existing behavior).
    this._velocityCurve = 'linear';

    // Lazy subscriptions so the audio context can come up first.
    this._tuningUnsubscribe = null;
    this._envelopeUnsubscribe = null;
    this._waveUnsubscribe = null;
    this._widthUnsubscribe = null;

    KeyboardVoiceManager.instance = this;
  }

  _ensureTuningSubscribed() {
    if (this._tuningUnsubscribe) return;
    this._tuningUnsubscribe = tuning.onChange(() => this._retuneAllVoices());
  }

  _ensureEnvelopeSubscribed() {
    if (this._envelopeUnsubscribe) return;
    this._envelopeUnsubscribe = keyboardEnvelope.onChange(() => this._retargetVoiceSustain());
  }

  _ensureWaveSubscribed() {
    if (this._waveUnsubscribe) return;
    this._waveUnsubscribe = keyboardWave.onChange(() => this._reapplyVoiceWave());
  }

  // Width / mode subscription. Repans every live voice on either:
  //   - mode flip (lr ↔ voicepan): voices switch from per-degree L/R
  //     to random spread (or back), so held notes follow without
  //     waiting for the next note-on
  //   - width drag in voicepan mode: re-randomizes positions live
  //   - width drag in lr mode: bus crossfeed handles the narrowing,
  //     but we still re-trigger _repanAllVoices to keep the panner
  //     values consistent (cheap, no-op effect on hard-panned voices)
  _ensureWidthSubscribed() {
    if (this._widthUnsubscribe) return;
    this._widthUnsubscribe = stereoWidth.onChange(() => this._repanAllVoices());
  }

  /**
   * Glide every live voice's pan to its current target — random in
   * [-width,+width] for voicepan, per-degree L/R for lr. Tau is 50 ms
   * so a slider drag feels live but doesn't zip.
   */
  _repanAllVoices() {
    const ctx = audioEngine.audioContext;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const v of this.voices) {
      const target = stereoWidth.mode === 'voicepan'
        ? stereoWidth.randomPan()
        : this._panForDegree(v.degree);
      v.panner.pan.setTargetAtTime(target, t, PAN_RAMP_TAU);
    }
  }

  /**
   * Re-apply the morphed waveform to every running voice (held + in
   * release tail) when the keyboard wave slider moves. setPeriodicWave
   * on a running oscillator preserves phase in practice on Chrome and
   * Safari.
   */
  _reapplyVoiceWave() {
    const ctx = audioEngine.audioContext;
    if (!ctx) return;
    const wave = keyboardWave.getPeriodicWave(ctx);
    if (!wave) return;
    for (const v of this.voices) {
      v.osc.setPeriodicWave(wave);
    }
  }

  /**
   * Glide every non-released voice toward peak·sustain after a sustain
   * change. A voice mid-attack/mid-decay abandons its scheduled ramp
   * and heads straight for the new sustain target — accepted as second-
   * order: sustain dragging is exploratory, not performative.
   */
  _retargetVoiceSustain() {
    const ctx = audioEngine.audioContext;
    if (!ctx) return;
    for (const v of this.voices) {
      if (v.released) continue;
      keyboardEnvelope.retargetSustain(v.gain.gain, ctx, v.peak);
    }
  }

  /**
   * Push a freq update into every active (held or releasing) voice from
   * the current tuning. Resolved via the voice's bound SLOT (not its
   * degree) so a held note follows the orb the user originally pressed
   * even if a mid-drag reorder shuffles the degree-to-slot map. If the
   * voice's slot was removed (drone count reduced past it), the voice
   * keeps its previous freq.
   */
  _retuneAllVoices() {
    const ctx = audioEngine.audioContext;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const voice of this.voices) {
      const raw = tuning.pitchForSlotAndOctave(voice.slot, voice.octave);
      if (raw === null) continue;
      const newFreq = Math.max(0.001, Math.min(20000, raw));
      voice.osc.frequency.setTargetAtTime(newFreq, now, RETUNE_TAU);
      voice.targetFreq = newFreq;
    }
  }

  setHold(on) {
    const wasHold = this._hold;
    this._hold = !!on;
    if (!wasHold && this._hold) {
      // Turning hold ON — latch every voice that's currently sounding so
      // the user can lift their fingers and the held chord persists.
      // Voices in their release tail are skipped (they're already on
      // their way out — re-latching would make hold feel sticky).
      for (const v of this.voices) {
        if (!v.released) v._latched = true;
      }
    } else if (wasHold && !this._hold) {
      // Turning hold OFF releases everything that was latched, since
      // there's no real "press" holding those voices anymore.
      for (const v of this.voices) {
        if (v._latched && !v.released) this._releaseVoice(v);
        if (v) v._latched = false;
      }
    }
  }

  getHold() { return this._hold; }

  setVelocityCurve(curve) {
    if (typeof curve !== 'string') return;
    this._velocityCurve = curve;
  }

  getVelocityCurve() { return this._velocityCurve; }

  // Map 0-1 raw velocity → 0-1 envelope peak per the active curve preset.
  _applyVelocityCurve(v) {
    const x = Math.max(0, Math.min(1, v));
    switch (this._velocityCurve) {
      case 'soft':  return x * x;          // quieter touches stay quiet
      case 'hard':  return Math.sqrt(x);   // flatten dynamics
      case 'fixed': return x > 0 ? 1 : 0;  // any non-zero hit → full
      case 'linear':
      default:      return x;
    }
  }

  noteOn(midiNote, velocity = 1) {
    if (!audioEngine.isInitialized) return null;
    // Gate input on the keyboard pool's enable state — toggling
    // "keyboard off" via the bottom-row play/stop button stops voices
    // from spawning (in addition to ramping the audio bus to 0).
    if (audioEngine.getKeyboardEnabled && !audioEngine.getKeyboardEnabled()) return null;

    // Hold-mode toggle: pressing a key that's already latched releases
    // it (with normal envelope release). Falls through to spawn a new
    // voice when no latched voice for this midi exists yet.
    if (this._hold) {
      const existing = this.voices.find(v =>
        v.midiNote === midiNote && !v.released && v._latched);
      if (existing) {
        this._releaseVoice(existing);
        return existing.id;
      }
    }

    const { audioContext: ctx, masterGainNode: dest } = audioEngine.getAudioBus();
    if (!ctx || !dest) return null;

    const dao = tuning.degreeAndOctaveForMidi(midiNote);
    if (!dao) return null; // empty scale
    const { degree, octave } = dao;
    // Resolve the drone slot at noteOn and bind the voice to it. Held
    // voices retune by slot (not degree), so dragging this orb past
    // another won't snap the held pitch onto the new degree-occupant.
    const slot = tuning.droneSlotForDegree(degree);
    if (slot < 0) return null;
    const rawFreq = tuning.pitchForSlotAndOctave(slot, octave);
    if (rawFreq === null) return null;
    // Clamp into the audible range — Z/X spamming or a high MIDI note
    // can otherwise push freq above Nyquist (silent + alias risk).
    const freq = Math.max(0.001, Math.min(20000, rawFreq));

    this._ensureTuningSubscribed();
    this._ensureEnvelopeSubscribed();
    this._ensureWaveSubscribed();
    this._ensureWidthSubscribed();

    if (this.voices.length >= MAX_VOICES) {
      this._stealVoice();
    }

    // Pan mode dictates note-on pan:
    //   - 'voicepan': fresh random in [-width, +width] (Oberheim-style)
    //   - 'lr': inherit the drone slot's L/R routing (legacy hard pan)
    const pan = stereoWidth.mode === 'voicepan'
      ? stereoWidth.randomPan()
      : this._panForDegree(degree);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner();

    // Apply the keyboard pool's current waveform shape before start so
    // the voice's first sample is already in the right shape.
    const wave = keyboardWave.getPeriodicWave(ctx);
    if (wave) osc.setPeriodicWave(wave);

    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    panner.pan.setValueAtTime(pan, ctx.currentTime);

    osc.connect(gain);
    gain.connect(panner);
    panner.connect(dest);

    // Velocity → envelope peak via the active curve preset. `peak` is
    // captured on the voice so a later sustain change can retarget held
    // notes to peak·newSustain.
    const peak = this._applyVelocityCurve(velocity);
    const t0 = ctx.currentTime;
    keyboardEnvelope.applyNoteOn(gain.gain, ctx, peak);

    osc.start();

    const voice = {
      id: this._nextVoiceId++,
      midiNote,
      degree,
      // Slot is the load-bearing identity for retunes. Degree is kept
      // alongside it for visualizers / debug — don't use it to look up
      // freq once the voice is alive.
      slot,
      octave,
      osc,
      gain,
      panner,
      peak,
      startTime: t0,
      released: false,
      _latched: this._hold,
      // Phase tracking — mirrors AudioEngine.updatePhases. `targetFreq`
      // is what we last asked the audio thread to ramp toward;
      // `smoothedFreq` is the same exponential approximation the audio
      // thread is doing internally (tau = RETUNE_TAU). The visualizer
      // integrates `smoothedFreq` so its phase tracks the actual
      // running oscillator across retunes.
      targetFreq: freq,
      smoothedFreq: freq,
      phase: 0,
      _lastPhaseUpdate: t0,
    };
    osc.onended = () => this._cleanupVoice(voice);
    this.voices.push(voice);
    return voice.id;
  }

  noteOff(midiNote) {
    // Most-recent un-released voice for this MIDI note. Latched voices
    // (hold mode) are skipped — those toggle via a second noteOn, not
    // via the corresponding noteOff event.
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.midiNote !== midiNote || v.released) continue;
      if (v._latched) continue;
      if (this.sustainPedalDown) {
        this.pendingReleases.add(v.id);
      } else {
        this._releaseVoice(v);
      }
      return;
    }
  }

  setSustainPedal(down) {
    const wasDown = this.sustainPedalDown;
    this.sustainPedalDown = !!down;
    if (wasDown && !down) {
      // Pedal lift — release everything that was waiting.
      for (const id of this.pendingReleases) {
        const v = this.voices.find(v => v.id === id);
        if (v && !v.released) this._releaseVoice(v);
      }
      this.pendingReleases.clear();
    }
  }

  _releaseVoice(voice) {
    if (voice.released) return;
    voice.released = true;
    const ctx = audioEngine.audioContext;
    // applyNoteOff captures the live gain value so a release mid-attack
    // doesn't jump to the sustain level before falling to 0. Returns the
    // absolute time the ramp lands so we can schedule osc.stop after a
    // 50 ms safety pad.
    const releaseEnd = keyboardEnvelope.applyNoteOff(voice.gain.gain, ctx);
    voice.osc.stop(releaseEnd + 0.05);
    // osc.onended will fire _cleanupVoice.
  }

  _stealVoice() {
    // Prefer a voice already in its release tail.
    const releasedVoice = this.voices.find(v => v.released);
    if (releasedVoice) {
      // Force-stop fast; cleanup runs via onended.
      try { releasedVoice.osc.stop(); } catch { /* already stopped */ }
      return;
    }
    if (this.voices.length === 0) return;
    // Steal oldest held voice with a fast fade.
    const oldest = this.voices[0];
    const ctx = audioEngine.audioContext;
    const t = ctx.currentTime;
    oldest.released = true;
    const cur = oldest.gain.gain.value;
    oldest.gain.gain.cancelScheduledValues(t);
    oldest.gain.gain.setValueAtTime(cur, t);
    oldest.gain.gain.linearRampToValueAtTime(0, t + STEAL_FADE);
    oldest.osc.stop(t + STEAL_FADE + 0.005);
  }

  _cleanupVoice(voice) {
    try { voice.osc.disconnect(); } catch { /* ignore */ }
    try { voice.gain.disconnect(); } catch { /* ignore */ }
    try { voice.panner.disconnect(); } catch { /* ignore */ }
    const idx = this.voices.indexOf(voice);
    if (idx >= 0) this.voices.splice(idx, 1);
    this.pendingReleases.delete(voice.id);
  }

  /**
   * Hard-pan inherited from the drone's L/R routing for the slot that
   * supplies this scale degree. L-only → −1, R-only → +1, both or
   * neither → 0. Used in 'lr' pan mode.
   */
  _panForDegree(degree) {
    const slot = tuning.droneSlotForDegree(degree);
    if (slot < 0) return 0;
    const channels = audioEngine.routingMap[slot] || [];
    const onLeft = channels.includes(0);
    const onRight = channels.includes(1);
    if (onLeft && !onRight) return -1;
    if (onRight && !onLeft) return 1;
    return 0;
  }

  /**
   * Currently-sounding voices (for visualizer / on-screen-keyboard glow).
   * Returns a fresh array of plain objects — safe to read without
   * worrying about mutation.
   */
  getActiveVoices() {
    return this.voices.map(v => ({
      id: v.id,
      midiNote: v.midiNote,
      degree: v.degree,
      // The slot the voice is actually sounding (bound at noteOn).
      // Consumers should prefer this over `tuning.droneSlotForDegree(v.degree)`
      // since the degree-to-slot map can shift mid-press when orbs reorder.
      slot: v.slot,
      octave: v.octave,
      released: v.released,
      amp: v.gain.gain.value,
    }));
  }

  /**
   * Advance every voice's phase accumulator to audioContext.currentTime.
   * Call once per visualizer frame, alongside audioEngine.updatePhases.
   * Each phase integrates an exponentially-smoothed target freq (same
   * tau the audio thread uses for setTargetAtTime), so the accumulator
   * stays aligned with the actual sounding oscillator across retunes.
   */
  updatePhases() {
    const ctx = audioEngine.audioContext;
    if (!ctx || this.voices.length === 0) return;
    const now = ctx.currentTime;
    for (const v of this.voices) {
      const dt = now - v._lastPhaseUpdate;
      if (dt <= 0) continue;
      v._lastPhaseUpdate = now;
      const alpha = 1 - Math.exp(-dt / RETUNE_TAU);
      v.smoothedFreq += (v.targetFreq - v.smoothedFreq) * alpha;
      v.phase = (v.phase + TWO_PI * v.smoothedFreq * dt) % TWO_PI;
    }
  }

  /**
   * Per-voice synthesis snapshot for the visualizer. Returns the live
   * envelope amp + pan reads from the audio nodes plus the phase /
   * smoothed freq updated by the most recent updatePhases() call.
   */
  getVoicesForSynth() {
    const out = [];
    for (const v of this.voices) {
      const amp = v.gain.gain.value;
      if (amp <= 0) continue;
      out.push({
        freq: v.smoothedFreq,
        phase: v.phase,
        amp,
        pan: v.panner.pan.value,
        // Voice is bound to a drone slot at noteOn — visualizers color
        // the voice's trace from the slot's palette entry so the trace
        // matches the orb being held. Slot-bound (not degree) so the
        // color stays put when a mid-drag reorder shuffles degrees.
        slot: v.slot,
        degree: v.degree,
      });
    }
    return out;
  }
}

const keyboardVoiceManager = new KeyboardVoiceManager();
export default keyboardVoiceManager;

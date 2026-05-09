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
import { keyboardStereo } from './StereoMode';

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

  // Mode + curve subscription:
  //   - mode flip (lr ↔ stereo): voices glide to their new pan target
  //     AND retune to honor the curve (detune is 0 in lr).
  //   - detune master / curve change: voices retune to the new
  //     curve[slot] × detuneHz. Live editing of the curve propagates
  //     to held voices so the user hears the shape immediately.
  _ensureWidthSubscribed() {
    if (this._widthUnsubscribe) return;
    this._widthUnsubscribe = keyboardStereo.onChange((_inst, info) => {
      if (!info) return;
      if (info.kind === 'mode') {
        this._repanAllVoices();
        this._reapplyVoiceDetune();
      } else if (info.kind === 'detune' || info.kind === 'curve') {
        this._reapplyVoiceDetune();
      }
    });
  }

  /**
   * Recompute every held voice's detune from keyboardStereo.detuneHzAt
   * (slot) and ramp its oscillator to the new played freq. Tau matches
   * the noteOn retune tau.
   */
  _reapplyVoiceDetune() {
    const ctx = audioEngine.audioContext;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const voice of this.voices) {
      const newDetune = keyboardStereo.detuneHzAt(voice.slot);
      voice.detuneHz = newDetune;
      const raw = tuning.pitchForSlotAndOctave(voice.slot, voice.octave);
      if (raw === null) continue;
      if (voice._isStereo) {
        const half = newDetune / 2;
        const fL = Math.max(0.001, Math.min(20000, raw + half));
        const fR = Math.max(0.001, Math.min(20000, raw - half));
        voice.osc.frequency.setTargetAtTime(fL, now, RETUNE_TAU);
        voice.targetFreq = fL;
        if (voice.oscR) {
          voice.oscR.frequency.setTargetAtTime(fR, now, RETUNE_TAU);
          voice.targetFreqR = fR;
        }
      } else {
        const newFreq = Math.max(0.001, Math.min(20000, raw + newDetune));
        voice.osc.frequency.setTargetAtTime(newFreq, now, RETUNE_TAU);
        voice.targetFreq = newFreq;
      }
    }
  }

  /**
   * Glide every live voice's pan to its current target — 0 (centered,
   * equal L+R) in 'stereo' mode, per-degree hard pan in 'lr'. Tau is
   * 50 ms so a mode flip feels live but doesn't zip.
   */
  _repanAllVoices() {
    const ctx = audioEngine.audioContext;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const v of this.voices) {
      // Stereo voices use a ChannelMerger and have no panner — their
      // L/R split is baked into the topology. Only single-osc (lr)
      // voices have a panner to retarget.
      if (!v.panner) continue;
      const target = keyboardStereo.mode === 'stereo'
        ? 0
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
      if (v._isStereo && v.oscR) v.oscR.setPeriodicWave(wave);
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
      if (v._isStereo && v.gainR) {
        keyboardEnvelope.retargetSustain(v.gainR.gain, ctx, v.peak);
      }
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
      const detune = voice.detuneHz || 0;
      if (voice._isStereo) {
        const half = detune / 2;
        const fL = Math.max(0.001, Math.min(20000, raw + half));
        const fR = Math.max(0.001, Math.min(20000, raw - half));
        voice.osc.frequency.setTargetAtTime(fL, now, RETUNE_TAU);
        voice.targetFreq = fL;
        if (voice.oscR) {
          voice.oscR.frequency.setTargetAtTime(fR, now, RETUNE_TAU);
          voice.targetFreqR = fR;
        }
      } else {
        const newFreq = Math.max(0.001, Math.min(20000, raw + detune));
        voice.osc.frequency.setTargetAtTime(newFreq, now, RETUNE_TAU);
        voice.targetFreq = newFreq;
      }
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

    // Detune from keyboardStereo's curve — deterministic per slot. In
    // stereo mode this becomes the L↑/R↓ spread (each side ±detune/2).
    // In lr mode the curve returns 0, so the voice plays clean tuning.
    const detuneHz = keyboardStereo.detuneHzAt(slot);
    const isStereo = keyboardStereo.mode === 'stereo';

    // Velocity → envelope peak. Captured on the voice so a later
    // sustain change can retarget held notes to peak·newSustain.
    const peak = this._applyVelocityCurve(velocity);
    const t0 = ctx.currentTime;
    const wave = keyboardWave.getPeriodicWave(ctx);

    let voice;

    if (isStereo) {
      // Dual-osc topology: primary plays freq + detune/2 → L only,
      // partner plays freq - detune/2 → R only. ChannelMerger routes
      // each gain output to its dedicated channel (no panner needed).
      const oscL = ctx.createOscillator();
      const gainL = ctx.createGain();
      const oscR = ctx.createOscillator();
      const gainR = ctx.createGain();
      const merger = ctx.createChannelMerger(2);
      if (wave) {
        oscL.setPeriodicWave(wave);
        oscR.setPeriodicWave(wave);
      }
      const halfDetune = detuneHz / 2;
      const freqL = Math.max(0.001, Math.min(20000, freq + halfDetune));
      const freqR = Math.max(0.001, Math.min(20000, freq - halfDetune));
      oscL.frequency.setValueAtTime(freqL, t0);
      oscR.frequency.setValueAtTime(freqR, t0);
      oscL.connect(gainL);
      oscR.connect(gainR);
      gainL.connect(merger, 0, 0); // L only
      gainR.connect(merger, 0, 1); // R only
      merger.connect(dest);
      // Both gains get the same envelope ramp — they share peak/sustain
      // values but are separate AudioParams since they're on different
      // GainNodes. applyNoteOn with the same params on both produces
      // matching ramps.
      keyboardEnvelope.applyNoteOn(gainL.gain, ctx, peak);
      keyboardEnvelope.applyNoteOn(gainR.gain, ctx, peak);
      oscL.start();
      oscR.start();

      voice = {
        id: this._nextVoiceId++,
        midiNote, degree, slot, octave, peak,
        startTime: t0, released: false, _latched: this._hold,
        detuneHz,
        _isStereo: true,
        osc: oscL, gain: gainL,           // primary (L)
        oscR, gainR,                       // partner (R)
        merger, panner: null,              // merger replaces panner
        // Phase tracking for both oscs. The synth visualizer reads
        // both via getVoicesForSynth so the lissajous shows the L≠R
        // beating between the two.
        targetFreq: freqL, smoothedFreq: freqL, phase: 0, _lastPhaseUpdate: t0,
        targetFreqR: freqR, smoothedFreqR: freqR, phaseR: 0, _lastPhaseUpdateR: t0,
      };
      // Either osc completing (release tail end) is the trigger to clean
      // up the whole voice — we stop both at the same scheduled time so
      // the second onended is harmless.
      oscL.onended = () => this._cleanupVoice(voice);
    } else {
      // Single-osc topology (lr mode): osc → gain → panner → dest.
      // Inherits the drone slot's L/R routing for the hard pan position.
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const panner = ctx.createStereoPanner();
      if (wave) osc.setPeriodicWave(wave);
      const playedFreq = Math.max(0.001, Math.min(20000, freq + detuneHz));
      osc.frequency.setValueAtTime(playedFreq, t0);
      panner.pan.setValueAtTime(this._panForDegree(degree), t0);
      osc.connect(gain);
      gain.connect(panner);
      panner.connect(dest);
      keyboardEnvelope.applyNoteOn(gain.gain, ctx, peak);
      osc.start();

      voice = {
        id: this._nextVoiceId++,
        midiNote, degree, slot, octave, peak,
        startTime: t0, released: false, _latched: this._hold,
        detuneHz,
        _isStereo: false,
        osc, gain, panner,
        oscR: null, gainR: null, merger: null,
        targetFreq: playedFreq, smoothedFreq: playedFreq, phase: 0, _lastPhaseUpdate: t0,
      };
      osc.onended = () => this._cleanupVoice(voice);
    }

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
    // doesn't jump to the sustain level. Returns the absolute time the
    // ramp lands; osc.stop scheduled with a 50 ms safety pad.
    const releaseEnd = keyboardEnvelope.applyNoteOff(voice.gain.gain, ctx);
    voice.osc.stop(releaseEnd + 0.05);
    if (voice._isStereo && voice.oscR) {
      // Both gains share the same envelope state, so applyNoteOff on
      // gainR returns the same releaseEnd. Stop the partner osc at the
      // same time so the voice goes silent simultaneously on L and R.
      keyboardEnvelope.applyNoteOff(voice.gainR.gain, ctx);
      voice.oscR.stop(releaseEnd + 0.05);
    }
    // osc.onended (primary) will fire _cleanupVoice for the whole voice.
  }

  _stealVoice() {
    // Prefer a voice already in its release tail.
    const releasedVoice = this.voices.find(v => v.released);
    if (releasedVoice) {
      // Force-stop fast; cleanup runs via onended.
      try { releasedVoice.osc.stop(); } catch { /* already stopped */ }
      if (releasedVoice._isStereo && releasedVoice.oscR) {
        try { releasedVoice.oscR.stop(); } catch { /* already stopped */ }
      }
      return;
    }
    if (this.voices.length === 0) return;
    // Steal oldest held voice with a fast fade.
    const oldest = this.voices[0];
    const ctx = audioEngine.audioContext;
    const t = ctx.currentTime;
    oldest.released = true;
    const fadeGain = (g) => {
      const cur = g.gain.value;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(cur, t);
      g.gain.linearRampToValueAtTime(0, t + STEAL_FADE);
    };
    fadeGain(oldest.gain);
    oldest.osc.stop(t + STEAL_FADE + 0.005);
    if (oldest._isStereo && oldest.oscR) {
      fadeGain(oldest.gainR);
      oldest.oscR.stop(t + STEAL_FADE + 0.005);
    }
  }

  _cleanupVoice(voice) {
    try { voice.osc.disconnect(); } catch { /* ignore */ }
    try { voice.gain.disconnect(); } catch { /* ignore */ }
    if (voice.panner) {
      try { voice.panner.disconnect(); } catch { /* ignore */ }
    }
    if (voice._isStereo) {
      try { voice.oscR && voice.oscR.disconnect(); } catch { /* ignore */ }
      try { voice.gainR && voice.gainR.disconnect(); } catch { /* ignore */ }
      try { voice.merger && voice.merger.disconnect(); } catch { /* ignore */ }
    }
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
      if (dt > 0) {
        v._lastPhaseUpdate = now;
        const alpha = 1 - Math.exp(-dt / RETUNE_TAU);
        v.smoothedFreq += (v.targetFreq - v.smoothedFreq) * alpha;
        v.phase = (v.phase + TWO_PI * v.smoothedFreq * dt) % TWO_PI;
      }
      if (v._isStereo) {
        const dtR = now - v._lastPhaseUpdateR;
        if (dtR > 0) {
          v._lastPhaseUpdateR = now;
          const alphaR = 1 - Math.exp(-dtR / RETUNE_TAU);
          v.smoothedFreqR += (v.targetFreqR - v.smoothedFreqR) * alphaR;
          v.phaseR = (v.phaseR + TWO_PI * v.smoothedFreqR * dtR) % TWO_PI;
        }
      }
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
      if (amp > 0) {
        out.push({
          freq: v.smoothedFreq,
          phase: v.phase,
          amp,
          // Stereo voices have no panner — primary signal is hard
          // L (channel-merger routes gainL to channel 0). lr voices
          // read from the panner.
          pan: v._isStereo ? -1 : v.panner.pan.value,
          slot: v.slot,
          degree: v.degree,
        });
      }
      if (v._isStereo && v.gainR) {
        const ampR = v.gainR.gain.value;
        if (ampR > 0) {
          out.push({
            freq: v.smoothedFreqR,
            phase: v.phaseR,
            amp: ampR,
            pan: 1,        // partner is hard R
            slot: v.slot,
            degree: v.degree,
          });
        }
      }
    }
    return out;
  }
}

const keyboardVoiceManager = new KeyboardVoiceManager();
export default keyboardVoiceManager;

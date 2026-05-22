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
import { keyboardEnvelope, computerKbdEnvelope } from './Envelope';
import { keyboardWave } from './Wave';
import { keyboardStereo, midiStereo, stereoForSource } from './StereoMode';

// Pick the envelope that owns this source's attack/release shape. The
// kbd source runs AR-only off its own envelope so it doesn't share
// state with the velocity-sensitive MIDI envelope.
function envForSource(source) {
  return source === 'kbd' ? computerKbdEnvelope : keyboardEnvelope;
}

const MAX_VOICES = 32;             // hard ceiling across all sources
const DEFAULT_MAX_KBD = 2;         // computer-keyboard default polyphony
const DEFAULT_MAX_MIDI = 32;       // MIDI default polyphony (existing behavior)
const RETUNE_TAU = 0.016; // matches drone's setTargetAtTime tau
const STEAL_FADE = 0.01;  // 10 ms fast fade for stolen held voices (hard cap only)
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
    // Hold mode is per-source so the computer keyboard (expressive,
    // hold-on by default) and MIDI (press-and-hold by default) can run
    // with independent semantics. When a source's hold is on, voices it
    // spawns get `_latched = true`; that source's noteOff ignores those
    // voices and a second noteOn on the same midi releases them (toggle).
    this._holdBySource = { kbd: true, midi: false };

    // Per-source voice cap. Exceeding the cap RELEASES the oldest voice
    // of the same source (natural envelope tail) — the hard MAX_VOICES
    // ceiling above is the only path that uses fast-fade stealing.
    this._maxVoicesBySource = { kbd: DEFAULT_MAX_KBD, midi: DEFAULT_MAX_MIDI };

    // Re-press behavior for the kbd source when hold is engaged.
    //   'toggle'  — re-pressing a latched note releases it (default).
    //   'restart' — re-pressing releases the existing voice AND starts
    //               a fresh one ramping up from 0.
    this._kbdRepressMode = 'toggle';

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
  //
  // We subscribe to BOTH the kbd-source and midi-source stereo
  // instances. Each handler runs the same global resync (repan +
  // retune all voices) — since each voice picks its own source's
  // stereo controller inside those functions, MIDI voices ignore
  // keyboardStereo changes and vice versa.
  _ensureWidthSubscribed() {
    if (this._widthUnsubscribe) return;
    const handle = (_inst, info) => {
      if (!info) return;
      if (info.kind === 'mode') {
        this._repanAllVoices();
        this._reapplyVoiceDetune();
      } else if (info.kind === 'detune' || info.kind === 'curve') {
        this._reapplyVoiceDetune();
      }
    };
    const unsubKbd = keyboardStereo.onChange(handle);
    const unsubMidi = midiStereo.onChange(handle);
    this._widthUnsubscribe = () => { unsubKbd(); unsubMidi(); };
  }

  /**
   * Recompute every held voice's detune from keyboardStereo.detuneHzAt
   * (slot) and ramp its oscillator to the new played freq. Tau matches
   * the noteOn retune tau.
   */
  /**
   * Build the voice's partial stack — one audio osc per non-muted entry
   * in audioEngine.getExtraPartials(slot). Snapshots `ratio` + `vol`
   * at noteOn so live mixer edits on the parent slot don't retroactively
   * change a held voice's stack (user-confirmed Stage 3 decision).
   *
   * Each extra mirrors the primary's topology — stereo voices get a
   * dual-osc + merger per extra, lr voices get a single-osc + panner.
   * Envelope schedules use the same applyNoteOn with peak scaled by the
   * partial's vol so the partial's contribution sits at the user-set
   * mix balance.
   *
   * Muted partials are skipped at noteOn (no audio nodes built) — the
   * Stage 3 snapshot rule means an unmute mid-press wouldn't re-spawn
   * them anyway, so save the resources.
   */
  _buildVoiceExtras(voice, freq, dest, peak, source, ctx) {
    const slot = voice.slot;
    const detuneHz = voice.detuneHz || 0;
    const env = envForSource(source);
    const envMode = source === 'kbd' ? 'ar' : 'adsr';
    const wave = keyboardWave.getPeriodicWave(ctx);
    const t0 = ctx.currentTime;
    const isStereo = voice._isStereo;
    const pan = voice.panner ? this._panForDegree(voice.degree) : 0;

    const extras = [];
    const slotPartials = audioEngine.getExtraPartials(slot);
    for (const p of slotPartials) {
      if (p.muted) continue;
      const extraNominal = Math.max(0.001, Math.min(20000, freq * p.ratio));
      // Effective peak for this partial: voice peak (velocity-scaled or
      // 1.0 for kbd) × the partial's mixer vol. Snapshotted so a later
      // mixer drag on the parent's partial doesn't retroactively rebalance.
      const extraPeak = peak * (p.vol || 0);
      const entry = { ratio: p.ratio, partialVol: p.vol || 0 };
      if (isStereo) {
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
        const fL = Math.max(0.001, Math.min(20000, extraNominal + halfDetune));
        const fR = Math.max(0.001, Math.min(20000, extraNominal - halfDetune));
        oscL.frequency.setValueAtTime(fL, t0);
        oscR.frequency.setValueAtTime(fR, t0);
        oscL.connect(gainL);
        oscR.connect(gainR);
        gainL.connect(merger, 0, 0);
        gainR.connect(merger, 0, 1);
        merger.connect(dest);
        env.applyNoteOn(gainL.gain, ctx, extraPeak, null, envMode);
        env.applyNoteOn(gainR.gain, ctx, extraPeak, null, envMode);
        oscL.start();
        oscR.start();
        entry.osc = oscL; entry.gain = gainL;
        entry.oscR = oscR; entry.gainR = gainR;
        entry.merger = merger; entry.panner = null;
      } else {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const panner = ctx.createStereoPanner();
        if (wave) osc.setPeriodicWave(wave);
        const played = Math.max(0.001, Math.min(20000, extraNominal + detuneHz));
        osc.frequency.setValueAtTime(played, t0);
        panner.pan.setValueAtTime(pan, t0);
        osc.connect(gain);
        gain.connect(panner);
        panner.connect(dest);
        env.applyNoteOn(gain.gain, ctx, extraPeak, null, envMode);
        osc.start();
        entry.osc = osc; entry.gain = gain; entry.panner = panner;
        entry.oscR = null; entry.gainR = null; entry.merger = null;
      }
      extras.push(entry);
    }
    voice._extras = extras;
  }

  _reapplyVoiceDetune() {
    const ctx = audioEngine.audioContext;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const voice of this.voices) {
      const newDetune = stereoForSource(voice._source).detuneHzAt(voice.slot);
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
      // Extras follow the same shape, but nominal = raw * ratio. The
      // detune shift is applied additively, identical to the primary
      // path — same beat rate across partials.
      if (voice._extras) {
        for (const e of voice._extras) {
          const nominal = raw * e.ratio;
          if (voice._isStereo) {
            const half = newDetune / 2;
            const fL = Math.max(0.001, Math.min(20000, nominal + half));
            const fR = Math.max(0.001, Math.min(20000, nominal - half));
            if (e.osc) e.osc.frequency.setTargetAtTime(fL, now, RETUNE_TAU);
            if (e.oscR) e.oscR.frequency.setTargetAtTime(fR, now, RETUNE_TAU);
          } else {
            const newFreq = Math.max(0.001, Math.min(20000, nominal + newDetune));
            if (e.osc) e.osc.frequency.setTargetAtTime(newFreq, now, RETUNE_TAU);
          }
        }
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
      // voices have a panner to retarget. Per-source stereo lookup so
      // a kbd-mode flip doesn't repan held MIDI voices and vice versa.
      const target = stereoForSource(v._source).mode === 'stereo'
        ? 0
        : this._panForDegree(v.degree);
      if (v.panner) {
        v.panner.pan.setTargetAtTime(target, t, PAN_RAMP_TAU);
      }
      // Extras mirror the primary topology — lr extras have their own
      // panner; stereo extras have their own merger and no panner.
      if (v._extras) {
        for (const e of v._extras) {
          if (e.panner) e.panner.pan.setTargetAtTime(target, t, PAN_RAMP_TAU);
        }
      }
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
      if (v._extras) {
        for (const e of v._extras) {
          if (e.osc) e.osc.setPeriodicWave(wave);
          if (e.oscR) e.oscR.setPeriodicWave(wave);
        }
      }
    }
  }

  /**
   * Glide every non-released voice toward peak·sustain after a sustain
   * change. A voice mid-attack/mid-decay abandons its scheduled ramp
   * and heads straight for the new sustain target — accepted as second-
   * order: sustain dragging is exploratory, not performative.
   *
   * kbd-source voices are AR (no sustain stage) and held at whatever
   * gain the player dialed in, so the sustain slider doesn't apply to
   * them — they get skipped here.
   */
  _retargetVoiceSustain() {
    const ctx = audioEngine.audioContext;
    if (!ctx) return;
    for (const v of this.voices) {
      if (v.released) continue;
      if (v._source === 'kbd') continue;
      keyboardEnvelope.retargetSustain(v.gain.gain, ctx, v.peak);
      if (v._isStereo && v.gainR) {
        keyboardEnvelope.retargetSustain(v.gainR.gain, ctx, v.peak);
      }
      // Extras: their landing level is voice.peak × partialVol, so
      // retargetSustain gets called with that scaled peak.
      if (v._extras) {
        for (const e of v._extras) {
          const extraPeak = v.peak * e.partialVol;
          keyboardEnvelope.retargetSustain(e.gain.gain, ctx, extraPeak);
          if (e.gainR) keyboardEnvelope.retargetSustain(e.gainR.gain, ctx, extraPeak);
        }
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
      // Extras: nominal = raw * ratio, then detune applied the same way.
      // Ratios were snapshotted at noteOn so they don't drift mid-press.
      if (voice._extras) {
        for (const e of voice._extras) {
          const nominal = raw * e.ratio;
          if (voice._isStereo) {
            const half = detune / 2;
            const fL = Math.max(0.001, Math.min(20000, nominal + half));
            const fR = Math.max(0.001, Math.min(20000, nominal - half));
            if (e.osc) e.osc.frequency.setTargetAtTime(fL, now, RETUNE_TAU);
            if (e.oscR) e.oscR.frequency.setTargetAtTime(fR, now, RETUNE_TAU);
          } else {
            const newFreq = Math.max(0.001, Math.min(20000, nominal + detune));
            if (e.osc) e.osc.frequency.setTargetAtTime(newFreq, now, RETUNE_TAU);
          }
        }
      }
    }
  }

  setHold(on, source = 'midi') {
    const next = !!on;
    const wasHold = !!this._holdBySource[source];
    if (next === wasHold) return;
    this._holdBySource[source] = next;
    if (!wasHold && next) {
      // Turning hold ON for this source — latch every voice from this
      // source that's currently sounding so the user can lift their
      // fingers and the held chord persists. Voices in their release
      // tail are skipped (re-latching would make hold feel sticky).
      for (const v of this.voices) {
        if (v._source !== source) continue;
        if (!v.released) v._latched = true;
      }
    } else if (wasHold && !next) {
      // Turning hold OFF for this source releases its latched voices.
      for (const v of this.voices) {
        if (v._source !== source) continue;
        if (v._latched && !v.released) this._releaseVoice(v);
        if (v) v._latched = false;
      }
    }
  }

  getHold(source = 'midi') { return !!this._holdBySource[source]; }

  setMaxVoices(count, source = 'midi') {
    const n = Math.max(1, Math.min(MAX_VOICES, count | 0));
    this._maxVoicesBySource[source] = n;
  }

  getMaxVoices(source = 'midi') { return this._maxVoicesBySource[source]; }

  setKbdRepressMode(mode) {
    if (mode === 'toggle' || mode === 'restart') this._kbdRepressMode = mode;
  }

  getKbdRepressMode() { return this._kbdRepressMode; }

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

  noteOn(midiNote, velocity = 1, options = {}) {
    if (!audioEngine.isInitialized) return null;
    // Gate input on the keyboard pool's enable state — toggling
    // "keyboard off" via the bottom-row play/stop button stops voices
    // from spawning (in addition to ramping the audio bus to 0).
    if (audioEngine.getKeyboardEnabled && !audioEngine.getKeyboardEnabled()) return null;

    const source = options.source === 'kbd' ? 'kbd' : 'midi';
    const holdOn = !!this._holdBySource[source];

    // Hold-mode re-press: pressing a key that's already latched (from
    // the same source) either releases it ('toggle') or releases AND
    // restarts a fresh ramp ('restart'). 'restart' is only meaningful
    // for the kbd source; midi always toggles.
    if (holdOn) {
      const existing = this.voices.find(v =>
        v.midiNote === midiNote && !v.released && v._latched && v._source === source);
      if (existing) {
        this._releaseVoice(existing);
        if (!(source === 'kbd' && this._kbdRepressMode === 'restart')) {
          return existing.id;
        }
        // 'restart' falls through to spawn a new voice ramping from 0.
      }
    }

    const { audioContext: ctx, masterGainNode: dest } = audioEngine.getAudioBus({ source });
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

    // Source-aware soft cap: when exceeded, send the oldest voice OF
    // THE SAME SOURCE into its release tail (no abrupt fade). MAX_VOICES
    // is the absolute ceiling for the whole pool — only that path uses
    // fast-fade stealing.
    this._releaseOldestOfSource(source);
    if (this.voices.length >= MAX_VOICES) {
      this._stealVoice();
    }

    // Detune from this source's stereo curve — deterministic per slot.
    // In stereo mode this becomes the L↑/R↓ spread (each side ±detune/2).
    // In lr mode the curve returns 0, so the voice plays clean tuning.
    // kbd and midi sources have their own StereoMode instances so the
    // mixer can flip their pan modes independently.
    const stereo = stereoForSource(source);
    const detuneHz = stereo.detuneHzAt(slot);
    const isStereo = stereo.mode === 'stereo';

    // Velocity → envelope peak. Captured on the voice so a later
    // sustain change can retarget held notes to peak·newSustain.
    // For kbd source, peak always starts at 1.0 — the user "dials in"
    // their dynamic by how long they hold the key; freezeNote on keyup
    // captures the reached level and overwrites peak.
    // Equal-loudness compensation for stereo mode. With both L and R
    // channels running at peak the perceived loudness is ~√2× louder
    // than lr mode (which only fires one channel). Scaling per-side
    // peak by 1/√2 brings stereo back into line with lr. Bake into
    // voice.peak so retargetSustain and freezeToCurrent automatically
    // see the corrected value.
    const peakRaw = source === 'kbd' ? 1 : this._applyVelocityCurve(velocity);
    const peak = isStereo ? peakRaw / Math.sqrt(2) : peakRaw;
    // kbd voices run AR-only against their own envelope: ramp 0 → peak,
    // then hold at peak (no decay slump). MIDI keeps full ADSR off the
    // shared keyboardEnvelope.
    const env = envForSource(source);
    const envMode = source === 'kbd' ? 'ar' : 'adsr';
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
      env.applyNoteOn(gainL.gain, ctx, peak, null, envMode);
      env.applyNoteOn(gainR.gain, ctx, peak, null, envMode);
      oscL.start();
      oscR.start();

      voice = {
        id: this._nextVoiceId++,
        midiNote, degree, slot, octave, peak,
        startTime: t0, released: false, _latched: holdOn,
        _source: source,
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
      this._buildVoiceExtras(voice, freq, dest, peak, source, ctx);
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
      env.applyNoteOn(gain.gain, ctx, peak, null, envMode);
      osc.start();

      voice = {
        id: this._nextVoiceId++,
        midiNote, degree, slot, octave, peak,
        startTime: t0, released: false, _latched: holdOn,
        _source: source,
        detuneHz,
        _isStereo: false,
        osc, gain, panner,
        oscR: null, gainR: null, merger: null,
        targetFreq: playedFreq, smoothedFreq: playedFreq, phase: 0, _lastPhaseUpdate: t0,
      };
      osc.onended = () => this._cleanupVoice(voice);
      this._buildVoiceExtras(voice, freq, dest, peak, source, ctx);
    }

    this.voices.push(voice);
    return voice.id;
  }

  noteOff(midiNote, options = {}) {
    const source = options.source === 'kbd' ? 'kbd' : 'midi';
    // Most-recent un-released voice for this MIDI note from this source.
    // Latched voices (hold mode) are skipped — those toggle via a second
    // noteOn, not via the corresponding noteOff event.
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.midiNote !== midiNote || v.released) continue;
      if (v._source !== source) continue;
      if (v._latched) continue;
      if (this.sustainPedalDown) {
        this.pendingReleases.add(v.id);
      } else {
        this._releaseVoice(v);
      }
      return;
    }
  }

  /**
   * Release every voice (optionally filtered by source). Latched voices
   * count too — this is the "hard stop" path used when external state
   * upends what's playing (e.g. loading a patch swaps the scale, so any
   * held kbd notes were tuned to the OLD drones and should go silent
   * rather than retune to the new ones). Released voices fade over the
   * envelope's release time; cleanup happens via the usual onended.
   */
  releaseAll(source = null) {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.released) continue;
      if (source && v._source !== source) continue;
      this._releaseVoice(v);
    }
    // Pedal-pending releases no longer correspond to live voices.
    if (!source || source === 'midi') this.pendingReleases.clear();
  }

  /**
   * Force-release the active voice for `midiNote` from this source,
   * latched or not. Used by the on-screen keyboard for drag-leave —
   * dragging across a latched key should not leave a stuck voice
   * behind. Falls back to the same envelope-release ramp as noteOff.
   */
  releaseNote(midiNote, source = 'midi') {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.midiNote !== midiNote || v.released) continue;
      if (v._source !== source) continue;
      this._releaseVoice(v);
      return;
    }
  }

  /**
   * Snap the active kbd voice for `midiNote` to "frozen at current gain"
   * and retarget its sustain to current·sustain. Used by the computer-
   * keyboard expressive mode on keyup: the volume the user dialed in by
   * how long they held becomes the note's sustain level. The voice's
   * `peak` is rewritten to the captured gain so later sustain-slider
   * movements scale relative to the frozen level (consistent with the
   * peak·sustain math everywhere else).
   */
  freezeNote(midiNote, source = 'kbd') {
    const ctx = audioEngine.audioContext;
    if (!ctx) return;
    const env = envForSource(source);
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.midiNote !== midiNote || v.released) continue;
      if (v._source !== source) continue;
      const cur = env.freezeToCurrent(v.gain.gain, ctx);
      if (v._isStereo && v.gainR) {
        env.freezeToCurrent(v.gainR.gain, ctx);
      }
      v.peak = cur;
      return;
    }
  }

  /**
   * If this source already has its cap worth of non-released voices,
   * push the oldest one of THIS SOURCE into its release tail so a new
   * note can come in without an abrupt cut. The release uses the normal
   * envelope release time — caller invokes this before spawning.
   */
  _releaseOldestOfSource(source) {
    const cap = this._maxVoicesBySource[source] ?? MAX_VOICES;
    let count = 0;
    let oldest = null;
    for (const v of this.voices) {
      if (v._source !== source || v.released) continue;
      count += 1;
      if (oldest === null || v.startTime < oldest.startTime) oldest = v;
    }
    if (count >= cap && oldest) this._releaseVoice(oldest);
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
    // Use the voice's own source envelope so kbd voices stolen by the
    // kbd cap fade over the kbd release time, not the MIDI one.
    // applyNoteOff captures the live gain value so a release mid-attack
    // doesn't jump to the sustain level. Returns the absolute time the
    // ramp lands; osc.stop scheduled with a 50 ms safety pad.
    const env = envForSource(voice._source);
    const releaseEnd = env.applyNoteOff(voice.gain.gain, ctx);
    voice.osc.stop(releaseEnd + 0.05);
    if (voice._isStereo && voice.oscR) {
      // Both gains share the same envelope state, so applyNoteOff on
      // gainR returns the same releaseEnd. Stop the partner osc at the
      // same time so the voice goes silent simultaneously on L and R.
      env.applyNoteOff(voice.gainR.gain, ctx);
      voice.oscR.stop(releaseEnd + 0.05);
    }
    // Extras share the voice's envelope — release each one at the same
    // schedule so the whole stack fades together. osc.stop is set to
    // the same releaseEnd so all partial oscs go silent at the same
    // moment as the primary.
    if (voice._extras) {
      for (const e of voice._extras) {
        env.applyNoteOff(e.gain.gain, ctx);
        e.osc.stop(releaseEnd + 0.05);
        if (e.gainR) env.applyNoteOff(e.gainR.gain, ctx);
        if (e.oscR) e.oscR.stop(releaseEnd + 0.05);
      }
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
      if (releasedVoice._extras) {
        for (const e of releasedVoice._extras) {
          try { e.osc.stop(); } catch { /* already stopped */ }
          if (e.oscR) {
            try { e.oscR.stop(); } catch { /* already stopped */ }
          }
        }
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
    if (oldest._extras) {
      for (const e of oldest._extras) {
        fadeGain(e.gain);
        e.osc.stop(t + STEAL_FADE + 0.005);
        if (e.gainR) fadeGain(e.gainR);
        if (e.oscR) e.oscR.stop(t + STEAL_FADE + 0.005);
      }
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
    // Disconnect every extra. Each partial's osc was scheduled to stop
    // at the same time as the primary, so their own onended callbacks
    // would fire harmlessly — we don't wire them; the primary's
    // onended drives the single cleanup pass for the whole voice.
    if (voice._extras) {
      for (const e of voice._extras) {
        try { e.osc.disconnect(); } catch { /* ignore */ }
        try { e.gain.disconnect(); } catch { /* ignore */ }
        if (e.panner) {
          try { e.panner.disconnect(); } catch { /* ignore */ }
        }
        if (e.oscR) { try { e.oscR.disconnect(); } catch { /* ignore */ } }
        if (e.gainR) { try { e.gainR.disconnect(); } catch { /* ignore */ } }
        if (e.merger) { try { e.merger.disconnect(); } catch { /* ignore */ } }
      }
      voice._extras = null;
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
      // Source + start time let consumers (e.g. the mixer) compute when
      // the voice has finished its attack/decay ramp and is sitting at
      // sustain — the predicate depends on which envelope the source uses.
      source: v._source,
      startTime: v.startTime,
      // Velocity-scaled envelope peak. The mixer derives the steady-state
      // "where it lands" amp from this: peak·sustain for ADSR voices,
      // peak for AR (kbd) voices.
      peak: v.peak,
      // Sounding frequency for visualizers. For stereo voices the primary
      // (L) freq is exposed; the partner (R) sits at -detune/2 from this.
      freq: v.targetFreq,
    }));
  }

  /**
   * Set a held voice's steady-state level. `level` is on the same 0..1
   * scale as the displayed amp — i.e., what the user wants the voice to
   * settle at after the envelope finishes. The translation back to peak
   * depends on source: ADSR's peak·sustain landing means `peak = level /
   * sustain` (clamped at 1, capping the achievable level at `sustain`);
   * AR voices have no sustain multiplier so `peak = level`.
   *
   * The live gain is retargeted with the same setTargetAtTime path the
   * sustain slider uses, so an in-flight attack/decay smoothly redirects
   * to the new target without clicking. Released voices are ignored —
   * once a voice is in its release tail we can't reasonably re-grab it.
   */
  setVoiceLevel(voiceId, level) {
    const voice = this.voices.find(v => v.id === voiceId);
    if (!voice || voice.released) return;
    const ctx = audioEngine.audioContext;
    if (!ctx) return;

    const clamped = Math.max(0, Math.min(1, level));
    const env = envForSource(voice._source);

    if (voice._source === 'kbd') {
      voice.peak = clamped;
    } else {
      const s = env.sustain;
      voice.peak = s > 0.001 ? Math.min(1, clamped / s) : 1;
    }

    if (voice._source === 'kbd') {
      // AR mode: held level == peak (no sustain multiplier). Retarget
      // directly. Pinning the value first means a mid-attack drag won't
      // continue ramping toward the original peak.
      const SUSTAIN_TAU = 0.05;
      const applyTo = (param, targetPeak) => {
        const t = ctx.currentTime;
        param.cancelScheduledValues(t);
        param.setValueAtTime(param.value, t);
        param.setTargetAtTime(targetPeak, t, SUSTAIN_TAU);
      };
      applyTo(voice.gain.gain, voice.peak);
      if (voice._isStereo && voice.gainR) applyTo(voice.gainR.gain, voice.peak);
      // Extras land at voice.peak × partialVol. The mixer's voice
      // fader represents the primary's level; extras follow the same
      // peak change scaled by their snapshotted partialVol so the
      // stack stays balanced as the user drags.
      if (voice._extras) {
        for (const e of voice._extras) {
          const extraPeak = voice.peak * e.partialVol;
          applyTo(e.gain.gain, extraPeak);
          if (e.gainR) applyTo(e.gainR.gain, extraPeak);
        }
      }
    } else {
      // ADSR mode: reuse Envelope.retargetSustain so the glide tau and
      // schedule semantics match the SettingsPanel sustain slider.
      env.retargetSustain(voice.gain.gain, ctx, voice.peak);
      if (voice._isStereo && voice.gainR) {
        env.retargetSustain(voice.gainR.gain, ctx, voice.peak);
      }
      if (voice._extras) {
        for (const e of voice._extras) {
          const extraPeak = voice.peak * e.partialVol;
          env.retargetSustain(e.gain.gain, ctx, extraPeak);
          if (e.gainR) env.retargetSustain(e.gainR.gain, ctx, extraPeak);
        }
      }
    }
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

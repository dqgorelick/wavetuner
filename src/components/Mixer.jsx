import { memo, useEffect, useState } from 'react';
import audioEngine from '../audio/AudioEngine';
import keyboardVoiceManager from '../audio/KeyboardVoiceManager';
import { keyboardEnvelope } from '../audio/Envelope';
import palette, { useTheme } from '../theme/palette';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function freqToNote(freq) {
  if (freq <= 0) return { note: '--', octave: 0, cents: 0 };
  const semitonesFromA4 = 12 * Math.log2(freq / 440);
  const midiNote = Math.round(69 + semitonesFromA4);
  const cents = Math.round((semitonesFromA4 - (midiNote - 69)) * 100);
  const noteIndex = ((midiNote % 12) + 12) % 12;
  const octave = Math.floor(midiNote / 12) - 1;
  return { note: NOTE_NAMES[noteIndex], octave, cents };
}

function formatFreq(freq) {
  if (freq >= 10000) return `${(freq / 1000).toFixed(1)}k`;
  if (freq >= 1000) return `${(freq / 1000).toFixed(2)}k`;
  return freq.toFixed(2);
}

// "Audible" drone threshold. getAllVolumes returns 0-100, so 0.1 ≈ 0.001 in
// the 0-1 scale. Filters out near-zero strips so the mixer doesn't list a
// drone the user has faded all the way down.
const AUDIBLE_VOL = 0.1;

// "Audible" voice amp threshold (0-1 scale). Once a released voice's
// envelope tail decays below this, the strip is removed — keeps released
// voices on screen long enough to see the release ramp without leaving
// dead strips around once they're effectively silent.
const AUDIBLE_AMP = 0.001;

// Apply a value to whatever fader sits under (clientX, clientY). The drag
// model is intentionally hit-test driven (not pointer-capture driven) so
// the user can sweep vertically through the mixer and have each fader's
// value snap to the cursor X as it's crossed. Data attributes on the
// fader element identify the target (drone slot vs voice id); released
// voices opt out via data-released so a sweep skips them.
function applyAtPoint(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return;
  const fader = el.closest('.mixer-fader');
  if (!fader) return;
  if (fader.dataset.released === 'true') return;
  const rect = fader.getBoundingClientRect();
  const v = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const oscIdx = fader.getAttribute('data-osc-index');
  if (oscIdx !== null) {
    audioEngine.setVolume(Number(oscIdx), v);
    return;
  }
  const voiceId = fader.getAttribute('data-voice-id');
  if (voiceId !== null) {
    keyboardVoiceManager.setVoiceLevel(Number(voiceId), v);
  }
}

// Pointer-down on any fader starts the drag. Listeners live on document
// so the cursor can leave the panel and continue tracking — matching the
// detune-orb behavior. Released-voice rows bail out before listeners
// attach, so they can't initiate a sweep but they still receive
// applyAtPoint no-ops when swept over (handled inside setVoiceLevel).
function startMixerDrag(e) {
  if (e.currentTarget.dataset.released === 'true') return;
  e.preventDefault();
  applyAtPoint(e.clientX, e.clientY);
  const onMove = (ev) => applyAtPoint(ev.clientX, ev.clientY);
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
}

// Fader cell — thin track with a colored fill line and a ball at the
// active position. For drones, fill and ball share the same value (the
// drone is always at its set volume). For voices, fill = live envelope
// amp (animates), ball = steady-state target (peak·sustain or peak).
// Released voices hide the ball (no setpoint to grab during release).
const Fader = memo(function Fader({ dataAttrs, fill, ball, color, released }) {
  const fillPct = Math.max(0, Math.min(1, fill)) * 100;
  const ballPct = ball === null ? null : Math.max(0, Math.min(1, ball)) * 100;
  return (
    <div
      className={`mixer-fader ${released ? 'released' : ''}`}
      style={{ '--mixer-color': color }}
      onPointerDown={startMixerDrag}
      {...dataAttrs}
    >
      <div className="mixer-fader-track" />
      <div className="mixer-fader-fill" style={{ width: `${fillPct}%` }} />
      {ballPct !== null && (
        <div className="mixer-fader-ball" style={{ left: `${ballPct}%` }} />
      )}
    </div>
  );
});

// Per-row action cluster: remove, clone, octave-up, octave-down. Wired
// to the AudioEngine slot APIs. Lives outside the grid's fader cell so
// the buttons don't intercept fader drags; pointer-down on a button
// stops propagation so the cross-row sweep doesn't fire either.
const RowButtons = memo(function RowButtons({ slot, canRemove, canClone, onSlotsChange }) {
  const stopPointer = (e) => {
    // Buttons live inside the grid but outside .mixer-fader; the
    // global sweep handler wouldn't pick them up anyway. The
    // stopPropagation guard is defensive — preventing a future
    // mixer-level pointerdown from snagging on a button click.
    e.stopPropagation();
  };

  const handleRemove = () => {
    if (!canRemove) return;
    // Stale slot bindings on held kbd voices after the reindex — drop
    // them so the user doesn't hear a held note jump to a new pitch.
    keyboardVoiceManager.releaseAll();
    audioEngine.removeOscillatorAt(slot);
    onSlotsChange?.();
  };
  const handleClone = () => {
    if (!canClone) return;
    audioEngine.cloneOscillator(slot);
    onSlotsChange?.();
  };
  const handleOctave = (factor) => {
    const cur = audioEngine.getFrequency(slot);
    if (!Number.isFinite(cur)) return;
    const next = Math.max(0.1, Math.min(20000, cur * factor));
    audioEngine.setFrequency(slot, next);
  };

  return (
    <div className="mixer-row-buttons" onPointerDown={stopPointer}>
      <button
        type="button"
        className="mixer-btn"
        onClick={handleClone}
        disabled={!canClone}
        title="Clone (add a copy of this drone)"
        aria-label="Clone drone"
      >+</button>
      <button
        type="button"
        className="mixer-btn"
        onClick={() => handleOctave(2)}
        title="Up an octave"
        aria-label="Octave up"
      >↑</button>
      <button
        type="button"
        className="mixer-btn"
        onClick={() => handleOctave(0.5)}
        title="Down an octave"
        aria-label="Octave down"
      >↓</button>
      <button
        type="button"
        className="mixer-btn mixer-btn-remove"
        onClick={handleRemove}
        disabled={!canRemove}
        title="Remove this drone"
        aria-label="Remove drone"
      >×</button>
    </div>
  );
});

function Mixer({ oscillatorCount, minOscillators = 2, maxOscillators = 12, onSlotsChange }) {
  useTheme(); // re-render on theme flip so palette.oscColor swaps correctly

  // RAF-driven snapshot of audible drones + voices.
  //   drones: [{ slot, freq, vol }]
  //   voices: [{ id, slot, freq, amp, target, source, released }]
  // Drones are signature-compared so we don't re-render on sub-perceptual
  // jitter; voices skip signature dedup because amp moves every frame
  // (envelope ramp visualization).
  const [drones, setDrones] = useState([]);
  const [voices, setVoices] = useState([]);

  useEffect(() => {
    let raf;
    let lastDroneSig = '';
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!audioEngine.isInitialized) return;
      try {
        // Drones
        const freqs = audioEngine.getAllFrequencies();
        const vols100 = audioEngine.getAllVolumes(); // 0-100
        const muted = audioEngine.getAllMutedStates();
        const nextDrones = [];
        for (let i = 0; i < oscillatorCount; i++) {
          if (muted[i]) continue;
          const v100 = vols100[i] ?? 0;
          if (v100 <= AUDIBLE_VOL) continue;
          nextDrones.push({ slot: i, freq: freqs[i] ?? 0, vol: v100 / 100 });
        }
        const droneSig = nextDrones.map(d =>
          `${d.slot}:${Math.round(d.freq * 20)}:${Math.round(d.vol * 200)}`
        ).join('|');
        if (droneSig !== lastDroneSig) {
          lastDroneSig = droneSig;
          setDrones(nextDrones);
        }

        // Voices. Skip the released-and-already-silent ones so the strip
        // drops off as soon as the release tail is inaudible. Target is
        // the steady-state level the envelope will land on for held
        // voices — peak·sustain for ADSR, peak for AR.
        const active = keyboardVoiceManager.getActiveVoices();
        const sustain = keyboardEnvelope.sustain;
        const nextVoices = [];
        for (const v of active) {
          if (v.released && v.amp <= AUDIBLE_AMP) continue;
          const target = v.source === 'kbd' ? v.peak : v.peak * sustain;
          nextVoices.push({
            id: v.id,
            slot: v.slot,
            freq: v.freq,
            amp: v.amp,
            target,
            source: v.source,
            released: v.released,
          });
        }
        setVoices(nextVoices);
      } catch { /* ignore */ }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [oscillatorCount]);

  if (drones.length === 0 && voices.length === 0) return null;

  return (
    <div className="mixer-panel" role="region" aria-label="Mixer">
      <div className="mixer-stack">
        {/* Drones first in DOM order so column-reverse puts them at the
            bottom; voices follow and stack above as they spawn. The grid
            on .mixer-row keeps the fader column aligned across all rows
            regardless of whether the tag slot is populated. */}
        {drones.map(({ slot, freq, vol }) => {
          const color = palette.oscColor(slot, oscillatorCount);
          const note = freqToNote(freq);
          const cents = note.cents >= 0 ? `+${note.cents}` : `${note.cents}`;
          return (
            <div
              key={`drone-${slot}`}
              className="mixer-row mixer-row-drone"
              style={{ '--mixer-color': color }}
            >
              <span className="mixer-dot" />
              <span className="mixer-label">
                <span className="mixer-freq">{formatFreq(freq)}</span>
                <span className="mixer-note">{note.note}{note.octave}<span className="mixer-cents">{cents}</span></span>
              </span>
              <span className="mixer-source-tag mixer-source-tag-empty" />
              <Fader
                dataAttrs={{ 'data-osc-index': slot }}
                fill={vol}
                ball={vol}
                color={color}
                released={false}
              />
              <RowButtons
                slot={slot}
                canRemove={oscillatorCount > minOscillators}
                canClone={oscillatorCount < maxOscillators}
                onSlotsChange={onSlotsChange}
              />
            </div>
          );
        })}
        {voices.map(({ id, slot, freq, amp, target, source, released }) => {
          const color = palette.oscColor(slot, oscillatorCount);
          const note = freqToNote(freq);
          const cents = note.cents >= 0 ? `+${note.cents}` : `${note.cents}`;
          const tag = source === 'kbd' ? 'KBD' : 'MIDI';
          return (
            <div
              key={`voice-${id}`}
              className={`mixer-row mixer-row-voice ${released ? 'released' : ''}`}
              style={{ '--mixer-color': color }}
            >
              <span className="mixer-dot" />
              <span className="mixer-label">
                <span className="mixer-freq">{formatFreq(freq)}</span>
                <span className="mixer-note">{note.note}{note.octave}<span className="mixer-cents">{cents}</span></span>
              </span>
              <span className="mixer-source-tag" aria-label={`source ${tag}`}>{tag}</span>
              <Fader
                dataAttrs={{
                  'data-voice-id': id,
                  'data-released': released ? 'true' : 'false',
                }}
                fill={amp}
                ball={released ? null : target}
                color={color}
                released={released}
              />
              {/* Empty buttons slot — keeps the grid column count
                  consistent so the fader edges line up with drone
                  rows that have an active button cluster. */}
              <span className="mixer-row-buttons mixer-row-buttons-empty" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default memo(Mixer);

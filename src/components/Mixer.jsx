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

// Pretty-print a partial's ratio. Integer multipliers read "×N",
// reciprocals of integers read "÷N", anything else falls back to a
// truncated decimal so non-octave ratios still display compactly.
function formatRatio(r) {
  if (Math.abs(r - 1) < 1e-6) return '×1';
  if (r > 1) {
    if (Math.abs(r - Math.round(r)) < 1e-6) return `×${Math.round(r)}`;
    return `×${r.toFixed(2)}`;
  }
  const inv = 1 / r;
  if (Math.abs(inv - Math.round(inv)) < 1e-6) return `÷${Math.round(inv)}`;
  return `×${r.toFixed(2)}`;
}

// "Audible" voice amp threshold (0-1 scale). Once a released voice's
// envelope tail decays below this, the strip is removed — keeps released
// voices on screen long enough to see the release ramp without leaving
// dead strips around once they're effectively silent.
const AUDIBLE_AMP = 0.001;

// Apply a value to whatever fader sits under (clientX, clientY). The drag
// model is intentionally hit-test driven (not pointer-capture driven) so
// the user can sweep vertically through the mixer and have each fader's
// value snap to the cursor X as it's crossed. Data attributes on the
// fader element identify the target: drone slot, partial (slot+index),
// or voice. Released voices opt out via data-released so a sweep skips
// them.
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
  const partialSlot = fader.getAttribute('data-partial-slot');
  if (partialSlot !== null) {
    const pIdx = fader.getAttribute('data-partial-index');
    if (pIdx !== null) {
      audioEngine.setPartialVolume(Number(partialSlot), Number(pIdx), v);
    }
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
// active position. For drones / partials, fill and ball share the same
// value. For voices, fill = live envelope amp (animates), ball =
// steady-state target. Released voices hide the ball.
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

// Buttons cluster for a drone primary row. Only the mute toggle
// remains in the mixer — octave shifts moved into the tuning panel,
// next to the per-slot Hz/ratio inputs.
const PrimaryButtons = memo(function PrimaryButtons({ slot }) {
  const stopPointer = (e) => e.stopPropagation();

  const handleMute = () => {
    audioEngine.toggleMute(slot);
  };

  return (
    <div className="mixer-row-buttons mixer-row-buttons-voice" onPointerDown={stopPointer}>
      <button
        type="button"
        className="mixer-btn mixer-btn-mute"
        onClick={handleMute}
        title="Mute this drone"
        aria-label="Mute drone"
      >×</button>
    </div>
  );
});

// Buttons cluster for a partial row. Clone adds a sibling partial.
// Octave shifts the partial's ratio (×2 / ÷2). Remove drops just this
// partial — its parent slot stays.
const PartialButtons = memo(function PartialButtons({ slot, partialIndex }) {
  const stopPointer = (e) => e.stopPropagation();

  const handleClone = () => {
    audioEngine.addPartial(slot);
  };
  const handleOctave = (factor) => {
    // The engine snapshots ratio inside setPartialRatio; pull current
    // off getExtraPartials so successive presses compound correctly.
    const list = audioEngine.getExtraPartials(slot);
    const cur = list[partialIndex]?.ratio;
    if (!Number.isFinite(cur)) return;
    audioEngine.setPartialRatio(slot, partialIndex, cur * factor);
  };
  const handleRemove = () => {
    audioEngine.removePartialAt(slot, partialIndex);
  };

  return (
    <div className="mixer-row-buttons" onPointerDown={stopPointer}>
      <button
        type="button"
        className="mixer-btn"
        onClick={handleClone}
        title="Add another partial to this drone"
        aria-label="Add partial"
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
        title="Remove this partial"
        aria-label="Remove partial"
      >×</button>
    </div>
  );
});

function Mixer({ oscillatorCount }) {
  useTheme(); // re-render on theme flip so palette.oscColor swaps correctly

  // RAF-driven snapshot of mixer rows.
  //   rows: flat list of { type: 'drone' | 'partial', ... }
  //         DOM order: per audible slot, partials first then primary.
  //         column-reverse in CSS flips this so primary visually sits on
  //         top of its partials, newest partial right beneath it.
  //   voices: separate list, appended after rows in DOM (voices appear
  //           at the visual top of the mixer).
  const [rows, setRows] = useState([]);
  const [voices, setVoices] = useState([]);

  useEffect(() => {
    let raf;
    let lastRowSig = '';
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!audioEngine.isInitialized) return;
      try {
        const freqs = audioEngine.getAllFrequencies();
        const vols100 = audioEngine.getAllVolumes(); // 0-100
        const muted = audioEngine.getAllMutedStates();
        // Global drone on/off — the "Turn drones off" button in the
        // oscillator controls flips this without touching per-slot
        // mutedStates. When it's off the mixer hides every drone (and
        // its partials) since none of them are audible; voices remain
        // because they ride a separate bus.
        const droneBusOff = audioEngine.droneEnabled === false;
        const nextRows = [];
        for (let i = 0; i < oscillatorCount; i++) {
          // Only audible drones appear in the mixer. Muting a single
          // drone (× in its button cluster) removes its row; flipping
          // the global drone toggle off removes all of them. Re-enabling
          // happens via the spectrum bar (per-slot) or the drone toggle
          // (global). Volume === 0 is NOT the same as muted: a silent-
          // but-unmuted row still renders so the user can find and
          // raise it. Partials of a hidden drone are dropped with it.
          const baseFreq = freqs[i] ?? 0;
          const v100 = vols100[i] ?? 0;
          const isMuted = !!muted[i];
          if (droneBusOff || isMuted) continue;
          // Partials first in DOM so column-reverse puts the primary
          // on top of its partials. Always show every extra of an
          // audible primary — even silent/muted ones — so the user
          // can re-enable without re-finding the row.
          const extras = audioEngine.getExtraPartials(i);
          for (const p of extras) {
            nextRows.push({
              type: 'partial',
              id: p.id,
              slot: i,
              partialIndex: p.partialIndex,
              ratio: p.ratio,
              freq: baseFreq * p.ratio,
              vol: p.vol,
              muted: p.muted,
            });
          }
          nextRows.push({
            type: 'drone',
            slot: i,
            freq: baseFreq,
            vol: v100 / 100,
            muted: isMuted,
          });
        }

        const rowSig = nextRows.map(r => r.type === 'drone'
          ? `d:${r.slot}:${Math.round(r.freq * 20)}:${Math.round(r.vol * 200)}:${r.muted ? 1 : 0}`
          : `p:${r.id}:${Math.round(r.freq * 20)}:${Math.round(r.vol * 200)}:${r.muted ? 1 : 0}:${r.ratio.toFixed(4)}`
        ).join('|');
        if (rowSig !== lastRowSig) {
          lastRowSig = rowSig;
          setRows(nextRows);
        }

        // Voices.
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
            midiNote: v.midiNote,
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

  if (rows.length === 0 && voices.length === 0) return null;

  return (
    <div className="mixer-panel" role="region" aria-label="Mixer">
      <div className="mixer-stack">
        {rows.map((row) => {
          if (row.type === 'drone') {
            const { slot, freq, vol, muted } = row;
            const color = palette.oscColor(slot, oscillatorCount);
            const note = freqToNote(freq);
            const cents = note.cents >= 0 ? `+${note.cents}` : `${note.cents}`;
            return (
              <div
                key={`drone-${slot}`}
                className={`mixer-row mixer-row-drone ${muted ? 'muted' : ''}`}
                style={{ '--mixer-color': color }}
              >
                <span className="mixer-marker">D{slot + 1}</span>
                <span className="mixer-freq">{formatFreq(freq)}</span>
                <span className="mixer-note">{note.note}{note.octave}<span className="mixer-cents">{cents}</span></span>
                <span className="mixer-source-tag mixer-source-tag-empty" />
                <Fader
                  dataAttrs={{ 'data-osc-index': slot }}
                  fill={vol}
                  ball={vol}
                  color={color}
                  released={false}
                />
                <PrimaryButtons slot={slot} />
              </div>
            );
          }
          // partial row
          const { id, slot, partialIndex, ratio, freq, vol, muted } = row;
          const color = palette.oscColor(slot, oscillatorCount);
          const note = freqToNote(freq);
          const cents = note.cents >= 0 ? `+${note.cents}` : `${note.cents}`;
          return (
            <div
              key={`partial-${id}`}
              className={`mixer-row mixer-row-partial ${muted ? 'muted' : ''}`}
              style={{ '--mixer-color': color }}
            >
              <span className="mixer-dot mixer-dot-partial" />
              <span className="mixer-freq">{formatFreq(freq)}</span>
              <span className="mixer-note">{note.note}{note.octave}<span className="mixer-cents">{cents}</span></span>
              <span className="mixer-source-tag mixer-source-tag-ratio">{formatRatio(ratio)}</span>
              <Fader
                dataAttrs={{
                  'data-partial-slot': slot,
                  'data-partial-index': partialIndex,
                }}
                fill={vol}
                ball={vol}
                color={color}
                released={false}
              />
              <PartialButtons slot={slot} partialIndex={partialIndex} />
            </div>
          );
        })}
        {voices.map(({ id, slot, freq, amp, target, midiNote, source, released }) => {
          const color = palette.oscColor(slot, oscillatorCount);
          const note = freqToNote(freq);
          const cents = note.cents >= 0 ? `+${note.cents}` : `${note.cents}`;
          const handleVoiceMute = (e) => {
            e.stopPropagation();
            if (released) return;
            keyboardVoiceManager.releaseNote(midiNote, source);
          };
          return (
            <div
              key={`voice-${id}`}
              className={`mixer-row mixer-row-voice ${released ? 'released' : ''}`}
              style={{ '--mixer-color': color }}
            >
              <span className="mixer-marker">{source === 'kbd' ? `K${slot + 1}` : 'MIDI'}</span>
              <span className="mixer-freq">{formatFreq(freq)}</span>
              <span className="mixer-note">{note.note}{note.octave}<span className="mixer-cents">{cents}</span></span>
              <span className="mixer-source-tag mixer-source-tag-empty" />
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
              <div
                className="mixer-row-buttons mixer-row-buttons-voice"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className="mixer-btn mixer-btn-mute"
                  onClick={handleVoiceMute}
                  disabled={released}
                  title="Release this voice"
                  aria-label="Release voice"
                >×</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default memo(Mixer);

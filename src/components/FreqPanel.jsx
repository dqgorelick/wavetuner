import { useEffect, useState } from 'react';
import audioEngine from '../audio/AudioEngine';
import frequencyManager from '../audio/FrequencyManager';
import { droneStereo, MAX_DETUNE_HZ } from '../audio/StereoMode';
import palette, { useTheme } from '../theme/palette';
import PanPot from './PanPot';
import VerticalFader from './VerticalFader';
import EntryKeypad from './EntryKeypad';
import NoteKeyboard from './NoteKeyboard';
import { FreqScrubber, DetuneSlider, OctaveJogger } from './FreqPanelParts';
import { freqToMidiAndCents, noteName, parseHz, formatHz } from '../ui/pitchMath';
import '../styles/freqPanels.css';

// Per-voice frequency panel — web port of the iOS FrequencyPanel
// (Views/FrequencyPanel.swift). Selection IS the panel: it mounts while
// a voice's note readout is selected in the MixerConsole and floats
// above the source knob band (the iOS panel covers the band instead —
// deliberate web difference so the knobs stay live).
//
// Header: [mute·№][Hz chip][note chip][✕] — the chips are live SOUNDING
// readouts doubling as a face radio (controls / freq keypad / note
// keyboard; tapping the active chip returns to controls). All commits
// run in the NOMINAL domain through frequencyManager.setSlotHz, which
// keeps ratio-lock / follow-root semantics and feeds the undo stack.

const HZ_MIN = 0.1;
const HZ_MAX = 20000;

export default function FreqPanel({ voice, voicePans = [], onSetVoicePan, onClose }) {
  const [face, setFace] = useState('controls');
  const [buffer, setBuffer] = useState('');
  const [invalid, setInvalid] = useState(false);

  // Engine mirrors — rAF poll like MixerConsole (the panel shows live
  // values while orb drags / glides / MIDI move the voice under it).
  const [hz, setHz] = useState(() => audioEngine.getFrequency(voice) || 0);
  const [ratio, setRatio] = useState(() => audioEngine.getTransposeRatio?.() ?? 1);
  const [vol, setVol] = useState(0);
  const [muted, setMuted] = useState(false);
  const [, setStereoTick] = useState(0);

  const themeName = useTheme();
  const color = palette.oscColor(voice, audioEngine.getOscillatorCount?.() ?? 2);
  void themeName;

  useEffect(() => {
    let raf;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!audioEngine.isInitialized) return;
      try {
        const nextHz = audioEngine.getFrequency(voice) || 0;
        const nextRatio = audioEngine.getTransposeRatio?.() ?? 1;
        const nextVol = (audioEngine.getAllVolumes()[voice] ?? 0) / 100;
        const nextMuted = !!audioEngine.getAllMutedStates()[voice];
        setHz((p) => (Math.abs(p - nextHz) > 1e-6 ? nextHz : p));
        setRatio((p) => (Math.abs(p - nextRatio) > 1e-9 ? nextRatio : p));
        setVol((p) => (Math.abs(p - nextVol) > 1e-4 ? nextVol : p));
        setMuted((p) => (p === nextMuted ? p : nextMuted));
      } catch { /* ignore */ }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [voice]);
  useEffect(() => droneStereo.onChange(() => setStereoTick((n) => n + 1)), []);

  // Reseed the keypad buffer on voice retarget / face entry (iOS
  // reseed() rule) — from the engine directly, not the lagging mirror.
  // Render-time previous-state pattern (not an effect) so the reseed
  // lands in the same render as the retarget.
  const [seededFor, setSeededFor] = useState(null);
  const seedId = `${voice}:${face}`;
  if (seededFor !== seedId) {
    setSeededFor(seedId);
    setBuffer(formatHz(audioEngine.getFrequency(voice) || 0));
    setInvalid(false);
  }

  const commitHz = (raw) => {
    if (!Number.isFinite(raw)) return;
    frequencyManager.setSlotHz(voice, Math.max(HZ_MIN, Math.min(HZ_MAX, raw)));
  };

  // Chips display SOUNDING pitch (nominal × transpose ratio).
  const sounding = hz * ratio;
  const hzLabel = sounding >= 1000
    ? `${(sounding / 1000).toFixed(2)} kHz`
    : `${sounding.toFixed(2)} Hz`;
  const { midi, cents } = freqToMidiAndCents(sounding);
  const centsInt = Math.round(cents);
  const noteLabel = `${noteName(midi)} ${centsInt >= 0 ? '+' : ''}${centsInt}¢`;

  const pan = Number.isFinite(voicePans[voice]) ? voicePans[voice] : 0;
  const curveVal = droneStereo.detuneCurve[voice] ?? 0;
  const effectiveHz = curveVal * MAX_DETUNE_HZ;
  // Pair lines show the pan-narrowed pair offset; 0 in L/R mode (the
  // web engine's detuneHzAt rule). The caption shows the un-narrowed
  // value on purpose (iOS: "deliberately ≠ the tapered lines").
  const pannedHz = droneStereo.mode === 'stereo' ? effectiveHz * (1 - Math.abs(pan)) : 0;
  // Two decimals below 1 Hz: that's where the pinned-ceiling axis spends
  // half its travel, so 0.1 Hz steps would read as a dead zone.
  const detuneLabel = effectiveHz < 0.005
    ? '0hz'
    : `${effectiveHz < 1 ? effectiveHz.toFixed(2)
        : effectiveHz < 9.95 ? effectiveHz.toFixed(1)
        : effectiveHz.toFixed(0)}hz`;

  const chip = (id, label, caption) => (
    <div className={`vp-chip-wrap ${id}`}>
      <button
        type="button"
        className={`vp-chip${face === id ? ' active' : ''}`}
        onClick={() => setFace((f) => (f === id ? 'controls' : id))}
        data-testid={id === 'freq' ? 'pitchCardHz' : 'pitchCardNote'}
        aria-pressed={face === id}
      >
        {label}
      </button>
      <span className="vp-caption">{caption}</span>
    </div>
  );

  const setFromBuffer = () => {
    const parsed = parseHz(buffer);
    if (parsed == null) { setInvalid(true); return; }
    commitHz(parsed);
    setBuffer(formatHz(Math.max(HZ_MIN, Math.min(HZ_MAX, parsed))));
  };

  return (
    <div
      className="voice-panel"
      style={{ '--vp-color': color }}
      data-testid="frequencyPanel"
      role="dialog"
      aria-label={`Voice ${voice + 1} frequency`}
    >
      <div className="vp-head">
        <div className="vp-mute-slot">
          <button
            type="button"
            className={`vp-mute${muted ? ' muted' : ''}`}
            onClick={() => audioEngine.initialized && audioEngine.toggleMute(voice)}
            data-testid="panelMute"
            aria-pressed={!muted}
            aria-label={muted ? `Unmute voice ${voice + 1}` : `Mute voice ${voice + 1}`}
          >
            {voice + 1}
          </button>
          <span className="vp-caption">MUTE</span>
        </div>
        <div className="vp-chips">
          {chip('freq', hzLabel, 'FREQUENCY')}
          {chip('note', noteLabel, 'NOTE')}
        </div>
        <div className="vp-close-slot">
          <button
            type="button"
            className="vp-close"
            onClick={onClose}
            data-testid="panelClose"
            aria-label="Close frequency panel"
          >
            ✕
          </button>
        </div>
      </div>

      {face === 'controls' && (
        <div className="vp-body">
          <div className="vp-lane">
            <PanPot
              pan={pan}
              index={voice}
              color={color}
              muted={muted}
              size={36}
              onChange={(p, opts) => onSetVoicePan?.(voice, p, opts)}
            />
            <span className="vp-caption">PAN</span>
            <div className="vp-fader" data-testid="panelFader">
              <VerticalFader
                value={vol}
                color={color}
                muted={muted}
                onValue={(v) => audioEngine.initialized && audioEngine.setVolume(voice, v)}
                ariaLabel={`Voice ${voice + 1} level`}
              />
            </div>
            <span className="vp-caption">LEVEL</span>
          </div>
          <div className="vp-center">
            <FreqScrubber
              hz={hz}
              getHz={() => audioEngine.getFrequency(voice) || 0}
              color={color}
              onCommit={commitHz}
              detuneMarkerHz={pannedHz}
            />
            <div>
              <DetuneSlider
                value={curveVal}
                onChange={(v) => droneStereo.setDetuneCurveAt(voice, v)}
              />
              <span className="vp-caption" style={{ display: 'block', marginTop: 1 }}>
                STEREO DETUNE: <span className="vp-caption-value">{detuneLabel}</span>
              </span>
            </div>
          </div>
          <OctaveJogger
            vertical
            height={40}
            onUp={() => commitHz(hz * 2)}
            onDown={() => commitHz(hz / 2)}
          />
        </div>
      )}

      {face === 'freq' && (
        <div className="vp-freq-face">
          <div className="ekp-side-col">
            <div className={`ekp-buffer${invalid ? ' invalid' : ''}`} data-testid="pitchEntryBuffer">
              <span className="ekp-buffer-text">{buffer || ' '}</span>
              <span className="ekp-caret" aria-hidden="true" />
              <span className="ekp-unit">Hz</span>
            </div>
            <button type="button" className="ekp-sidebtn em" onClick={setFromBuffer} data-testid="keypadSet">set</button>
            <button
              type="button"
              className="ekp-sidebtn"
              onClick={() => { setBuffer(''); setInvalid(false); }}
              data-testid="keypadClear"
            >
              clear
            </button>
          </div>
          <EntryKeypad
            buffer={buffer}
            onBuffer={(b) => { setBuffer(b); setInvalid(false); }}
          />
        </div>
      )}

      {face === 'note' && (
        <NoteKeyboard hz={hz} color={color} slot={voice} onCommitHz={commitHz} />
      )}
    </div>
  );
}

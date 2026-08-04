import { useEffect, useRef, useState } from 'react';
import audioEngine from '../audio/AudioEngine';
import { droneStereo, MAX_DETUNE_HZ } from '../audio/StereoMode';
import VerticalFader from './VerticalFader';
import CurveEditor from './CurveEditor';
import { OctaveJogger } from './FreqPanelParts';
import '../styles/freqPanels.css';

// ALL (bus) panel — web port of the iOS AllPanel (Views/Panels/
// AllPanel.swift). Opened from the console's ALL caption; floats above
// the source knob band in the frequency panel's chassis. Header =
// [mute-all][− | + N VOICES][✕]; left bus column = PAN ALL toggle +
// GAIN fader; center = transpose readout + knurled dial (±24 st, full
// width drag = 24 st) + octave jogger (±12 st) + RESET / APPLY; below,
// the stereo-detune curve (ZERO / RANDOM + the shared CurveEditor —
// the same droneStereo.detuneCurve the per-voice DetuneSlider edits).

const BUS_COLOR = 'rgba(255,255,255,0.55)';
const DIAL_SPAN_ST = 24; // full-width drag (iOS dialSpanSemitones)
const MAX_ST = 24; // engine clamp (transposeMaxSemitones)

const SpeakerIcon = ({ slashed }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    {slashed ? (
      <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
    ) : (
      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
    )}
  </svg>
);

export default function AllPanel({
  oscillatorCount,
  minOscillators = 2,
  maxOscillators = 12,
  onOscillatorCountChange,
  onClose,
}) {
  const [semi, setSemi] = useState(() => audioEngine.getTransposeSemitones?.() ?? 0);
  const [muted, setMuted] = useState([]);
  const [freqs, setFreqs] = useState([]);
  const [busGain, setBusGain] = useState(() => audioEngine.getDroneBusGain?.() ?? 1);
  const [busMuted, setBusMuted] = useState(() => audioEngine.isDroneBusMuted?.() ?? false);
  const [, setStereoTick] = useState(0);
  const dialRef = useRef(null);
  const dialDragRef = useRef(null);

  useEffect(() => {
    let raf;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!audioEngine.isInitialized) return;
      try {
        const s = audioEngine.getTransposeSemitones();
        setSemi((p) => (Math.abs(p - s) > 1e-4 ? s : p));
        const nextMuted = audioEngine.getAllMutedStates().slice(0, oscillatorCount).map(Boolean);
        setMuted((p) => (p.length === nextMuted.length && p.every((v, i) => v === nextMuted[i]) ? p : nextMuted));
        const nextFreqs = audioEngine.getAllFrequencies().slice(0, oscillatorCount);
        setFreqs((p) => (p.length === nextFreqs.length && p.every((v, i) => v === nextFreqs[i]) ? p : nextFreqs));
        const g = audioEngine.getDroneBusGain();
        setBusGain((p) => (Math.abs(p - g) > 0.001 ? g : p));
        const bm = audioEngine.isDroneBusMuted();
        setBusMuted((p) => (p === bm ? p : bm));
      } catch { /* ignore */ }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [oscillatorCount]);
  useEffect(() => droneStereo.onChange(() => setStereoTick((n) => n + 1)), []);

  const anyLive = muted.slice(0, oscillatorCount).some((m) => !m);
  const allMuted = muted.length >= oscillatorCount && !anyLive;
  const isStereo = droneStereo.mode === 'stereo';
  const offCenter = Math.abs(semi) > 0.05;

  const handleMuteAll = () => {
    if (!audioEngine.initialized) return;
    for (let i = 0; i < oscillatorCount; i++) {
      if (anyLive) {
        if (!muted[i]) audioEngine.muteOscillator(i);
      } else {
        audioEngine.unmuteOscillator(i);
      }
    }
  };

  // TRANSPOSE readout — the ROOT (lowest active) drone's shift in Hz +
  // the offset in cents; deliberately the same numbers as the spectrum
  // bar's corner readout (iOS: sounding-Hz version read as confusing).
  const root = freqs.reduce((lo, f) => (f > 0 && (lo === 0 || f < lo) ? f : lo), 0);
  let transposeValue = '0hz, 0 cents';
  if (offCenter && root > 0) {
    const hzDelta = root * (Math.pow(2, semi / 12) - 1);
    const hzText = `${hzDelta >= 0 ? '+' : ''}${Math.abs(hzDelta) >= 10 ? hzDelta.toFixed(0) : hzDelta.toFixed(1)}hz`;
    const centsText = `${semi >= 0 ? '+' : ''}${Math.round(semi * 100)} cents`;
    transposeValue = `${hzText}, ${centsText}`;
  }

  const setTranspose = (v, opts) => {
    audioEngine.cancelTransposeGlide?.();
    audioEngine.setTransposeSemitones(v, opts);
  };

  // Dial: relative self-healing drag — base captured on the first move,
  // full width = 24 st (half the thumb's ±24 display scale, matching
  // the spectrum bar's drag gain). No tap-to-commit.
  const dialHandlers = {
    onPointerDown: (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      dialDragRef.current = {
        pid: e.pointerId,
        startX: e.clientX,
        base: audioEngine.getTransposeSemitones(),
        width: e.currentTarget.getBoundingClientRect().width,
        moved: false,
      };
    },
    onPointerMove: (e) => {
      const d = dialDragRef.current;
      if (!d || e.pointerId !== d.pid) return;
      const dx = e.clientX - d.startX;
      if (!d.moved && Math.abs(dx) <= 0.5) return;
      d.moved = true;
      setTranspose(d.base + (dx / d.width) * DIAL_SPAN_ST, { persist: false });
    },
    onPointerUp: (e) => {
      const d = dialDragRef.current;
      if (!d || e.pointerId !== d.pid) return;
      dialDragRef.current = null;
      if (d.moved) setTranspose(audioEngine.getTransposeSemitones());
    },
    onPointerCancel: (e) => {
      const d = dialDragRef.current;
      if (!d || e.pointerId !== d.pid) return;
      dialDragRef.current = null;
      if (d.moved) setTranspose(audioEngine.getTransposeSemitones());
    },
  };
  const thumbFrac = Math.max(0, Math.min(1, 0.5 + semi / (2 * MAX_ST)));

  const handleApply = () => {
    // Fold the offset into nominal Hz — sounding pitch unchanged,
    // transpose returns to 0 (iOS applyTransposeToFrequencies). One
    // shared ratio preserves voice ratios, so follow-root / ratio-lock
    // propagation is a no-op on top of the batch write.
    const ratio = audioEngine.getTransposeRatio();
    if (Math.abs(ratio - 1) < 1e-9) return;
    audioEngine.cancelTransposeGlide?.();
    const nominal = audioEngine.getAllFrequencies().slice(0, oscillatorCount);
    audioEngine.setAllFrequenciesBatch(nominal.map((f) => f * ratio));
    audioEngine.setTransposeSemitones(0);
  };

  const curve = droneStereo.detuneCurve;
  const hasDetune = curve.some((v) => v > 0.001);

  return (
    <div
      className="voice-panel"
      style={{ '--vp-color': BUS_COLOR }}
      data-testid="allPanel"
      role="dialog"
      aria-label="All voices"
    >
      <div className="vp-head">
        <div className="vp-mute-slot">
          <button
            type="button"
            className={`ap-mute${allMuted ? ' all-muted' : ''}`}
            onClick={handleMuteAll}
            data-testid="allPanelMute"
            aria-label={anyLive ? 'Mute all drones' : 'Unmute all drones'}
          >
            <SpeakerIcon slashed={anyLive} />
          </button>
          <span className="vp-caption">MUTE ALL</span>
        </div>
        {/* One segmented pill: [−][N VOICES][+] — the steppers sit at the
            pill's two ends with the count between them. */}
        <div className="ap-voices">
          <button
            type="button"
            className="ap-voices-chip"
            onClick={() => onOscillatorCountChange?.(oscillatorCount - 1)}
            disabled={oscillatorCount <= minOscillators}
            data-testid="allVoicesMinus"
            aria-label="Remove a voice"
          >
            −
          </button>
          <span className="ap-voices-label">{oscillatorCount}<em> VOICES</em></span>
          <button
            type="button"
            className="ap-voices-chip"
            onClick={() => onOscillatorCountChange?.(oscillatorCount + 1)}
            disabled={oscillatorCount >= maxOscillators}
            data-testid="allVoicesPlus"
            aria-label="Add a voice"
          >
            +
          </button>
        </div>
        <div className="vp-close-slot">
          <button
            type="button"
            className="vp-close"
            onClick={onClose}
            data-testid="allPanelClose"
            aria-label="Close all panel"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="vp-body">
        <div className="vp-lane">
          <button
            type="button"
            className="ap-bus-toggle"
            onClick={() => droneStereo.setMode(isStereo ? 'lr' : 'stereo')}
            data-testid="allPanelStereoToggle"
            aria-label={isStereo ? 'Stereo mode (click for L/R)' : 'L/R mode (click for stereo)'}
          >
            {isStereo ? '⊙' : 'LR'}
          </button>
          <span className="vp-caption">PAN ALL</span>
          <div className="vp-fader" data-testid="allPanelGainFader">
            <VerticalFader
              value={Math.max(0, Math.min(1, busGain / 2))}
              color={BUS_COLOR}
              muted={busMuted}
              unityTick
              onValue={(v) => audioEngine.initialized && audioEngine.setDroneBusGain(v * 2)}
              ariaLabel="All drones gain"
            />
          </div>
          <span className="vp-caption">GAIN</span>
        </div>

        <div className="ap-transpose-col">
          <div className="ap-transpose-row">
            <div className="ap-transpose-col">
              <span className="ap-transpose-title" data-testid="allTransposeReadout">
                TRANSPOSE: <b>{transposeValue}</b>
              </span>
              <div className="ap-dial" ref={dialRef} {...dialHandlers} data-testid="allTransposeDial">
                <div className="fscrub-knurl" style={{ height: 12 }} aria-hidden="true" />
                <div className="fscrub-tick" style={{ height: 16 }} aria-hidden="true" />
                <div
                  className="fscrub-thumb"
                  style={{ left: `calc(${(thumbFrac * 100).toFixed(2)}% - ${(thumbFrac * 14).toFixed(1)}px)` }}
                />
              </div>
            </div>
            <OctaveJogger
              height={32}
              captionAbove
              onUp={() => setTranspose(Math.min(MAX_ST, semi + 12))}
              onDown={() => setTranspose(Math.max(-MAX_ST, semi - 12))}
              upDisabled={semi > MAX_ST - 0.01}
              downDisabled={semi < -MAX_ST + 0.01}
            />
          </div>
          <div className="ap-words" style={{ paddingRight: 57 + 8 }}>
            <button
              type="button"
              className="ap-word"
              onClick={() => audioEngine.glideTranspose(0, 700)}
              disabled={!offCenter}
              data-testid="allTransposeReset"
            >
              RESET
            </button>
            <button
              type="button"
              className="ap-word"
              onClick={handleApply}
              disabled={!offCenter}
              data-testid="allTransposeApply"
            >
              APPLY
            </button>
          </div>

          <div className="ap-detune">
            <div className="ap-detune-head">
              <span className="vp-caption">
                STEREO DETUNE <span className="vp-caption-value">0—{MAX_DETUNE_HZ}hz</span>
              </span>
              <button
                type="button"
                className="ap-word inline"
                onClick={() => droneStereo.setDetuneCurve(new Array(curve.length).fill(0))}
                disabled={!hasDetune}
                data-testid="allDetuneZero"
              >
                ZERO
              </button>
              <button
                type="button"
                className="ap-word inline"
                onClick={() => droneStereo.randomizeCurve()}
                data-testid="allDetuneRandom"
              >
                RANDOM
              </button>
            </div>
            <CurveEditor stereoMode={droneStereo} slotCount={oscillatorCount} label="Detune curve" />
          </div>
        </div>
      </div>
    </div>
  );
}

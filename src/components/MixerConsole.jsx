import { memo, useEffect, useMemo, useRef, useState } from 'react';
import audioEngine from '../audio/AudioEngine';
import frequencyManager from '../audio/FrequencyManager';
import conductor from '../audio/GenerativeConductor';
import { droneStereo } from '../audio/StereoMode';
import palette, { useTheme } from '../theme/palette';
import PanPot from './PanPot';
import VerticalFader from './VerticalFader';
import { freqToNote, formatFreq, formatCents } from '../ui/noteFormat';
import {
  stripGeometry,
  controlScale,
  rubber,
  BASE_PITCH,
  GUTTER_WIDTH,
  MAX_STRETCH,
  ALL_SLOT_SHARE,
  PITCH_ROW_H,
  CONSOLE_HEAD,
  NOTE_ROW_H,
  MUTE_ROW_BASE,
  PAN_ROW_BASE,
  ROW_SPACING,
  cellGeometry,
} from '../ui/stripGeometry';

// Outer edge reservation — the SAME 8px on both flanks so the label rail
// and the ALL lane sit equally close to the console's edges (the group
// stays centered between them). 8 rather than the 32px RAIL_INSET: the
// transport that used to overhang the leading edge now lives in the left
// screen rail, so the wider reservation just read as left padding.
const EDGE_INSET = 8;

// Mixer console — port of the iOS column mixer (HomeMixerSection.swift):
// a centered group of [label rail][one column per voice][ALL lane] under
// the spectrum. Each voice column is NOTE readout / mute cell / pan pot /
// level fader; the ALL lane is the drone bus (mute-all, stereo-mode
// toggle, bus gain with unity at half-track). Geometry is the pure
// stripGeometry() function — columns stretch to fill the row up to 1.35×
// and page by whole columns (◀ ▶ in the LEVEL label slot) on overflow.

const BUS_COLOR = 'rgba(255,255,255,0.55)';

const SpeakerIcon = ({ slashed }) => (
  <svg viewBox="0 0 24 24" className="button-icon" aria-hidden="true">
    {slashed ? (
      <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
    ) : (
      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
    )}
  </svg>
);

// Corner-bracket selection marker (iOS SelectionCornersShape): four
// sharp white L corners over the selected note cell.
const CornerMarker = ({ dimmed }) => (
  <span className={`console-corners${dimmed ? ' dimmed' : ''}`} aria-hidden="true">
    <i /><i /><i /><i />
  </span>
);

function MixerConsole({
  oscillatorCount,
  voicePans = [],
  onSetVoicePan,
  // Selection is lifted (iOS "selection IS the panel"): a voice index,
  // 'all', or null. The frequency / ALL panels mount off it in App.
  selectedVoice = null,
  onSelectVoice,
  // Voices whose orb is being dragged / grabbed in the spectrum bar. They
  // wear the same corner brackets as a selection so the console says which
  // orb is under the finger — at half opacity when the voice isn't the
  // selected one, so a real selection still reads as the stronger mark.
  activeVoices = null,
}) {
  const rootRef = useRef(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [offset, setOffset] = useState(0);
  const [panning, setPanning] = useState(false);
  const panRef = useRef(null);
  const suppressClickRef = useRef(false);

  // Engine mirrors, refreshed by the rAF poll below.
  const [freqs, setFreqs] = useState([]);
  const [vols, setVols] = useState([]); // 0..1
  const [muted, setMuted] = useState([]);
  const [stagedMutes, setStagedMutes] = useState(() => frequencyManager.getStagedMutes());
  const [transitionInFlight, setTransitionInFlight] = useState(false);
  const [pulseExits, setPulseExits] = useState([]);
  const [busGain, setBusGain] = useState(() => audioEngine.getDroneBusGain?.() ?? 1);
  const [busMuted, setBusMuted] = useState(() => audioEngine.isDroneBusMuted?.() ?? false);
  const [droneMode, setDroneMode] = useState(droneStereo.mode);
  const prevPendingOffRef = useRef([]);
  const pulseExitAtRef = useRef([]);
  const freqDragRef = useRef({});

  const themeName = useTheme();

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setDims((prev) => (Math.abs(prev.w - width) < 0.5 && Math.abs(prev.h - height) < 0.5
        ? prev
        : { w: width, h: height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => droneStereo.onChange((s, info) => {
    if (info?.kind === 'mode') setDroneMode(s.mode);
  }), []);

  useEffect(() => {
    let raf;
    const arraysEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!audioEngine.isInitialized) return;
      try {
        const nextFreqs = audioEngine.getSoundingFrequencies().slice(0, oscillatorCount);
        const nextVols = audioEngine.getAllVolumes().slice(0, oscillatorCount).map((v) => v / 100);
        const nextMuted = audioEngine.getAllMutedStates().slice(0, oscillatorCount).map(Boolean);
        setFreqs((prev) => (arraysEqual(prev, nextFreqs) ? prev : nextFreqs));
        setVols((prev) => (arraysEqual(prev, nextVols) ? prev : nextVols));
        setMuted((prev) => (arraysEqual(prev, nextMuted) ? prev : nextMuted));

        // Staged on/off preview — identity-stable when unchanged.
        const sm = frequencyManager.getStagedMutes();
        setStagedMutes((prev) => {
          if (prev === sm) return prev;
          if (prev && sm && prev.length === sm.length
              && prev.every((m, i) => !!m === !!sm[i])) return prev;
          return sm;
        });
        const inFlight = conductor.running
          || frequencyManager.isLaunching
          || frequencyManager.recallOffsPending;
        setTransitionInFlight((prev) => (prev === inFlight ? prev : inFlight));
        // Stamp cells leaving the dimmed pending-off look, and mirror the
        // "within the 1.1s exit window" flags into state so render stays
        // pure (.pulse-exit runs its one-shot ease from these).
        const nowTs = performance.now();
        const nextPulse = [];
        for (let i = 0; i < oscillatorCount; i++) {
          const pendingOff = sm != null && i < sm.length
            && !!sm[i] !== nextMuted[i] && !nextMuted[i];
          if (prevPendingOffRef.current[i] && !pendingOff) {
            pulseExitAtRef.current[i] = nowTs;
          }
          prevPendingOffRef.current[i] = pendingOff;
          const exitAt = pulseExitAtRef.current[i];
          nextPulse.push(exitAt != null && nowTs - exitAt < 1100);
        }
        setPulseExits((prev) => (arraysEqual(prev, nextPulse) ? prev : nextPulse));

        const nextGain = audioEngine.getDroneBusGain();
        setBusGain((prev) => (Math.abs(prev - nextGain) > 0.001 ? nextGain : prev));
        const nextBusMuted = audioEngine.isDroneBusMuted();
        setBusMuted((prev) => (prev === nextBusMuted ? prev : nextBusMuted));
      } catch { /* ignore */ }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [oscillatorCount]);

  const geo = useMemo(
    () => stripGeometry({
      count: oscillatorCount,
      rowWidth: Math.max(160, dims.w),
      leadingInset: EDGE_INSET,
      trailingInset: EDGE_INSET,
    }),
    [oscillatorCount, dims.w]
  );
  // Measured height less the head lift — that band belongs to the NOTE
  // row alone, so the control rows size off the same budget as before.
  const control = controlScale(geo.scale, (dims.h || 210) - CONSOLE_HEAD);

  // Shrink-wrap the element to what the columns can actually use at max
  // stretch, so the group (and the row centering around it) has no dead
  // flanks: the label rail lands EDGE_INSET px from the element's left
  // edge and the ALL lane the same distance from its right — flush
  // against the side-menu column. Viewport clamps still apply (the CSS
  // min() terms); --side-w carves out the menu column's width on narrow
  // screens.
  const neededWidth = Math.ceil(
    2 * EDGE_INSET + GUTTER_WIDTH
    + oscillatorCount * BASE_PITCH * MAX_STRETCH
    + Math.max(GUTTER_WIDTH, ALL_SLOT_SHARE * BASE_PITCH * MAX_STRETCH)
  );

  // The parked offset is clamped through the CURRENT geometry at render
  // time (rather than re-snapped via an effect), so voice-count or
  // width changes can never leave the strip stranded past its edge.
  // Mid-pan the raw offset renders as-is — rubber-band overshoot lives
  // outside the snap range and the gesture owns clamping.
  const shownOffset = panning ? offset : geo.snap(offset);

  const oscillators = useMemo(() => {
    void themeName;
    return Array.from({ length: oscillatorCount }, (_, i) => ({
      index: i,
      color: palette.oscColor(i, oscillatorCount),
    }));
  }, [oscillatorCount, themeName]);

  const muteRowH = MUTE_ROW_BASE * control;
  const panRowH = PAN_ROW_BASE * control;
  // Mute cell / pan dial sizes — the mute cell is a square whose side is
  // the tightest of the type, lane and row limits (see cellGeometry).
  const cells = cellGeometry({ scale: geo.scale, control, laneWidth: geo.laneWidth });
  const anyLive = muted.slice(0, oscillatorCount).some((m) => !m);
  const allMuted = muted.length >= oscillatorCount && !anyLive;
  const isStereo = droneMode === 'stereo';

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

  const page = (dir) => setOffset((o) => geo.snap(geo.snap(o) + dir * geo.pitch));

  // Drag-to-pan on the strip — the iOS VoiceStripPan feel: the note
  // readouts and mute cells double as the pan surface (pan pots and
  // faders own their gestures and are skipped), a touch gets 6px of
  // slop and must move horizontally to commit, overshoot rubber-bands,
  // and release latches to the nearest whole column. A committed pan
  // swallows the tap (the capture-phase click handler below).
  const handleStripPointerDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.console-pan-slot, .console-fader-slot')) return;
    suppressClickRef.current = false;
    panRef.current = {
      pid: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      phase: 'undecided',
      panStart: 0,
    };
  };
  const handleStripPointerMove = (e) => {
    const d = panRef.current;
    if (!d || e.pointerId !== d.pid) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.phase === 'undecided') {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      if (Math.abs(dx) <= Math.abs(dy) || geo.maxOffset <= 0) {
        d.phase = 'cancelled';
        return;
      }
      d.phase = 'panning';
      d.panStart = geo.snap(offset);
      try { e.currentTarget.setPointerCapture(d.pid); } catch { /* ignore */ }
      setPanning(true);
    }
    if (d.phase !== 'panning') return;
    const raw = d.panStart - dx;
    if (raw < 0) {
      setOffset(-rubber(-raw));
    } else if (raw > geo.maxOffset) {
      setOffset(geo.maxOffset + rubber(raw - geo.maxOffset));
    } else {
      setOffset(raw);
    }
  };
  const handleStripPointerEnd = (e) => {
    const d = panRef.current;
    if (!d || e.pointerId !== d.pid) return;
    panRef.current = null;
    if (d.phase === 'panning') {
      suppressClickRef.current = true;
      setPanning(false);
      setOffset((o) => geo.snap(o));
    }
  };
  const handleStripClickCapture = (e) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  const rowsStyle = {
    '--console-scale': geo.scale,
    '--console-control': control,
    '--console-mute-h': `${muteRowH}px`,
    '--console-pan-h': `${panRowH}px`,
    '--console-cell': `${cells.mute}px`,
    '--console-row-gap': `${ROW_SPACING}px`,
    // The NOTE row absorbs the head lift, so the frequency button's top
    // edge meets the edge rails' play/pause box; every row below keeps
    // its exact height.
    '--console-head': `${CONSOLE_HEAD}px`,
    '--console-note-h': `${NOTE_ROW_H}px`,
  };

  const lane = (osc) => {
    const i = osc.index;
    const f = freqs[i] ?? 0;
    const isMuted = muted[i] ?? false;
    const note = freqToNote(f);
    const vol = vols[i] ?? 0;
    const isSelected = selectedVoice === i;
    const willFlip = stagedMutes != null && i < stagedMutes.length
      && !!stagedMutes[i] !== isMuted;
    const pendingClass = !willFlip ? '' : isMuted ? ' unmute-pending' : ' mute-pending';
    const pulseExit = !willFlip && (pulseExits[i] ?? false);
    return (
      <div
        key={i}
        className="console-lane"
        style={{ width: geo.pitch, '--osc-color': osc.color }}
      >
        <div className="console-lane-inner" style={{ width: geo.laneWidth }}>
          <button
            type="button"
            className={`console-note${isMuted ? ' muted' : ''}`}
            onClick={() => onSelectVoice?.(isSelected ? null : i)}
            title={`Voice ${i + 1}: ${f.toFixed(2)} Hz`}
            aria-label={`Voice ${i + 1} frequency ${f.toFixed(2)} hertz`}
            aria-pressed={isSelected}
          >
            <span className="console-note-freq">{formatFreq(f)}</span>
            <span className="console-note-name">
              {note.note}{note.octave} <em>{formatCents(note.cents)}</em>
            </span>
            {isSelected
              ? <CornerMarker />
              : activeVoices?.has(i) ? <CornerMarker dimmed /> : null}
          </button>
          <div className="console-mute-slot">
            <button
              type="button"
              className={`console-mute ${isMuted ? 'off' : 'on'}${pendingClass}${willFlip && transitionInFlight ? ' pulsing' : ''}${pulseExit ? ' pulse-exit' : ''}`}
              onClick={() => audioEngine.initialized && audioEngine.toggleMute(i)}
              title={isMuted ? `Unmute ${i + 1}` : `Mute ${i + 1}`}
              aria-pressed={!isMuted}
            >
              {i + 1}
            </button>
          </div>
          <div className="console-pan-slot">
            <PanPot
              pan={Number.isFinite(voicePans[i]) ? voicePans[i] : 0}
              index={i}
              color={osc.color}
              muted={isMuted}
              size={Math.round(cells.dial)}
              onChange={(p, opts) => onSetVoicePan?.(i, p, opts)}
            />
          </div>
          <div className="console-fader-slot">
            <VerticalFader
              value={vol}
              color={osc.color}
              muted={isMuted}
              onValue={(v) => audioEngine.initialized && audioEngine.setVolume(i, v)}
              onXStart={() => {
                const hz = audioEngine.getFrequency?.(i);
                freqDragRef.current[i] = Number.isFinite(hz) && hz > 0 ? hz : null;
                return freqDragRef.current[i];
              }}
              onXDelta={(startHz, dxFrac) => {
                if (!Number.isFinite(startHz) || startHz <= 0) return;
                // One lane width = 5% of the frequency at touch-down — a
                // RATE, not a stop: dxFrac keeps counting past ±1 so the
                // tune follows the finger as far as it travels (iOS does
                // the same). Only the engine's own floor stops it; the
                // clamp keeps a 20-lane pull from crossing zero, where the
                // linear form would otherwise invert.
                const hz = startHz * (1 + dxFrac * 0.05);
                frequencyManager.setSlotHz(i, Math.max(0.1, Math.min(20000, hz)));
              }}
              ariaLabel={`Voice ${i + 1} level`}
            />
          </div>
        </div>
      </div>
    );
  };

  return (
    <div
      className="mixer-console"
      ref={rootRef}
      style={{
        ...rowsStyle,
        // 100vw minus the edge rails (--rail-w each side) and the air
        // between console and rail (--console-air: 24px of viewport
        // breathing room on desktop, 8px on phones where the rails are
        // pinned to the screen edges), minus an open side-menu column.
        width: `min(calc(100vw - var(--console-air, 24px) - (2 * var(--rail-w, 0px)) - var(--side-w, 0px)), 720px, ${neededWidth}px)`,
      }}
      role="region"
      aria-label="Voice mixer"
    >
      {/* Scrolling lane strip, clipped to the viewport between the gutters. */}
      <div
        className={`console-strip-clip${geo.overflows ? ' pannable' : ''}${panning ? ' panning' : ''}`}
        style={geo.overflows
          ? { clipPath: `inset(0 ${geo.maskRight}px 0 ${geo.maskLeft}px)` }
          : undefined}
        onPointerDown={geo.overflows ? handleStripPointerDown : undefined}
        onPointerMove={geo.overflows ? handleStripPointerMove : undefined}
        onPointerUp={geo.overflows ? handleStripPointerEnd : undefined}
        onPointerCancel={geo.overflows ? handleStripPointerEnd : undefined}
        onClickCapture={handleStripClickCapture}
      >
        <div
          className="console-strip"
          style={{
            width: geo.contentWidth,
            transform: `translateX(${geo.stripX(shownOffset)}px)`,
            transition: panning ? 'none' : undefined,
          }}
        >
          {oscillators.map(lane)}
        </div>
      </div>

      {/* Label rail — pinned left of the first visible column. */}
      <div
        className="console-rail"
        style={{ left: geo.railLeadingInset, width: GUTTER_WIDTH }}
        aria-hidden="true"
      >
        <span className="console-rail-label console-rail-note">NOTE</span>
        <span className="console-rail-label console-rail-mute">MUTE</span>
        <span className="console-rail-label console-rail-pan">PAN</span>
        <span className="console-rail-level">
          {geo.overflows ? (
            <span className="console-pager">
              {/* Stroked chevrons, not ‹ › glyphs — the text arrows rendered
                  hairline-thin at the rail's width and read as dust. */}
              <button
                type="button"
                onClick={() => page(-1)}
                disabled={shownOffset <= 0}
                aria-label="Show earlier voices"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M15.5 4.5 8 12l7.5 7.5" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => page(1)}
                disabled={shownOffset >= geo.maxOffset}
                aria-label="Show later voices"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M8.5 4.5 16 12l-7.5 7.5" />
                </svg>
              </button>
            </span>
          ) : (
            <span className="console-rail-label">LEVEL</span>
          )}
        </span>
      </div>

      {/* ALL lane — pinned right, never scrolls. */}
      <div
        className="console-all"
        style={{ right: geo.allLaneTrailingInset, width: geo.allSlot, '--osc-color': BUS_COLOR }}
      >
        <button
          type="button"
          className="console-all-caption"
          onClick={() => onSelectVoice?.(selectedVoice === 'all' ? null : 'all')}
          title="All voices"
          aria-label="All voices panel"
          aria-pressed={selectedVoice === 'all'}
        >
          <span className="console-note-freq">ALL</span>
          <span className="console-note-name">[{oscillatorCount}]</span>
          {selectedVoice === 'all' && <CornerMarker />}
        </button>
        <div className="console-mute-slot">
          <button
            type="button"
            className={`console-all-kill${allMuted ? ' all-muted' : ''}`}
            onClick={handleMuteAll}
            title={anyLive ? 'Mute all drones' : 'Unmute all drones'}
            aria-label={anyLive ? 'Mute all drones' : 'Unmute all drones'}
          >
            <SpeakerIcon slashed={anyLive} />
          </button>
        </div>
        <div className="console-pan-slot">
          <button
            type="button"
            className="console-all-stereo"
            onClick={() => droneStereo.setMode(isStereo ? 'lr' : 'stereo')}
            title={isStereo ? 'Stereo split — click for hard L/R' : 'Hard L/R — click for stereo split'}
            aria-label={isStereo ? 'Stereo mode (click for L/R)' : 'L/R mode (click for stereo)'}
          >
            {isStereo ? '⊙' : 'LR'}
          </button>
        </div>
        <div className="console-fader-slot">
          <VerticalFader
            value={Math.max(0, Math.min(1, busGain / 2))}
            color={BUS_COLOR}
            muted={busMuted}
            unityTick
            onValue={(v) => audioEngine.initialized && audioEngine.setDroneBusGain(v * 2)}
            ariaLabel="All drones gain"
          />
        </div>
      </div>
    </div>
  );
}

export default memo(MixerConsole);

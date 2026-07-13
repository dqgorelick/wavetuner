import { memo, useEffect, useState, useMemo, useCallback, useRef } from 'react';
import audioEngine from '../audio/AudioEngine';
import frequencyManager from '../audio/FrequencyManager';
import conductor from '../audio/GenerativeConductor';
import { droneStereo } from '../audio/StereoMode';
import keyboardVoiceManager from '../audio/KeyboardVoiceManager';
import midiOutput from '../audio/MidiOutput';
import palette, { useTheme } from '../theme/palette';
import { isEditableTarget } from '../hooks/keyboardUtils';
import CaptureBar from './CaptureBar';

function getOscillatorLabel(index) {
  return `${index + 1}`;
}

// One pan control in the tray. Continuous: drag horizontally to sweep
// −1 … +1 (with snaps at the L/⊙/R detents); click without dragging
// bounces through center: side → ⊙ → other side → ⊙ → side …. A voice
// starting AT center (no side history, e.g. stereo mode's origin) goes
// to its parity default first — odd voices L, even voices R — so
// clicking down the row lays out an alternating panorama. The cell only
// shows the coarse state (L / ⊙ / R — the side letter between detents);
// the fine position, percentage and side render as a status flash ON THE
// ORB (see FrequencySpectrumBar's .fsb-status) while adjusting.
const PAN_EPS = 0.01;
const PAN_GLYPH = { L: 'L', R: 'R', both: '⊙' };

function PanCell({ index, label, pan, defaultPan, droneMode, onSetVoicePan }) {
  const dragRef = useRef(null);
  // Which side the voice most recently sat on (−1 | 1 | null), so the
  // click-from-center step knows which "other side" to bounce to.
  const lastSideRef = useRef(null);

  const detent = Math.abs(pan + 1) < PAN_EPS ? 'L'
    : Math.abs(pan - 1) < PAN_EPS ? 'R'
    : Math.abs(pan) < PAN_EPS ? 'both'
    : null;
  const moved = Math.abs(pan - defaultPan) > PAN_EPS;

  const cycle = () => {
    if (Math.abs(pan) > PAN_EPS) {
      // On a side (hard or fine-tuned) → remember it, bounce to center.
      lastSideRef.current = pan < 0 ? -1 : 1;
      onSetVoicePan(index, 0);
    } else {
      // At center → opposite of the last side; fresh voices take the
      // parity default (voice 1, 3, … → L; voice 2, 4, … → R).
      const defaultSide = index % 2 === 0 ? -1 : 1;
      onSetVoicePan(index, lastSideRef.current != null ? -lastSideRef.current : defaultSide);
    }
  };

  const handlePointerDown = (e) => {
    if (!audioEngine.initialized) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    dragRef.current = { startX: e.clientX, startY: e.clientY, startPan: pan, dragging: false };
  };
  const handlePointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.dragging && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    d.dragging = true;
    // Both axes drive the dial: right OR up pans right, left OR down
    // pans left (vertical gives a fader-like fine gesture on the tiny
    // cell without the pointer covering it). 80 px of travel on either
    // axis = the full −1 → +1 sweep.
    let next = Math.max(-1, Math.min(1, d.startPan + (dx - dy) / 40));
    // Detent snaps so the classic three states are easy to land on.
    if (Math.abs(next) < 0.08) next = 0;
    else if (next > 0.92) next = 1;
    else if (next < -0.92) next = -1;
    onSetVoicePan(index, next);
  };
  const handlePointerEnd = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (d && !d.dragging) cycle();
  };

  const stateDesc = detent === 'both'
    ? (droneMode === 'stereo' ? 'center (stereo split)' : 'center (both)')
    : detent
      ? `${detent} only`
      : `${pan > 0 ? 'R' : 'L'} ${Math.round(Math.abs(pan) * 100)}%`;

  // Between detents the cell keeps the coarse side letter (the orb's
  // status flash carries the fine position); `partial` restyles it so a
  // fine-tuned L reads differently from a hard L.
  const glyph = detent ? PAN_GLYPH[detent] : (pan > 0 ? 'R' : 'L');

  return (
    <button
      type="button"
      className={`pan-tray-cell${moved ? ' moved' : ''}${detent ? '' : ' partial'}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      title={`Voice ${label} pan: ${stateDesc} — drag →/↑ = R, ←/↓ = L; click to bounce side ↔ center`}
      aria-label={`Voice ${label} pan ${stateDesc}`}
    >
      {glyph}
    </button>
  );
}

function OscillatorControls({
  oscillatorCount = 2,
  isPaused = false,
  onPausedChange,
  voicePans = [],
  onSetVoicePan,
  onResetVoiceRouting,
}) {
  const [mutedOscillators, setMutedOscillators] = useState(() => Array(oscillatorCount).fill(false));
  // Staged on/off targets: the per-voice mute flags the selected save slot
  // would apply on GO (null unless a save is staged AND 'on/off' is a tracked
  // param). Cells whose state will flip preview the direction: a muted cell
  // about to come ON gains an outline (.unmute-pending); a sounding cell
  // about to go OFF dims (.mute-pending). This is THE on/off preview — the
  // orbs above deliberately carry none (user 2026-07-06).
  const [stagedMutes, setStagedMutes] = useState(() => frequencyManager.getStagedMutes());
  // Transition-in-flight: a generative run, an in-flight launch glide, or a
  // GO whose deferred note-offs haven't fired yet. Pending cells PULSE while
  // true (anticipation until the flip lands); staged-but-idle stays static.
  const [transitionInFlight, setTransitionInFlight] = useState(false);
  // When a cell leaves its dimmed pending-off state (the mute lands, or the
  // save is deselected mid-flight), a CSS transition can't ease it out — the
  // pulse keyframes held opacity, and Chrome won't transition from an
  // animation-held value. Instead we stamp the exit moment and run a
  // one-shot ease-from-dim animation (.pulse-exit) so the cell never flashes
  // back to full brightness.
  const prevPendingOffRef = useRef([]);
  const pulseExitAtRef = useRef([]);
  // Mirror the drone pan mode so the L/R/⊙ indicators re-render when it's
  // toggled from the mixer or settings (both call droneStereo.setMode).
  const [droneMode, setDroneMode] = useState(droneStereo.mode);
  // Whether any computer-keyboard / MIDI note is currently sounding. The
  // drone's own play/pause button (to the left of the drones) only shows
  // once something else is playing — a first-time user with no input never
  // sees it, since the master pause is all they need.
  const [hasPlayedNotes, setHasPlayedNotes] = useState(false);
  // Master transport state, driven by the bottom-row button + spacebar.
  // Distinct from the drone pause (audioEngine.isPaused / the `isPaused`
  // prop): the master pause silences drones AND keyboard/MIDI together,
  // whereas the drone button only pauses the drone.
  const [masterPaused, setMasterPaused] = useState(false);

  useEffect(() => {
    setDroneMode(droneStereo.mode);
    return droneStereo.onChange((s, info) => {
      if (info?.kind === 'mode') setDroneMode(s.mode);
    });
  }, []);

  useEffect(() => {
    setMutedOscillators((prev) => {
      const arr = [...prev];
      while (arr.length < oscillatorCount) arr.push(false);
      return arr.slice(0, oscillatorCount);
    });
  }, [oscillatorCount]);

  // Subscribing triggers a re-render when the user flips themes; the
  // actual color value is resolved fresh from the palette singleton
  // each render so non-React readers see the same source of truth.
  const themeName = useTheme();
  const oscillators = useMemo(() => {
    void themeName; // dep gates re-memo when the user flips palette
    return Array.from({ length: oscillatorCount }, (_, i) => ({
      index: i,
      label: getOscillatorLabel(i),
      color: palette.oscColor(i, oscillatorCount),
    }));
  }, [oscillatorCount, themeName]);

  useEffect(() => {
    let animationId;
    const arraysEqual = (a, b) => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    };
    const sync = () => {
      if (audioEngine.initialized) {
        try {
          const muted = audioEngine.getAllMutedStates();
          if (muted.length >= oscillatorCount) {
            const nm = muted.slice(0, oscillatorCount);
            setMutedOscillators((prev) => (arraysEqual(prev, nm) ? prev : nm));
          }
          // Pending on/off preview — identity-stable when unchanged so the
          // rAF poll doesn't churn renders.
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
          // Stamp cells leaving the dimmed pending-off look, for .pulse-exit.
          const nm2 = audioEngine.getAllMutedStates();
          for (let i = 0; i < oscillatorCount; i++) {
            const pendingOff = sm != null && i < sm.length
              && !!sm[i] !== !!nm2[i] && !nm2[i];
            if (prevPendingOffRef.current[i] && !pendingOff) {
              pulseExitAtRef.current[i] = performance.now();
            }
            prevPendingOffRef.current[i] = pendingOff;
          }
        } catch {
          // ignore
        }
        // Track live keyboard/MIDI voices for the play-pause button.
        // Released voices (in their fade-out tail) don't count as playing.
        // While paused we keep the button up regardless so the user has a
        // resume control even after the held notes have drained.
        const playing = keyboardVoiceManager.getActiveVoices().some((v) => !v.released);
        setHasPlayedNotes((prev) => (prev === playing ? prev : playing));
      }
      animationId = requestAnimationFrame(sync);
    };
    sync();
    return () => cancelAnimationFrame(animationId);
  }, [oscillatorCount]);

  // Master play/pause — the leftmost bottom-row button and the spacebar
  // both fire this. It silences EVERYTHING (drones + computer/MIDI
  // keyboard, locally and on the external synth) and brings it all back on
  // the next press, overriding any independent drone pause. Held voices
  // are kept alive (the keyboard bus is muted, not released) so they sound
  // again on resume; the synth gets note-offs on pause and re-triggers on
  // resume via MidiOutput's reconcile loop. Uses explicit pause/unpause
  // (not a toggle) so it can't fight the drone button over isPaused.
  const kbdEnabledBeforeMuteRef = useRef(true);
  const masterPausedRef = useRef(false);
  const handleGlobalPlayPause = useCallback(() => {
    if (!audioEngine.initialized) return;
    const nextPaused = !masterPausedRef.current;
    masterPausedRef.current = nextPaused;
    if (nextPaused) {
      audioEngine.pauseDrones();
      midiOutput.setDroneMuted(true);
      kbdEnabledBeforeMuteRef.current = audioEngine.getKeyboardEnabled();
      audioEngine.setKeyboardEnabled(false);
      midiOutput.setKbdMuted(true);
    } else {
      audioEngine.unpauseDrones();
      midiOutput.setDroneMuted(false);
      audioEngine.setKeyboardEnabled(kbdEnabledBeforeMuteRef.current);
      midiOutput.setKbdMuted(false);
    }
    setMasterPaused(nextPaused);
    onPausedChange?.(audioEngine.paused);
  }, [onPausedChange]);

  // The drone's OWN play/pause (the button to the left of the drones).
  // Pauses just the drone — locally and on the synth — while keyboard /
  // MIDI keep playing, so the drone reads as a self-contained instrument.
  // Resuming the drone does NOT un-pause anything else.
  const handleDronePauseToggle = useCallback(() => {
    if (!audioEngine.initialized) return;
    if (audioEngine.paused) {
      audioEngine.unpauseDrones();
      midiOutput.setDroneMuted(false);
    } else {
      audioEngine.pauseDrones();
      midiOutput.setDroneMuted(true);
    }
    onPausedChange?.(audioEngine.paused);
  }, [onPausedChange]);

  // GO / transition should never fire into silence — CaptureBar calls this
  // first so a paused session resumes before the glide starts. Master pause
  // wins (it also re-enables keyboard/MIDI); otherwise clear a drone-only
  // pause. Routed through the same handlers as the buttons so their state
  // (masterPausedRef, the play icon) stays in sync.
  const ensurePlaying = useCallback(() => {
    if (!audioEngine.initialized) return;
    if (masterPausedRef.current) handleGlobalPlayPause();
    else if (audioEngine.paused) handleDronePauseToggle();
  }, [handleGlobalPlayPause, handleDronePauseToggle]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (isEditableTarget(e.target)) return;
      if (e.key === ' ') {
        e.preventDefault();
        handleGlobalPlayPause();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleGlobalPlayPause]);

  const handleMuteToggle = (index) => {
    if (!audioEngine.initialized) return;
    audioEngine.toggleMute(index);
  };

  // Mute every un-muted slot in one click. Button only renders when at
  // least one slot is currently un-muted; once everything's muted it
  // hides itself (there's nothing left for it to do). To bring drones
  // back the user clicks individual squares — no toggle here.
  const handleAllOff = () => {
    if (!audioEngine.initialized) return;
    for (let i = 0; i < oscillatorCount; i++) {
      if (!mutedOscillators[i]) audioEngine.muteOscillator(i);
    }
  };
  const anyOn = mutedOscillators.some((m) => !m);

  // Per-voice continuous pan (−1 hard L … 0 mode origin … +1 hard R).
  // The origin depends on mode — 'lr' is the alternating hard-pan
  // (slot i → i%2 → ∓1); 'stereo' is the L/R split (center, 0). The
  // reset returns every voice to its mode-appropriate origin.
  const defaultPanFor = (i) => (droneMode === 'stereo' ? 0 : (i % 2 === 0 ? -1 : 1));
  const panFor = (i) => (Number.isFinite(voicePans[i]) ? voicePans[i] : defaultPanFor(i));
  const anyPanNonDefault = oscillators.some(
    (osc) => Math.abs(panFor(osc.index) - defaultPanFor(osc.index)) > PAN_EPS
  );

  return (
    <div className="osc-controls-panel">
      {/* Pan tray — one small pan dial per voice, sitting directly
          above the drone mute squares so each lines up with its slot.
          Drag horizontally for continuous pan; click cycles the classic
          L → R → ⊙ detents. In stereo mode ⊙ is the L/R split and panning
          slides that voice's detune pair toward one side (the detune and
          partner osc narrow to zero at the extremes). Reset (right slot,
          above the mute-all ×) returns every voice to its mode-appropriate
          origin and only appears once one differs. */}
      <div className="pan-tray open">
        <div className="pan-tray-slot pan-tray-slot-left" aria-hidden="true" />
        <div className="pan-tray-cells">
          {oscillators.map((osc) => (
            <PanCell
              key={`p-${osc.index}`}
              index={osc.index}
              label={osc.label}
              pan={panFor(osc.index)}
              defaultPan={defaultPanFor(osc.index)}
              droneMode={droneMode}
              onSetVoicePan={(i, p) => onSetVoicePan?.(i, p)}
            />
          ))}
        </div>
        <div className="pan-tray-slot pan-tray-slot-right">
          {anyPanNonDefault && (
            <button
              type="button"
              className="pan-tray-reset"
              onClick={() => onResetVoiceRouting?.()}
              title={droneMode === 'stereo' ? 'Reset all voices to stereo' : 'Reset all voices to L/R'}
              aria-label={droneMode === 'stereo' ? 'Reset all voices to stereo' : 'Reset all voices to L/R'}
            >
              ↵
            </button>
          )}
        </div>
      </div>
      {/* Drone tray — always open (the drone on/off menu toggle is gone).
          Holds the per-osc mute squares (small, outlined when off, lit
          with osc color when on) — mute/unmute is the way to silence
          individual drones now. */}
      <div className="drone-tray open">
        {/* 3-column grid: [empty 1fr] [centered cells] [actions 1fr].
            Left and right slots have matching flex (1fr) so the middle
            cell row stays horizontally centered regardless of whether
            the × button is present in the right slot. */}
        {/* Left slot mirrors the right "×": the drone's OWN play/pause, so
            the drone can be paused/resumed as its own instrument while the
            keyboard / MIDI keep going. Shown once something else is playing
            (or while the drone is solo-paused) — a first-time user with no
            input never sees it and just uses the master pause. */}
        <div className="drone-tray-slot drone-tray-slot-left">
          {(hasPlayedNotes || (isPaused && !masterPaused)) && (
            <button
              type="button"
              className={`drone-tray-kbd-play ${isPaused ? 'paused' : ''}`}
              onClick={handleDronePauseToggle}
              title={isPaused ? 'Resume drone' : 'Pause drone'}
              aria-label={isPaused ? 'Resume drone' : 'Pause drone'}
            >
              {isPaused ? (
                <svg viewBox="0 0 24 24" className="button-icon">
                  <path d="M8 5v14l11-7z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="button-icon">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
              )}
            </button>
          )}
        </div>
        <div className="drone-tray-cells">
          {oscillators.map((osc) => {
            const muted = mutedOscillators[osc.index] || false;
            // The staged save would flip this drone on GO. Direction decides
            // the preview: off→on outlines, on→off dims.
            const willFlip = stagedMutes != null && osc.index < stagedMutes.length
              && !!stagedMutes[osc.index] !== muted;
            const pendingClass = !willFlip ? ''
              : muted ? ' unmute-pending' : ' mute-pending';
            // Recently left the dimmed pending-off look → ease out from dim
            // instead of snapping to full brightness (see pulseExitAtRef).
            const exitAt = pulseExitAtRef.current[osc.index];
            const pulseExit = !willFlip && exitAt != null
              && performance.now() - exitAt < 1100;
            return (
              <button
                key={`m-${osc.index}`}
                type="button"
                className={`drone-tray-cell ${muted ? 'off' : 'on'}${pendingClass}${willFlip && transitionInFlight ? ' pulsing' : ''}${pulseExit ? ' pulse-exit' : ''}`}
                style={{ '--cell-color': osc.color }}
                onClick={() => handleMuteToggle(osc.index)}
                title={muted ? `Unmute ${osc.label}` : `Mute ${osc.label}`}
                aria-pressed={!muted}
                >
                {osc.label}
              </button>
            );
          })}
        </div>
        <div className="drone-tray-slot drone-tray-slot-right">
          {/* × — mutes every un-muted slot in one click. Self-hides
              once nothing is left to mute, so its presence is the cue
              that there are drones sounding. The surrounding slot
              keeps its 1fr width regardless, so cells don't shift. */}
          {anyOn && (
            <button
              type="button"
              className="drone-tray-all-off"
              onClick={handleAllOff}
              title="Mute all drones"
              aria-label="Mute all drones"
            >
              ×
            </button>
          )}
        </div>
      </div>
      <div className="osc-grid-wrap">
        <div className="osc-grid-row bottom-row">
          <div className="grid-cell bottom-cell-wrap osc-play-col">
            <button
              type="button"
              className={`bottom-cell bottom-play ${masterPaused ? 'paused' : ''}`}
              onClick={handleGlobalPlayPause}
              title={masterPaused ? 'Play everything (Space)' : 'Pause everything — drones, keyboard + MIDI (Space)'}
              aria-label={masterPaused ? 'Play' : 'Pause'}
            >
              {masterPaused ? (
                <svg viewBox="0 0 24 24" className="button-icon">
                  <path d="M8 5v14l11-7z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="button-icon">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
              )}
            </button>
          </div>
          <CaptureBar onEnsurePlaying={ensurePlaying} />
        </div>
      </div>
    </div>
  );
}

export default memo(OscillatorControls);

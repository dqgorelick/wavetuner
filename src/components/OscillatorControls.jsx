import { memo, useEffect, useState, useMemo, useCallback, useRef } from 'react';
import audioEngine from '../audio/AudioEngine';
import { droneStereo } from '../audio/StereoMode';
import keyboardVoiceManager from '../audio/KeyboardVoiceManager';
import midiOutput from '../audio/MidiOutput';
import palette, { useTheme } from '../theme/palette';
import { isEditableTarget } from '../hooks/keyboardUtils';

function getOscillatorLabel(index) {
  return `${index + 1}`;
}

function OscillatorControls({
  oscillatorCount = 2,
  isKbdTrayOpen = false,
  onKbdTrayToggle,
  isPaused = false,
  onPausedChange,
  droneEnabled = true,
  onDroneEnabledChange,
  isMixerOpen = true,
  onMixerToggle,
  isTuningOpen = false,
  onTuningToggle,
  routingMap = {},
  onSetVoiceRouting,
  onResetVoiceRouting,
}) {
  const [mutedOscillators, setMutedOscillators] = useState(() => Array(oscillatorCount).fill(false));
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

  const handleDroneToggle = () => {
    if (!audioEngine.initialized) return;
    const next = !droneEnabled;
    audioEngine.setDroneEnabled(next);
    onDroneEnabledChange?.(next);
  };

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

  // Per-voice pan: routingMap[i] holds the output channels (0=L, 1=R).
  // The origin depends on mode — in 'lr' it's the alternating hard-pan
  // (slot i → i%2); in 'stereo' it's the L/R split ([0,1] = ⊙ "both").
  // Either way the tray toggle cycles L → R → ⊙ → L and reset returns
  // every voice to its mode-appropriate origin.
  const defaultChannelsFor = (i) => (droneMode === 'stereo' ? [0, 1] : [i % 2]);
  const channelsFor = (i) => {
    const c = routingMap[i];
    return Array.isArray(c) && c.length ? c : defaultChannelsFor(i);
  };
  const panStateFor = (i) => {
    const c = channelsFor(i);
    if (c.length >= 2) return 'both';
    return c[0] === 1 ? 'R' : 'L';
  };
  const PAN_GLYPH = { L: 'L', R: 'R', both: '⊙' };
  const PAN_NEXT = { L: [1], R: [0, 1], both: [0] };
  const handleCyclePan = (i) => {
    if (!audioEngine.initialized) return;
    onSetVoiceRouting?.(i, PAN_NEXT[panStateFor(i)]);
  };
  // A voice is "out of place" when its routing differs from the mode's
  // origin — underlined in the tray so you can spot which were moved.
  const isPanDefault = (i) => {
    const c = channelsFor(i);
    const def = defaultChannelsFor(i);
    return c.length === def.length && def.every((ch, k) => c[k] === ch);
  };
  const anyPanNonDefault = oscillators.some((osc) => !isPanDefault(osc.index));

  return (
    <div className="osc-controls-panel">
      {/* Pan tray — one subtle L/R/⊙ toggle per voice, sitting directly
          above the drone mute squares so each lines up with its slot.
          Cycles L → R → ⊙(both). In stereo mode ⊙ is the L/R split and an
          L/R override collapses that voice's detune pair to one side. Reset
          (right slot, above the mute-all ×) returns every voice to its
          mode-appropriate origin and only appears once one differs. */}
      <div className={`pan-tray${droneEnabled ? ' open' : ''}`}>
        <div className="pan-tray-slot pan-tray-slot-left" aria-hidden="true" />
        <div className="pan-tray-cells">
          {oscillators.map((osc) => {
            const state = panStateFor(osc.index);
            const moved = !isPanDefault(osc.index);
            return (
              <button
                key={`p-${osc.index}`}
                type="button"
                className={`pan-tray-cell${moved ? ' moved' : ''}`}
                onClick={() => handleCyclePan(osc.index)}
                title={`Voice ${osc.label} pan: ${
                  state === 'both'
                    ? (droneMode === 'stereo' ? 'both (stereo split)' : 'both (center)')
                    : `${state} only`
                } — click to cycle L → R → ⊙`}
                aria-label={`Voice ${osc.label} pan ${state}`}
                tabIndex={droneEnabled ? 0 : -1}
              >
                {PAN_GLYPH[state]}
              </button>
            );
          })}
        </div>
        <div className="pan-tray-slot pan-tray-slot-right">
          {anyPanNonDefault && (
            <button
              type="button"
              className="pan-tray-reset"
              onClick={() => onResetVoiceRouting?.()}
              title={droneMode === 'stereo' ? 'Reset all voices to stereo' : 'Reset all voices to L/R'}
              aria-label={droneMode === 'stereo' ? 'Reset all voices to stereo' : 'Reset all voices to L/R'}
              tabIndex={droneEnabled ? 0 : -1}
            >
              ↵
            </button>
          )}
        </div>
      </div>
      {/* Drone tray — slides open whenever drones are enabled. Holds the
          per-osc mute squares (small, outlined when off, lit with osc
          color when on). Closed when droneEnabled is false; pointer
          events are suppressed via the open class so the squares can't
          be clicked while collapsed. */}
      <div className={`drone-tray${droneEnabled ? ' open' : ''}`}>
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
              tabIndex={droneEnabled ? 0 : -1}
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
            return (
              <button
                key={`m-${osc.index}`}
                type="button"
                className={`drone-tray-cell ${muted ? 'off' : 'on'}`}
                style={{ '--cell-color': osc.color }}
                onClick={() => handleMuteToggle(osc.index)}
                title={muted ? `Unmute ${osc.label}` : `Mute ${osc.label}`}
                aria-pressed={!muted}
                tabIndex={droneEnabled ? 0 : -1}
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
              tabIndex={droneEnabled ? 0 : -1}
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
          <div className="grid-cell bottom-cell-wrap osc-kbd-col">
            <button
              type="button"
              className={`bottom-cell bottom-toggle ${isKbdTrayOpen ? 'on' : 'off'}`}
              onClick={onKbdTrayToggle}
              aria-pressed={isKbdTrayOpen}
              title={isKbdTrayOpen ? 'Hide keyboard' : 'Show keyboard'}
              aria-label={isKbdTrayOpen ? 'Hide keyboard' : 'Show keyboard'}
            >
              <span className="bottom-toggle-label">KBD</span>
            </button>
          </div>
          <div className="grid-cell bottom-cell-wrap osc-all-col">
            <button
              type="button"
              className={`bottom-cell bottom-toggle ${droneEnabled ? 'on' : 'off'}`}
              onClick={handleDroneToggle}
              aria-pressed={droneEnabled}
              title={droneEnabled ? 'Turn drones off' : 'Turn drones on'}
              aria-label={droneEnabled ? 'Drones on — click to turn off' : 'Drones off — click to turn on'}
            >
              <span className="bottom-toggle-label">drone</span>
            </button>
          </div>
          <div className="grid-cell bottom-cell-wrap osc-mixer-col">
            <button
              type="button"
              className={`bottom-cell bottom-toggle ${isMixerOpen ? 'on' : 'off'}`}
              onClick={onMixerToggle}
              aria-pressed={isMixerOpen}
              title={isMixerOpen ? 'Hide mixer' : 'Show mixer'}
              aria-label={isMixerOpen ? 'Hide mixer' : 'Show mixer'}
            >
              <span className="bottom-toggle-label">MIXER</span>
            </button>
          </div>
          <div className="grid-cell bottom-cell-wrap osc-tuning-col">
            <button
              type="button"
              className={`bottom-cell bottom-toggle ${isTuningOpen ? 'on' : 'off'}`}
              onClick={onTuningToggle}
              aria-pressed={isTuningOpen}
              title={isTuningOpen ? 'Hide tuning' : 'Show tuning'}
              aria-label={isTuningOpen ? 'Hide tuning' : 'Show tuning'}
            >
              <span className="bottom-toggle-label">TUNING</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(OscillatorControls);

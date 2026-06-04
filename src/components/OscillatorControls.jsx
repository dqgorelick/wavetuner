import { memo, useEffect, useState, useMemo, useCallback } from 'react';
import audioEngine from '../audio/AudioEngine';
import keyboardVoiceManager from '../audio/KeyboardVoiceManager';
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
}) {
  const [mutedOscillators, setMutedOscillators] = useState(() => Array(oscillatorCount).fill(false));

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

  // Global play/pause — toggles the drone bus AND releases any held
  // computer-keyboard voices. This is what the leftmost bottom-row
  // button and the spacebar both fire so "everything off" is a single
  // gesture (drones fade out, keys release). Resume just unpauses
  // drones; keyboard voices have to be replayed.
  const handleGlobalPlayPause = useCallback(() => {
    if (!audioEngine.initialized) return;
    const wasPaused = audioEngine.paused;
    audioEngine.togglePlayPause();
    if (!wasPaused) keyboardVoiceManager.releaseAll('kbd');
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

  return (
    <div className="osc-controls-panel">
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
        <div className="drone-tray-slot drone-tray-slot-left" aria-hidden="true" />
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
              className={`bottom-cell bottom-play ${isPaused ? 'paused' : ''}`}
              onClick={handleGlobalPlayPause}
              title={isPaused ? 'Play everything (Space)' : 'Pause everything — silence drones + release keys (Space)'}
              aria-label={isPaused ? 'Play' : 'Pause'}
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

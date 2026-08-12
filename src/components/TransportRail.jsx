import { memo, useEffect, useState, useCallback, useRef } from 'react';
import audioEngine from '../audio/AudioEngine';
import keyboardVoiceManager from '../audio/KeyboardVoiceManager';
import midiOutput from '../audio/MidiOutput';
import { isEditableTarget } from '../hooks/keyboardUtils';
import MasterMeterRail from './MasterMeterRail';

// Left edge rail — the iOS master rail (ContentView.masterRail) brought to
// the web: a column flanking the console row's left edge (spanning the
// area below the spectrum bar) with the master play/pause in a closed box
// at the top and the vertical L/R master meter fader running down the
// rest of the lane. The drone-only play floats just
// under the play box, same visibility rule it had in the old console
// transport (only once keyboard/MIDI is sounding, or while the drone is
// solo-paused). Undo/redo moved to the right rail (NavRail).
// `registerEnsurePlaying` hands the parent a "make sound happen" callback.
// The master-pause flag lives in here (not in App), so anything outside
// the rail that needs to resume — the perform menu's GO / generative
// transition, which would otherwise commit a big audible change in
// silence — has to reach it through this handle.
function TransportRail({ isPaused = false, onPausedChange, registerEnsurePlaying }) {
  // Whether any computer-keyboard / MIDI note is currently sounding —
  // gates the drone-only play button (a first-time user with no input
  // never sees it; the master pause is all they need).
  const [hasPlayedNotes, setHasPlayedNotes] = useState(false);
  // Master transport state. Distinct from the drone pause (the `isPaused`
  // prop): the master pause silences drones AND keyboard/MIDI together,
  // whereas the drone button only pauses the drone.
  const [masterPaused, setMasterPaused] = useState(false);

  useEffect(() => {
    let animationId;
    // ~15 Hz poll — this loop derives one boolean ("any un-released
    // voice?"), and getActiveVoices() allocates a fresh object per voice
    // per call. Polling it at rAF rate (120 Hz on ProMotion) was pure
    // GC churn; a ≤66 ms latency on a play-button gate is imperceptible.
    const SYNC_MIN_MS = 1000 / 15 - 1.5;
    let lastTs = 0;
    const sync = (ts) => {
      animationId = requestAnimationFrame(sync);
      const now = typeof ts === 'number' ? ts : performance.now();
      if (now - lastTs < SYNC_MIN_MS) return;
      lastTs = now;
      if (audioEngine.initialized) {
        // Released voices (in their fade-out tail) don't count as playing.
        const playing = keyboardVoiceManager.getActiveVoices().some((v) => !v.released);
        setHasPlayedNotes((prev) => (prev === playing ? prev : playing));
      }
    };
    sync();
    return () => cancelAnimationFrame(animationId);
  }, []);

  // Master play/pause — the rail button and the spacebar both fire this.
  // It silences EVERYTHING (drones + computer/MIDI keyboard, locally and
  // on the external synth) and brings it all back on the next press,
  // overriding any independent drone pause. Held voices are kept alive
  // (the keyboard bus is muted, not released) so they sound again on
  // resume; the synth gets note-offs on pause and re-triggers on resume
  // via MidiOutput's reconcile loop. Uses explicit pause/unpause (not a
  // toggle) so it can't fight the drone button over isPaused.
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
      // Noise has no envelope of its own — gate it here or "pause
      // everything" would leave the hiss running.
      audioEngine.setNoisePaused(true);
    } else {
      audioEngine.unpauseDrones();
      midiOutput.setDroneMuted(false);
      audioEngine.setKeyboardEnabled(kbdEnabledBeforeMuteRef.current);
      midiOutput.setKbdMuted(false);
      audioEngine.setNoisePaused(false);
    }
    setMasterPaused(nextPaused);
    onPausedChange?.(audioEngine.paused);
  }, [onPausedChange]);

  // The drone's OWN play/pause. Pauses just the drone — locally and on
  // the synth — while keyboard / MIDI keep playing, so the drone reads as
  // a self-contained instrument. Resuming the drone does NOT un-pause
  // anything else.
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

  // Resume whatever is silencing the drones, using the SAME handlers the
  // buttons use so their state never drifts out of sync. Master pause
  // wins — it also gates keyboard/MIDI and the noise bed, so unpausing
  // the drone alone would leave the rail's play glyph lying.
  const ensurePlaying = useCallback(() => {
    if (!audioEngine.initialized) return;
    if (masterPausedRef.current) handleGlobalPlayPause();
    else if (audioEngine.paused) handleDronePauseToggle();
  }, [handleGlobalPlayPause, handleDronePauseToggle]);
  useEffect(() => {
    registerEnsurePlaying?.(ensurePlaying);
    return () => registerEnsurePlaying?.(null);
  }, [registerEnsurePlaying, ensurePlaying]);

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

  return (
    <div className="edge-rail edge-rail-left">
      {/* Master play/pause — the rail-top closed box (iOS playPauseButton:
          the WHOLE slot is the button, glyph brightens while paused). */}
      <button
        type="button"
        className={`rail-play ${masterPaused ? 'paused' : ''}`}
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
      {/* Drone-only play/pause — under the master play, shown once
          keyboard/MIDI is sounding (or while the drone is solo-paused). */}
      {(hasPlayedNotes || (isPaused && !masterPaused)) && (
        <button
          type="button"
          className={`console-drone-play rail-drone-play ${isPaused ? 'paused' : ''}`}
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
      {/* Master meter fader — fills the rest of the lane down to the
          rail's foot, like the iOS master column. */}
      <MasterMeterRail />
    </div>
  );
}

export default memo(TransportRail);

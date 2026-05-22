import { memo, useEffect, useState } from 'react';
import audioEngine from '../audio/AudioEngine';
import keyboardVoiceManager from '../audio/KeyboardVoiceManager';
import { keyboardEnvelope } from '../audio/Envelope';
import { droneStereo, keyboardStereo, midiStereo } from '../audio/StereoMode';
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
    return;
  }
  // Bus faders use 0..2 range so the slider maps v → v*2. Unity (1.0)
  // sits at the midpoint; right half is the +1..+2 boost zone.
  const bus = fader.getAttribute('data-bus');
  if (bus !== null) {
    const gain = v * 2;
    if (bus === 'drone') audioEngine.setDroneBusGain(gain);
    else if (bus === 'kbd') audioEngine.setKbdBusGain(gain);
    else if (bus === 'midi') audioEngine.setMidiBusGain(gain);
    return;
  }
  // Master fader stays on the engine's existing 0..1 range — drags map
  // directly without scaling.
  if (fader.hasAttribute('data-master')) {
    audioEngine.setMasterVolume(v);
  }
}

// Double-tap detection state for the three bus faders. Browsers don't
// fire `dblclick` reliably on touch when we preventDefault() on
// pointerdown (which we have to, for drag), so we track our own
// timestamp + last-bus and reset to unity (1.0) when a second tap
// arrives within DOUBLE_TAP_MS on the SAME bus fader.
const DOUBLE_TAP_MS = 300;
let _lastBusTapTime = 0;
let _lastBusTapKey = null;

// Pointer-down on any fader starts the drag. Listeners live on document
// so the cursor can leave the panel and continue tracking — matching the
// detune-orb behavior. Released-voice rows bail out before listeners
// attach, so they can't initiate a sweep but they still receive
// applyAtPoint no-ops when swept over (handled inside setVoiceLevel).
function startMixerDrag(e) {
  if (e.currentTarget.dataset.released === 'true') return;

  // Double-tap reset for the bus faders. The first tap still sets the
  // bus value via the normal drag path below; the second tap (within
  // 300 ms, on the same bus) snaps it to unity. The brief mid-tap
  // value flash isn't worth the complexity of deferring the first
  // apply.
  const busKey = e.currentTarget.getAttribute('data-bus');
  if (busKey !== null) {
    const now =
      typeof performance !== 'undefined' && performance.now
        ? performance.now()
        : Date.now();
    if (busKey === _lastBusTapKey && now - _lastBusTapTime < DOUBLE_TAP_MS) {
      e.preventDefault();
      if (busKey === 'drone') audioEngine.setDroneBusGain(1.0);
      else if (busKey === 'kbd') audioEngine.setKbdBusGain(1.0);
      else if (busKey === 'midi') audioEngine.setMidiBusGain(1.0);
      _lastBusTapTime = 0;
      _lastBusTapKey = null;
      return;
    }
    _lastBusTapTime = now;
    _lastBusTapKey = busKey;
  }

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

// Bus / master row color. Single neutral white so the bus strip reads
// as utility controls rather than another colored sound source.
const BUS_COLOR = 'rgba(255, 255, 255, 0.85)';

// Render a 0..2 bus fader. Slider position represents value/2 so the
// midpoint of the track lands at unity (1.0×). Layout uses the same
// .mixer-row grid as the dynamic rows above so the fader column and
// mute button align exactly with drone/voice rows. A small stereo-mode
// toggle sits to the left of the value readout so the user can flip
// each source's pan mode without leaving the mixer.
const BusFader = memo(function BusFader({
  busKey, label, value, muted, stereoMode, onToggleMute, onToggleStereo,
}) {
  const fill = Math.max(0, Math.min(1, value / 2));
  const stopPointer = (e) => e.stopPropagation();
  const isStereo = stereoMode === 'stereo';
  return (
    <div
      className={`mixer-row mixer-row-bus ${muted ? 'muted' : ''}`}
      style={{ '--mixer-color': BUS_COLOR }}
    >
      <span className="mixer-bus-label">{label}</span>
      <div className="mixer-bus-meta" onPointerDown={stopPointer}>
        <button
          type="button"
          className={`mixer-stereo-toggle ${isStereo ? 'is-stereo' : 'is-lr'}`}
          onClick={onToggleStereo}
          title={isStereo ? 'Switch to L/R panning' : 'Switch to stereo panning'}
          aria-label={isStereo ? 'Stereo mode (click for L/R)' : 'L/R mode (click for stereo)'}
        >
          L<span className="mixer-stereo-mid">{isStereo ? '+' : '|'}</span>R
        </button>
        <span className="mixer-bus-value">{value.toFixed(2)}×</span>
      </div>
      <span className="mixer-source-tag mixer-source-tag-empty" />
      <Fader
        dataAttrs={{ 'data-bus': busKey }}
        fill={fill}
        ball={fill}
        color={BUS_COLOR}
        released={false}
      />
      <div className="mixer-row-buttons mixer-row-buttons-voice" onPointerDown={stopPointer}>
        <button
          type="button"
          className="mixer-btn mixer-btn-mute"
          onClick={onToggleMute}
          title={muted ? 'Unmute this bus' : 'Mute this bus'}
          aria-label={muted ? 'Unmute bus' : 'Mute bus'}
        >{muted ? '○' : '×'}</button>
      </div>
    </div>
  );
});

// Pick a CSS class for a meter channel based on its peak-hold level.
// Green under 0.85, amber 0.85..0.999, red at clip.
function meterZone(holdLevel) {
  if (holdLevel >= 0.999) return 'clip';
  if (holdLevel >= 0.85) return 'hot';
  return '';
}

// Master row — the slider track is REPLACED by two stacked horizontal
// meters (L on top, R on bottom) reading the engine's post-master
// analyser nodes. The fader ball still indicates the user's volume
// setting, sitting on top of the meters so dragging it stays natural.
// peak hold ticks decay slowly per channel so brief transients stay
// visible long enough to read.
const MasterFader = memo(function MasterFader({
  value, muted, peakL, peakR, peakHoldL, peakHoldR, onToggleMute,
}) {
  const ballPct = Math.max(0, Math.min(1, value)) * 100;
  const metPctL = Math.max(0, Math.min(1, peakL)) * 100;
  const metPctR = Math.max(0, Math.min(1, peakR)) * 100;
  const holdPctL = Math.max(0, Math.min(1, peakHoldL)) * 100;
  const holdPctR = Math.max(0, Math.min(1, peakHoldR)) * 100;
  const zoneL = meterZone(peakHoldL);
  const zoneR = meterZone(peakHoldR);
  const stopPointer = (e) => e.stopPropagation();
  return (
    <div
      className={`mixer-row mixer-row-master ${muted ? 'muted' : ''}`}
      style={{ '--mixer-color': BUS_COLOR }}
    >
      <span className="mixer-bus-label">Main</span>
      <span className="mixer-bus-value">{value.toFixed(2)}</span>
      <span className="mixer-source-tag mixer-source-tag-empty" />
      <div
        className="mixer-fader mixer-fader-master"
        style={{ '--mixer-color': BUS_COLOR }}
        onPointerDown={startMixerDrag}
        data-master=""
      >
        <div className={`mixer-master-meter-row L ${zoneL}`} style={{ width: `${metPctL}%` }} />
        <div className={`mixer-master-meter-row R ${zoneR}`} style={{ width: `${metPctR}%` }} />
        {peakHoldL > 0.001 && (
          <div className="mixer-master-meter-hold L" style={{ left: `${holdPctL}%` }} />
        )}
        {peakHoldR > 0.001 && (
          <div className="mixer-master-meter-hold R" style={{ left: `${holdPctR}%` }} />
        )}
        <div className="mixer-fader-ball" style={{ left: `${ballPct}%` }} />
      </div>
      <div className="mixer-row-buttons mixer-row-buttons-voice" onPointerDown={stopPointer}>
        <button
          type="button"
          className="mixer-btn mixer-btn-mute"
          onClick={onToggleMute}
          title={muted ? 'Unmute main output' : 'Mute main output'}
          aria-label={muted ? 'Unmute main' : 'Mute main'}
        >{muted ? '○' : '×'}</button>
      </div>
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
  // Bus + master fader values (kept in state so React redraws when the
  // user drags). All three bus values are 0..2; master is 0..1.
  const [busDrone, setBusDrone] = useState(() => audioEngine.getDroneBusGain?.() ?? 1);
  const [busKbd, setBusKbd] = useState(() => audioEngine.getKbdBusGain?.() ?? 1);
  const [busMidi, setBusMidi] = useState(() => audioEngine.getMidiBusGain?.() ?? 1);
  const [master, setMaster] = useState(() => audioEngine.getMasterVolume?.() ?? 1);
  const [muteDrone, setMuteDrone] = useState(() => audioEngine.isDroneBusMuted?.() ?? false);
  const [muteKbd, setMuteKbd] = useState(() => audioEngine.isKbdBusMuted?.() ?? false);
  const [muteMidi, setMuteMidi] = useState(() => audioEngine.isMidiBusMuted?.() ?? false);
  const [muteMaster, setMuteMaster] = useState(() => audioEngine.isMasterMuted?.() ?? false);
  // Per-source stereo mode ('lr' | 'stereo'). The three pools own their
  // own StereoMode instances; this state mirrors them so the mixer row
  // re-renders when the user toggles. Subscriptions below keep them
  // in sync with external changes (e.g. URL state, settings panel).
  const [stereoDrone, setStereoDrone] = useState(() => droneStereo.mode);
  const [stereoKbd, setStereoKbd] = useState(() => keyboardStereo.mode);
  const [stereoMidi, setStereoMidi] = useState(() => midiStereo.mode);
  useEffect(() => {
    const unDrone = droneStereo.onChange((s, info) => {
      if (info?.kind === 'mode') setStereoDrone(s.mode);
    });
    const unKbd = keyboardStereo.onChange((s, info) => {
      if (info?.kind === 'mode') setStereoKbd(s.mode);
    });
    const unMidi = midiStereo.onChange((s, info) => {
      if (info?.kind === 'mode') setStereoMidi(s.mode);
    });
    return () => { unDrone(); unKbd(); unMidi(); };
  }, []);
  // Post-master stereo peak meter. peakL/R = instantaneous frame peak
  // per channel; peakHoldL/R decay slowly so brief transients stay
  // visible long enough to read.
  const [peakL, setPeakL] = useState(0);
  const [peakR, setPeakR] = useState(0);
  const [peakHoldL, setPeakHoldL] = useState(0);
  const [peakHoldR, setPeakHoldR] = useState(0);

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

        // Bus + master fader live values. Cheap reads; the setters
        // short-circuit React updates when the value is unchanged so
        // this doesn't cause re-renders on every frame.
        const nextDrone = audioEngine.getDroneBusGain();
        const nextKbd = audioEngine.getKbdBusGain();
        const nextMidi = audioEngine.getMidiBusGain();
        const nextMaster = audioEngine.getMasterVolume();
        setBusDrone(prev => Math.abs(prev - nextDrone) > 0.001 ? nextDrone : prev);
        setBusKbd(prev => Math.abs(prev - nextKbd) > 0.001 ? nextKbd : prev);
        setBusMidi(prev => Math.abs(prev - nextMidi) > 0.001 ? nextMidi : prev);
        setMaster(prev => Math.abs(prev - nextMaster) > 0.001 ? nextMaster : prev);
        // Mute flags (updated via toggle methods on the engine; also
        // auto-reset when the user drags a slider).
        const nextMuteDrone = audioEngine.isDroneBusMuted();
        const nextMuteKbd = audioEngine.isKbdBusMuted();
        const nextMuteMidi = audioEngine.isMidiBusMuted();
        const nextMuteMaster = audioEngine.isMasterMuted();
        setMuteDrone(prev => prev !== nextMuteDrone ? nextMuteDrone : prev);
        setMuteKbd(prev => prev !== nextMuteKbd ? nextMuteKbd : prev);
        setMuteMidi(prev => prev !== nextMuteMidi ? nextMuteMidi : prev);
        setMuteMaster(prev => prev !== nextMuteMaster ? nextMuteMaster : prev);

        // Post-master stereo peak meter. peakHold decays exponentially
        // per channel so brief transients stay visible ~1s before
        // fading. Each channel holds independently so a panned signal
        // produces an asymmetric meter the user can read at a glance.
        const { peakL: pL, peakR: pR } = audioEngine.getMasterPeakLevels();
        setPeakL(prev => Math.abs(prev - pL) > 0.001 ? pL : prev);
        setPeakR(prev => Math.abs(prev - pR) > 0.001 ? pR : prev);
        const decay = 0.97; // ~1s to fall ~50% at 60fps
        setPeakHoldL(prev => {
          const next = Math.max(prev * decay, pL);
          return Math.abs(next - prev) > 0.001 ? next : prev;
        });
        setPeakHoldR(prev => {
          const next = Math.max(prev * decay, pR);
          return Math.abs(next - prev) > 0.001 ? next : prev;
        });
      } catch { /* ignore */ }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [oscillatorCount]);

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
              <span className="mixer-marker">{source === 'kbd' ? `K${slot + 1}` : `M${slot + 1}`}</span>
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
      {/* Bus + master strip pinned beneath the dynamic mixer rows. Always
          visible — these knobs balance per-source loudness without
          restructuring the engine. */}
      <div className="mixer-bus-stack">
        <BusFader
          busKey="drone"
          label="Drone"
          value={busDrone}
          muted={muteDrone}
          stereoMode={stereoDrone}
          onToggleMute={() => audioEngine.toggleDroneBusMute()}
          onToggleStereo={() => droneStereo.setMode(stereoDrone === 'stereo' ? 'lr' : 'stereo')}
        />
        <BusFader
          busKey="kbd"
          label="KBD"
          value={busKbd}
          muted={muteKbd}
          stereoMode={stereoKbd}
          onToggleMute={() => audioEngine.toggleKbdBusMute()}
          onToggleStereo={() => keyboardStereo.setMode(stereoKbd === 'stereo' ? 'lr' : 'stereo')}
        />
        <BusFader
          busKey="midi"
          label="MIDI"
          value={busMidi}
          muted={muteMidi}
          stereoMode={stereoMidi}
          onToggleMute={() => audioEngine.toggleMidiBusMute()}
          onToggleStereo={() => midiStereo.setMode(stereoMidi === 'stereo' ? 'lr' : 'stereo')}
        />
        <MasterFader
          value={master}
          muted={muteMaster}
          peakL={peakL}
          peakR={peakR}
          peakHoldL={peakHoldL}
          peakHoldR={peakHoldR}
          onToggleMute={() => audioEngine.toggleMasterMute()}
        />
      </div>
    </div>
  );
}

export default memo(Mixer);

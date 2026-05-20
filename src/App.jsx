import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import audioEngine from './audio/AudioEngine';
import tuning from './audio/Tuning';
import keyboardVoiceManager from './audio/KeyboardVoiceManager';
import { droneEnvelope, keyboardEnvelope } from './audio/Envelope';
import { droneWave, keyboardWave } from './audio/Wave';
import { droneFold, keyboardFold } from './audio/Fold';
import { droneStereo, keyboardStereo } from './audio/StereoMode';
import frequencyManager from './audio/FrequencyManager';
import midiInput from './audio/MidiInput';
import palette from './theme/palette';
import Oscilloscope from './components/Oscilloscope';
import OscillatorControls from './components/OscillatorControls';
import FrequencySpectrumBar from './components/FrequencySpectrumBar';
import FullscreenFreqList from './components/FullscreenFreqList';
import FrequencyManagerPanel from './components/FrequencyManager';
import StartScreen from './components/StartScreen';
import SettingsPanel from './components/SettingsPanel';
import KeyboardTray from './components/KeyboardTray';
import Mixer from './components/Mixer';
import PatchesPanel from './components/PatchesPanel';
import HydraPanel from './components/HydraPanel';
import HydraOverlay from './components/HydraOverlay';
import { startHydra, stopHydra, evalHydra } from './visuals/Hydra';
import { BUILTIN_SKETCHES, DEFAULT_SKETCH_ID } from './visuals/hydraSketches';
import { getAutosave, setAutosave } from './patches/storage';
import { applyPatch, applyPatchSmooth, preInitApplyPatch, applyPatchRoutingPostInit, capturePatch } from './patches/apply';
import './App.css';

// Parse "A,D,S,R" envelope param (A/D/R in ms, S in 0..1 or 0..100). Returns
// {attack, decay, sustain, release} with each in seconds, or null on bad input.
function parseEnvParam(str) {
  if (!str) return null;
  const parts = str.split(',').map(Number);
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return null;
  let [aMs, dMs, s, rMs] = parts;
  // Sustain may be encoded as 0..100 (older URLs) or 0..1 — both round-trip
  // sanely if we treat anything > 1 as a percentage.
  if (s > 1) s = s / 100;
  return {
    attack: Math.max(0.001, aMs / 1000),
    decay: Math.max(0.001, dMs / 1000),
    sustain: Math.max(0, Math.min(1, s)),
    release: Math.max(0.001, rMs / 1000),
  };
}

// Parse URL params for initial state (called once at module load)
function getInitialStateFromURL() {
  const params = new URLSearchParams(window.location.search);
  const fParam = params.get('f');
  const vParam = params.get('v');
  const rParam = params.get('r');
  const dEnv = parseEnvParam(params.get('dEnv'));
  const kEnv = parseEnvParam(params.get('kEnv'));
  // Visualizer "trace cycles": clamp to slider range and reject NaN.
  // See research/oscilloscope-frequency-adaptive.md §5.
  const cyParam = parseInt(params.get('cy') || '', 10);
  const vizCycles = Number.isFinite(cyParam) && cyParam >= 1 && cyParam <= 16
    ? cyParam
    : null;
  // Wave-shape morph (0..3) and wavefolder amount (0..1) per pool.
  // Both null when the URL doesn't carry them so defaults stay 0.
  const parseFloatInRange = (raw, min, max) => {
    const n = parseFloat(raw);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : null;
  };
  const dWave = parseFloatInRange(params.get('dWave'), 0, 3);
  const kWave = parseFloatInRange(params.get('kWave'), 0, 3);
  const dFold = parseFloatInRange(params.get('dFold'), 0, 1);
  const kFold = parseFloatInRange(params.get('kFold'), 0, 1);
  // Per-pool stereo mode + detune. Both pools share the same param
  // shapes: dPan/dDet for drones, kPan/kDet for keyboard.
  const dPanRaw = (params.get('dPan') || '').toLowerCase();
  const droneStereoMode = dPanRaw === 'lr' || dPanRaw === 'stereo' ? dPanRaw : null;
  const droneDetuneHz = parseFloatInRange(params.get('dDet'), 0, 10);
  const parseCurve = (raw) => {
    if (!raw) return null;
    const parts = raw.split(',').map(Number);
    if (parts.some(n => Number.isNaN(n))) return null;
    return parts.map(n => Math.max(0, Math.min(1, n)));
  };
  const droneCurve = parseCurve(params.get('dCurve'));
  const kPanRaw = (params.get('kPan') || '').toLowerCase();
  const kbdStereoMode = kPanRaw === 'lr' || kPanRaw === 'stereo' ? kPanRaw : null;
  const kbdDetuneHz = parseFloatInRange(params.get('kDet'), 0, 10);
  const kbdCurve = parseCurve(params.get('kCurve'));
  const tRaw = (params.get('t') || '').toLowerCase();
  const theme = tRaw === 'classic' || tRaw === 'duo' ? tRaw : null;

  let base = { count: 4, frequencies: null, volumes: null, routing: null };

  if (fParam && vParam) {
    const frequencies = fParam.split(',').map(Number);
    const volumes = vParam.split(',').map(Number); // Keep as 0-100 (initialize() will convert)

    // Parse routing: "0:0.1,1:1,2:0" => { 0: [0,1], 1: [1], 2: [0] }
    let routing = null;
    if (rParam) {
      routing = {};
      rParam.split(',').forEach(part => {
        const [osc, channels] = part.split(':');
        if (osc !== undefined && channels !== undefined) {
          routing[parseInt(osc)] = channels.split('.').map(Number);
        }
      });
    }

    if (frequencies.length >= 2 && volumes.length >= 2) {
      const count = Math.min(frequencies.length, volumes.length, 10);
      base = {
        count,
        frequencies: frequencies.slice(0, count),
        volumes: volumes.slice(0, count),
        routing,
      };
    }
  }
  return { ...base, dEnv, kEnv, vizCycles, dWave, kWave, dFold, kFold, droneStereoMode, droneDetuneHz, droneCurve, kbdStereoMode, kbdDetuneHz, kbdCurve, theme };
}

// Compute once at module load
const INITIAL_URL_STATE = getInitialStateFromURL();

// Push envelope params from the URL into the singletons immediately, so
// the first audio scheduled (initial drone fade-in, default keyboard
// state) already uses the user's saved values rather than the
// hard-coded defaults.
if (INITIAL_URL_STATE.dEnv) {
  droneEnvelope.attack = INITIAL_URL_STATE.dEnv.attack;
  droneEnvelope.decay = INITIAL_URL_STATE.dEnv.decay;
  droneEnvelope.sustain = INITIAL_URL_STATE.dEnv.sustain;
  droneEnvelope.release = INITIAL_URL_STATE.dEnv.release;
}
if (INITIAL_URL_STATE.kEnv) {
  keyboardEnvelope.attack = INITIAL_URL_STATE.kEnv.attack;
  keyboardEnvelope.decay = INITIAL_URL_STATE.kEnv.decay;
  keyboardEnvelope.sustain = INITIAL_URL_STATE.kEnv.sustain;
  keyboardEnvelope.release = INITIAL_URL_STATE.kEnv.release;
}
// Wave + Fold are pool-singletons that drive the audio path directly.
// Pushing values in BEFORE AudioEngine.initialize means the first
// PeriodicWave / fold curve created uses the user's saved values
// rather than the defaults — no audible snap on load.
if (INITIAL_URL_STATE.dWave !== null) droneWave.setPosition(INITIAL_URL_STATE.dWave);
if (INITIAL_URL_STATE.kWave !== null) keyboardWave.setPosition(INITIAL_URL_STATE.kWave);
if (INITIAL_URL_STATE.dFold !== null) droneFold.setAmount(INITIAL_URL_STATE.dFold);
if (INITIAL_URL_STATE.kFold !== null) keyboardFold.setAmount(INITIAL_URL_STATE.kFold);
// Per-pool stereo mode + detune — pushed pre-init so the first
// frame of audio uses the saved values rather than snapping from default.
if (INITIAL_URL_STATE.droneStereoMode !== null) droneStereo.setMode(INITIAL_URL_STATE.droneStereoMode);
if (INITIAL_URL_STATE.droneDetuneHz !== null) droneStereo.setDetuneHz(INITIAL_URL_STATE.droneDetuneHz);
// URL-provided curves are pushed in pre-init; the random default is
// applied AFTER audioEngine.initialize() so it sees the real
// oscillator count (autosave can load 12 slots, but INITIAL_URL_STATE
// .count would still be the URL/4-default — pre-seeding to that count
// would leave the higher slots flat).
if (INITIAL_URL_STATE.droneCurve) {
  droneStereo.detuneCurve = INITIAL_URL_STATE.droneCurve.slice();
}
if (INITIAL_URL_STATE.kbdStereoMode !== null) keyboardStereo.setMode(INITIAL_URL_STATE.kbdStereoMode);
if (INITIAL_URL_STATE.kbdDetuneHz !== null) keyboardStereo.setDetuneHz(INITIAL_URL_STATE.kbdDetuneHz);
if (INITIAL_URL_STATE.kbdCurve) {
  keyboardStereo.detuneCurve = INITIAL_URL_STATE.kbdCurve.slice();
}
// Color theme — pushed pre-mount so the very first paint already uses
// the user's saved palette rather than flashing the default.
if (INITIAL_URL_STATE.theme) palette.setTheme(INITIAL_URL_STATE.theme);

// Visualizer modes — defined at module scope so the SVG icons are
// constructed once and reused across renders. The trigger button shows
// the active mode's icon; the dropdown fans the others out below it.
const VIZ_MODES = [
  {
    id: 0,
    label: 'Circle',
    icon: <circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" strokeWidth="2" />,
  },
  {
    id: 1,
    label: 'Wave',
    icon: <path d="M2 12 Q 6 5, 9 12 T 16 12 T 22 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
  },
  {
    id: 2,
    label: 'Face',
    icon: (
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="8" cy="9" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="16" cy="9" r="1.6" fill="currentColor" stroke="none" />
        <path d="M7.5 15 Q 12 18, 16.5 15" />
      </g>
    ),
  },
  {
    id: 3,
    label: 'Hilbert',
    icon: (
      <g fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="9.5" cy="12" r="5" />
        <circle cx="14.5" cy="12" r="5" />
      </g>
    ),
  },
];


function App() {
  const [isStarted, setIsStarted] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isPatchesOpen, setIsPatchesOpen] = useState(false);
  // Hydra mode: when on, the hydra-synth canvas overlays the
  // oscilloscope and the scope canvas is hidden (per user preference —
  // cleaner output when running a sketch). Defaults ON so a fresh
  // session boots straight into the chromatic sketch — the
  // oscilloscope still draws into its (hidden) canvas as Hydra's s0
  // source. Panel toggle is independent from the enable state so the
  // editor can be opened/closed without disrupting playback.
  const [isHydraEnabled, setIsHydraEnabled] = useState(true);
  const [isHydraPanelOpen, setIsHydraPanelOpen] = useState(false);
  const hydraCanvasRef = useRef(null);

  // Boot/teardown Hydra when the enable toggle flips. Source the
  // oscilloscope's canvas via its known id (stable, no ref plumbing)
  // and run the default passthrough sketch so the user sees output
  // immediately. The wrapping setTimeout gives the overlay canvas a
  // tick to size to its parent before Hydra reads its dimensions.
  useEffect(() => {
    if (!isHydraEnabled) {
      stopHydra();
      return undefined;
    }
    let cancelled = false;
    const id = setTimeout(() => {
      if (cancelled) return;
      const overlayCanvas = hydraCanvasRef.current;
      const sourceCanvas = document.getElementById('scope');
      if (!overlayCanvas || !sourceCanvas) return;
      startHydra({ canvas: overlayCanvas, sourceCanvas });
      const defaultSketch = BUILTIN_SKETCHES.find(s => s.id === DEFAULT_SKETCH_ID);
      if (defaultSketch) evalHydra(defaultSketch.code);
    }, 50);
    return () => { cancelled = true; clearTimeout(id); };
  }, [isHydraEnabled]);

  // Hydra panel and patches panel share screen real estate — opening one
  // closes the other so they don't overlap.
  const openHydraPanel = useCallback(() => {
    setIsPatchesOpen(false);
    setIsHydraPanelOpen(true);
  }, []);
  const toggleHydraPanel = useCallback(() => {
    if (isHydraPanelOpen) setIsHydraPanelOpen(false);
    else openHydraPanel();
  }, [isHydraPanelOpen, openHydraPanel]);
  // Most recently loaded patch — drives the "return" button beneath the
  // align button so the user can snap state back to whatever patch they
  // last opened. Cleared when no patch has been loaded this session.
  const [currentPatch, setCurrentPatch] = useState(null);
  // Static waveform style. 'beating' shows only the aggregate line;
  // 'wave' shows per-oscillator colored lines + aggregate; 'off' hides
  // the static entirely. Number of periods visible is user-controlled
  // via staticPeriods.
  const [staticMode, setStaticMode] = useState('beating');
  // How many periods of the fundamental fit in the static waveform's
  // display window. Applies to both 'beating' and 'wave' styles —
  // more periods → denser display, better for seeing beat envelopes;
  // fewer → easier to read individual wave shapes.
  const [staticPeriods, setStaticPeriods] = useState(20);
  // Line thickness multiplier (both per-osc colored lines and the
  // aggregate composite) and colored-outline thickness for the
  // aggregate (XY-scope-style neon halo; 0 = no outline, just the
  // white core).
  const [staticLineWidth, setStaticLineWidth] = useState(2.0);
  const [staticOutlineThickness, setStaticOutlineThickness] = useState(2.5);
  // Lissajous-only multipliers (vizMode 0). Surfaced via the Hydra
  // panel's Visualizer section. Defaults of 1 keep the look identical
  // to pre-slider rendering — drag up/down to taste.
  const [vizScale, setVizScale] = useState(1.0);
  const [vizLineWidth, setVizLineWidth] = useState(1.0);
  const [vizOutline, setVizOutline] = useState(1.0);
  // Lissajous rotation: 0 = square (default), +1 = diamond (+45°),
  // −1 = mirror diamond (−45°). Opt-in via the Hydra panel.
  const [vizRotation, setVizRotation] = useState(0);
  // Visualizer mode: 0 circle (XY), 1 line (standing wave), 2 face, 3 hilbert.
  const [vizMode, setVizMode] = useState(0);
  // Visualizer-mode dropdown: the trigger button (active mode's symbol)
  // toggles a vertical fan of the remaining modes below it. Closes on
  // outside click and after picking an option.
  const [isVizDropdownOpen, setIsVizDropdownOpen] = useState(false);
  const vizDropdownRef = useRef(null);
  useEffect(() => {
    if (!isVizDropdownOpen) return;
    const onDocPointerDown = (e) => {
      if (vizDropdownRef.current && !vizDropdownRef.current.contains(e.target)) {
        setIsVizDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocPointerDown);
    return () => document.removeEventListener('mousedown', onDocPointerDown);
  }, [isVizDropdownOpen]);
  // Adaptive synth-buffer length is derived from this × sampleRate /
  // highest-active-freq, clamped to [128, 2048]. Higher = more cycles
  // / richer drift; lower = crisper figures (especially at high freqs).
  // Default 6 reads as "a few clean cycles" across the audible range.
  const [vizCycles, setVizCycles] = useState(INITIAL_URL_STATE.vizCycles ?? 13);
  // Visualizer source is now hardcoded per mode in Oscilloscope.jsx
  // (Circle + Face → audio, Hilbert + Standing-line → synth) — no
  // user-facing toggle.
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [oscillatorCount, setOscillatorCount] = useState(INITIAL_URL_STATE.count);
  const [routingMap, setRoutingMap] = useState({});
  const [fineTuneEnabled, setFineTuneEnabled] = useState(false);
  const [activeOscs, setActiveOscs] = useState(() => new Set());
  // Set of oscillator indices currently being fine-tuned via horizontal drag
  // on a volume fader. Used to light up the matching spectrum-bar orb so the
  // user sees which osc they're affecting.
  const [fineTuningOscs, setFineTuningOscs] = useState(() => new Set());
  const handleFineTuningChange = useCallback((index, isFineTuning) => {
    setFineTuningOscs((prev) => {
      const has = prev.has(index);
      if (isFineTuning === has) return prev;
      const next = new Set(prev);
      if (isFineTuning) next.add(index); else next.delete(index);
      return next;
    });
  }, []);
  // 'simple' (default compact strip) | 'expanded' (full panel) | 'fullscreen' (only scope+spectrum)
  const [uiMode, setUiMode] = useState('simple');
  // Keyboard tray (slim ~50 px strip rolling up from the bottom). Lifted
  // to App so the wrapper can pick up a `kbd-tray-open` class — that
  // class shifts every bottom-anchored fixed element up by the tray's
  // height (see App.css).
  const [isKbdTrayOpen, setIsKbdTrayOpen] = useState(false);
  // Keyboard mapping picker. Lives in React state so SettingsPanel can
  // render the radios; pushed into the Tuning singleton on change so
  // non-React callers (voice manager, computer-keyboard hook) see it via
  // tuning.degreeAndOctaveForMidi.
  const [kbdKeyMode, setKbdKeyMode] = useState('chromatic'); // 'chromatic' | 'white-only'
  const [kbdFillMode, setKbdFillMode] = useState('fill');    // 'fill' | 'jump'
  useEffect(() => { tuning.setKeyMode(kbdKeyMode); }, [kbdKeyMode]);
  useEffect(() => { tuning.setFillMode(kbdFillMode); }, [kbdFillMode]);
  // Auto-default: when there are more drone notes than fit in one
  // octave for the current key mode, the only useful fill mode is
  // "fill" (jump would silence the extra notes). Threshold: 7 for
  // white-only (7 keys per octave), 11 for chromatic (12 keys per
  // octave — at N=12 jump and fill collapse to the same thing, but
  // beyond that fill is the only mode that exposes every degree).
  useEffect(() => {
    const threshold = kbdKeyMode === 'white-only' ? 7 : 11;
    if (oscillatorCount > threshold) setKbdFillMode('fill');
  }, [oscillatorCount, kbdKeyMode]);
  // Hold mode is per source. The computer keyboard runs in an expressive
  // mode (long ramp on attack, freeze-on-keyup), so hold-on is its
  // default; MIDI defaults to press-and-hold like a normal controller.
  // Pressing a latched note from either source toggles it off.
  const [kbdHoldOn, setKbdHoldOn] = useState(true);
  const [midiHoldOn, setMidiHoldOn] = useState(false);
  useEffect(() => { keyboardVoiceManager.setHold(kbdHoldOn, 'kbd'); }, [kbdHoldOn]);
  useEffect(() => { keyboardVoiceManager.setHold(midiHoldOn, 'midi'); }, [midiHoldOn]);

  // Computer-keyboard voice cap. Cap exceeded → oldest kbd voice enters
  // its release tail (no abrupt cut). Default 2 encourages two-handed
  // picking on a Mac keyboard. MIDI keeps the voice manager's built-in
  // default (32) — no UI for it yet.
  const [kbdVoiceCount, setKbdVoiceCount] = useState(2);
  useEffect(() => { keyboardVoiceManager.setMaxVoices(kbdVoiceCount, 'kbd'); }, [kbdVoiceCount]);

  // Re-press behavior when kbd hold is engaged. 'toggle' = second press
  // releases the latched voice. 'restart' = second press releases AND
  // spawns a fresh voice ramping from 0. Kbd-only knob.
  const [kbdRepressMode, setKbdRepressMode] = useState('toggle');
  useEffect(() => { keyboardVoiceManager.setKbdRepressMode(kbdRepressMode); }, [kbdRepressMode]);
  // MIDI-input gate — when off, incoming MIDI messages are dropped at
  // the source (MidiInput._handleMessage). Computer-keyboard and
  // on-screen play paths are unaffected. The keyboard *bus* itself
  // stays live so its volume fader is always interactive.
  const [midiEnabled, setMidiEnabled] = useState(() => midiInput.enabled);
  const handleMidiEnabledToggle = useCallback(() => {
    const next = !midiInput.enabled;
    midiInput.setEnabled(next);
    setMidiEnabled(next);
  }, []);
  // MIDI velocity curve: 'linear' | 'soft' | 'hard' | 'fixed'.
  // Pushed into the voice manager on change; default 'linear' = identity,
  // matches pre-existing behavior.
  const [velocityCurve, setVelocityCurve] = useState('linear');
  useEffect(() => { keyboardVoiceManager.setVelocityCurve(velocityCurve); }, [velocityCurve]);
  // Tune feature config. Lifted to App because the trigger button lives on the
  // main control panel (OscillatorControls) while the sliders that configure
  // variance/glide live inside the Settings popup — both need the same values.
  const [tuneVarianceHz, setTuneVarianceHz] = useState(0);
  const [tuneGlideSec, setTuneGlideSec] = useState(1.0);

  // Master-bus soft limiter / saturator. Curve is a string key matching
  // SATURATION_CURVES in AudioEngine ('off' | 'tanh' | 'cubic' | 'sine' | 'hard').
  // Drive is the pre-saturation gain into the curve (1.0 = neutral).
  // Applied via setSaturationCurve / setSaturationDrive on the engine,
  // which propagates to the worklet (or stashes the value until the
  // worklet finishes loading inside initialize()).
  const [saturationCurve, setSaturationCurve] = useState('tanh');
  const [saturationDrive, setSaturationDrive] = useState(1.0);
  const handleSaturationCurveChange = useCallback((curve) => {
    setSaturationCurve(curve);
    audioEngine.setSaturationCurve(curve);
  }, []);
  const handleSaturationDriveChange = useCallback((drive) => {
    setSaturationDrive(drive);
    audioEngine.setSaturationDrive(drive);
  }, []);

  // Color theme — mirrors the palette singleton so SettingsPanel can render
  // the picker. Singleton was already populated from the URL above (and
  // listeners on the singleton drive non-React redraws), so this state is
  // primarily for the SettingsPanel UI.
  const [theme, setThemeState] = useState(palette.theme);
  const handleThemeChange = useCallback((t) => {
    palette.setTheme(t);
    setThemeState(palette.theme);
  }, []);

  // JI ratio limit for the frequency rail's nearest-ratio readout.
  // Mirrors frequencyManager.limit; setter pushes back into the
  // singleton so the rail picks it up.
  const [jiLimit, setJiLimit] = useState(frequencyManager.limit);
  const handleJiLimitChange = useCallback((n) => {
    frequencyManager.setLimit(n);
    setJiLimit(frequencyManager.limit);
  }, []);

  // Align button — glides every drone to its nearest JI target. Lives
  // in the frequency rail's footer now; App owns the busy state so a
  // mid-glide click doesn't double-trigger the gliding scheduler.
  const [isAligning, setIsAligning] = useState(false);
  const handleAlign = useCallback(() => {
    if (!audioEngine.initialized) return;
    const targets = audioEngine.computeJustIntonationTargets(tuneVarianceHz);
    setIsAligning(true);
    audioEngine.glideToFrequencies(targets, Math.round(tuneGlideSec * 1000), () => {
      setIsAligning(false);
    });
  }, [tuneVarianceHz, tuneGlideSec]);

  // Mobile caps the oscillator count at 4 — but ONLY on iOS, where the
  // Web Audio backend is the bottleneck (Safari struggles with 10+ live
  // oscillators on iPhone). Android and desktop touchscreens get the
  // full 12. The matchMedia listener triggers if the viewport crosses
  // the breakpoint at runtime; the iOS check is a one-time UA sniff
  // (covers iPhone/iPod, iPad pre-iPadOS-13, and modern iPads which
  // report as MacIntel but expose maxTouchPoints > 1).
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const onChange = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const isIOS = useMemo(() => {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    return navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
  }, []);
  const maxOscillators = (isMobile && isIOS) ? 4 : 12;
  
  const initializedRef = useRef(false);
  
  // Apply initial URL settings to audio engine before initialization (runs once)
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    
    if (INITIAL_URL_STATE.frequencies && INITIAL_URL_STATE.volumes) {
      audioEngine.frequencyValues = INITIAL_URL_STATE.frequencies;
      audioEngine.volumeValues = INITIAL_URL_STATE.volumes.map(v => v / 100); // Convert 0-100 to 0-1
      audioEngine.oscillatorCount = INITIAL_URL_STATE.count;
    }
  }, []);
  
  // Mute audio on page leave/refresh and show confirmation dialog
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      // Immediately mute and suspend to prevent audio artifacts
      if (audioEngine.audioContext && audioEngine.masterGainNode) {
        try {
          // Set gain to 0 immediately
          audioEngine.masterGainNode.gain.value = 0;
          // Also disconnect all oscillators to stop sound instantly
          audioEngine.oscillators.forEach(osc => {
            try {
              osc.disconnect();
            } catch (err) {
              // Ignore disconnect errors
            }
          });
          // Suspend the audio context
          audioEngine.audioContext.suspend();
        } catch (err) {
          // Ignore errors during cleanup
        }
      }
      
      // Show confirmation dialog if audio is playing
      if (audioEngine.initialized && !audioEngine.paused) {
        // Standard way to trigger browser's "Leave site?" dialog
        e.preventDefault();
        // For older browsers
        e.returnValue = 'Audio is playing. Are you sure you want to leave?';
        return e.returnValue;
      }
    };
    
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  // Autosave: once a second, snapshot the current engine state and write
  // to the rolling autosave slot if anything changed since last write.
  // Refreshing the page restores from this slot (see handleStart). 1-second
  // granularity is fine — the UI mutates faster than that during drags but
  // the user only sees the result after they let go.
  useEffect(() => {
    if (!isStarted) return;
    let lastJson = '';
    const flush = () => {
      if (!audioEngine.isInitialized) return;
      try {
        const patch = capturePatch({
          id: 'autosave',
          name: 'Autosave',
          source: 'user',
        });
        const sig = JSON.stringify({
          f: patch.frequencies,
          v: patch.snapshot.volumes,
          m: patch.snapshot.muted,
          r: patch.snapshot.routing,
        });
        if (sig !== lastJson) {
          lastJson = sig;
          setAutosave(patch);
        }
      } catch (e) {
        console.warn('autosave failed', e);
      }
    };
    const id = setInterval(flush, 1000);
    return () => {
      clearInterval(id);
      flush();
    };
  }, [isStarted]);

  const handleStart = async () => {
    // Precedence: URL params > autosave > engine random defaults. URL is
    // explicit (the user pasted a share link); autosave is the rolling
    // last-state save so refresh restores work.
    const { frequencies, volumes, routing } = INITIAL_URL_STATE;
    let pendingAutosave = null;
    if (!frequencies) {
      pendingAutosave = getAutosave();
      if (pendingAutosave) preInitApplyPatch(pendingAutosave);
    }

    // Push saturation settings before initialize so the worklet picks
    // them up the moment it loads — avoids a brief default-curve window
    // on first start.
    audioEngine.setSaturationCurve(saturationCurve);
    audioEngine.setSaturationDrive(saturationDrive);

    await audioEngine.initialize(frequencies, volumes); // volumes already in 0-100 format

    // Seed the smooth-random detune curves at the real oscillator count.
    // engine.initialize() resizes the curves to the live oscillatorCount
    // and pads new positions with zeros. randomizeCurve overwrites with
    // a fresh smooth-random pattern. Skipped when:
    //   - URL provided an explicit curve (user shared a session), OR
    //   - autosave provided one (preInitApplyPatch restored it above).
    // Without that skip, every reload after saving would erase the user's
    // curve in favor of fresh random.
    const autoDroneCurve = pendingAutosave?.snapshot?.stereo?.drone?.curve;
    const autoKbdCurve = pendingAutosave?.snapshot?.stereo?.keyboard?.curve;
    if (!INITIAL_URL_STATE.droneCurve && !Array.isArray(autoDroneCurve)) {
      droneStereo.randomizeCurve();
    }
    if (!INITIAL_URL_STATE.kbdCurve && !Array.isArray(autoKbdCurve)) {
      keyboardStereo.randomizeCurve();
    }

    // Kick off Web MIDI from the user gesture. requestMIDIAccess on
    // Chrome/Edge with sysex:false typically doesn't prompt, but doing
    // it from the click is safe regardless. Status / devices are
    // surfaced in SettingsPanel.
    midiInput.connect();

    // Apply routing from URL if present
    if (routing) {
      // Clear default routing and apply URL routing
      for (const [oscIndex, channels] of Object.entries(routing)) {
        const oscIdx = parseInt(oscIndex);
        // First remove all existing routing for this oscillator
        const currentChannels = audioEngine.routingMap[oscIdx] || [];
        for (const ch of [...currentChannels]) {
          audioEngine.removeRouting(oscIdx, ch);
        }
        // Then add the URL routing
        for (const ch of channels) {
          audioEngine.addRouting(oscIdx, ch);
        }
      }
    } else if (pendingAutosave) {
      applyPatchRoutingPostInit(pendingAutosave);
    }

    // Sync oscillator count and routing from audio engine
    setOscillatorCount(audioEngine.getOscillatorCount());
    setRoutingMap(audioEngine.getRoutingMap());

    setIsStarted(true);
  };
  
  const handleShare = useCallback(async () => {
    const frequencies = audioEngine.getAllFrequencies();
    const volumes = audioEngine.getAllVolumes();
    const routing = audioEngine.getRoutingMap();
    
    // Build URL with all settings
    // frequencies are in Hz, volumes are already 0-100 from getAllVolumes()
    const freqStr = frequencies.map(f => Math.round(f * 100) / 100).join(',');
    const volStr = volumes.map(v => Math.round(v)).join(',');
    
    // Encode routing as: oscIndex:ch1.ch2.ch3,oscIndex:ch1.ch2 etc
    const routingStr = Object.entries(routing)
      .map(([osc, channels]) => {
        const chList = Array.isArray(channels) ? channels : [channels];
        return `${osc}:${chList.join('.')}`;
      })
      .join(',');
    
    // Build URL without encoding for readability
    let queryParts = [`f=${freqStr}`, `v=${volStr}`];
    if (routingStr) queryParts.push(`r=${routingStr}`);

    // Envelope params: A/D/R in ms (rounded), S as 0..1 with two decimals.
    const encEnv = (env) =>
      `${Math.round(env.attack * 1000)},` +
      `${Math.round(env.decay * 1000)},` +
      `${env.sustain.toFixed(2)},` +
      `${Math.round(env.release * 1000)}`;
    queryParts.push(`dEnv=${encEnv(droneEnvelope)}`);
    queryParts.push(`kEnv=${encEnv(keyboardEnvelope)}`);
    queryParts.push(`cy=${vizCycles}`);
    // Wave shape + fold per pool. Skip when at default (0) to keep
    // URLs short for users who never touched the sliders.
    if (droneWave.position > 0)    queryParts.push(`dWave=${droneWave.position.toFixed(2)}`);
    if (keyboardWave.position > 0) queryParts.push(`kWave=${keyboardWave.position.toFixed(2)}`);
    if (droneFold.amount > 0)      queryParts.push(`dFold=${droneFold.amount.toFixed(2)}`);
    if (keyboardFold.amount > 0)   queryParts.push(`kFold=${keyboardFold.amount.toFixed(2)}`);
    // Per-pool stereo mode + detune — only encode when non-default
    // (mode='lr', detune=0) to keep URLs short.
    if (droneStereo.mode !== 'lr')      queryParts.push(`dPan=${droneStereo.mode}`);
    if (droneStereo.detuneHz > 0)       queryParts.push(`dDet=${droneStereo.detuneHz.toFixed(1)}`);
    if (droneStereo.detuneCurve.some(v => v > 0)) {
      queryParts.push(`dCurve=${droneStereo.detuneCurve.map(v => v.toFixed(2)).join(',')}`);
    }
    if (keyboardStereo.mode !== 'lr')   queryParts.push(`kPan=${keyboardStereo.mode}`);
    if (keyboardStereo.detuneHz > 0)    queryParts.push(`kDet=${keyboardStereo.detuneHz.toFixed(1)}`);
    if (keyboardStereo.detuneCurve.some(v => v > 0)) {
      queryParts.push(`kCurve=${keyboardStereo.detuneCurve.map(v => v.toFixed(2)).join(',')}`);
    }
    // Theme — only encode when not the default ('duo') to keep URLs short.
    if (palette.theme !== 'duo') queryParts.push(`t=${palette.theme}`);

    const url = `${window.location.origin}${window.location.pathname}?${queryParts.join('&')}`;
    
    // Update browser URL without reload
    window.history.replaceState({}, '', url);
    
    // Try to copy to clipboard
    const copyToClipboard = async () => {
      // Try modern clipboard API first
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(url);
          return true;
        } catch (err) {
          console.warn('Clipboard API failed:', err);
        }
      }
      
      // Fallback for older browsers and some mobile browsers
      try {
        const textArea = document.createElement('textarea');
        textArea.value = url;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        textArea.style.top = '0';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        return successful;
      } catch (err) {
        console.warn('Fallback copy failed:', err);
        return false;
      }
    };
    
    const copied = await copyToClipboard();
    
    if (copied) {
      alert('Settings URL copied to clipboard!');
    } else {
      alert('URL updated! Copy it from your browser address bar to share.');
    }
  }, [vizCycles]);

  const handleSettingsToggle = useCallback(() => {
    setIsSettingsOpen(prev => !prev);
  }, []);

  // Pull oscillator count + routing back from the engine after a path that
  // bypasses handleOscillatorCountChange / handleRoutingChange (currently:
  // patch loading). The engine is the source of truth; React state needs
  // to follow so the spectrum bar, controls, and routing UI redraw.
  const syncStateFromEngine = useCallback(() => {
    setOscillatorCount(audioEngine.getOscillatorCount());
    setRoutingMap(audioEngine.getRoutingMap());
  }, []);

  // PatchesPanel hands back the patch it just applied so we can light up
  // the "return" affordance in the controls strip. Captures the live
  // post-load engine state into the stored patch — built-in patches are
  // tuning-only (no `snapshot`) and applyPatch picks a random voicing
  // for them, so reverting to the *as-loaded* state means snapshotting
  // what the user actually heard, not what the patch on disk encoded.
  const handlePatchLoaded = useCallback((patch) => {
    // Held kbd voices (latched via hold, or mid-ramp) were tuned to
    // the previous scale — let them go silent so the new patch's
    // drones aren't competing with stale keyboard notes.
    keyboardVoiceManager.releaseAll('kbd');
    const captured = capturePatch({
      id: patch?.id,
      name: patch?.name,
      source: patch?.source,
      description: patch?.description,
    });
    setCurrentPatch(captured);
    syncStateFromEngine();
  }, [syncStateFromEngine]);

  // Re-apply the most recently loaded patch — used by the return button
  // beneath the align icon. Tries applyPatchSmooth first, which lerps
  // freqs + volumes in parallel without silencing the master when the
  // current shape (osc count + routing) matches the patch. Falls back
  // to applyPatch (with its master fade) when the shape diverged —
  // routing changes can't be crossfaded without a click.
  const handleRevertToPatch = useCallback(async () => {
    if (!currentPatch) return;
    keyboardVoiceManager.releaseAll('kbd');
    await applyPatchSmooth(currentPatch);
    syncStateFromEngine();
  }, [currentPatch, syncStateFromEngine]);

  const handleOscillatorCountChange = useCallback((newCount) => {
    const clampedCount = Math.max(2, Math.min(maxOscillators, newCount));
    setOscillatorCount(clampedCount);
    audioEngine.setOscillatorCount(clampedCount);
    // Sync routing map after count change (new oscillators have default routing)
    setRoutingMap(audioEngine.getRoutingMap());
  }, [maxOscillators]);

  // When the viewport drops to mobile width and we're over the mobile cap,
  // trim the highest-index oscillators down to 4. AudioEngine.setOscillatorCount
  // already preserves removed-osc state on its stack, so resizing back to
  // desktop and re-adding restores their freq/volume.
  useEffect(() => {
    if (isMobile && oscillatorCount > maxOscillators) {
      handleOscillatorCountChange(maxOscillators);
    }
  }, [isMobile, oscillatorCount, maxOscillators, handleOscillatorCountChange]);

  const handleRoutingChange = useCallback(async (action, oscIndex, outputChannel) => {
    // Fade out before routing change to prevent pops
    const wasPaused = audioEngine.paused;
    if (!wasPaused) {
      await audioEngine.fadeOut();
    }
    
    if (action === 'add') {
      audioEngine.addRouting(oscIndex, outputChannel);
    } else if (action === 'remove') {
      audioEngine.removeRouting(oscIndex, outputChannel);
    } else if (action === 'clearOutput') {
      audioEngine.clearOutputChannel(outputChannel);
    }
    
    // Update state from audio engine
    setRoutingMap(audioEngine.getRoutingMap());
    
    // Fade back in if we weren't paused
    if (!wasPaused) {
      await audioEngine.fadeIn();
    }
  }, []);

  const handleDeviceChange = useCallback(async (deviceId) => {
    // Fade out audio before switching to prevent pops
    const wasPaused = audioEngine.paused;
    if (!wasPaused) {
      await audioEngine.fadeOut();
      setIsPaused(true);
    }
    await audioEngine.setOutputDevice(deviceId);
    // Note: User needs to manually unpause after device change
  }, []);


  const handleFineTuneToggle = useCallback(() => {
    setFineTuneEnabled((v) => !v);
  }, []);

  const handleShowHelp = useCallback(() => {
    setIsHelpOpen(true);
  }, []);

  const handleCloseHelp = useCallback(() => {
    setIsHelpOpen(false);
  }, []);

  // Remember the last non-fullscreen mode so toggling fullscreen returns
  // the user to whichever panel state they came from (simple or expanded).
  const previousModeRef = useRef('simple');
  const toggleFullscreen = useCallback(() => {
    setUiMode((prev) => {
      if (prev === 'fullscreen') return previousModeRef.current;
      previousModeRef.current = prev;
      return 'fullscreen';
    });
  }, []);

  // (F-key fullscreen shortcut removed — `f` is reserved for the keyboard's
  // computer-key input. Fullscreen still toggles via the on-screen button.)

  return (
    <div id="wrapper" className={`${isPaused ? 'paused' : ''} ${uiMode}-mode${isKbdTrayOpen ? ' kbd-tray-open' : ''}${isHydraEnabled ? ' hydra-mode' : ''}${isSettingsOpen ? ' settings-open' : ''}`.trim()}>
      {(!isStarted || isHelpOpen) && (
        <StartScreen
          onStart={isStarted ? handleCloseHelp : handleStart}
        />
      )}

      <Oscilloscope
        uiMode={uiMode}
        staticMode={staticMode}
        staticPeriods={staticPeriods}
        staticLineWidth={staticLineWidth}
        staticOutlineThickness={staticOutlineThickness}
        vizMode={vizMode}
        vizCycles={vizCycles}
        vizScale={vizScale}
        vizLineWidth={vizLineWidth}
        vizOutline={vizOutline}
        vizRotation={vizRotation}
      />
      <HydraOverlay ref={hydraCanvasRef} visible={isHydraEnabled} />

      {isStarted && (
        <>
          <FrequencySpectrumBar
            oscillatorCount={oscillatorCount}
            fineTuneEnabled={fineTuneEnabled}
            onActiveChange={setActiveOscs}
            extraActive={fineTuningOscs}
            suppressAutoUnmute={isKbdTrayOpen}
            compactDots={uiMode === 'fullscreen'}
          />
          {uiMode === 'fullscreen' && (
            <FullscreenFreqList
              oscillatorCount={oscillatorCount}
              isPaused={isPaused}
              onPausedChange={setIsPaused}
            />
          )}
          {/* Frequency manager rail — temporarily hidden while the
              left-side relocation + spectrum extraction + save/load
              patch integration is in progress. Re-enable by flipping
              the guard to `uiMode !== 'fullscreen'` once the new
              layout lands. */}
          {false && (
            <FrequencyManagerPanel
              oscillatorCount={oscillatorCount}
              onAlign={handleAlign}
              isAligning={isAligning}
            />
          )}
          <Mixer
            oscillatorCount={oscillatorCount}
            minOscillators={2}
            maxOscillators={maxOscillators}
            onSlotsChange={syncStateFromEngine}
          />

          <OscillatorControls
            oscillatorCount={oscillatorCount}
            maxOscillators={maxOscillators}
            onShare={handleShare}
            onShowHelp={handleShowHelp}
            fineTuneEnabled={fineTuneEnabled}
            onFineTuneToggle={handleFineTuneToggle}
            onOscillatorCountChange={handleOscillatorCountChange}
            activeOscs={activeOscs}
            uiMode={uiMode}
            onModeChange={setUiMode}
            onFineTuningChange={handleFineTuningChange}
            isKbdTrayOpen={isKbdTrayOpen}
            onKbdTrayToggle={() => setIsKbdTrayOpen((v) => !v)}
            kbdHoldOn={kbdHoldOn}
            onKbdHoldToggle={() => setKbdHoldOn((v) => !v)}
            isPaused={isPaused}
            onPausedChange={setIsPaused}
            currentPatch={currentPatch}
            onRevertToPatch={handleRevertToPatch}
          />
          <button
            className="help-toggle"
            onClick={handleShowHelp}
            title="Help / Controls"
            aria-label="Help"
          >
            <svg viewBox="0 0 24 24" className="button-icon">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z" />
            </svg>
          </button>
          <button
            className={`patches-toggle${isPatchesOpen ? ' active' : ''}`}
            onClick={() => setIsPatchesOpen((v) => !v)}
            title="Patches"
            aria-label="Patches"
            aria-expanded={isPatchesOpen}
          >
            <svg viewBox="0 0 24 24" className="button-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="6" width="16" height="3" rx="1" />
              <rect x="4" y="11" width="16" height="3" rx="1" />
              <rect x="4" y="16" width="16" height="3" rx="1" />
            </svg>
          </button>
          <PatchesPanel
            isOpen={isPatchesOpen}
            onClose={() => setIsPatchesOpen(false)}
            onAfterLoad={handlePatchLoaded}
          />
          <button
            className={`hydra-toggle${isHydraPanelOpen ? ' active' : ''}${isHydraEnabled ? ' hydra-on' : ''}`}
            onClick={toggleHydraPanel}
            title={isHydraEnabled ? 'Hydra (running) — open editor' : 'Hydra editor'}
            aria-label="Hydra editor"
            aria-expanded={isHydraPanelOpen}
          >
            <svg viewBox="0 0 24 24" className="button-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3.2" />
              <path d="M12 5v3M12 16v3M5 12h3M16 12h3M7 7l2 2M15 15l2 2M17 7l-2 2M9 15l-2 2" />
            </svg>
          </button>
          <HydraPanel
            isOpen={isHydraPanelOpen}
            onClose={() => setIsHydraPanelOpen(false)}
            isRunning={isHydraEnabled}
            onEnabledChange={setIsHydraEnabled}
            vizScale={vizScale}
            onVizScaleChange={setVizScale}
            vizOutline={vizOutline}
            onVizOutlineChange={setVizOutline}
            vizLineWidth={vizLineWidth}
            onVizLineWidthChange={setVizLineWidth}
            vizCycles={vizCycles}
            onVizCyclesChange={setVizCycles}
            vizRotation={vizRotation}
            onVizRotationChange={setVizRotation}
          />
          {(() => {
            const activeViz = VIZ_MODES.find((m) => m.id === vizMode) || VIZ_MODES[0];
            const otherViz = VIZ_MODES.filter((m) => m.id !== vizMode);
            return (
              <div
                className="scope-mode-buttons"
                ref={vizDropdownRef}
                role="radiogroup"
                aria-label="Visualizer mode"
              >
                <button
                  type="button"
                  className={`scope-mode-btn active ${isVizDropdownOpen ? 'open' : ''}`}
                  onClick={() => setIsVizDropdownOpen((v) => !v)}
                  title={`Visualizer: ${activeViz.label}`}
                  aria-label={`Visualizer: ${activeViz.label}`}
                  aria-haspopup="true"
                  aria-expanded={isVizDropdownOpen}
                >
                  <svg viewBox="0 0 24 24" className="button-icon">{activeViz.icon}</svg>
                </button>
                {isVizDropdownOpen && (
                  <div className="scope-mode-dropdown">
                    {otherViz.map(({ id, label, icon }) => (
                      <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={false}
                        className="scope-mode-btn"
                        onClick={() => {
                          setVizMode(id);
                          setIsVizDropdownOpen(false);
                        }}
                        title={label}
                        aria-label={label}
                      >
                        <svg viewBox="0 0 24 24" className="button-icon">{icon}</svg>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
          <button
            className="share-toggle"
            onClick={handleShare}
            title="Share — copy a URL of the current state"
            aria-label="Share"
          >
            <svg viewBox="0 0 24 24" className="button-icon">
              <path fill="currentColor" d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z" />
            </svg>
          </button>
          <button
            className={`settings-toggle${isSettingsOpen ? ' active' : ''}`}
            onClick={handleSettingsToggle}
            title="Settings"
            aria-label="Settings"
            aria-expanded={isSettingsOpen}
          >
            <svg viewBox="0 0 24 24" className="button-icon">
              <path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
            </svg>
          </button>
          <button
            className="fullscreen-toggle"
            onClick={toggleFullscreen}
            title={uiMode === 'fullscreen' ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
            aria-label={uiMode === 'fullscreen' ? 'Exit fullscreen' : 'Fullscreen'}
          >
            <svg viewBox="0 0 24 24" className="button-icon">
              {uiMode === 'fullscreen' ? (
                /* collapse: arrows pointing inward */
                <path d="M9 9H5v2h6V5H9v4zm-4 6h4v4h2v-6H5v2zm10 4h2v-4h4v-2h-6v6zm2-10V5h-2v6h6V9h-4z" />
              ) : (
                /* expand: arrows pointing outward */
                <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
              )}
            </svg>
          </button>
          <SettingsPanel
            isOpen={isSettingsOpen}
            onClose={handleSettingsToggle}
            oscillatorCount={oscillatorCount}
            routingMap={routingMap}
            onRoutingChange={handleRoutingChange}
            onDeviceChange={handleDeviceChange}
            tuneVarianceHz={tuneVarianceHz}
            onTuneVarianceChange={setTuneVarianceHz}
            tuneGlideSec={tuneGlideSec}
            onTuneGlideChange={setTuneGlideSec}
            velocityCurve={velocityCurve}
            onVelocityCurveChange={setVelocityCurve}
            theme={theme}
            onThemeChange={handleThemeChange}
            kbdKeyMode={kbdKeyMode}
            onKbdKeyModeChange={setKbdKeyMode}
            kbdFillMode={kbdFillMode}
            onKbdFillModeChange={setKbdFillMode}
            midiEnabled={midiEnabled}
            onMidiEnabledToggle={handleMidiEnabledToggle}
            saturationCurve={saturationCurve}
            onSaturationCurveChange={handleSaturationCurveChange}
            saturationDrive={saturationDrive}
            onSaturationDriveChange={handleSaturationDriveChange}
            kbdRepressMode={kbdRepressMode}
            onKbdRepressModeChange={setKbdRepressMode}
            jiLimit={jiLimit}
            onJiLimitChange={handleJiLimitChange}
          />
          <KeyboardTray
            isOpen={isKbdTrayOpen}
            onOpenChange={setIsKbdTrayOpen}
            kbdHoldOn={kbdHoldOn}
            onKbdHoldToggle={() => setKbdHoldOn((v) => !v)}
            midiHoldOn={midiHoldOn}
            onMidiHoldToggle={() => setMidiHoldOn((v) => !v)}
            kbdVoiceCount={kbdVoiceCount}
            onKbdVoiceCountChange={setKbdVoiceCount}
            oscillatorCount={oscillatorCount}
          />
        </>
      )}
    </div>
  );
}

export default App;

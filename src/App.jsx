import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import audioEngine from './audio/AudioEngine';
import Oscilloscope from './components/Oscilloscope';
import OscillatorControls from './components/OscillatorControls';
import FrequencySpectrumBar from './components/FrequencySpectrumBar';
import FullscreenFreqList from './components/FullscreenFreqList';
import StartScreen from './components/StartScreen';
import SettingsPanel from './components/SettingsPanel';
import './App.css';

// Parse URL params for initial state (called once at module load)
function getInitialStateFromURL() {
  const params = new URLSearchParams(window.location.search);
  const fParam = params.get('f');
  const vParam = params.get('v');
  const rParam = params.get('r');
  
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
      return { 
        count, 
        frequencies: frequencies.slice(0, count), 
        volumes: volumes.slice(0, count),
        routing
      };
    }
  }
  return { count: 4, frequencies: null, volumes: null, routing: null };
}

// Compute once at module load
const INITIAL_URL_STATE = getInitialStateFromURL();


function App() {
  const [isStarted, setIsStarted] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
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
  // Visualizer mode: 0 circle (XY), 1 line (standing wave), 2 face, 3 hilbert.
  const [vizMode, setVizMode] = useState(0);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [oscillatorCount, setOscillatorCount] = useState(INITIAL_URL_STATE.count);
  const [routingMap, setRoutingMap] = useState({});
  const [fineTuneEnabled, setFineTuneEnabled] = useState(false);
  const [activeOscs, setActiveOscs] = useState(() => new Set());
  // Set of oscillator indices "selected" via the fullscreen freq list — these
  // make the spectrum marker glow stronger but don't otherwise change audio.
  const [selectedOscs, setSelectedOscs] = useState(() => new Set());
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
  // Union of explicit selections and in-progress fader fine-tunes, passed to
  // the spectrum bar so it lights up both categories with the same treatment.
  const spectrumExtraActive = useMemo(() => {
    if (fineTuningOscs.size === 0) return selectedOscs;
    const merged = new Set(selectedOscs);
    for (const i of fineTuningOscs) merged.add(i);
    return merged;
  }, [selectedOscs, fineTuningOscs]);
  // 'simple' (default compact strip) | 'expanded' (full panel) | 'fullscreen' (only scope+spectrum)
  const [uiMode, setUiMode] = useState('simple');
  // Tune feature config. Lifted to App because the trigger button lives on the
  // main control panel (OscillatorControls) while the sliders that configure
  // variance/glide live inside the Settings popup — both need the same values.
  const [tuneVarianceHz, setTuneVarianceHz] = useState(0);
  const [tuneGlideSec, setTuneGlideSec] = useState(1.0);

  // Mobile caps the oscillator count at 4 (vs 10 on desktop). The matchMedia
  // listener triggers if the viewport crosses the breakpoint at runtime.
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const onChange = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const maxOscillators = isMobile ? 4 : 10;
  
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
  
  const handleStart = () => {
    // Use the pre-parsed URL state
    const { frequencies, volumes, routing } = INITIAL_URL_STATE;
    
    audioEngine.initialize(frequencies, volumes); // volumes already in 0-100 format
    
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
  }, []);
  
  const handleSettingsToggle = useCallback(() => {
    setIsSettingsOpen(prev => !prev);
  }, []);

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

  // F toggles fullscreen at any time. Disabled on mobile widths since the
  // mode is meant for desktop and the toggle button is hidden there too.
  // Also avoid intercepting if focus is in an editable element.
  useEffect(() => {
    if (!isStarted) return;
    const onKey = (e) => {
      if (e.key !== 'f' && e.key !== 'F') return;
      if (window.matchMedia('(max-width: 768px)').matches) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      toggleFullscreen();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isStarted, toggleFullscreen]);

  return (
    <div id="wrapper" className={`${isPaused ? 'paused' : ''} ${uiMode}-mode`.trim()}>
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
      />

      {isStarted && (
        <>
          <FrequencySpectrumBar
            oscillatorCount={oscillatorCount}
            fineTuneEnabled={fineTuneEnabled}
            onActiveChange={setActiveOscs}
            extraActive={spectrumExtraActive}
          />
          {uiMode === 'fullscreen' && (
            <FullscreenFreqList
              oscillatorCount={oscillatorCount}
              selectedOscs={selectedOscs}
              onToggleSelect={(idx) => setSelectedOscs((prev) => {
                const next = new Set(prev);
                if (next.has(idx)) next.delete(idx); else next.add(idx);
                return next;
              })}
            />
          )}
          <OscillatorControls
            oscillatorCount={oscillatorCount}
            maxOscillators={maxOscillators}
            onShare={handleShare}
            onSettingsToggle={handleSettingsToggle}
            isSettingsOpen={isSettingsOpen}
            onShowHelp={handleShowHelp}
            fineTuneEnabled={fineTuneEnabled}
            onFineTuneToggle={handleFineTuneToggle}
            onOscillatorCountChange={handleOscillatorCountChange}
            activeOscs={activeOscs}
            uiMode={uiMode}
            onModeChange={setUiMode}
            tuneVarianceHz={tuneVarianceHz}
            tuneGlideSec={tuneGlideSec}
            onFineTuningChange={handleFineTuningChange}
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
          <div className="scope-mode-buttons" role="radiogroup" aria-label="Visualizer mode">
            {[
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
            ].map(({ id, label, icon }) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={vizMode === id}
                className={`scope-mode-btn ${vizMode === id ? 'active' : ''}`}
                onClick={() => setVizMode(id)}
                title={label}
                aria-label={label}
              >
                <svg viewBox="0 0 24 24" className="button-icon">{icon}</svg>
              </button>
            ))}
          </div>
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
            onOscillatorCountChange={handleOscillatorCountChange}
            routingMap={routingMap}
            onRoutingChange={handleRoutingChange}
            onDeviceChange={handleDeviceChange}
            staticMode={staticMode}
            onStaticModeChange={setStaticMode}
            staticPeriods={staticPeriods}
            onStaticPeriodsChange={setStaticPeriods}
            staticLineWidth={staticLineWidth}
            onStaticLineWidthChange={setStaticLineWidth}
            staticOutlineThickness={staticOutlineThickness}
            onStaticOutlineThicknessChange={setStaticOutlineThickness}
            tuneVarianceHz={tuneVarianceHz}
            onTuneVarianceChange={setTuneVarianceHz}
            tuneGlideSec={tuneGlideSec}
            onTuneGlideChange={setTuneGlideSec}
          />
        </>
      )}
    </div>
  );
}

export default App;

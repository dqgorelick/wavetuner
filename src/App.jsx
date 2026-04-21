import { useState, useEffect, useCallback, useRef } from 'react';
import audioEngine from './audio/AudioEngine';
import Oscilloscope from './components/Oscilloscope';
import OscillatorControls from './components/OscillatorControls';
import FrequencySpectrumBar from './components/FrequencySpectrumBar';
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
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [oscillatorCount, setOscillatorCount] = useState(INITIAL_URL_STATE.count);
  const [routingMap, setRoutingMap] = useState({});
  const [fineTuneEnabled, setFineTuneEnabled] = useState(false);
  
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
    const clampedCount = Math.max(2, Math.min(10, newCount));
    setOscillatorCount(clampedCount);
    audioEngine.setOscillatorCount(clampedCount);
    // Sync routing map after count change (new oscillators have default routing)
    setRoutingMap(audioEngine.getRoutingMap());
  }, []);

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


  const handleShowHelp = useCallback(() => {
    setIsHelpOpen(true);
  }, []);

  const handleCloseHelp = useCallback(() => {
    setIsHelpOpen(false);
  }, []);

  return (
    <div id="wrapper" className={isPaused ? 'paused' : ''}>
      {(!isStarted || isHelpOpen) && (
        <StartScreen 
          onStart={isStarted ? handleCloseHelp : handleStart} 
        />
      )}
      
      <Oscilloscope />
      
      {isStarted && (
        <>
          <FrequencySpectrumBar
            oscillatorCount={oscillatorCount}
            fineTuneEnabled={fineTuneEnabled}
          />
          <OscillatorControls
            oscillatorCount={oscillatorCount}
            routingMap={routingMap}
            onShare={handleShare}
            onSettingsToggle={handleSettingsToggle}
            isSettingsOpen={isSettingsOpen}
            onShowHelp={handleShowHelp}
            fineTuneEnabled={fineTuneEnabled}
            onFineTuneToggle={() => setFineTuneEnabled((v) => !v)}
          />
          <SettingsPanel
            isOpen={isSettingsOpen}
            onClose={handleSettingsToggle}
            oscillatorCount={oscillatorCount}
            onOscillatorCountChange={handleOscillatorCountChange}
            routingMap={routingMap}
            onRoutingChange={handleRoutingChange}
            onDeviceChange={handleDeviceChange}
          />
        </>
      )}
    </div>
  );
}

export default App;

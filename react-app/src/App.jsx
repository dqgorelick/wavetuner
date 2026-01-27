import { useState, useEffect, useCallback } from 'react';
import audioEngine from './audio/AudioEngine';
import Oscilloscope from './components/Oscilloscope';
import OscillatorControls from './components/OscillatorControls';
import StartScreen from './components/StartScreen';
import Controls from './components/Controls';
import './App.css';

function App() {
  const [isStarted, setIsStarted] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  
  // Load settings from URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fParam = params.get('f');
    const vParam = params.get('v');
    
    if (fParam && vParam) {
      const frequencies = fParam.split(',').map(Number);
      const volumes = vParam.split(',').map(Number);
      
      if (frequencies.length === 4 && volumes.length === 4) {
        audioEngine.frequencyValues = frequencies;
        audioEngine.volumeValues = volumes.map(v => v / 100);
      }
    }
  }, []);
  
  const handleStart = () => {
    const params = new URLSearchParams(window.location.search);
    const fParam = params.get('f');
    const vParam = params.get('v');
    
    let initialFreqs = null;
    let initialVols = null;
    
    if (fParam && vParam) {
      initialFreqs = fParam.split(',').map(Number);
      initialVols = vParam.split(',').map(Number);
    }
    
    audioEngine.initialize(initialFreqs, initialVols);
    setIsStarted(true);
  };
  
  const handleShare = useCallback(() => {
    const frequencies = audioEngine.getAllFrequencies();
    const volumes = audioEngine.getAllVolumes();
    
    const freqStr = frequencies.map(f => Math.round(f * 100) / 100).join(',');
    const volStr = volumes.join(',');
    const url = `${window.location.origin}${window.location.pathname}?f=${freqStr}&v=${volStr}`;
    
    if (confirm('Copy current settings URL to clipboard?')) {
      const confirmMessage = `URL to be copied:\n${url}\n\nCopy to clipboard?`;
      if (confirm(confirmMessage)) {
        navigator.clipboard.writeText(url)
          .then(() => alert('Settings URL copied to clipboard!'))
          .catch(err => {
            console.error('Failed to copy URL:', err);
            alert('Failed to copy URL to clipboard');
          });
      }
    }
  }, []);
  
  return (
    <div id="wrapper" className={isPaused ? 'paused' : ''}>
      {!isStarted && <StartScreen onStart={handleStart} />}
      
      <Oscilloscope />
      
      {isStarted && (
        <>
          <OscillatorControls />
          <Controls onShare={handleShare} />
        </>
      )}
    </div>
  );
}

export default App;

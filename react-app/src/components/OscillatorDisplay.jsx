import { useEffect, useRef, useState } from 'react';
import audioEngine from '../audio/AudioEngine';

/**
 * OscillatorDisplay - Shows oscillator info and handles interaction
 * 
 * CRITICAL: Display values are updated via direct DOM manipulation,
 * NOT React state, to avoid re-renders that cause audio blips.
 * Only the active oscillator state uses React (for CSS class toggling).
 */
export default function OscillatorDisplay({ onValuesChange }) {
  const [activeOscillators, setActiveOscillators] = useState([false, false, false, false]);
  
  // Refs for DOM elements (direct manipulation, no React re-renders)
  const freqRefs = useRef([null, null, null, null]);
  const volRefs = useRef([null, null, null, null]);
  
  // Refs for audio control
  const currentMouseRef = useRef({ x: 0, y: 0 });
  const mouseOriginRef = useRef({ x: [0, 0, 0, 0], y: [0, 0, 0, 0] });
  const isFineTuningRef = useRef(false);
  const activeRef = useRef([false, false, false, false]);
  const animationFrameRef = useRef(null);
  
  // Ref for callback to avoid stale closure
  const onValuesChangeRef = useRef(onValuesChange);
  onValuesChangeRef.current = onValuesChange;
  
  // URL update tracking (debounced, less frequent)
  const lastUrlUpdateRef = useRef(0);
  
  // Update display using requestAnimationFrame (synced with render, no setInterval)
  // Uses direct DOM manipulation to avoid React re-renders
  useEffect(() => {
    let lastFreqs = [0, 0, 0, 0];
    let lastVols = [0, 0, 0, 0];
    
    const updateDisplay = () => {
      animationFrameRef.current = requestAnimationFrame(updateDisplay);
      
      if (!audioEngine.initialized) return;
      
      const freqs = audioEngine.getAllFrequencies();
      const vols = audioEngine.getAllVolumes();
      
      // Direct DOM updates (bypass React entirely)
      for (let i = 0; i < 4; i++) {
        if (freqRefs.current[i] && Math.abs(freqs[i] - lastFreqs[i]) > 0.01) {
          freqRefs.current[i].textContent = freqs[i].toFixed(2);
          lastFreqs[i] = freqs[i];
        }
        if (volRefs.current[i] && Math.abs(vols[i] - lastVols[i]) > 0.5) {
          volRefs.current[i].textContent = vols[i];
          lastVols[i] = vols[i];
        }
      }
      
      // URL updates - only every 2 seconds max
      const now = Date.now();
      if (onValuesChangeRef.current && now - lastUrlUpdateRef.current > 2000) {
        onValuesChangeRef.current(freqs, vols);
        lastUrlUpdateRef.current = now;
      }
    };
    
    updateDisplay();
    
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);
  
  // Mouse move handler - directly updates audio, no React state
  useEffect(() => {
    const handleMouseMove = (event) => {
      const mouseX = event.clientX;
      const mouseY = event.clientY;
      
      currentMouseRef.current.x = mouseX;
      currentMouseRef.current.y = mouseY;
      
      if (!audioEngine.initialized) return;
      
      const sensitivity = isFineTuningRef.current ? 0.0005 : 0.005;
      
      for (let i = 0; i < 4; i++) {
        if (activeRef.current[i]) {
          const mouseDeltaX = mouseX - mouseOriginRef.current.x[i];
          const mouseDeltaY = mouseY - mouseOriginRef.current.y[i];
          
          const currentFreq = audioEngine.getFrequency(i);
          const frequencyChange = Math.exp(Math.abs(mouseDeltaX) * sensitivity) - 1;
          
          let newFreq;
          if (mouseDeltaX > 0) {
            newFreq = Math.min(1000, currentFreq * (1 + frequencyChange));
          } else {
            newFreq = Math.max(0, currentFreq / (1 + frequencyChange));
          }
          
          const currentVol = audioEngine.getVolume(i);
          const volumeChange = (mouseDeltaY / window.innerHeight) * -1;
          const newVol = Math.max(0, Math.min(1, currentVol - volumeChange));
          
          audioEngine.setFrequency(i, newFreq);
          audioEngine.setVolume(i, newVol);
          
          mouseOriginRef.current.x[i] = mouseX;
          mouseOriginRef.current.y[i] = mouseY;
        }
      }
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    return () => document.removeEventListener('mousemove', handleMouseMove);
  }, []);
  
  // Keyboard handlers
  useEffect(() => {
    const handleKeyDown = (event) => {
      const key = event.key.toLowerCase();
      
      if (key === 'shift') {
        isFineTuningRef.current = true;
      } else if (key >= '1' && key <= '4') {
        const index = parseInt(key) - 1;
        toggleOscillator(index);
      }
    };
    
    const handleKeyUp = (event) => {
      if (event.key.toLowerCase() === 'shift') {
        isFineTuningRef.current = false;
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
    };
  }, []);
  
  const toggleOscillator = (index, mouseX = null, mouseY = null) => {
    if (!audioEngine.initialized) return;
    
    const newActiveState = !activeRef.current[index];
    activeRef.current[index] = newActiveState;
    
    if (newActiveState) {
      mouseOriginRef.current.x[index] = mouseX ?? currentMouseRef.current.x;
      mouseOriginRef.current.y[index] = mouseY ?? currentMouseRef.current.y;
    }
    
    setActiveOscillators([...activeRef.current]);
  };
  
  const handleOscillatorClick = (index, event) => {
    toggleOscillator(index, event.clientX, event.clientY);
  };
  
  const channelLabels = ['L', 'R', 'L', 'R'];
  const initialFreqs = [60, 60.3, 60, 60];
  const initialVols = [50, 50, 0, 0];
  
  return (
    <div id="output">
      {[0, 1, 2, 3].map((index) => (
        <div className="osc-info" key={index}>
          <div
            id={`osc${index + 1}-box`}
            className={`osc-box ${activeOscillators[index] ? 'active' : ''}`}
            onClick={(e) => handleOscillatorClick(index, e)}
          >
            {index + 1} {channelLabels[index]}
          </div>
          <p>
            <span ref={el => freqRefs.current[index] = el}>
              {initialFreqs[index].toFixed(2)}
            </span>
            hz, vol: <span ref={el => volRefs.current[index] = el}>
              {initialVols[index]}
            </span>%
          </p>
        </div>
      ))}
    </div>
  );
}

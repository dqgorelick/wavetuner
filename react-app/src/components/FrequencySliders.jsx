import { useEffect, useRef, useState } from 'react';
import audioEngine from '../audio/AudioEngine';

/**
 * Custom frequency slider - draggable and keyboard accessible
 */
function FrequencySlider({ index, label, color, onFrequencyChange }) {
  const sliderRef = useRef(null);
  const thumbRef = useRef(null);
  const isDraggingRef = useRef(false);
  const [thumbPosition, setThumbPosition] = useState(50); // 0-100 percentage
  
  // Frequency range (logarithmic scale works better for audio)
  const MIN_FREQ = 20;
  const MAX_FREQ = 500;
  
  // Convert frequency to slider position (0-100)
  const freqToPosition = (freq) => {
    const logMin = Math.log(MIN_FREQ);
    const logMax = Math.log(MAX_FREQ);
    const logFreq = Math.log(Math.max(MIN_FREQ, Math.min(MAX_FREQ, freq)));
    return ((logFreq - logMin) / (logMax - logMin)) * 100;
  };
  
  // Convert slider position (0-100) to frequency
  const positionToFreq = (pos) => {
    const logMin = Math.log(MIN_FREQ);
    const logMax = Math.log(MAX_FREQ);
    const logFreq = logMin + (pos / 100) * (logMax - logMin);
    return Math.exp(logFreq);
  };
  
  // Sync with audio engine on mount and periodically
  useEffect(() => {
    const syncWithEngine = () => {
      if (audioEngine.initialized) {
        const freq = audioEngine.getFrequency(index);
        const pos = freqToPosition(freq);
        setThumbPosition(pos);
      }
    };
    
    syncWithEngine();
    const interval = setInterval(syncWithEngine, 200);
    return () => clearInterval(interval);
  }, [index]);
  
  // Handle drag
  const handleMouseDown = (e) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };
  
  const handleMouseMove = (e) => {
    if (!isDraggingRef.current || !sliderRef.current) return;
    
    const rect = sliderRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(100, (x / rect.width) * 100));
    
    setThumbPosition(percentage);
    
    const freq = positionToFreq(percentage);
    audioEngine.setFrequency(index, freq);
    onFrequencyChange?.(index, freq);
  };
  
  const handleMouseUp = () => {
    isDraggingRef.current = false;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  };
  
  // Handle click on track
  const handleTrackClick = (e) => {
    if (!sliderRef.current) return;
    
    const rect = sliderRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(100, (x / rect.width) * 100));
    
    setThumbPosition(percentage);
    
    const freq = positionToFreq(percentage);
    audioEngine.setFrequency(index, freq);
    onFrequencyChange?.(index, freq);
  };
  
  // Handle keyboard
  const handleKeyDown = (e) => {
    if (!audioEngine.initialized) return;
    
    let newPos = thumbPosition;
    const step = e.shiftKey ? 1 : 5; // Fine control with Shift
    
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        e.preventDefault();
        newPos = Math.max(0, thumbPosition - step);
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        e.preventDefault();
        newPos = Math.min(100, thumbPosition + step);
        break;
      case 'Home':
        e.preventDefault();
        newPos = 0;
        break;
      case 'End':
        e.preventDefault();
        newPos = 100;
        break;
      default:
        return;
    }
    
    setThumbPosition(newPos);
    const freq = positionToFreq(newPos);
    audioEngine.setFrequency(index, freq);
    onFrequencyChange?.(index, freq);
  };
  
  const currentFreq = positionToFreq(thumbPosition);
  
  return (
    <div className="freq-slider-container">
      <div className="freq-slider-label" style={{ color }}>
        {label}
      </div>
      <div 
        ref={sliderRef}
        className="freq-slider-track"
        onClick={handleTrackClick}
      >
        <div 
          className="freq-slider-fill"
          style={{ 
            width: `${thumbPosition}%`,
            backgroundColor: color 
          }}
        />
        <div
          ref={thumbRef}
          className="freq-slider-thumb"
          style={{ 
            left: `${thumbPosition}%`,
            borderColor: color,
            backgroundColor: isDraggingRef.current ? color : '#000'
          }}
          tabIndex={0}
          role="slider"
          aria-label={`${label} frequency`}
          aria-valuemin={MIN_FREQ}
          aria-valuemax={MAX_FREQ}
          aria-valuenow={Math.round(currentFreq)}
          onMouseDown={handleMouseDown}
          onKeyDown={handleKeyDown}
        />
      </div>
      <div className="freq-slider-value">
        {currentFreq.toFixed(1)} Hz
      </div>
    </div>
  );
}

/**
 * Container for all four frequency sliders
 */
export default function FrequencySliders() {
  const sliders = [
    { index: 0, label: '1 L', color: '#ff4136' },
    { index: 1, label: '2 R', color: '#2ecc40' },
    { index: 2, label: '3 L', color: '#0074d9' },
    { index: 3, label: '4 R', color: '#ffdc00' },
  ];
  
  return (
    <div className="freq-sliders-wrapper">
      {sliders.map((slider) => (
        <FrequencySlider
          key={slider.index}
          index={slider.index}
          label={slider.label}
          color={slider.color}
        />
      ))}
    </div>
  );
}

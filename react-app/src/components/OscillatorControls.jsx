import { useEffect, useRef, useState } from 'react';
import audioEngine from '../audio/AudioEngine';

// Convert frequency to musical note + cents
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

// Convert position (0-100) to frequency (logarithmic 20-500Hz)
function positionToFreq(pos) {
  const logMin = Math.log(20);
  const logMax = Math.log(500);
  const logFreq = logMin + (pos / 100) * (logMax - logMin);
  return Math.exp(logFreq);
}

// Convert frequency to position (0-100)
function freqToPosition(freq) {
  const logMin = Math.log(20);
  const logMax = Math.log(500);
  const logFreq = Math.log(Math.max(20, Math.min(500, freq)));
  return ((logFreq - logMin) / (logMax - logMin)) * 100;
}

/**
 * Volume gauge - 5 vertical bars that fill up (display only)
 */
function VolumeGauge({ volume, color, isMuted }) {
  const bars = 5;
  const filledBars = isMuted ? 0 : Math.ceil((volume / 100) * bars);
  
  return (
    <div className={`volume-gauge ${isMuted ? 'muted' : ''}`}>
      {Array.from({ length: bars }, (_, i) => {
        const barIndex = bars - 1 - i;
        const isFilled = barIndex < filledBars;
        return (
          <div
            key={i}
            className={`gauge-bar ${isFilled ? 'filled' : ''}`}
            style={{
              backgroundColor: isFilled ? color : 'transparent',
              borderColor: color
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * Oscillator info row (mute indicator + volume gauge + frequency readout + movement toggle)
 */
function OscillatorRow({ index, label, color, isActive, isBeingDragged, isMuted, onToggle, onMuteToggle, freq, volume }) {
  const noteInfo = freqToNote(freq);
  const centsStr = noteInfo.cents >= 0 ? `+${noteInfo.cents}` : `${noteInfo.cents}`;
  const isMoving = isActive || isBeingDragged;
  
  return (
    <div 
      className={`osc-row ${isMuted ? 'muted' : ''} ${isMoving ? 'moving' : ''}`}
      style={{ '--row-color': color }}
    >
      {/* Mute indicator square - lit when unmuted, unlit when muted */}
      <div
        className={`osc-mute-indicator ${!isMuted ? 'unmuted' : ''}`}
        style={{ '--dot-color': color }}
        title={isMuted ? 'Click to unmute' : 'Click to mute'}
        onClick={() => onMuteToggle(index)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && onMuteToggle(index)}
      >
        {label}
      </div>
      
      <VolumeGauge 
        volume={volume} 
        color={color} 
        isMuted={isMuted}
      />
      
      <div className="freq-readout">
        <span className="freq-hz">{freq.toFixed(1)}Hz</span>
        <span className="freq-note" style={{ color }}>{noteInfo.note}{noteInfo.octave}</span>
        <span className="freq-cents">{centsStr}¢</span>
      </div>
      
      {/* Movement toggle button with crosshair icon */}
      <button
        className={`osc-movement-toggle ${isActive ? 'active' : ''}`}
        onClick={() => onToggle(index)}
        title={isActive ? 'Stop XY movement' : 'Enable XY movement'}
        aria-pressed={isActive}
        style={{ '--dot-color': color }}
      >
        <svg viewBox="0 0 24 24" className="movement-icon">
          <line x1="12" y1="2" x2="12" y2="8" />
          <line x1="12" y1="16" x2="12" y2="22" />
          <line x1="2" y1="12" x2="8" y2="12" />
          <line x1="16" y1="12" x2="22" y2="12" />
          <path d="M12 2 L9 5 M12 2 L15 5" />
          <path d="M12 22 L9 19 M12 22 L15 19" />
          <path d="M2 12 L5 9 M2 12 L5 15" />
          <path d="M22 12 L19 9 M22 12 L19 15" />
          <circle cx="12" cy="12" r="2" />
        </svg>
      </button>
    </div>
  );
}

/**
 * Combined oscillator controls with draggable XY pad
 */
export default function OscillatorControls() {
  const [activeOscillators, setActiveOscillators] = useState([false, false, false, false]);
  const [mutedOscillators, setMutedOscillators] = useState([false, false, false, false]);
  const [freqPositions, setFreqPositions] = useState([50, 50, 50, 50]);
  const [volPositions, setVolPositions] = useState([50, 50, 0, 0]);
  const [xyControlEnabled, setXyControlEnabled] = useState(true);
  const [fineTuneEnabled, setFineTuneEnabled] = useState(false);
  const [shiftHeld, setShiftHeld] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [draggedDots, setDraggedDots] = useState([]);
  const [isPaused, setIsPaused] = useState(false);
  
  // Refs
  const xyPadRef = useRef(null);
  const currentMouseRef = useRef({ x: 0, y: 0 });
  const mouseOriginRef = useRef({ x: [0, 0, 0, 0], y: [0, 0, 0, 0] });
  const activeRef = useRef([false, false, false, false]);
  const dragStartRef = useRef({ x: 0, y: 0 });
  
  const isFineTuning = fineTuneEnabled || shiftHeld;
  const isFineTuningRef = useRef(isFineTuning);
  isFineTuningRef.current = isFineTuning;
  
  const oscillators = [
    { index: 0, label: '1 L', color: '#ff4136' },
    { index: 1, label: '2 R', color: '#2ecc40' },
    { index: 2, label: '3 L', color: '#0074d9' },
    { index: 3, label: '4 R', color: '#ffdc00' },
  ];
  
  // Sync with audio engine using requestAnimationFrame for smooth updates
  useEffect(() => {
    let animationId;
    
    const sync = () => {
      if (audioEngine.initialized) {
        const freqs = audioEngine.getAllFrequencies();
        const vols = audioEngine.getAllVolumes();
        const muted = audioEngine.getAllMutedStates();
        setFreqPositions(freqs.map(f => freqToPosition(f)));
        setVolPositions(vols);
        setMutedOscillators(muted);
      }
      animationId = requestAnimationFrame(sync);
    };
    
    sync();
    return () => cancelAnimationFrame(animationId);
  }, []);
  
  // Map shift+number symbols to indices (for keyboards that produce !@#$ with shift)
  const shiftSymbolMap = { '!': 0, '@': 1, '#': 2, '$': 3 };
  
  // Global keyboard handler
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        // Release all toggles
        activeRef.current = [false, false, false, false];
        setActiveOscillators([false, false, false, false]);
      } else if (e.key === ' ') {
        // Space = play/pause
        e.preventDefault();
        handlePlayPause();
      } else if (e.key === 'Shift') {
        setShiftHeld(true);
      } else if (e.key === 'm' || e.key === 'M') {
        setXyControlEnabled(prev => !prev);
      } else if (e.key >= '1' && e.key <= '4') {
        const index = parseInt(e.key) - 1;
        if (e.shiftKey) {
          // Shift + number = mute/unmute
          handleMuteToggle(index);
        } else {
          // Just number = toggle XY movement
          handleToggle(index);
        }
      } else if (shiftSymbolMap[e.key] !== undefined) {
        // Handle !@#$ as Shift+1234 on US keyboards
        const index = shiftSymbolMap[e.key];
        handleMuteToggle(index);
      }
    };
    
    const handleKeyUp = (e) => {
      if (e.key === 'Shift') {
        setShiftHeld(false);
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
    };
  }, []);
  
  // XY Mouse movement handler (for toggled oscillators)
  useEffect(() => {
    const handleMouseMove = (e) => {
      const mouseX = e.clientX;
      const mouseY = e.clientY;
      
      currentMouseRef.current.x = mouseX;
      currentMouseRef.current.y = mouseY;
      
      if (!audioEngine.initialized || !xyControlEnabled) return;
      
      const sensitivity = isFineTuningRef.current ? 0.0005 : 0.005;
      
      for (let i = 0; i < 4; i++) {
        if (activeRef.current[i]) {
          const mouseDeltaX = mouseX - mouseOriginRef.current.x[i];
          const mouseDeltaY = mouseY - mouseOriginRef.current.y[i];
          
          // Frequency change (logarithmic)
          const currentFreq = audioEngine.getFrequency(i);
          const frequencyChange = Math.exp(Math.abs(mouseDeltaX) * sensitivity) - 1;
          
          let newFreq;
          if (mouseDeltaX > 0) {
            newFreq = Math.min(1000, currentFreq * (1 + frequencyChange));
          } else {
            newFreq = Math.max(0, currentFreq / (1 + frequencyChange));
          }
          
          // Volume change (up = louder) - 4x faster for full range coverage
          const currentVol = audioEngine.getVolume(i);
          const volumeChange = (mouseDeltaY / window.innerHeight) * 4;
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
  }, [xyControlEnabled]);
  
  // Dot dragging handler (mouse and touch) - scrubbing behavior
  useEffect(() => {
    if (!isDragging || draggedDots.length === 0) {
      document.body.classList.remove('scrubbing');
      return;
    }
    
    // Add scrubbing class to body for consistent cursor
    document.body.classList.add('scrubbing');
    
    const updatePosition = (clientX, clientY) => {
      if (!audioEngine.initialized) return;
      
      // Calculate delta from last position
      const deltaX = clientX - dragStartRef.current.x;
      const deltaY = clientY - dragStartRef.current.y;
      
      // Sensitivity based on fine-tune mode
      const sensitivity = isFineTuningRef.current ? 0.0005 : 0.005;
      
      // Apply changes to all dragged dots
      for (const dotIndex of draggedDots) {
        // Frequency change (logarithmic)
        const currentFreq = audioEngine.getFrequency(dotIndex);
        const frequencyChange = Math.exp(Math.abs(deltaX) * sensitivity) - 1;
        
        let newFreq;
        if (deltaX > 0) {
          newFreq = Math.min(1000, currentFreq * (1 + frequencyChange));
        } else {
          newFreq = Math.max(0, currentFreq / (1 + frequencyChange));
        }
        
        // Volume change (up = louder) - 4x faster for full range coverage
        const currentVol = audioEngine.getVolume(dotIndex);
        const volumeChange = (deltaY / window.innerHeight) * 4;
        const newVol = Math.max(0, Math.min(1, currentVol - volumeChange));
        
        audioEngine.setFrequency(dotIndex, newFreq);
        audioEngine.setVolume(dotIndex, newVol);
      }
      
      // Update drag start for next delta
      dragStartRef.current = { x: clientX, y: clientY };
    };
    
    const handleMouseMove = (e) => {
      updatePosition(e.clientX, e.clientY);
    };
    
    const handleTouchMove = (e) => {
      if (e.touches.length > 0) {
        updatePosition(e.touches[0].clientX, e.touches[0].clientY);
      }
    };
    
    const handleEnd = () => {
      document.body.classList.remove('scrubbing');
      setIsDragging(false);
      setDraggedDots([]);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleEnd);
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleEnd);
    document.addEventListener('touchcancel', handleEnd);
    
    return () => {
      document.body.classList.remove('scrubbing');
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleEnd);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleEnd);
      document.removeEventListener('touchcancel', handleEnd);
    };
  }, [isDragging, draggedDots]);
  
  const handlePlayPause = () => {
    if (!audioEngine.initialized) return;
    audioEngine.togglePlayPause();
    setIsPaused(audioEngine.paused);
  };
  
  const handleToggle = (index) => {
    if (!audioEngine.initialized) return;
    
    const newActive = !activeRef.current[index];
    activeRef.current[index] = newActive;
    
    if (newActive) {
      // Sync ALL active oscillators' origins to current mouse position
      // This ensures they all move together at the same rate
      const mouseX = currentMouseRef.current.x;
      const mouseY = currentMouseRef.current.y;
      for (let i = 0; i < 4; i++) {
        if (activeRef.current[i]) {
          mouseOriginRef.current.x[i] = mouseX;
          mouseOriginRef.current.y[i] = mouseY;
        }
      }
    }
    
    setActiveOscillators([...activeRef.current]);
  };
  
  const handleMuteToggle = (index) => {
    if (!audioEngine.initialized) return;
    audioEngine.toggleMute(index);
  };
  
  const handleDotMouseDown = (e, index) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Determine which dots to drag
    let dotsToMove = [index];
    
    // If XY control is off and the clicked dot is toggled, drag all toggled dots
    // Also drag other toggled dots if any are active
    if (!xyControlEnabled && activeOscillators[index]) {
      dotsToMove = activeOscillators.map((active, i) => active ? i : -1).filter(i => i >= 0);
    } else if (activeOscillators[index]) {
      // If this dot is toggled, also include other toggled dots
      dotsToMove = activeOscillators.map((active, i) => active ? i : -1).filter(i => i >= 0);
      if (!dotsToMove.includes(index)) {
        dotsToMove.push(index);
      }
    }
    
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    setDraggedDots(dotsToMove);
    setIsDragging(true);
  };
  
  const handleDotTouchStart = (e, index) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Determine which dots to drag (same logic as mouse)
    let dotsToMove = [index];
    
    if (!xyControlEnabled && activeOscillators[index]) {
      dotsToMove = activeOscillators.map((active, i) => active ? i : -1).filter(i => i >= 0);
    } else if (activeOscillators[index]) {
      dotsToMove = activeOscillators.map((active, i) => active ? i : -1).filter(i => i >= 0);
      if (!dotsToMove.includes(index)) {
        dotsToMove.push(index);
      }
    }
    
    if (e.touches.length > 0) {
      dragStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    setDraggedDots(dotsToMove);
    setIsDragging(true);
  };
  
  // Get current frequencies for display
  const frequencies = freqPositions.map(pos => positionToFreq(pos));
  
  // Determine if zoom view should show (dragging OR XY control active)
  const hasActiveXY = xyControlEnabled && activeOscillators.some(a => a);
  const showZoom = isDragging || hasActiveXY;
  
  // Get the primary dot for zoom view centering
  // Priority: first dragged dot, then first active XY-controlled dot
  let primaryIndex = null;
  if (draggedDots.length > 0) {
    primaryIndex = draggedDots[0];
  } else if (hasActiveXY) {
    primaryIndex = activeOscillators.findIndex(a => a);
  }
  const zoomCenterFreq = primaryIndex !== null ? audioEngine.getFrequency(primaryIndex) : 0;
  
  
  return (
    <div className="osc-panel">
      {/* Zoomed frequency scale - appears when dragging or XY controlling */}
      {showZoom && primaryIndex !== null && (
        <div className="freq-zoom-wrapper">
          <div className="freq-zoom">
            {/* Grid lines every 1Hz across the 10Hz range */}
            {Array.from({ length: 11 }, (_, i) => {
              const freq = Math.floor(zoomCenterFreq) - 5 + i;
              const offset = ((freq - zoomCenterFreq) / 10) * 100 + 50; // Map to 0-100%
              const isMajor = freq % 5 === 0;
              return (
                <div
                  key={i}
                  className={`zoom-grid-line ${isMajor ? 'major' : ''}`}
                  style={{ left: `${offset}%` }}
                >
                  {isMajor && <span className="zoom-freq-label">{freq}</span>}
                </div>
              );
            })}
            
            {/* Show all oscillator positions as vertical lines */}
            {oscillators.map((osc) => {
              const freq = frequencies[osc.index];
              const diff = freq - zoomCenterFreq;
              const offset = (diff / 10) * 100 + 50; // Map to percentage
              const isInRange = offset >= -5 && offset <= 105;
              const isPrimary = osc.index === primaryIndex;
              const isMuted = mutedOscillators[osc.index];
              
              if (!isInRange) return null;
              
              // Format the label: primary shows Hz, others show +/- difference
              const label = isPrimary 
                ? `${freq.toFixed(2)}Hz`
                : `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}`;
              
              return (
                <div
                  key={osc.index}
                  className={`zoom-line ${isPrimary ? 'primary' : ''} ${isMuted ? 'muted' : ''}`}
                  style={{
                    left: `${offset}%`,
                    '--line-color': osc.color
                  }}
                >
                  <div className={`zoom-label ${isPrimary ? 'primary' : ''}`}>
                    <span className="zoom-label-text">{label}</span>
                  </div>
                </div>
              );
            })}
            
            {/* Center indicator */}
            <div className="zoom-center-line" />
          </div>
        </div>
      )}
      
      {/* XY Pad - draggable dots with scrubbing behavior */}
      <div className="xy-indicator-wrapper">
        <div className={`xy-indicator ${isDragging ? 'is-dragging' : ''}`} ref={xyPadRef}>
          <span className="xy-label freq">Freq</span>
          <span className="xy-label vol">Vol</span>
          {(() => {
            // Check if ANY dot is being moved (dragged or XY controlled)
            const anyDotMoving = isDragging || (xyControlEnabled && activeOscillators.some(a => a));
            
            return oscillators.map((osc) => {
              const isBeingDragged = isDragging && draggedDots.includes(osc.index);
              const isActive = activeOscillators[osc.index] || isBeingDragged;
              const isMuted = mutedOscillators[osc.index];
              const x = 10 + (freqPositions[osc.index] * 0.8);
              const y = 90 - (volPositions[osc.index] * 0.8);
              
              return (
                <div key={osc.index}>
                  {/* Vertical frequency indicator line - shows for ALL dots when any is moving */}
                  {anyDotMoving && (
                    <div
                      className={`freq-indicator-line ${isMuted ? 'muted' : ''}`}
                      style={{
                        left: `${x}%`,
                        '--line-color': osc.color
                      }}
                    />
                  )}
                  <div
                    className={`xy-dot ${isActive ? 'active' : ''} ${isBeingDragged ? 'dragging' : ''} ${isMuted ? 'muted' : ''}`}
                    style={{
                      left: `${x}%`,
                      top: `${y}%`,
                      '--dot-color': osc.color
                    }}
                    onMouseDown={(e) => handleDotMouseDown(e, osc.index)}
                    onTouchStart={(e) => handleDotTouchStart(e, osc.index)}
                  />
                </div>
              );
            });
          })()}
        </div>
        
        {/* Toggle buttons - below XY pad */}
        <div className="control-toggles">
          <button
            className={`control-toggle ${isPaused ? '' : 'active'}`}
            onClick={handlePlayPause}
            title={isPaused ? 'Play (Space)' : 'Pause (Space)'}
          >
            {isPaused ? 'Play' : 'Pause'}
          </button>
          
          <button
            className={`control-toggle xy-toggle ${xyControlEnabled ? 'active' : ''}`}
            onClick={() => setXyControlEnabled(!xyControlEnabled)}
            aria-pressed={xyControlEnabled}
            title="When ON, toggled oscillators follow mouse movement"
          >
            Mouse {xyControlEnabled ? 'ON' : 'OFF'}
          </button>
          
          <button
            className={`control-toggle ${isFineTuning ? 'active' : ''}`}
            onClick={() => setFineTuneEnabled(!fineTuneEnabled)}
            aria-pressed={fineTuneEnabled}
            title="Fine tune mode for precise adjustments (hold Shift)"
          >
            Fine {isFineTuning ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>
      
      {/* Controls */}
      <div className="osc-controls-wrapper">
        {oscillators.map((osc) => (
          <OscillatorRow
            key={osc.index}
            index={osc.index}
            label={osc.label}
            color={osc.color}
            isActive={activeOscillators[osc.index]}
            isBeingDragged={isDragging && draggedDots.includes(osc.index)}
            isMuted={mutedOscillators[osc.index]}
            onToggle={handleToggle}
            onMuteToggle={handleMuteToggle}
            freq={frequencies[osc.index]}
            volume={volPositions[osc.index]}
          />
        ))}
      </div>
    </div>
  );
}

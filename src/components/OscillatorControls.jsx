import { useEffect, useRef, useState, useMemo } from 'react';
import audioEngine from '../audio/AudioEngine';

// Convert frequency to musical note + cents
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Oscillator colors for up to 10 oscillators
const OSCILLATOR_COLORS = [
  '#ff4136', // 1 - red
  '#2ecc40', // 2 - green
  '#0074d9', // 3 - blue
  '#ffdc00', // 4 - yellow
  '#bb8fce', // 5 - purple
  '#85c1e9', // 6 - light blue
  '#82e0aa', // 7 - mint
  '#f8b500', // 8 - orange
  '#e74c3c', // 9 - coral
  '#1abc9c', // 10 - teal
];

function freqToNote(freq) {
  if (freq <= 0) return { note: '--', octave: 0, cents: 0 };
  
  const semitonesFromA4 = 12 * Math.log2(freq / 440);
  const midiNote = Math.round(69 + semitonesFromA4);
  const cents = Math.round((semitonesFromA4 - (midiNote - 69)) * 100);
  
  const noteIndex = ((midiNote % 12) + 12) % 12;
  const octave = Math.floor(midiNote / 12) - 1;
  
  return { note: NOTE_NAMES[noteIndex], octave, cents };
}

// Frequency range constants
const FREQ_RANGE = { min: 0.1, max: 20000 };

// Convert position (0-100) to frequency (logarithmic scale)
function positionToFreq(pos) {
  // Use 0.1 as minimum for log scale (can't log 0)
  const logMin = Math.log(FREQ_RANGE.min);
  const logMax = Math.log(FREQ_RANGE.max);
  const logFreq = logMin + (pos / 100) * (logMax - logMin);
  return Math.exp(logFreq);
}

// Convert frequency to position (0-100)
function freqToPosition(freq) {
  const logMin = Math.log(FREQ_RANGE.min);
  const logMax = Math.log(FREQ_RANGE.max);
  const clampedFreq = Math.max(FREQ_RANGE.min, Math.min(FREQ_RANGE.max, freq));
  const logFreq = Math.log(Math.max(0.1, clampedFreq));
  return ((logFreq - logMin) / (logMax - logMin)) * 100;
}

// Get oscillator label with channel indicator from actual routing
function getOscillatorLabel(index, routingMap = {}, outputChannels = 2) {
  const num = index + 1;
  const outputs = routingMap[index] ?? [index % 2];
  const outputList = Array.isArray(outputs) ? outputs : [outputs];
  
  // Only show routing arrow for stereo with single output
  if (outputChannels <= 2 && outputList.length === 1) {
    const channelLabel = outputList[0] === 0 ? 'L' : 'R';
    return `${num}→${channelLabel}`;
  }
  
  // For multiple outputs or multi-channel, just show the number
  return `${num}`;
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
 * Supports dynamic oscillator count (2-10)
 */
export default function OscillatorControls({ 
  oscillatorCount = 2, 
  routingMap = {},
  onShare,
  onSettingsToggle,
  isSettingsOpen,
  onShowHelp
}) {
  // Get output channel count from audio engine
  const outputChannels = audioEngine.outputChannelCount || 2;
  // Initialize state arrays based on oscillator count
  const createInitialArray = (defaultValue, length) => Array(length).fill(defaultValue);
  
  const [activeOscillators, setActiveOscillators] = useState(() => createInitialArray(false, oscillatorCount));
  const [mutedOscillators, setMutedOscillators] = useState(() => createInitialArray(false, oscillatorCount));
  const [freqPositions, setFreqPositions] = useState(() => createInitialArray(50, oscillatorCount));
  const [volPositions, setVolPositions] = useState(() => createInitialArray(50, oscillatorCount));
  const [xyControlEnabled, setXyControlEnabled] = useState(true);
  const [fineTuneEnabled, setFineTuneEnabled] = useState(false);
  const [shiftHeld, setShiftHeld] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [draggedDots, setDraggedDots] = useState([]);
  const [isPaused, setIsPaused] = useState(false);
  
  // Refs
  const xyPadRef = useRef(null);
  const currentMouseRef = useRef({ x: 0, y: 0 });
  const mouseOriginRef = useRef({ x: createInitialArray(0, 10), y: createInitialArray(0, 10) });
  const activeRef = useRef(createInitialArray(false, 10));
  const dragStartRef = useRef({ x: 0, y: 0 });
  const oscillatorCountRef = useRef(oscillatorCount);
  
  const isFineTuning = fineTuneEnabled || shiftHeld;
  const isFineTuningRef = useRef(isFineTuning);
  isFineTuningRef.current = isFineTuning;
  
  // Update ref when prop changes
  useEffect(() => {
    oscillatorCountRef.current = oscillatorCount;
  }, [oscillatorCount]);
  
  // Resize state arrays when oscillator count changes
  useEffect(() => {
    setActiveOscillators(prev => {
      const newArr = [...prev];
      while (newArr.length < oscillatorCount) newArr.push(false);
      return newArr.slice(0, oscillatorCount);
    });
    setMutedOscillators(prev => {
      const newArr = [...prev];
      while (newArr.length < oscillatorCount) newArr.push(false);
      return newArr.slice(0, oscillatorCount);
    });
    setFreqPositions(prev => {
      const newArr = [...prev];
      while (newArr.length < oscillatorCount) newArr.push(50);
      return newArr.slice(0, oscillatorCount);
    });
    setVolPositions(prev => {
      const newArr = [...prev];
      while (newArr.length < oscillatorCount) newArr.push(50);
      return newArr.slice(0, oscillatorCount);
    });
  }, [oscillatorCount]);
  
  // Generate oscillator configs dynamically
  const oscillators = useMemo(() => {
    return Array.from({ length: oscillatorCount }, (_, i) => ({
      index: i,
      label: getOscillatorLabel(i, routingMap, outputChannels),
      color: OSCILLATOR_COLORS[i % OSCILLATOR_COLORS.length]
    }));
  }, [oscillatorCount, routingMap, outputChannels]);
  
  // Sync with audio engine using requestAnimationFrame for smooth updates
  useEffect(() => {
    let animationId;
    
    const sync = () => {
      if (audioEngine.initialized) {
        try {
          const count = oscillatorCountRef.current;
          const freqs = audioEngine.getAllFrequencies();
          const vols = audioEngine.getAllVolumes();
          const muted = audioEngine.getAllMutedStates();
          
          // Only update if we have enough data
          if (freqs.length >= count && vols.length >= count && muted.length >= count) {
            setFreqPositions(freqs.slice(0, count).map(f => freqToPosition(f)));
            setVolPositions(vols.slice(0, count));
            setMutedOscillators(muted.slice(0, count));
          }
        } catch (e) {
          // Ignore sync errors during transitions
        }
      }
      animationId = requestAnimationFrame(sync);
    };
    
    sync();
    return () => cancelAnimationFrame(animationId);
  }, []);
  
  // Map shift+number symbols to indices (for keyboards that produce !@#$%^&*() with shift)
  const shiftSymbolMap = { '!': 0, '@': 1, '#': 2, '$': 3, '%': 4, '^': 5, '&': 6, '*': 7, '(': 8, ')': 9 };
  
  // Global keyboard handler
  useEffect(() => {
    const handleKeyDown = (e) => {
      const count = oscillatorCountRef.current;
      
      if (e.key === 'Escape') {
        // Release all toggles
        activeRef.current = Array(10).fill(false);
        setActiveOscillators(Array(count).fill(false));
      } else if (e.key === ' ') {
        // Space = play/pause
        e.preventDefault();
        handlePlayPause();
      } else if (e.key === 'Shift') {
        setShiftHeld(true);
      } else if (e.key === 'm' || e.key === 'M') {
        setXyControlEnabled(prev => !prev);
      } else if (e.key >= '0' && e.key <= '9') {
        // 1-9 = oscillators 0-8, 0 = oscillator 9
        const index = e.key === '0' ? 9 : parseInt(e.key) - 1;
        if (index < count) {
          if (e.shiftKey) {
            handleMuteToggle(index);
          } else {
            handleToggle(index);
          }
        }
      } else if (shiftSymbolMap[e.key] !== undefined) {
        // Handle shift+number symbols on US keyboards
        const index = shiftSymbolMap[e.key];
        if (index < count) {
          handleMuteToggle(index);
        }
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
      const count = oscillatorCountRef.current;
      
      for (let i = 0; i < count; i++) {
        if (activeRef.current[i]) {
          const mouseDeltaX = mouseX - mouseOriginRef.current.x[i];
          const mouseDeltaY = mouseY - mouseOriginRef.current.y[i];
          
          // Frequency change (logarithmic)
          const currentFreq = audioEngine.getFrequency(i);
          const frequencyChange = Math.exp(Math.abs(mouseDeltaX) * sensitivity) - 1;
          
          let newFreq;
          if (mouseDeltaX > 0) {
            newFreq = Math.min(FREQ_RANGE.max, currentFreq * (1 + frequencyChange));
          } else {
            newFreq = Math.max(FREQ_RANGE.min, currentFreq / (1 + frequencyChange));
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
    
    // Click handler to release active oscillators (when clicking outside control panels)
    const handleClick = (e) => {
      // Don't release if clicking inside the XY pad or any control panel
      const xyPad = document.querySelector('.xy-indicator');
      const oscPanel = document.querySelector('.osc-panel');
      const oscControlsPanel = document.querySelector('.osc-controls-panel');
      
      if (xyPad && xyPad.contains(e.target)) return;
      if (oscPanel && oscPanel.contains(e.target)) return;
      if (oscControlsPanel && oscControlsPanel.contains(e.target)) return;
      
      // Release all active oscillators
      if (activeRef.current.some(a => a)) {
        activeRef.current = Array(10).fill(false);
        setActiveOscillators(Array(oscillatorCountRef.current).fill(false));
      }
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('click', handleClick);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('click', handleClick);
    };
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
          newFreq = Math.min(FREQ_RANGE.max, currentFreq * (1 + frequencyChange));
        } else {
          newFreq = Math.max(FREQ_RANGE.min, currentFreq / (1 + frequencyChange));
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
      const count = oscillatorCountRef.current;
      for (let i = 0; i < count; i++) {
        if (activeRef.current[i]) {
          mouseOriginRef.current.x[i] = mouseX;
          mouseOriginRef.current.y[i] = mouseY;
        }
      }
    }
    
    setActiveOscillators([...activeRef.current.slice(0, oscillatorCountRef.current)]);
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
  
  // Add scrubbing class to body when XY control is active (for cursor)
  useEffect(() => {
    if (hasActiveXY) {
      document.body.classList.add('xy-control-active');
    } else {
      document.body.classList.remove('xy-control-active');
    }
    return () => document.body.classList.remove('xy-control-active');
  }, [hasActiveXY]);
  
  
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
    <>
      {/* Oscillator Controls - Bottom Left */}
      <div className="osc-controls-panel">
        <div className="osc-controls-wrapper">
          {oscillators.map((osc) => (
            <OscillatorRow
              key={osc.index}
              index={osc.index}
              label={osc.label}
              color={osc.color}
              isActive={activeOscillators[osc.index] || false}
              isBeingDragged={isDragging && draggedDots.includes(osc.index)}
              isMuted={mutedOscillators[osc.index] || false}
              onToggle={handleToggle}
              onMuteToggle={handleMuteToggle}
              freq={frequencies[osc.index] ?? 60}
              volume={volPositions[osc.index] ?? 50}
            />
          ))}
        </div>
      </div>
      
      {/* XY Pad and Controls - Bottom Right */}
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
                const freq = frequencies[osc.index] ?? 60;
                const diff = freq - zoomCenterFreq;
                const offset = (diff / 10) * 100 + 50; // Map to percentage
                const isInRange = offset >= -5 && offset <= 105;
                const isPrimary = osc.index === primaryIndex;
                const isMuted = mutedOscillators[osc.index] || false;
                
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
              const isMuted = mutedOscillators[osc.index] || false;
              const freqPos = freqPositions[osc.index] ?? 50;
              const volPos = volPositions[osc.index] ?? 50;
              const x = 10 + (freqPos * 0.8);
              const y = 90 - (volPos * 0.8);
              
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
      </div>
        
        {/* Toggle buttons - below XY pad */}
        <div className="control-toggles">
          <button
            className={`control-toggle icon-button ${isPaused ? '' : 'active'}`}
            onClick={handlePlayPause}
            title={isPaused ? 'Play (Space)' : 'Pause (Space)'}
          >
            {isPaused ? (
              <svg viewBox="0 0 24 24" className="button-icon">
                <path d="M8 5v14l11-7z"/>
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="button-icon">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
              </svg>
            )}
          </button>
          
          <button
            className={`control-toggle ${isFineTuning ? 'active' : ''}`}
            onClick={() => setFineTuneEnabled(!fineTuneEnabled)}
            aria-pressed={fineTuneEnabled}
            title="Fine tune mode for precise adjustments (hold Shift)"
          >
            Fine Tune
          </button>
          
          <button
            className="control-toggle icon-button"
            onClick={onShare}
            title="Save/Share Formula (S)"
          >
            <svg viewBox="0 0 24 24" className="button-icon">
              <path d="M17 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/>
            </svg>
          </button>
          
          <button
            className={`control-toggle icon-button ${isSettingsOpen ? 'active' : ''}`}
            onClick={onSettingsToggle}
            title="Settings"
          >
            <svg viewBox="0 0 24 24" className="button-icon">
              <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
            </svg>
          </button>
          
          <button
            className="control-toggle icon-button"
            onClick={onShowHelp}
            title="Help / Controls"
          >
            <svg viewBox="0 0 24 24" className="button-icon">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/>
            </svg>
          </button>
        </div>
      </div>
      
      {/* XY control active notice at bottom center */}
      {hasActiveXY && (
        <div className="xy-active-notice">
          <span>Shifting frequencies with mouse movement, click or ESC to release</span>
        </div>
      )}
    </>
  );
}

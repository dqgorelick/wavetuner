import { useState, useEffect } from 'react';
import audioEngine from '../audio/AudioEngine';

/**
 * Controls - Play/Pause and Share buttons
 */
export default function Controls({ onShare }) {
  const [isPaused, setIsPaused] = useState(false);
  
  const handlePlayPause = () => {
    if (!audioEngine.initialized) return;
    
    audioEngine.togglePlayPause();
    setIsPaused(audioEngine.paused);
  };
  
  // Keyboard handler for space
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === ' ') {
        event.preventDefault();
        handlePlayPause();
      } else if (event.key.toLowerCase() === 's') {
        onShare?.();
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onShare]);
  
  return (
    <div className="button-container">
      <button
        id="play-pause-button"
        className={isPaused ? 'paused' : ''}
        onClick={handlePlayPause}
      >
        {isPaused ? 'Play' : 'Pause'}
      </button>
      <button id="share-button" onClick={onShare}>
        Share Formula
      </button>
    </div>
  );
}

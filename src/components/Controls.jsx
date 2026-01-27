import { useEffect } from 'react';

/**
 * Controls - Settings and Save buttons (icon-based)
 */
export default function Controls({ onShare, onSettingsToggle, isSettingsOpen }) {
  // Keyboard handler for share/save
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key.toLowerCase() === 's' && !event.metaKey && !event.ctrlKey) {
        onShare?.();
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onShare]);
  
  return (
    <div className="button-container">
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
    </div>
  );
}

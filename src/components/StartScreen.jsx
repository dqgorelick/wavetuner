/**
 * StartScreen - Initial overlay prompting user to start audio
 */
export default function StartScreen({ onStart }) {
  return (
    <div id="start-wrapper">
      <h1 id="start-title">Wave Tuner</h1>
      
      <p id="start-subtitle">Tune frequencies to find harmony and dissonance</p>

      <div id="start-image">
        <img src={`${import.meta.env.BASE_URL}lassajous.png`} alt="Lissajous figures" />
        <p className="image-caption">Lissajous figures, source: Wikipedia</p>
      </div>
      
      <div id="start-text">
        <h3>Controls</h3>
        <div className="controls-section">
          <p><strong>XY Pad:</strong> Drag dots to adjust frequency (X) and volume (Y)</p>
          <p><strong>Mouse Movement:</strong> Toggle oscillators then move mouse to shift frequencies</p>
          <p><strong>Hold Shift:</strong> Fine-tune mode for precise adjustments</p>
        </div>
        
        <h3>Keyboard Shortcuts</h3>
        <div className="controls-section">
          <p><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd> — Toggle oscillator mouse control</p>
          <p><kbd>Shift</kbd> + <kbd>1-4</kbd> — Mute/unmute oscillator</p>
          <p><kbd>Space</kbd> — Play/Pause</p>
          <p><kbd>S</kbd> — Save/Share settings</p>
          <p><kbd>ESC</kbd> — Release all oscillators</p>
        </div>
      </div>
      
      
      <button id="start-button" onClick={onStart}>
        Start
      </button>
      
      <p className="headphones-note">headphones, or nice sound system, highly recommended :)</p>
      <p className="created-by">
        created by <a href="https://dan.dog" target="_blank" rel="noopener noreferrer">Dan Gorelick</a>
      </p>
    </div>
  );
}

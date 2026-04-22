/**
 * StartScreen - Initial overlay prompting user to start audio
 */
export default function StartScreen({ onStart }) {
  return (
    <div id="start-wrapper">
      <h1 id="start-title">wavetuner</h1>

      <p id="start-subtitle">Sine wave instrument and visualizer</p>

      <div id="start-image">
        <img src={`${import.meta.env.BASE_URL}lassajous.png`} alt="Lissajous figures" />
      </div>

      <div id="start-text">
        <p className="start-tagline">Adjust frequencies to find harmony and dissonance</p>

        <div className="start-shortcuts">
          <h3>Keyboard Shortcuts</h3>
          <div className="controls-section">
            <p><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd> <kbd>+</kbd> — Toggle oscillator mouse control</p>
            <p><kbd>Shift</kbd> + <kbd>1-4+</kbd> — Mute/unmute oscillator</p>
            <p><kbd>Shift</kbd> + drag — Fine-tune frequency</p>
            <p><kbd>Space</kbd> — Play/Pause</p>
            <p><kbd>F</kbd> — Toggle fullscreen</p>
            <p><kbd>ESC</kbd> — Release all oscillators</p>
          </div>
        </div>
      </div>

      <button id="start-button" onClick={onStart}>
        Start
      </button>

      <p className="headphones-note">headphones recommended</p>
      <p className="created-by">
        created by <a href="https://dan.dog" target="_blank" rel="noopener noreferrer">Dan Gorelick</a>,
        this is still in development, please let{' '}
        <a href="https://instagram.com/dqgorelick" target="_blank" rel="noopener noreferrer">me</a>
        {' '}know if you have any questions or feedback!
      </p>
      <p className="image-caption">Lissajous figures, source: Wikipedia</p>
    </div>
  );
}

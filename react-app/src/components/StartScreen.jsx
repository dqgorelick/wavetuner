/**
 * StartScreen - Initial overlay prompting user to start audio
 */
export default function StartScreen({ onStart }) {
  return (
    <div id="start-wrapper">
      <button id="start-button" onClick={onStart}>
        Start
      </button>
      <div id="start-text">
        <p>Headphones on, I'm ready!</p>
        <p>
          Press keys '1', '2', '3', and '4' or click the boxes to toggle
          oscillator control
        </p>
        <p>Move mouse left/right to control frequency</p>
        <p>Move mouse up/down to control volume</p>
        <p>Hold Shift for fine-tune control</p>
        <p>Press Space to play/pause</p>
        <p>Press 'S' to share your current settings</p>
      </div>
    </div>
  );
}

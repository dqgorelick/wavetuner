import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import audioEngine from './audio/AudioEngine'
import tuning from './audio/Tuning'
import keyboardVoiceManager from './audio/KeyboardVoiceManager'
import midiInput from './audio/MidiInput'
import midiOutput from './audio/MidiOutput'

// Console-test handles. Use after clicking Start so the audio graph is
// up:
//   kbd.noteOn(60)        → root, C4
//   kbd.noteOff(60)
//   tuning.sortedFrequencies
//   midi.status, midi.devices
//   midiOut.status, midiOut.devices, midiOut.setEnabled(true)  → MPE out
window.audioEngine = audioEngine
window.tuning = tuning
window.kbd = keyboardVoiceManager
window.midi = midiInput
window.midiOut = midiOutput

// Note: StrictMode disabled to prevent double-invocation of effects
// which can cause audio glitches during development
createRoot(document.getElementById('root')).render(<App />)

import { createRoot } from 'react-dom/client'
// Narrow face for console labels/readouts — the web stand-in for the
// iOS SF Compressed (.width(.compressed)) look. Weights match the
// console CSS: 500 (readouts), 600 (labels), 700 (kill/pager).
import '@fontsource/ibm-plex-sans-condensed/500.css'
import '@fontsource/ibm-plex-sans-condensed/600.css'
import '@fontsource/ibm-plex-sans-condensed/700.css'
import App from './App.jsx'
import audioEngine from './audio/AudioEngine'
import tuning from './audio/Tuning'
import keyboardVoiceManager from './audio/KeyboardVoiceManager'
import midiInput from './audio/MidiInput'
import midiOutput from './audio/MidiOutput'
import frequencyManager from './audio/FrequencyManager'
import conductor from './audio/GenerativeConductor'

// Console-test handles. Use after clicking Start so the audio graph is
// up:
//   kbd.noteOn(60)        → root, C4
//   kbd.noteOff(60)
//   tuning.sortedFrequencies
//   midi.status, midi.devices
//   midiOut.status, midiOut.devices, midiOut.setEnabled(true)  → MPE out
//   fm.saveCurrent(...), fm.stageSlot(id), fm.launchAll()      → save states
//   conductor.transition()                                     → generative
window.audioEngine = audioEngine
window.tuning = tuning
window.kbd = keyboardVoiceManager
window.midi = midiInput
window.midiOut = midiOutput
window.fm = frequencyManager
window.conductor = conductor

// Note: StrictMode disabled to prevent double-invocation of effects
// which can cause audio glitches during development
createRoot(document.getElementById('root')).render(<App />)

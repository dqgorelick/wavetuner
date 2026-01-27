import { createRoot } from 'react-dom/client'
import App from './App.jsx'

// Note: StrictMode disabled to prevent double-invocation of effects
// which can cause audio glitches during development
createRoot(document.getElementById('root')).render(<App />)

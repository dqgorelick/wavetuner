import { useEffect, useState } from 'react';
import audioEngine from '../audio/AudioEngine';

// Bus gains are engine-range 0..2 (unity at a dial's midpoint).
export const BUS_MAX = 2;

// The wave / drone / kbd / midi bus levels live on the engine, so poll
// them like Mixer does: external writes (patch load, MIDI learn, mixer
// faders) stay in sync and local write-through keeps drags immediate.
// Shared by the source knob band (the waves dial) and the source tray
// panel (the level sliders), which live in different subtrees now that
// the trays open in the side-menu column.
export default function useBusGains() {
  const [bus, setBus] = useState(() => ({
    waves: audioEngine.getWaveBusGain?.() ?? 1,
    drone: audioEngine.getDroneBusGain?.() ?? 1,
    kbd: audioEngine.getKbdBusGain?.() ?? 1,
    midi: audioEngine.getMidiBusGain?.() ?? 1,
  }));
  useEffect(() => {
    const id = setInterval(() => {
      const next = {
        waves: audioEngine.getWaveBusGain(),
        drone: audioEngine.getDroneBusGain(),
        kbd: audioEngine.getKbdBusGain(),
        midi: audioEngine.getMidiBusGain(),
      };
      setBus((prev) =>
        Object.keys(next).every((k) => Math.abs(next[k] - prev[k]) < 0.001) ? prev : next
      );
    }, 200);
    return () => clearInterval(id);
  }, []);

  // Write-through setter: pushes to the engine and mirrors locally so the
  // control doesn't wait for the next poll tick.
  const setBusGain = (key, setter) => (v) => {
    const gain = v * BUS_MAX;
    setter(gain);
    setBus((prev) => ({ ...prev, [key]: gain }));
  };

  return [bus, setBusGain];
}

import { memo } from 'react';
import MixerConsole from './MixerConsole';
import SourceKnobBand from './SourceKnobBand';
import { NOTE_ROW_H } from '../ui/stripGeometry';

// The transport (master play/pause, drone play, undo/redo) lives in the
// edge rails — TransportRail / NavRail elements passed in from App —
// which flank this row on the left and right, mirroring the iOS
// master/right rails.
function OscillatorControls({
  // Edge-rail elements (TransportRail / NavRail from App) — first and
  // last flex items of the row so they hug the section's outer edges
  // and follow it as it widens.
  leftRail = null,
  rightRail = null,
  oscillatorCount = 2,
  voicePans = [],
  onSetVoicePan,
  saturationCurve,
  saturationDrive,
  onSaturationCurveChange,
  onSaturationDriveChange,
  // (The saturate tray's scope-saturation checkbox lives in the side-menu
  // column now — App wires it straight into SourceTrayPanel.)
  // Knob-band tray selection — the tray itself opens in the side-menu
  // column (sideMenus, from App), so the band only reports the toggle.
  openTray = null,
  onToggleTray,
  sideMenus = null,
  // Console selection driving the frequency / ALL panel — the panel
  // itself rides in the side-menu column (sideMenus, from App).
  selectedVoice = null,
  onSelectVoice,
  // Voices with an orb under the finger in the spectrum bar (App's
  // activeOscs) — the console brackets them, dimmed.
  activeVoices = null,
}) {
  return (
    // --console-note-h is published on the whole row, not just inside the
    // console: the mobile frequency sheet is a sibling of .console-main
    // and tops itself at the NOTE row's bottom edge (App.css).
    <div className="osc-controls-panel" style={{ '--console-note-h': `${NOTE_ROW_H}px` }}>
      {leftRail}
      <div className="console-main">
        {/* Mixer console — the iOS-style column mixer (label rail, one
            column per voice, ALL lane). */}
        <MixerConsole
          oscillatorCount={oscillatorCount}
          voicePans={voicePans}
          onSetVoicePan={onSetVoicePan}
          selectedVoice={selectedVoice}
          onSelectVoice={onSelectVoice}
          activeVoices={activeVoices}
        />
        {/* Source knob band — waves · shape · fold · noise · saturate,
            under the console (iOS keeps its knob band in the same slot
            under the mixer). */}
        <SourceKnobBand
          saturationCurve={saturationCurve}
          saturationDrive={saturationDrive}
          onSaturationCurveChange={onSaturationCurveChange}
          onSaturationDriveChange={onSaturationDriveChange}
          openTray={openTray}
          onToggleTray={onToggleTray}
        />
      </div>
      {/* iPad-style side-menu column — the open menu (mixer / tuning /
          perform / a frequency or ALL panel / a knob-band source tray,
          later settings + saves)
          sits to the right of the console; the whole row re-centers
          since the panel is a centered fixed element. Content comes
          from App.jsx. */}
      {sideMenus}
      {rightRail}
    </div>
  );
}

export default memo(OscillatorControls);

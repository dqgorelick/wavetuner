import { memo, useEffect, useState } from 'react';
import frequencyManager from '../audio/FrequencyManager';
import { useTheme } from '../theme/palette';

// Corner-bracket marker — the app-wide "this tab is open" grammar from
// iOS (SelectionCornersShape): four L corners around a 36px square.
function BracketMarker() {
  return (
    <svg className="rail-tab-brackets" viewBox="0 0 36 36" aria-hidden="true">
      <path d="M1 9V1h8M27 1h8v8M35 27v8h-8M9 35H1v-8" />
    </svg>
  );
}

// One tab of the right rail: dim white that brightens while its menu is
// open, with the corner brackets as the open marker (iOS railTab).
function RailTab({ id, active, onClick, title, children }) {
  return (
    <button
      type="button"
      className={`rail-tab ${active ? 'active' : ''}`}
      data-rail-tab={id}
      onClick={onClick}
      aria-pressed={active}
      title={title}
      aria-label={title}
    >
      <span className="rail-tab-face">
        {children}
        {active && <BracketMarker />}
      </span>
    </button>
  );
}

// Right edge rail — the iOS right icon rail (ContentView.rightRail) on the
// web: a column flanking the console row's right edge, spanning the area
// below the spectrum bar. Top cluster is the global nav — folder =
// perform, Hz = tuning, then the sliders glyph = mixer — and undo/redo
// chips sit at the foot. The gear (settings) joins the rail in a later
// pass; until then it keeps its top-right corner slot.
//
// Two tabs came OUT of this column (Dan, 2026-08-11):
//   • dice / transitions — gone altogether. It only ever opened the
//     throw-away GenerativePanel (GENERATIVE.md §7), which now has no
//     button at all; App keeps a window hook for it.
//   • KBD — the keyboard tray's show/hide moved into Settings →
//     Keyboard, so the rail carries panels, not surfaces.
//
// `showMixer` is false on mobile, where the mixer doesn't ship at all
// (App.jsx force-closes it alongside hiding this tab).
function NavRail({ sideMenu, onToggleSideMenu, showMixer }) {
  // Undo/redo enabled state follows frequencyManager's history. Same
  // rAF-coalesced bump the console transport used — the manager's
  // onChange can fire in bursts during glides.
  const theme = useTheme();
  const [, setHistoryV] = useState(0);
  useEffect(() => {
    let raf = 0;
    const bump = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; setHistoryV((v) => v + 1); });
    };
    const off = frequencyManager.onChange(bump);
    return () => { if (raf) cancelAnimationFrame(raf); off(); };
  }, []);

  return (
    <div className="edge-rail edge-rail-right">
      <RailTab
        id="perform"
        active={sideMenu === 'perform'}
        onClick={() => onToggleSideMenu('perform')}
        title={sideMenu === 'perform' ? 'Hide perform controls' : 'Show perform controls — tracked parameters and transition timing'}
      >
        {/* folder (iOS "folder") */}
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
        </svg>
      </RailTab>
      <RailTab
        id="tuning"
        active={sideMenu === 'tuning'}
        onClick={() => onToggleSideMenu('tuning')}
        title={sideMenu === 'tuning' ? 'Hide tuning' : 'Show tuning'}
      >
        <span className="rail-tab-hz">Hz</span>
      </RailTab>
      {showMixer && (
        <RailTab
          id="mixer"
          active={sideMenu === 'mixer'}
          onClick={() => onToggleSideMenu('mixer')}
          title={sideMenu === 'mixer' ? 'Hide mixer' : 'Show mixer'}
        >
          {/* simple theme: the tab is the word (and the slider glyph's
              grab-dots are dots, which simple has none of). */}
          {theme === 'simple' ? (
            <span className="rail-tab-kbd">MIX</span>
          ) : (
            /* three sliders (iOS "slider.horizontal.3" — the sequence
                lane's params button) */
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M3 7h18M3 12h18M3 17h18" />
              <circle cx="15" cy="7" r="2.2" fill="currentColor" stroke="none" />
              <circle cx="9" cy="12" r="2.2" fill="currentColor" stroke="none" />
              <circle cx="16" cy="17" r="2.2" fill="currentColor" stroke="none" />
            </svg>
          )}
        </RailTab>
      )}
      <div className="rail-spacer" />
      {/* Undo/redo — the iOS rail's history chips (undo above redo,
          bottom cluster; the gear's future slot sits below them). */}
      <button
        type="button"
        className="rail-history-btn"
        onClick={() => frequencyManager.undo()}
        disabled={!frequencyManager.canUndo()}
        title="Undo (glides back)"
        aria-label="Undo"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 14 4 9l5-5" />
          <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
        </svg>
      </button>
      <button
        type="button"
        className="rail-history-btn"
        onClick={() => frequencyManager.redo()}
        disabled={!frequencyManager.canRedo()}
        title="Redo (glides forward)"
        aria-label="Redo"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m15 14 5-5-5-5" />
          <path d="M20 9H10a6 6 0 0 0 0 12h3" />
        </svg>
      </button>
    </div>
  );
}

export default memo(NavRail);

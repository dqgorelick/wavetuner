import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { keymap } from '@codemirror/view';
import {
  evalUserCode,
  selectSketch,
  getSketches,
  supportsLiveCode,
  DEFAULT_SKETCH_ID,
} from '../visuals/backend';
import { listUserSketches, saveSketch, deleteSketch } from '../visuals/hydraStorage';

function VizSlider({ label, value, min, max, step, format, onChange, title }) {
  return (
    <div className="tune-slider-row" title={title}>
      <span className="tune-slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="tune-slider"
      />
      <span className="tune-slider-value">{format(value)}</span>
    </div>
  );
}

/**
 * HydraPanel — left-side slide-in with a CodeMirror editor and a list
 * of starter + saved sketches.
 *
 * Live-coding model:
 *   - Default code on open: passthrough sketch (`src(s0).out()`)
 *   - Cmd/Ctrl-Enter inside the editor → eval current code
 *   - Run button in the header → eval
 *   - Hush button → silence Hydra (keeps the canvas, just stops output)
 *   - Save button → prompt for name, persist to localStorage
 *
 * Errors from `evalUserCode` surface in a small status bar below the
 * editor so a typo doesn't silently fail.
 */
export default function HydraPanel({
  isOpen,
  onClose,
  isRunning,
  onEnabledChange,
  vizScale,
  onVizScaleChange,
  vizOutline,
  onVizOutlineChange,
  vizLineWidth,
  onVizLineWidthChange,
  vizCycles,
  onVizCyclesChange,
  vizRotation,
  onVizRotationChange,
  vizQuality,
  onVizQualityChange,
  vfxScale,
  onVfxScaleChange,
  vfxBlend,
  onVfxBlendChange,
}) {
  const sketches = useMemo(() => getSketches(), []);
  const defaultCode = useMemo(
    () => sketches.find(s => s.id === DEFAULT_SKETCH_ID)?.code || '',
    [sketches]
  );
  const [code, setCode] = useState(defaultCode);
  const codeRef = useRef(code);
  useEffect(() => { codeRef.current = code; }, [code]);

  const [status, setStatus] = useState({ kind: 'idle', text: '' });
  const [userSketches, setUserSketches] = useState([]);
  const refreshUserSketches = useCallback(() => {
    setUserSketches(listUserSketches());
  }, []);
  useEffect(() => { if (isOpen) refreshUserSketches(); }, [isOpen, refreshUserSketches]);

  const panelRef = useRef(null);
  // ESC closes. Click-outside is intentionally NOT a close trigger —
  // the user often interacts with the scope (drag → vfx sliders) while
  // the panel is open and watches the sliders move.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const runCode = useCallback(() => {
    if (!isRunning) {
      setStatus({ kind: 'error', text: 'Hydra is not enabled — toggle it on first.' });
      return;
    }
    const result = evalUserCode(codeRef.current);
    if (result.ok) setStatus({ kind: 'ok', text: 'Sketch evaluated.' });
    else setStatus({ kind: 'error', text: result.error });
  }, [isRunning]);
  // Refs so the CodeMirror keymap (built once, lifetime of the editor)
  // always calls the latest version of runCode without re-creating the
  // editor on every change.
  const runCodeRef = useRef(runCode);
  useEffect(() => { runCodeRef.current = runCode; }, [runCode]);

  const handleToggleEnable = useCallback(() => {
    const next = !isRunning;
    onEnabledChange?.(next);
    setStatus({
      kind: 'idle',
      text: next
        ? 'Hydra enabled. The default sketch will run automatically.'
        : 'Hydra disabled — showing the oscilloscope.',
    });
  }, [isRunning, onEnabledChange]);

  const handleSave = useCallback(() => {
    const name = window.prompt('Name this sketch:', 'My sketch');
    if (!name) return;
    const saved = saveSketch({ name: name.trim(), code: codeRef.current });
    if (saved) {
      setStatus({ kind: 'ok', text: `Saved "${saved.name}".` });
      refreshUserSketches();
    } else {
      setStatus({ kind: 'error', text: 'Could not save (storage unavailable?).' });
    }
  }, [refreshUserSketches]);

  const handleLoad = useCallback((sketch) => {
    // Switch the backend immediately so a preset click "just runs" in
    // both Hydra and shader modes. In the Hydra build we also seed the
    // editor with the source so the user can tweak it; in the shader
    // build the editor is hidden and `sketch.code` is undefined anyway.
    selectSketch(sketch.id);
    if (sketch.code !== undefined) setCode(sketch.code);
    setStatus({
      kind: 'idle',
      text: supportsLiveCode
        ? `Loaded "${sketch.name}". Cmd-Enter to run again.`
        : `Running "${sketch.name}".`,
    });
  }, []);

  const handleDelete = useCallback((id, name) => {
    if (!window.confirm(`Delete "${name}"?`)) return;
    deleteSketch(id);
    refreshUserSketches();
  }, [refreshUserSketches]);

  // Cmd/Ctrl-Enter binding inside the editor. Built once — the keymap
  // handler dispatches through runCodeRef so it always sees the current
  // closure without invalidating the extension array. The lint rule
  // flags the ref read pessimistically; the closure body only runs in
  // a key event, never during render.
  /* eslint-disable react-hooks/refs */
  const cmExtensions = useMemo(() => [
    javascript(),
    keymap.of([{
      key: 'Mod-Enter',
      run: () => { runCodeRef.current(); return true; },
    }]),
  ], []);
  /* eslint-enable react-hooks/refs */

  return (
    <aside
      ref={panelRef}
      className={`hydra-panel${isOpen ? ' open' : ''}`}
      aria-hidden={!isOpen}
    >
      <header className="hydra-panel-header">
        <h3>Visuals</h3>
        <button
          type="button"
          className="hydra-close"
          onClick={onClose}
          aria-label="Close visuals"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
      </header>

      <div
        className="hydra-quality-row hydra-quality-top"
        title="Render quality. Pretty: full per-frame detail. Performance: skips work the active mode doesn't need (phase calibration on the plain Lissajous, audio-feature analysis when nothing reads it) and halves the feature rate — looks ~the same, costs much less. Off: blanks the scope and stops the render loop."
      >
        <span className="tune-slider-label">Quality</span>
        <div className="settings-toggle-row hydra-quality-toggle">
          <button
            type="button"
            className={`settings-toggle-btn ${vizQuality === 'pretty' ? 'on' : 'off'}`}
            onClick={() => onVizQualityChange('pretty')}
            aria-pressed={vizQuality === 'pretty'}
          >
            pretty
          </button>
          <button
            type="button"
            className={`settings-toggle-btn ${vizQuality === 'performance' ? 'on' : 'off'}`}
            onClick={() => onVizQualityChange('performance')}
            aria-pressed={vizQuality === 'performance'}
          >
            perf
          </button>
          <button
            type="button"
            className={`settings-toggle-btn ${vizQuality === 'off' ? 'on' : 'off'}`}
            onClick={() => onVizQualityChange('off')}
            aria-pressed={vizQuality === 'off'}
          >
            off
          </button>
        </div>
      </div>

      <section className="hydra-section">
        <VizSlider
          label="Scale"
          value={vizScale}
          min={0.3}
          max={1.5}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={onVizScaleChange}
          title="Overall zoom on the lissajous figure. 100% = the original size; lower shrinks, higher pushes past the canvas edges."
        />
        <VizSlider
          label="Outline"
          value={vizOutline}
          min={0}
          max={3}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={onVizOutlineChange}
          title="Colored neon halo behind the white core. 0% = no halo; 100% = original; up to 300% for thick glow."
        />
        <VizSlider
          label="White line"
          value={vizLineWidth}
          min={0.2}
          max={3}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={onVizLineWidthChange}
          title="Thickness of the white core stroke. 100% = original."
        />
        <VizSlider
          label="Trails"
          value={vizCycles}
          min={1}
          max={16}
          step={1}
          format={(v) => `${v}`}
          onChange={onVizCyclesChange}
          title="How many cycles of the lowest sounding frequency fit per frame. Higher = longer trails / more drift."
        />
        <div
          className="tune-slider-row hydra-shape-row"
          title="Rotate the lissajous. Square: L on X, R on Y. Diamond: rotated +45° (mono draws vertically). Mirror: rotated −45° (mirrors the diamond — useful for asymmetric figures)."
        >
          <span className="tune-slider-label">Shape</span>
          <div className="settings-toggle-row hydra-shape-toggle">
            <button
              type="button"
              className={`settings-toggle-btn ${vizRotation === 0 ? 'on' : 'off'}`}
              onClick={() => onVizRotationChange(0)}
              aria-pressed={vizRotation === 0}
            >
              square
            </button>
            <button
              type="button"
              className={`settings-toggle-btn ${vizRotation === 1 ? 'on' : 'off'}`}
              onClick={() => onVizRotationChange(1)}
              aria-pressed={vizRotation === 1}
            >
              diamond
            </button>
            <button
              type="button"
              className={`settings-toggle-btn ${vizRotation === -1 ? 'on' : 'off'}`}
              onClick={() => onVizRotationChange(-1)}
              aria-pressed={vizRotation === -1}
            >
              mirror
            </button>
          </div>
        </div>
      </section>

      <header className="hydra-header">
        <h3>Hydra</h3>
        <div className="hydra-header-actions">
          <button
            type="button"
            className={`hydra-action-btn hydra-enable-btn ${isRunning ? 'on' : 'off'}`}
            onClick={handleToggleEnable}
            title={isRunning
              ? 'Hydra is on — click to switch back to the plain oscilloscope'
              : 'Hydra is off — click to start the video synth'}
            aria-pressed={isRunning}
          >
            {isRunning ? 'on' : 'off'}
          </button>
          {isRunning && (
            <>
              <button type="button" className="hydra-action-btn" onClick={runCode} title="Run (Cmd-Enter)">
                run
              </button>
              <button type="button" className="hydra-action-btn" onClick={handleSave} title="Save current sketch">
                save
              </button>
            </>
          )}
        </div>
      </header>

      {isRunning && (
        <>
          <div className="hydra-editor-wrap">
            <CodeMirror
              value={code}
              onChange={setCode}
              extensions={cmExtensions}
              theme="dark"
              basicSetup={{
                lineNumbers: true,
                foldGutter: false,
                highlightActiveLine: true,
                indentOnInput: true,
              }}
              height="240px"
            />
          </div>

          <div className={`hydra-status hydra-status-${status.kind}`}>
            {status.text || 'Hydra ready. Cmd-Enter to run.'}
          </div>
        </>
      )}

      <section className="hydra-section">
        <h5 className="hydra-section-title">Feedback</h5>
        <VizSlider
          label="Scale"
          value={vfxScale}
          min={0}
          max={3}
          step={0.01}
          format={(v) => v.toFixed(2)}
          onChange={onVfxScaleChange}
          title="How much the previous frame zooms before being added back. 0 disables the feedback layer. Drag on the oscilloscope to scrub this and Blend together."
        />
        <VizSlider
          label="Blend"
          value={vfxBlend}
          min={0}
          max={1}
          step={0.01}
          format={(v) => v.toFixed(2)}
          onChange={onVfxBlendChange}
          title="How strongly the feedback layer mixes in. 0 = no feedback; 1 = doubled feedback. Also drag-scrubable from the oscilloscope."
        />
      </section>

      <section className="hydra-section">
        <h5 className="hydra-section-title">Built-ins</h5>
        {sketches.map((s) => (
          <div key={s.id} className="hydra-sketch-card builtin">
            <button
              type="button"
              className="hydra-sketch-load"
              onClick={() => handleLoad(s)}
              title={s.description}
            >
              <span className="hydra-sketch-name">{s.name}</span>
            </button>
          </div>
        ))}
      </section>

      <section className="hydra-section">
        <h5 className="hydra-section-title">Yours</h5>
        {userSketches.length === 0 ? (
          <p className="hydra-empty">
            No saved sketches yet. Hit "save" to keep one.
          </p>
        ) : (
          userSketches.map((s) => (
            <div key={s.id} className="hydra-sketch-card user">
              <button
                type="button"
                className="hydra-sketch-load"
                onClick={() => handleLoad(s)}
              >
                <span className="hydra-sketch-name">{s.name}</span>
              </button>
              <button
                type="button"
                className="hydra-sketch-delete"
                onClick={() => handleDelete(s.id, s.name)}
                title="Delete"
                aria-label={`Delete ${s.name}`}
              >
                ×
              </button>
            </div>
          ))
        )}
      </section>
    </aside>
  );
}

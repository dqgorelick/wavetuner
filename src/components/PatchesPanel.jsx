import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePatches } from '../hooks/usePatches';
import { applyPatch } from '../patches/apply';
import { patchFrequencies } from '../patches/schema';

const FREQ_MIN_LOG = Math.log2(20);
const FREQ_MAX_LOG = Math.log2(20000);
const STRIP_W = 240;
const STRIP_H = 28;

const OSCILLATOR_COLORS = [
  '#ff4136', '#2ecc40', '#0074d9', '#ffdc00', '#bb8fce',
  '#85c1e9', '#82e0aa', '#f8b500', '#e74c3c', '#1abc9c',
  '#ff7eb6', '#a78bfa',
];

function freqToFrac(hz) {
  const clamped = Math.max(20, Math.min(20000, hz));
  return (Math.log2(clamped) - FREQ_MIN_LOG) / (FREQ_MAX_LOG - FREQ_MIN_LOG);
}

function formatCents(c) {
  if (Math.abs(c) < 0.01) return '0¢';
  const sign = c > 0 ? '+' : '';
  return `${sign}${c.toFixed(c >= 100 || c <= -100 ? 1 : 2)}¢`;
}

const PatchPreviewStrip = memo(function PatchPreviewStrip({ patch }) {
  const freqs = useMemo(() => patchFrequencies(patch) || [], [patch]);
  const sortedIndices = useMemo(
    () => freqs.map((_, i) => i).sort((a, b) => freqs[a] - freqs[b]),
    [freqs]
  );
  if (!freqs.length) return null;
  return (
    <svg
      className="patch-preview-strip"
      viewBox={`0 0 ${STRIP_W} ${STRIP_H}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <rect x={0} y={STRIP_H / 2 - 1} width={STRIP_W} height={2} className="patch-preview-baseline" />
      {sortedIndices.map((origIdx, n) => {
        const x = freqToFrac(freqs[origIdx]) * STRIP_W;
        const color = OSCILLATOR_COLORS[origIdx % OSCILLATOR_COLORS.length];
        return (
          <circle
            key={`${origIdx}-${n}`}
            cx={x}
            cy={STRIP_H / 2}
            r={4}
            fill={color}
            opacity={0.9}
          />
        );
      })}
    </svg>
  );
});

function RatiosList({ ratios }) {
  if (!ratios?.length) return null;
  return (
    <ul className="patch-ratios">
      {ratios.map((r, i) => (
        <li key={i}>
          <span className="patch-ratio-name">{r.name}</span>
          <span className="patch-ratio-cents">{formatCents(r.cents ?? 1200 * Math.log2(r.value))}</span>
        </li>
      ))}
    </ul>
  );
}

function PatchCard({ patch, onLoad, onRename, onDelete }) {
  // Draft is null while not renaming. When user clicks rename, we seed it
  // from patch.name. Avoids syncing prop→state in an effect.
  const [draftName, setDraftName] = useState(null);
  const renaming = draftName !== null;
  const inputRef = useRef(null);

  useEffect(() => { if (renaming) inputRef.current?.select(); }, [renaming]);

  const startRename = useCallback(() => setDraftName(patch.name), [patch.name]);
  const cancelRename = useCallback(() => setDraftName(null), []);
  const commitRename = useCallback(() => {
    const trimmed = (draftName ?? '').trim();
    if (trimmed && trimmed !== patch.name) onRename?.(patch.id, trimmed);
    setDraftName(null);
  }, [draftName, patch.id, patch.name, onRename]);

  const isUser = patch.source === 'user';
  const freqCount = patchFrequencies(patch)?.length ?? 0;

  return (
    <div className="patch-card">
      <div className="patch-card-head">
        {renaming ? (
          <input
            ref={inputRef}
            className="patch-rename-input"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              else if (e.key === 'Escape') cancelRename();
            }}
          />
        ) : (
          <h4 className="patch-name">{patch.name}</h4>
        )}
        {patch.author && <span className="patch-author">{patch.author}</span>}
      </div>
      {patch.description && <p className="patch-desc">{patch.description}</p>}
      <PatchPreviewStrip patch={patch} />
      <RatiosList ratios={patch.ratios} />
      <div className="patch-card-actions">
        <button type="button" className="patch-load-btn" onClick={() => onLoad(patch)}>
          Load <span className="patch-osc-hint">· {freqCount} osc</span>
        </button>
        {isUser && (
          <>
            <button
              type="button"
              className="patch-icon-btn"
              title="Rename"
              onClick={startRename}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M3 17.25V21h3.75l11-11.04-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
              </svg>
            </button>
            <button
              type="button"
              className="patch-icon-btn patch-delete-btn"
              title="Delete"
              onClick={() => {
                if (window.confirm(`Delete "${patch.name}"?`)) onDelete?.(patch.id);
              }}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
              </svg>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function SaveCurrentForm({ onSave }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const inputRef = useRef(null);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const submit = (e) => {
    e?.preventDefault();
    const patch = onSave(name);
    if (patch) {
      setName('');
      setOpen(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="patch-save-current" onClick={() => setOpen(true)}>
        + Save current as patch
      </button>
    );
  }
  return (
    <form className="patch-save-form" onSubmit={submit}>
      <input
        ref={inputRef}
        className="patch-rename-input"
        placeholder="Patch name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { setName(''); setOpen(false); } }}
      />
      <button type="submit" className="patch-load-btn">Save</button>
      <button
        type="button"
        className="patch-icon-btn"
        onClick={() => { setName(''); setOpen(false); }}
        title="Cancel"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
        </svg>
      </button>
    </form>
  );
}

function PatchesPanel({ isOpen, onClose, onAfterLoad }) {
  const { builtins, userPatches, saveCurrent, remove, rename, storageAvailable } = usePatches();
  const panelRef = useRef(null);

  // ESC closes; click-outside closes. Listen on `mousedown` rather than
  // `click` so the check runs *before* React handlers can re-render the
  // panel — otherwise clicking an inner button (e.g. Save) that triggers
  // a re-render unmounts e.target by the time `click` bubbles to
  // document, and contains() falsely reports "clicked outside."
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onDocDown = (e) => {
      if (!panelRef.current) return;
      if (panelRef.current.contains(e.target)) return;
      // Clicking the patches-toggle button itself shouldn't trigger another close.
      if (e.target.closest?.('.patches-toggle')) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    const id = setTimeout(() => document.addEventListener('mousedown', onDocDown), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(id);
      document.removeEventListener('mousedown', onDocDown);
    };
  }, [isOpen, onClose]);

  const handleLoad = useCallback(async (patch) => {
    await applyPatch(patch);
    onAfterLoad?.();
    onClose();
  }, [onClose, onAfterLoad]);

  return (
    <aside
      ref={panelRef}
      className={`patches-panel${isOpen ? ' open' : ''}`}
      aria-hidden={!isOpen}
    >
      <header className="patches-header">
        <h3>Patches</h3>
        <button
          type="button"
          className="patches-close"
          onClick={onClose}
          aria-label="Close patches"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
      </header>

      <div className="patches-body">
        <SaveCurrentForm onSave={saveCurrent} />

        <section className="patches-section">
          <h5 className="patches-section-title">Built-in</h5>
          {builtins.map((p) => (
            <PatchCard key={p.id} patch={p} onLoad={handleLoad} />
          ))}
        </section>

        <section className="patches-section">
          <h5 className="patches-section-title">Yours</h5>
          {userPatches.length === 0 ? (
            <p className="patches-empty">
              {storageAvailable
                ? 'No saved patches yet. Hit "Save current as patch" to start.'
                : 'Storage unavailable in this browser — saves won\'t persist.'}
            </p>
          ) : (
            userPatches.map((p) => (
              <PatchCard
                key={p.id}
                patch={p}
                onLoad={handleLoad}
                onRename={rename}
                onDelete={remove}
              />
            ))
          )}
        </section>
      </div>
    </aside>
  );
}

export default memo(PatchesPanel);

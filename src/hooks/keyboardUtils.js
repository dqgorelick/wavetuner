// Input types that don't consume letter/digit/space keys — focusing them
// should NOT gate global app shortcuts. Range sliders only consume
// arrow/page/home/end; checkbox/radio only consume space; buttons only
// consume space/enter. None of them eat letters, so e.g. dragging a
// settings slider should leave note keys (A/S/D/...) free to play.
const NON_TEXT_INPUT_TYPES = new Set([
  'range', 'checkbox', 'radio', 'button', 'submit', 'reset',
  'image', 'file', 'color',
]);

/**
 * Should this element swallow keystrokes instead of letting our global
 * keydown handlers act on them?
 *
 * Catches:
 *   - <input type="text|email|number|...">  — text-capturing form fields
 *   - <textarea>                            — multi-line text
 *   - contentEditable="true"                — rich-text divs, including
 *                                              CodeMirror 6's cm-content
 *                                              surface (the Hydra editor)
 *
 * Does NOT catch <input type="range|checkbox|radio|button|...">: those
 * don't capture letter keys, so global shortcuts (note play, share, etc.)
 * should remain active when a slider in the settings panel is focused.
 *
 * Use at the top of every document-level keydown listener that maps
 * letters/digits/space to app actions, so typing in the Hydra panel,
 * patch-name field, etc. doesn't fire global shortcuts at the same time.
 */
export function isEditableTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = (el.type || 'text').toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  return false;
}

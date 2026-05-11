/**
 * Should this element swallow keystrokes instead of letting our global
 * keydown handlers act on them?
 *
 * Catches:
 *   - <input>, <textarea>     — native form fields
 *   - contentEditable="true"  — rich-text divs, including CodeMirror 6's
 *                                cm-content surface (the Hydra editor)
 *
 * Use at the top of every document-level keydown listener that maps
 * letters/digits/space to app actions, so typing in the Hydra panel,
 * patch-name field, etc. doesn't fire global shortcuts at the same time.
 */
export function isEditableTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

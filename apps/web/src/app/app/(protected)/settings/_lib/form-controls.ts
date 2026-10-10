/**
 * Every control a person could act on inside `root`: form fields, switches,
 * radios, buttons and button-styled links. A disclosure (a button with
 * aria-expanded, which only shows more) is reading, not acting, so it is left
 * out. A read-only settings section has none of these (settingsReadOnly).
 * Pure DOM, for tests.
 */
export const FORM_CONTROL_SELECTOR = [
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role=switch]',
  '[role=radio]',
  '[role=combobox]',
  '[contenteditable="true"]',
  'button:not([aria-expanded])',
  'a.btn',
].join(', ');

export function formControls(root: ParentNode): Element[] {
  return [...root.querySelectorAll(FORM_CONTROL_SELECTOR)];
}

/** One line per control, for a readable failure: `button "Save"`. */
export function describeControls(root: ParentNode): string[] {
  return formControls(root).map((el) => `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[${el.getAttribute('role')}]` : ''} "${(el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 40)}"`);
}

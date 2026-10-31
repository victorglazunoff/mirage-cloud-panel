/**
 * Spread onto a Kabina text field that is not part of a login, address or payment form
 * (chat composer, search, quick add, filters, renames). iOS Safari shows its AutoFill bar
 * above the keyboard (passwords · cards · locations) for fields it takes for a form;
 * `autocomplete="off"` plus the password managers' ignore marks keep it off.
 *
 * The field also needs a neutral `id`/`name` (no «name», «email», «address», «card»…)
 * and must not sit inside a `<form>` that looks like a sign-in or checkout.
 * The round «hide keyboard» button iOS draws on the right is the system's own and stays.
 */
export const NO_AUTOFILL = {
  autoComplete: 'off',
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-bwignore': '',
  'data-form-type': 'other',
} as const;

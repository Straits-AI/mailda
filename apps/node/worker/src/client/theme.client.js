/**
 * The viewer's theme: Dark, Light, or System (which follows the device's light or dark setting).
 *
 * **Dark by default, and chosen per viewer in this browser.** Following the operating system alone showed
 * Light to everyone whose system states no preference, because a browser reports `light` then; so the choice
 * is the viewer's, offered in Settings > Appearance, and Dark is what a page wears until they make one. It is
 * kept in `localStorage` and never sent to the Node: it is a preference of one screen, not an account
 * setting, so a second browser starts in Dark.
 *
 * **Plain JavaScript, served as `/app/theme.js`, so there is one copy.** The framework-free script (the claim,
 * the sign-in, a locked-out doctor) applies the choice before it renders anything, and the React shell reads
 * and changes it. `delivery.client.js` is shared between the same two for the same reason: two copies of a
 * vocabulary are two chances to disagree.
 *
 * **The attribute is the whole mechanism.** The stylesheet's unqualified `:root` is the dark palette,
 * `:root[data-theme="light"]` is the light one, and `:root[data-theme="system"]` is light only under
 * `prefers-color-scheme: light` (`src/theme.ts`). So a page with no attribute, or a junk one, is dark.
 *
 * **Every storage access is inside a `try`, and a refusal is returned rather than swallowed.** Reading
 * `globalThis.localStorage` itself throws where site data is blocked. `storedTheme().readable` and
 * `chooseTheme().saved` are what Settings renders, so a browser that will not keep the choice says so
 * (AGENTS.md §3: never swallow).
 */

/** The `localStorage` key. Per viewer, this browser only. */
export const THEME_KEY = "mailda.theme";

/** The order Settings offers them. The first is the default. */
export const THEME_CHOICES = ["dark", "light", "system"];

function isChoice(value) {
  return THEME_CHOICES.includes(value);
}

/**
 * The stored choice. `"dark"` when nothing is stored or the value is not a choice; `readable: false` (and
 * `"dark"`) when reading storage threw.
 */
export function storedTheme() {
  let value;
  try {
    value = globalThis.localStorage.getItem(THEME_KEY);
  } catch {
    // Not swallowed: `readable: false` is the answer, and Settings renders it as a sentence.
    return { theme: "dark", readable: false };
  }
  return { theme: isChoice(value) ? value : "dark", readable: true };
}

/** Puts the theme on `<html>`, which is the only place the stylesheet looks. */
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

/**
 * What the page runs first. The attribute is always set, `"dark"` included, so the boot is observable.
 */
export function bootTheme() {
  applyTheme(storedTheme().theme);
}

/**
 * What `<html>` wears now, checked against the choices, so a caller that interpolates it (the body frame's
 * `srcdoc`) can only ever write one of three words.
 */
export function currentTheme() {
  const theme = document.documentElement.dataset.theme;
  return isChoice(theme) ? theme : "dark";
}

/**
 * Applies first, so the change is live whatever storage does, then stores. `{ saved: false }` when the
 * browser refused to keep it; the choice then lasts until the page reloads.
 */
export function chooseTheme(theme) {
  applyTheme(theme);
  try {
    globalThis.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Not swallowed: `saved: false` is the answer, and Settings renders it as a sentence.
    return { saved: false };
  }
  return { saved: true };
}

/**
 * Types for a module imported at runtime rather than bundled — the module is `src/client/theme.client.js`,
 * kept out of the bundle by the `external:` list in `scripts/build-client.mjs` so the page holds one instance
 * of it. Mapped onto the specifier `/app/theme.js` by `src/client/tsconfig.json`'s `paths`, for the reason
 * `delivery.d.ts` gives.
 *
 * Hand-written, therefore capable of drifting from the module it describes. `tsc` cannot catch that; the
 * client suite aliases the specifier to the real module (`vitest.client.config.ts`), so `theme.test.tsx`
 * exercises what these types describe.
 */

export type ThemeChoice = "dark" | "light" | "system";

export const THEME_KEY: string;
/** The order Settings offers them; the first is the default. */
export const THEME_CHOICES: readonly ThemeChoice[];
/** `readable: false` (and `"dark"`) when reading storage threw. */
export function storedTheme(): { theme: ThemeChoice; readable: boolean };
export function applyTheme(theme: ThemeChoice): void;
export function bootTheme(): void;
/** What `<html>` wears now, checked against the choices; `"dark"` otherwise. */
export function currentTheme(): ThemeChoice;
/** Applies first, then stores; `saved: false` when the browser refused to keep it. */
export function chooseTheme(theme: ThemeChoice): { saved: boolean };

import type { Area } from "../areas.ts";

/**
 * Words the page needs before anybody signs in, bundled into `/app/locale.js` for every locale. Kept small on
 * purpose: `docs/receipts/react-shell-bundle.md` counts these bytes as `shell.pre_auth_locale_bytes`.
 */
export const preauth = {
  "brand.name": "Mailda",
} as const satisfies Area<"preauth">;

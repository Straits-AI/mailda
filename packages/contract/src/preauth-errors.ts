/**
 * The refusal codes a page before sign-in can be shown (ADR 46, layer 3), as a closed list: the `error` field of
 * what the claim, sign-in, a passkey, an invitation and a session's renewal answer, and of the two refusals any
 * write can meet first (a cross-site request, a fault). The interface keys a headline in the viewer's language by
 * each (`preauth.refusal.<code>`, `apps/node/worker/src/i18n/en/preauth.ts`), so a code here without words, or
 * words for no code, does not compile.
 *
 * **The wire stays a string.** The Node writes these where it always has (`claimNode`'s statuses, `login`'s,
 * `refreshSession`'s, a `CallerError`'s code), and its `message` stays English and byte-stable. A code the Node
 * sends that is not here is shown as the Node's English alone, marked `lang="en"`, so a new refusal is never
 * hidden and never mistranslated; adding it here is what gives it a headline.
 *
 * Its own module, with no imports, because `/app/locale.js` (loaded before sign-in, and counted by
 * `docs/receipts/react-shell-bundle.md`) bundles it, and the contract's index brings zod.
 */
export const PREAUTH_ERRORS = [
  // `POST /api/claim` (`apps/node/worker/src/claim.ts`).
  "already_claimed", "bad_secret", "not_installed", "weak_password",
  // `POST /api/auth/login` (`apps/node/worker/src/routes/session.ts`).
  "not_claimed", "locked_out", "invalid_credentials",
  // `POST /api/auth/refresh`: a session that ended, which the sign-in page then shows.
  "no_refresh_token", "expired", "unknown", "reuse_detected",
  // `POST /api/auth/passkeys/verify` (`apps/node/worker/src/auth/passkey-verify.ts`, `apps/node/worker/src/auth/passkey.ts`).
  "E_PASSKEY_REJECTED", "E_CHALLENGE_UNUSABLE", "E_CHALLENGE_ALREADY_SPENT",
  // `POST /api/invitations/redeem` (`apps/node/worker/src/invitations.ts`).
  "E_INVITATION_UNUSABLE", "E_WEAK_PASSWORD",
  // Any write, before its route (`apps/node/worker/src/csrf.ts`), and a fault in any route.
  "E_CROSS_SITE_REQUEST", "internal",
] as const;

export type PreauthError = (typeof PREAUTH_ERRORS)[number];

/** Narrows a wire `error` to the list, or null: the caller then shows the Node's own words. */
export function preauthError(code: unknown): PreauthError | null {
  return (PREAUTH_ERRORS as readonly unknown[]).includes(code) ? (code as PreauthError) : null;
}

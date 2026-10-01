/**
 * Types for a module imported at runtime rather than bundled — the module is
 * `src/client/delivery.client.js`, and the reason it stays out of the bundle is the `external:` list in
 * `scripts/build-client.mjs`. Mapped onto the specifier `/app/delivery.js` by
 * `src/client/tsconfig.json`'s `paths`, because TypeScript reads a leading slash as a path on disk and so
 * an ambient `declare module` for it never matches.
 *
 * Hand-written, therefore capable of drifting from the module it describes. `tsc` cannot catch that; the
 * accessibility harness exercises both through the running application, and the delivery module has its
 * own test.
 */

/**
 * `state` is a delivery state (`DELIVERY_STATES`), `unobserved`, or a reason token (`DELIVERY_REASONS`) for a
 * recipient that has none; a newer Node's unknown token arrives as a string. The words are the catalog's
 * (`src/client/app/delivery-words.ts`).
 */
export interface DeliveryEntry { state: string; count: number }
export interface RecipientLike {
  kind?: string;
  address?: string;
  delivery_state?: string | null;
  /** Why no outcome is expected (`verified_destination`), or null. Never a state: an event wins. */
  delivery_reason?: string | null;
}

/** One recipient's tokens. `state` is `unobserved` when none is set; `reason` is null whenever a state is set. */
export function describeRecipient(recipient: RecipientLike): { state: string; reason: string | null };
export const DELIVERY_SEVERITY: string[];
export function severityRank(state: string): number;
/** Worst first. Empty only when nothing at all has been observed — see the module's own header. */
export function summariseDelivery(recipients: unknown): DeliveryEntry[];
/** Envelope order — to, cc, bcc — which is not what `ORDER BY kind` gives. */
// Declared as taking an array even though the implementation tolerates anything: the runtime guard is
// there for a JavaScript caller, and weakening the parameter to `unknown` here defeated inference and
// widened every caller's recipient back to `RecipientLike`.
export function orderRecipients<T extends RecipientLike>(recipients: readonly T[]): T[];

export interface SendLike {
  state?: string;
  fidelity?: string;
  has_submitted?: number | boolean;
  /** The machine token behind `awaiting` or `withheld` (#60), or null when the state needs no reason. */
  state_reason?: string | null;
}
/**
 * The state token, `never_submitted` when the submitted bytes provably do not exist (the stronger reading of
 * `outcome_unknown`), or the raw state. Takes the row, not the state, because the honest answer needs three of
 * its fields.
 */
export function describeSend(send: SendLike): string;
/** The `state_reason` token, or `null` when the row carries none, which is the ordinary case for `held`. */
export function describeReason(send: SendLike): string | null;

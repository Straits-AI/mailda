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

export interface DeliveryMeta { label: string; note: string }
export interface DeliveryEntry { state: string; count: number; label: string; note: string }
export interface RecipientLike { kind?: string; address?: string; delivery_state?: string | null }

export const DELIVERY_STATES: Record<string, DeliveryMeta>;
export const UNOBSERVED: DeliveryMeta;
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
export const SEND_STATES: Record<string, DeliveryMeta>;
/** The stronger reading available when the submitted bytes provably do not exist. */
export const NEVER_SUBMITTED: DeliveryMeta;
/** Takes the row, not the state, because the honest answer needs three of its fields. */
export function describeSend(send: SendLike): DeliveryMeta;
/** Why a send is `awaiting` or `withheld`, keyed on `state_reason`. */
export const SEND_REASONS: Record<string, DeliveryMeta>;
/** `null` when the row carries no reason, which is the ordinary case for `held`. */
export function describeReason(send: SendLike): DeliveryMeta | null;

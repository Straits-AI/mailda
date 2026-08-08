/**
 * Types for a module imported at runtime rather than bundled — see `../externals-note.md` reasoning in
 * `session.client.js`/`delivery.client.js`. Mapped onto the specifier `/app/delivery.js` by
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

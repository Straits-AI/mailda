import { BUDGETS } from "@mailda/budgets";

/**
 * How much a send may attach, in one place because two readers need the same numbers: the seal, which refuses
 * past them (`manifest.ts`), and the composer, which shows them before anybody presses send (`/app/config.js`
 * in `ui.ts`). A figure the interface typed for itself is one the Node could stop agreeing with.
 */

/**
 * The most a rendered message may be, base64 and boundaries included: Cloudflare's published outbound
 * ceiling for arbitrary recipients (`cloudflare-email-service-limits.md`), which `send()` answers with
 * `E_CONTENT_TOO_LARGE` past. Checked at the seal on the attachment bytes at their base64 size, so an
 * author is refused before a manifest exists rather than after a dispatch fails.
 */
export const MAX_OUTBOUND_BYTES = BUDGETS["email.outbound.max_bytes"];

/**
 * Room left for headers and the typed text. The 0.9 is a provisional assumption, not measured and with no
 * receipt. A forwarded original is not counted here, so a large one can still take a message past
 * `MAX_OUTBOUND_BYTES` at dispatch.
 */
export const ATTACHMENT_BUDGET = Math.floor(MAX_OUTBOUND_BYTES * 0.9);

/** Parts per send: a provisional assumption with no receipt. A count bound is what the byte bound lacks. */
export const MAX_ATTACHMENTS = 20;

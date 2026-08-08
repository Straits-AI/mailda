/**
 * Types for a module imported at runtime rather than bundled — see `../externals-note.md` reasoning in
 * `session.client.js`/`delivery.client.js`. Mapped onto the specifier `/app/session.js` by
 * `src/client/tsconfig.json`'s `paths`, because TypeScript reads a leading slash as a path on disk and so
 * an ambient `declare module` for it never matches.
 *
 * Hand-written, therefore capable of drifting from the module it describes. `tsc` cannot catch that; the
 * accessibility harness exercises both through the running application, and the delivery module has its
 * own test.
 */

/** Epoch millis at which the current access token expires, or null when there is none. */
export function accessExpiresAt(): number | null;
export function isSignedIn(): boolean;
/**
 * A session transition. `signed-out` carries the Node's own words for *why*, which is the difference
 * between "your session ended" and a screen that just stops working.
 */
export interface SessionEvent {
  type: "refreshed" | "signed-in" | "signed-out";
  reason?: string;
  message?: string;
}
/** Subscribes to session transitions. Returns an unsubscribe function. */
export function onSessionChange(listener: (event: SessionEvent) => void): () => void;
export function refresh(options?: { force?: boolean; seenExpiry?: number | null }): Promise<boolean>;
export function ensureFresh(): Promise<boolean>;
export function stop(): void;
/**
 * Fetch with the access token attached and one automatic refresh-and-retry on a refreshable 401.
 * Every screen goes through this rather than `fetch`, which is what makes the 401 contract single-place.
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response>;
export function start(): void;
export function adopt(): void;
export function logout(): Promise<void>;

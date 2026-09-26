/**
 * Types for `provision.mjs`, so a TypeScript test can import it. Hand-written like `preflight.d.mts`, and
 * compared against the module's real exports by `test/node/declaration-drift.test.ts`.
 */

/** wrangler's login token, from the environment or its config file; fails naming the paths looked at. */
export function wranglerToken(): Promise<string>;

/** A zone's catch-all in one line: `worker -> butler (enabled)`, or `nothing`. */
export function catchAllLine(catchAll: { action: string; destinations: string[]; enabled: boolean } | null): string;

/** The rows of the domain picker: every zone, then a typed subdomain, then an explicit skip. */
export function domainChoices(zones: ReadonlyArray<{ name: string }>): Array<{ label: string; value: string }>;

/** The zones an account holds, as wrangler's token sees them; an unreachable API reads as none. */
export function zonesOf(accountId: string, token: string): Promise<Array<{ name: string }>>;

export interface ProvisionOutcome {
  receiving: string | null;
  sending: string | null;
  deliveryEvents: string | null;
  address: string | null;
  catchAll: boolean;
}

/** One act the Node has on record, as `GET /api/provider` reports it under `provisioned`. */
export interface ProvisionedAct { domain: string; at: string; address: string | null; observed: boolean }

/**
 * Receiving, sending and the delivery-events subscription, through the Node's routes with the operator's
 * token. A step the Node already has on record (`provisioned`) is reported and not done again.
 */
export function provisionNode(input: {
  origin: string; cookie: string; accountId: string; token: string; yes: boolean;
  ask: (prompt: string) => Promise<string>;
  provisioned?: { receiving: ProvisionedAct | null; sending: ProvisionedAct | null; deliveryEvents: ProvisionedAct | null } | null;
}): Promise<ProvisionOutcome>;

/** The `== next` block after a setup. */
export function printNext(origin: string, setUp: ProvisionOutcome): void;

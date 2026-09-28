/**
 * Types for `provision.mjs`, so a TypeScript test can import it. Hand-written like `preflight.d.mts`, and
 * compared against the module's real exports by `test/node/declaration-drift.test.ts`.
 */

/** wrangler's login token, from the environment or its config file; fails naming the paths looked at. */
export function wranglerToken(): Promise<string>;

/** wrangler's login token as `wranglerToken` finds it, or null where that one fails for want of a login. */
export function wranglerTokenIfAny(): Promise<string | null>;

/**
 * `POST /api/provider/verified-destinations`'s `destinations`: counts only, never an address. Taken from the
 * contract rather than restated. The implementation is not type-checked against it (`checkJs: false`), so a
 * rename in the contract turns red where a typed caller passes one, `verified-destination-step.test.ts`'s fixture.
 */
export type VerifiedDestinations = import("@mailda/contract/schemas").ProviderVerifiedDestinations;

/** What a read of verified destinations found, as lines to print (unindented). Pure. */
export function verifiedDestinationLines(d: VerifiedDestinations): string[];

/** Posts the read with the operator's credential and prints what the Node recorded or why it refused. Never exits or throws. */
export function verifiedDestinationsStep(input: { origin: string; cookie: string; accountId: string; token: string }): Promise<void>;

/** A zone's catch-all in one line: `worker -> butler (enabled)`, or `nothing`. */
export function catchAllLine(catchAll: { action: string; destinations: string[]; enabled: boolean } | null): string;

/** The rows of the domain picker: every zone, then a typed subdomain, then an explicit skip. */
export function domainChoices(zones: ReadonlyArray<{ name: string }>): Array<{ label: string; value: string }>;

/** The zones an account holds, as wrangler's token sees them; an unreachable API reads as none. */
export function zonesOf(accountId: string, token: string): Promise<Array<{ name: string }>>;

/** How an address is routed, in the contract's words. */
export type AddressRouting = import("@mailda/contract/schemas").AddressRouting;

export interface ProvisionOutcome {
  receiving: string | null;
  sending: string | null;
  deliveryEvents: string | null;
  address: string | null;
  catchAll: boolean;
  /** Set when receiving ran, or was recorded, and its address does not reach this Node: what stops it. */
  routing: AddressRouting | null;
}

/**
 * One act the Node has on record, as `GET /api/provider` reports it under `provisioned`. `routing` is receiving's
 * recorded outcome; absent or null on a record from before 28 September 2026.
 */
export interface ProvisionedAct { domain: string; at: string; address: string | null; observed: boolean; routing?: AddressRouting | null }

/** Whether a receiving outcome's address reaches this Node: its `routing`, or its `rule` from a Node older than that. */
export function outcomeRoutesHere(outcome: { rule: string | null; routing?: AddressRouting | null }): boolean;

/** What a receiving record says for a summary: set up only when its address was routed here, or when it predates that record. */
export function receivingOf(act: ProvisionedAct | null | undefined): { receiving: string | null; address: string | null; routing: AddressRouting | null };

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

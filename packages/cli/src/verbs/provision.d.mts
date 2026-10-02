/**
 * Types for `provision.mjs`, so a TypeScript test can import it. Hand-written like `preflight.d.mts`, and
 * compared against the module's real exports by `test/node/declaration-drift.test.ts`.
 */

/** wrangler's login token: CLOUDFLARE_API_TOKEN, else `wrangler auth token --json`; fails saying why there is none. */
export function wranglerToken(): Promise<string>;

/** The token wrangler would act with, or why there is none, from `wrangler auth token --json`; never exits. */
export function wranglerTokenRead():
  | { token: string; error: null }
  | { token: null; error: string };

/**
 * `POST /api/provider/verified-destinations`'s `destinations`: counts only, never an address. Taken from the
 * contract rather than restated. The implementation is not type-checked against it (`checkJs: false`), so a
 * rename in the contract turns red where a typed caller passes one, `verified-destination-step.test.ts`'s fixture.
 */
export type VerifiedDestinations = import("@mailda/contract/schemas").ProviderVerifiedDestinations;

/** What a read of verified destinations found, as lines to print (unindented). Pure. */
export function verifiedDestinationLines(d: VerifiedDestinations): string[];

/** What registering a destination left, in one phrase (ADR 47). Pure. */
export function destinationSaid(destination: import("zod").infer<typeof import("@mailda/contract/schemas").providerDestinationAddResponse>["destination"]): string;

/** One kept forward as `mailda provider --forwards` prints it (ADR 47). Pure. */
export function keptForwardLines(one: import("@mailda/contract/schemas").KeptForwardRow): string[];

/** Posts the read with the operator's credential and prints what the Node recorded or why it refused. Never exits or throws. */
export function verifiedDestinationsStep(input: { origin: string; cookie: string; accountId: string; token: string }): Promise<void>;

/** A zone's catch-all in one line: `worker -> butler (enabled)`, or `nothing`. */
export function catchAllLine(catchAll: { action: string; destinations: string[]; enabled: boolean } | null): string;

/** The rows of the domain picker: every zone, then a typed subdomain, then an explicit skip. */
export function domainChoices(zones: ReadonlyArray<{ name: string }>): Array<{ label: string; value: string }>;

/** Every page of the zones an account holds, as the token sees them; a failed page is printed as a note. */
export function zonesOf(accountId: string, token: string, fetchImpl?: typeof fetch): Promise<Array<{ name: string }>>;

/** How an address is routed, in the contract's words. */
export type AddressRouting = import("@mailda/contract/schemas").AddressRouting;

export interface ProvisionOutcome {
  receiving: string | null;
  sending: string | null;
  deliveryEvents: string | null;
  address: string | null;
  /** The first address this run asked the Node for when it refused: it may be on the mailbox all the same. */
  attempted: string | null;
  catchAll: boolean;
  /** Set when receiving ran, or was recorded, and its address does not reach this Node: what stops it. */
  routing: AddressRouting | null;
}

/**
 * One act the Node has on record, as `GET /api/provider` reports it under `provisioned`. `routing` is receiving's
 * recorded outcome; absent or null on a record from before 28 September 2026.
 */
export interface ProvisionedAct { domain: string; at: string; address: string | null; observed: boolean; routing?: AddressRouting | null }

/** The name the Node receives at: the one on record, else the one this run's first address is on, else null. Pure. */
export function receivingDomain(
  provisioned: { receiving: ProvisionedAct | null } | null | undefined,
  setUp: { address: string | null } | null | undefined,
): string | null;

/** Whether a receiving outcome's address reaches this Node: its `routing`, or its `rule` from a Node older than that. */
export function outcomeRoutesHere(outcome: { rule: string | null; routing?: AddressRouting | null }): boolean;

/** What a receiving record says for a summary: set up only when its address was routed here, or when it predates that record. */
export function receivingOf(act: ProvisionedAct | null | undefined): { receiving: string | null; address: string | null; routing: AddressRouting | null };

/** The first address from the prompt's answer: a local part on `domain`, blank as `defaultLocal`, an answer with its own `@` whole. */
export function firstAddress(typed: string | undefined, domain: string, defaultLocal?: string): string;

/** `GET /api/provider/receiving`'s `ownRules`: the addresses on the domain with a routing rule of their own. From the contract. */
export type OwnRules = import("@mailda/contract/schemas").ProviderReceivingProposal["ownRules"];

/**
 * Those addresses and where each goes, as lines to print (unindented); unread, or a Node too old to list them, is said.
 * `below`: the routing step follows, and may change them. Pure.
 */
export function ownRulesLines(ownRules: OwnRules | null | undefined, domain: string, options?: { below?: boolean }): string[];

/** The first address's default local part: the sign-in address's own when it is on `domain` and not routed elsewhere; else `hello`, with why. Pure. */
export function defaultLocalFor(signInEmail: string | null | undefined, domain: string, ownRules: OwnRules | null | undefined): { local: string; said: string | null };

/** The install's last line: who signs in, and the address mail goes out as, or may. Pure. */
export function signInLine(email: string, setUp: ProvisionOutcome): string;

/**
 * Receiving, sending and the delivery-events subscription, through the Node's routes with the operator's
 * token. A step the Node already has on record (`provisioned`) is reported and not done again. `signInEmail` is
 * the administrator's, which the first address defaults to when it is on the domain (`defaultLocalFor`).
 */
export function provisionNode(input: {
  origin: string; cookie: string; accountId: string; token: string; yes: boolean;
  ask: (prompt: string) => Promise<string>;
  provisioned?: { receiving: ProvisionedAct | null; sending: ProvisionedAct | null; deliveryEvents: ProvisionedAct | null } | null;
  signInEmail?: string | null;
}): Promise<ProvisionOutcome>;

/** The `== next` block after a setup. */
export function printNext(origin: string, setUp: ProvisionOutcome): void;

/**
 * Types for `routing-step.mjs`, so a TypeScript test can import it. Hand-written like `provision.d.mts`, and
 * compared against the module's real exports by `test/node/declaration-drift.test.ts`.
 */

/** One rule as `GET /api/provider/routing-rules` lists it. From the contract. */
export type ListedRule = import("@mailda/contract/schemas").ProviderRoutingRules["rules"][number];
export type Listing = import("@mailda/contract/schemas").ProviderRoutingRules;

/** The rows on the names this Node receives for, the ones offered, and a count of the rules on other names. Pure. */
export function rulesPlan(listing: Listing, domain: string): {
  shown: ListedRule[];
  offered: ListedRule[];
  hidden: { count: number; names: string[] };
};

/** Where a rule sends its address today, in one phrase. Pure. */
export function whereTo(rule: ListedRule): string;

/** Whether taking `rule` over by hand needs `--mailbox`; `mailboxes` null when they could not be listed. Pure. */
export function needsMailbox(rule: ListedRule, mailboxes: Array<{ id: string; name: string }> | null): boolean;

/**
 * `mailda provider --take-over …` for one rule, as printed under `--yes`, with `--mailbox` wherever the Node would
 * refuse without it; `mailboxes` null when they could not be listed. Pure.
 */
export function takeOverCommand(
  rule: ListedRule, domain: string, origin: string, mailboxes?: Array<{ id: string; name: string }> | null,
  forward?: "keep" | "stop" | null, copy?: boolean,
): string;

/** The commands for one rule under `--yes`: a forward rule's choices (copies too, when listed), each with the Node's label. Pure. */
export function takeOverCommands(
  rule: ListedRule, domain: string, origin: string, mailboxes?: Array<{ id: string; name: string }> | null,
): Array<{ label: string | null; command: string }>;

/** One row as printed: the address, where it goes, and the put-back or the reason nothing is offered. Pure. */
export function ruleLines(rule: ListedRule, domain: string, origin: string, width: number): string[];

/** The step. Never exits, never throws; changes nothing under `--yes` or without a terminal. */
export function routingRulesStep(input: {
  origin: string; cookie: string | null; accountId: string; token: string | null; yes: boolean; domain: string | null;
  ask: (prompt: string) => Promise<string>;
  choose?: (prompt: string, options: Array<{ label: string; value: unknown }>) => Promise<unknown>;
}): Promise<void>;

/** Restores a taken-over rule from its own name with the operator's token, no Node asked. Exits on a refusal. */
export function putBackWithoutNode(input: {
  domain: string; ruleId: string; token: string; accountId: string; fetchImpl?: typeof fetch;
}): Promise<void>;

/**
 * How one address is routed, decided from a zone's Email Routing rules as Cloudflare lists them (28 September
 * 2026). Pure, and importing nothing, so the one function every caller uses (adding and removing an address,
 * the receiving onboard, and its proposal's list of addresses with rules of their own) is also the one a script
 * can run against a real zone's listing.
 *
 * The address's own rule is a matcher `literal` on `to` naming it exactly, and it outranks the catch-all. The
 * catch-all is a row with no literal matcher: `type: "all"` as measured in `email-routing-rule-takeover.md`, and
 * a row with no matcher at all as listed on a live zone on 28 September 2026. It never reads as the address's
 * own. A rule "routes here" only when it is enabled and its action is a Worker action naming this Worker.
 */

/** A routing rule as `GET /zones/{id}/email/routing/rules` lists it. */
export interface CloudflareRule {
  id?: string;
  name?: string;
  enabled?: boolean;
  matchers?: Array<{ type?: string; field?: string; value?: string }>;
  actions?: Array<{ type?: string; value?: string[] }>;
}

/**
 * `null` state: no rule of its own and no catch-all here covering it, so nothing routes it here and nothing
 * stands in the way of writing a literal rule. Every other state is the contract's `AddressRouting` word.
 */
export type Classified =
  | { state: "rule_written" | "routed_elsewhere" | "rule_disabled"; rule: CloudflareRule; detail: string }
  | { state: "catch_all"; rule: null; detail: string }
  | { state: null; rule: null; detail: string };

/** Whether a rule delivers to this Node: enabled, and a Worker action naming this Worker. Nothing else is "here". */
export function routesHere(rule: CloudflareRule, worker: string): boolean {
  const action = rule.actions?.[0];
  return rule.enabled === true && action?.type === "worker" && (action.value ?? []).includes(worker);
}

/** Where a rule sends mail, in Cloudflare's words: `forward to a@b`, `worker to other`, `drop`. */
export function whereTo(rule: CloudflareRule): string {
  const action = rule.actions?.[0];
  const to = (action?.value ?? []).join(", ");
  return `${action?.type ?? "unset"}${to === "" ? "" : ` to ${to}`}`;
}

/** The catch-all as it appears among the rules: no literal matcher at all. */
export function isCatchAll(rule: CloudflareRule): boolean {
  return !(rule.matchers ?? []).some((m) => m.type === "literal");
}

/** Whether the catch-all among the rules delivers here. It applies on the zone's own name only; the caller knows which. */
export function catchAllRoutesHere(rules: CloudflareRule[], worker: string): boolean {
  return rules.some((rule) => isCatchAll(rule) && routesHere(rule, worker));
}

/**
 * `catchAllHere` is whether the zone's catch-all delivers here and covers the address: the address is on the
 * zone's own name (Cloudflare's catch-all is apex only) and `catchAllRoutesHere`, or the catch-all's own endpoint
 * read back pointing here. `domain` names the zone in the next step a detail gives.
 */
export function classifyAddress(
  rules: CloudflareRule[], address: string, worker: string, catchAllHere: boolean, domain: string,
): Classified {
  const normalized = address.trim().toLowerCase();
  // `type` is redundant with `field` on every rule Cloudflare has listed (the catch-all carries no `field`), so
  // a mutant dropping it survives; it stays so the match says what it means rather than relying on that.
  const own = rules.find((rule) => (rule.matchers ?? []).some((m) =>
    m.type === "literal" && m.field === "to" && m.value?.toLowerCase() === normalized));
  const named = (rule: CloudflareRule) => `${normalized} has an Email Routing rule of its own, named ${JSON.stringify(rule.name ?? "")}`;
  if (own === undefined) {
    return catchAllHere
      ? { state: "catch_all", rule: null, detail: `the catch-all on ${domain} routes ${normalized} here, and it has no rule of its own` }
      : { state: null, rule: null, detail: `no rule routes ${normalized} here, and no catch-all here covers it` };
  }
  if (routesHere(own, worker)) {
    return { state: "rule_written", rule: own, detail: `a rule named ${JSON.stringify(own.name ?? "")} already routes ${normalized} here` };
  }
  /*
   * Disabled is its own answer. Cloudflare says a disabled rule "will not forward emails to a destination address
   * or Worker", and does not say whether the address then falls to the catch-all, so this Node does not claim
   * either. Take-over is not the next step: it keeps `enabled` as it is, and refuses a rule already naming this
   * Worker.
   */
  if (own.enabled !== true) {
    const ours = (own.actions?.[0]?.value ?? []).includes(worker) && own.actions?.[0]?.type === "worker";
    return {
      state: "rule_disabled", rule: own,
      detail: `${named(own)}, which is disabled (enabled, it would be ${whereTo(own)}). Cloudflare does not apply a `
        + "disabled rule and does not say whether the catch-all then does, so this Node cannot say where mail for it "
        + "goes, and left the rule as it is. "
        + (ours
          ? "It names this Node: enable it in the Cloudflare dashboard (Email, Email Routing, Routing rules)."
          : "To route the address here, delete it in the Cloudflare dashboard (Email, Email Routing, Routing rules), "
            + "then add the address again."),
    };
  }
  return {
    state: "routed_elsewhere", rule: own,
    detail: `${named(own)}: ${whereTo(own)}. It does not deliver to this Node, and this Node left it as it is. `
      + `To route the address here, list the rules with \`mailda provider --routing-rules ${domain}\`, which prints `
      + `the rule's id and digest, then \`mailda provider --take-over ${own.id ?? "<rule id>"} --domain ${domain} `
      + "--confirm <digest>`.",
  };
}

/** An address on a domain with an Email Routing rule of its own, as `classifyAddress` classifies it, and where it goes. */
export interface OwnRule { address: string; state: "rule_written" | "routed_elsewhere" | "rule_disabled"; where: string }

/**
 * Every address on `domain` itself (not its subdomains) that has an Email Routing rule of its own, each classified
 * by `classifyAddress` and sorted (28 September 2026). An enabled literal rule outranks the catch-all, so a
 * catch-all taken over here does not reach its address; for a disabled one Cloudflare does not say whether the
 * catch-all then applies, and `rule_disabled` claims neither. The take-over leaves every one of these rules as it is.
 */
export function rulesOfTheirOwn(rules: CloudflareRule[], domain: string, worker: string): OwnRule[] {
  const suffix = `@${domain.trim().toLowerCase()}`;
  const addresses = new Set(rules.flatMap((rule) => (rule.matchers ?? [])
    .filter((m) => m.type === "literal" && m.field === "to" && (m.value ?? "").toLowerCase().endsWith(suffix))
    .map((m) => (m.value ?? "").toLowerCase())));
  return [...addresses].sort().flatMap((address) => {
    const classified = classifyAddress(rules, address, worker, false, domain);
    // Found by the literal matcher `classifyAddress` looks for, so it always names the rule; `[]` satisfies the type.
    return classified.rule === null ? [] : [{ address, state: classified.state, where: whereTo(classified.rule) }];
  });
}

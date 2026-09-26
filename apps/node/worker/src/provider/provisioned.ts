/**
 * What this Node's Cloudflare setup has been observed to do, from the audit trail (25 September 2026).
 *
 * The Setup screen's progress reads receiving, sending and delivery events through the token, which a
 * Node set up at install by the CLI may never hold. The install's acts are in the audit trail, though:
 * each provisioning act writes an entry naming the domain and which credential did it. This is the
 * structured source for "set up, at install, on this date", which is honest about being a record of an act
 * rather than a live read, and the progress says so.
 *
 * Two entries count for each kind: the act itself, and the observation that Cloudflare already had it in
 * place (`*_observed`, 26 September 2026). The latest of either is the fact, and `observed` says which,
 * because "set up at install" and "found already set up" are different claims about who did it.
 */
const ACTIONS = {
  receiving: ["provider.receiving_onboarded"],
  sending: ["provider.sending_onboarded", "provider.sending_observed"],
  deliveryEvents: ["provider.delivery_events_subscribed", "provider.delivery_events_observed"],
} as const;

export interface ProvisionedAct {
  domain: string;
  at: string;
  /** Who acted: the Node's token, or an operator's own carried on the request; "unknown" for an entry from before this field. */
  /** `grant` is historical: entries written while the credential was an OAuth grant (before 26 September 2026). */
  authority: "token" | "grant" | "operator" | "unknown";
  address: string | null;
  /** True when this Node did not do it: Cloudflare reported it in place already, and the entry records the sighting. */
  observed: boolean;
}

export interface Provisioned {
  receiving: ProvisionedAct | null;
  sending: ProvisionedAct | null;
  deliveryEvents: ProvisionedAct | null;
}

export async function provisionedFacts(env: Env, orgId: string): Promise<Provisioned> {
  const actions = Object.values(ACTIONS).flat();
  const rows = await env.CATALOG.prepare(
    `SELECT action, subject, at, detail FROM audit_entries WHERE org_id = ? AND action IN (${actions.map(() => "?").join(", ")}) `
    + "ORDER BY seq DESC",
  ).bind(orgId, ...actions)
    .all<{ action: string; subject: string | null; at: string; detail: string | null }>();

  const latest = (of: readonly string[]): ProvisionedAct | null => {
    const row = rows.results.find((one) => of.includes(one.action));
    if (row === undefined || row.subject === null) return null;
    let detail: Record<string, unknown> = {};
    try { detail = JSON.parse(row.detail ?? "{}") as Record<string, unknown>; } catch { detail = {}; }
    const authority = detail.authority === "token" || detail.authority === "grant" || detail.authority === "operator" ? detail.authority : "unknown";
    return {
      domain: row.subject, at: row.at, authority,
      address: typeof detail.address === "string" ? detail.address : null,
      observed: row.action.endsWith("_observed"),
    };
  };
  return {
    receiving: latest(ACTIONS.receiving),
    sending: latest(ACTIONS.sending),
    deliveryEvents: latest(ACTIONS.deliveryEvents),
  };
}

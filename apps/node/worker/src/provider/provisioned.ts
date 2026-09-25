/**
 * What this Node's Cloudflare setup has been observed to do, from the audit trail (25 September 2026).
 *
 * The Setup screen's progress reads receiving, sending and delivery events through the grant, which a
 * Node set up at install by the CLI may never hold. The install's acts are in the audit trail, though:
 * each provisioning act writes an entry naming the domain and which credential did it. This is the
 * structured source for "set up, at install, on this date", which is honest about being a record of an act
 * rather than a live read, and the progress says so.
 */
const ACTIONS = {
  receiving: "provider.receiving_onboarded",
  sending: "provider.sending_onboarded",
  deliveryEvents: "provider.delivery_events_subscribed",
} as const;

export interface ProvisionedAct {
  domain: string;
  at: string;
  /** Who acted: the Node's grant, or an operator's own token; "unknown" for an entry from before this field. */
  authority: "grant" | "operator" | "unknown";
  address: string | null;
}

export interface Provisioned {
  receiving: ProvisionedAct | null;
  sending: ProvisionedAct | null;
  deliveryEvents: ProvisionedAct | null;
}

export async function provisionedFacts(env: Env, orgId: string): Promise<Provisioned> {
  const rows = await env.CATALOG.prepare(
    "SELECT action, subject, at, detail FROM audit_entries WHERE org_id = ? AND action IN (?, ?, ?) "
    + "ORDER BY seq DESC",
  ).bind(orgId, ACTIONS.receiving, ACTIONS.sending, ACTIONS.deliveryEvents)
    .all<{ action: string; subject: string | null; at: string; detail: string | null }>()
    .catch(() => ({ results: [] as Array<{ action: string; subject: string | null; at: string; detail: string | null }> }));

  const latest = (action: string): ProvisionedAct | null => {
    const row = rows.results.find((one) => one.action === action);
    if (row === undefined || row.subject === null) return null;
    let detail: Record<string, unknown> = {};
    try { detail = JSON.parse(row.detail ?? "{}") as Record<string, unknown>; } catch { detail = {}; }
    const authority = detail.authority === "grant" || detail.authority === "operator" ? detail.authority : "unknown";
    return { domain: row.subject, at: row.at, authority, address: typeof detail.address === "string" ? detail.address : null };
  };
  return {
    receiving: latest(ACTIONS.receiving),
    sending: latest(ACTIONS.sending),
    deliveryEvents: latest(ACTIONS.deliveryEvents),
  };
}

/**
 * The Node the pseudo-locale check (`pseudo-locale.test.tsx`) renders every route against.
 *
 * **Data is Greek; the Node's own words are English.** A name, a subject, a mailbox, an address, a team, a
 * description: whatever a person wrote is in Greek, so it can never be mistaken for, or hide, an English word
 * the interface forgot to translate. What the Node itself writes (an error's `message`, a doctor finding's
 * `detail` and `fix`, a breaker's sentence, a capability's `says`, a send's `last_error`) is English, as the real
 * Node's is, so that words shown without `<NodeWords>` around them are seen. Wire tokens (states, relations,
 * check names, audit actions) are the Node's too, and stay as it sends them. Ids and Cloudflare's resource names are
 * data, so they are Greek too (`μβχ_1` for `mbx_1`): an id on screen is not a word to translate.
 *
 * Shapes follow `src/client/app/api.ts`; each list has a row in each state worth reading.
 */

const AT = "2026-09-26T07:09:02.000Z";
const LATER = "2026-12-01T00:00:00.000Z";
const EARLIER = "2026-08-01T00:00:00.000Z";

/** The Node's own sentences, English as the real Node writes them. */
export const NODE_SAYS = {
  refused: "Refused by this Node for the test: the four-part message the Node writes.",
  failed: "This Node could not read that for the test.",
  detail: "Inbound routing has an address and nothing has arrived yet.",
  fix: "Run mailda doctor again after the change.",
  error: "The provider answered 421 and this Node will retry.",
  sentence: "Bounce rate over the last day.",
  says: "Read the metadata of a mailbox's messages.",
} as const;

/**
 * Data that is Latin whatever a fixture does: a link's scheme. Shown, it is the sender's, not the interface's; the
 * check removes each of these from a text before it looks (and the page's own host, which it knows itself).
 */
export const LATIN_DATA = ["https://κακό.δοκ/πληρωμή"] as const;

const ANA = "άννα@παράδειγμα.δοκ";
const BOB = "βασίλης@παράδειγμα.δοκ";
const OUTSIDE = "λογιστήριο@βόρειος.δοκ";
const SUPPORT = "υποστήριξη@παράδειγμα.δοκ";
const DOMAIN = "παράδειγμα.δοκ";

const mailbox = (id: string, name: string, addresses: string | null, over: Record<string, unknown> = {}) => ({
  id, name, unclaimed: 2, claimed: 1, mine: 1, first_response_minutes: 60, quarantine_dmarc_fail: 1,
  quarantine_dangerous_attachments: 1, attachment_max_bytes: 10_485_760, attachment_allowed_types: null, quarantined: 1, breached: 1,
  addresses, ...over,
});

const message = (id: string, over: Record<string, unknown> = {}) => ({
  id, message_id: `μσγ_${id}`, subject: "Τιμολόγιο αριθμός ένα", from_addr: OUTSIDE, envelope_from: OUTSIDE,
  envelope_to: SUPPORT, mailbox_id: "μβχ_1", raw_bytes: 14_090, accepted_at: AT, parse_error: null, conversation_id: "ψνω_1",
  auth_spf: "pass", auth_dkim: "fail", auth_dmarc: "pass", auth_dmarc_policy: "reject", auth_from_domain: "βόρειος.δοκ",
  attachments: 1, attachments_dangerous: 0, labels_json: JSON.stringify(["ετικέτα"]), read: 0, case_id: "ψασ_1",
  place: "inbox", from_name: "Άισα Ραχμάν", preview: "Παρακαλώ βρείτε συνημμένο", standing_content: 1, case_mine: 0,
  case_state: "open", ...over,
});

const recipient = (address: string, over: Record<string, unknown> = {}) => ({
  manifest_id: "σνδ_1", kind: "to", address, submission_state: "handed_over", delivery_state: "accepted",
  delivery_reason: null, bounce_type: null, last_error: null, ...over,
});

const send = (id: string, state: string, over: Record<string, unknown> = {}) => ({
  retry: { mode: null, why: NODE_SAYS.error }, id, subject: "Απάντηση στο τιμολόγιο", envelope_to: JSON.stringify([OUTSIDE]), state,
  state_at: AT, release_at: AT, attempts: 1, last_error: null, transport_message_id: null, fidelity: "exact",
  has_submitted: 1, is_copy: 0, state_reason: null, policy_outcome: null, recipients: [recipient(OUTSIDE)], ...over,
});

const SENDS = [
  send("σνδ_1", "handed_over"),
  send("σνδ_2", "outcome_unknown", { last_error: NODE_SAYS.error, retry: { mode: "resend-may-duplicate", duplicatePossible: true }, recipients: [recipient(OUTSIDE, { submission_state: "outcome_unknown", delivery_state: null })] }),
  send("σνδ_3", "held", { state_reason: "policy_hold", policy_outcome: "hold", has_submitted: 0, recipients: [recipient(OUTSIDE, { submission_state: "held", delivery_state: null })] }),
  send("σνδ_4", "handed_over", { recipients: [recipient(OUTSIDE, { delivery_state: "bounced", delivery_reason: "hard_bounce", bounce_type: "hard", last_error: NODE_SAYS.error })] }),
  send("σνδ_5", "withheld", { state_reason: "domain_paused", has_submitted: 0, recipients: [recipient(OUTSIDE, { submission_state: "withheld", delivery_state: null })] }),
  // The one retry offered without a written reason, so a press reaches the Node's refusal.
  send("σνδ_6", "throttled", { retry: { mode: "retry-effect", proof: "throttled" }, recipients: [recipient(OUTSIDE, { submission_state: "throttled", delivery_state: null })] }),
];

const caseRow = (id: string, over: Record<string, unknown> = {}) => ({
  id, conversation_id: "ψνω_1", mailbox_id: "μβχ_1", state: "open", state_at: AT, assignee: null, claimed_at: null,
  created_at: AT, subject: "Ερώτηση για παραγγελία", from_addr: OUTSIDE, content_restricted: false, message_count: 2,
  assignee_email: null, response_due_at: LATER, first_response_at: null, response_breached_at: null, ...over,
});

const finding = (check: string, ok: boolean, over: Record<string, unknown> = {}) => ({
  check, severity: ok ? "report" : "degraded", ok, detail: NODE_SAYS.detail, ...over,
});

const DOCTOR = {
  verdict: "degraded", claimed: true, at: AT,
  findings: [
    finding("inbound_routing", true),
    finding("transport_adapters", false, { fix: NODE_SAYS.fix, receipt: "docs/receipts/untranslated-scan-timeout.md" }),
    finding("key_vault", false, { severity: "refuse", fix: NODE_SAYS.fix }),
    // Each with a remedy beside it (`Remedy` in `ledgers.tsx`), so the refusal pass has the Doctor's acts to press.
    finding("recovery_escrow", true),
    finding("evidence_present", true),
    ...["migrations_applied", "evidence_key_generation", "evidence_orphans", "body_index_failed", "preview_backlog", "recovery_key_conflicts"]
      .map((check) => finding(check, false, { fix: NODE_SAYS.fix })),
    // A name this client does not know, as a newer Node may send: shown raw, which is the Node's word.
    finding("check_from_a_newer_node", false),
  ],
};

const act = (address: string | null) => ({
  domain: DOMAIN, at: AT, authority: "operator", address, observed: false, routing: address === null ? null : { state: "rule_written", detail: NODE_SAYS.detail },
});

/**
 * Connected (a token held), as Setup is read; or set up by the installer with no token, the one shape the first-run
 * gate reads as ready without spending a token (`useReadiness` in `onboarding.tsx`); or not set up at all.
 */
const provider = (how: "connected" | "installed" | "bare") => ({
  provider: how === "connected"
    ? { state: "token_held", accountId: "αψψ_1", accountName: "Εταιρεία Παράδειγμα", registeredAt: AT, verifiedAt: AT }
    : { state: "no_token", accountId: null, accountName: null, registeredAt: null, verifiedAt: null },
  provisioned: how === "installed" ? { receiving: act(SUPPORT), sending: act(null), deliveryEvents: act(null) } : { receiving: null, sending: null, deliveryEvents: null },
  permissions: [
    { name: "Zone Read", scope: "zone", why: "find the zone a domain lives in", optional: false },
    { name: "Registrar Domains Read", scope: "account", why: "price a domain before buying it", optional: true },
  ],
  note: "The permission names come from Cloudflare's token form.",
});

const ROUTING = [
  { domain: DOMAIN, zone: DOMAIN, zoneId: "ζ1", enabled: true, status: "ready", required: [], error: null },
  { domain: "εκκρεμεί.δοκ", zone: "εκκρεμεί.δοκ", zoneId: "ζ2", enabled: true, status: null, required: [{ type: "MX", name: "εκκρεμεί.δοκ", content: "route1.mx.cloudflare.net", priority: 9 }], error: null },
  { domain: "χαλασμένο.δοκ", zone: null, zoneId: null, enabled: null, status: null, required: [], error: NODE_SAYS.error },
];

const DELIVERY = [
  {
    domain: DOMAIN, zone: DOMAIN,
    sending: { name: DOMAIN, enabled: true, returnPath: null, dkimSelector: null, required: [], error: null },
    subscription: "συνδρομή", subscriptionId: "σ1", enabled: true, events: ["email.sending"], queueId: "θ1", queueName: "ουρά-συμβάντων",
    consumers: ["καταναλωτής"], error: null,
  },
  {
    domain: "εκκρεμεί.δοκ", zone: "εκκρεμεί.δοκ", sending: null, subscription: null, subscriptionId: null, enabled: null, events: [],
    queueId: null, queueName: null, consumers: [], error: null,
  },
];

const BUTLER_SOURCE = JSON.stringify({ name: "lead-response", trigger: "message.received", nodes: [] }, null, 2);

const butler = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: "απάντηση-σε-πελάτες", created_at: EARLIER, live_version_id: "βω_2", live_version: 2, published_at: AT,
  draft_version_id: "βω_3", pause: null, ...over,
});

const PEOPLE = [
  {
    id: "υσρ_ανα", email: ANA, created_at: EARLIER, relations: [
      { relation: "mailbox.content.read", objectType: "mailbox", objectId: "μβχ_1" },
      { relation: "send.propose", objectType: "mailbox", objectId: "μβχ_1" },
      { relation: "org.admin", objectType: "organization", objectId: "οργ_χ" },
    ],
  },
  { id: "υσρ_βοβ", email: BOB, created_at: EARLIER, relations: [] },
];

const AGENT = {
  id: "αγτ_1", name: "βοηθός-τιμολογίων", sponsorUserId: "υσρ_ανα", createdBy: "υσρ_ανα", createdAt: EARLIER, expiresAt: LATER,
  revokedAt: null, actions: ["mailbox.metadata.read"],
  held: [{ id: "mailbox.metadata.read", says: NODE_SAYS.says, reachesContent: false, held: 3, total: 4 }],
  unnamed: ["GET /api/retired"],
  grants: [{ mailboxId: "μβχ_1", mailboxName: "Υποστήριξη", relation: "mailbox.metadata.read", effective: true }],
};

const BODY = {
  state: "html", html: "<p>Παρακαλώ βρείτε συνημμένο.</p>", text: null, blockedRemote: 2, truncated: true, problem: null,
  attachments: [{ filename: "τιμολόγιο.πδφ", declaredType: "εφαρμογή/πδφ", bytes: 20_480, verdict: "plain" }],
  links: [{ href: LATIN_DATA[0], text: "βόρειος.δοκ/πληρωμή", verdict: "mismatch" }],
  recipients: { to: [SUPPORT], cc: [BOB], replyTo: OUTSIDE }, script: null,
};

const HEADERS = { headers: "Θέμα: Τιμολόγιο", truncated: true, limit_bytes: 65_536 };

type Body = unknown | ((url: URL) => unknown);

/** The Node's answers, `GET <path>` to a body or to a function of the request's URL. */
export function FIXTURES(kind: "populated" | "empty" | "first-run", connected: boolean): Record<string, Body> {
  const full = kind !== "empty";
  const list = <T,>(rows: T[]): T[] => (full ? rows : []);
  const messages = [
    message("ρψπτ_1"),
    message("ρψπτ_2", { read: 1, case_mine: 1, case_state: "claimed", subject: "Δεύτερο θέμα", attachments_dangerous: 1 }),
    message("ρψπτ_3", { place: "archive", subject: "Αρχειοθετημένο" }),
    message("ρψπτ_4", { place: "trash", subject: "Στον κάδο" }),
  ];
  return {
    "GET /api/me": { signedIn: true, principalId: "υσρ_ανα", principalKind: "user", userId: "υσρ_ανα", delegatorUserId: null, organizationId: "οργ_χ", email: ANA },
    "GET /api/mailboxes": { mailboxes: [mailbox("μβχ_1", "Υποστήριξη", SUPPORT), ...list([mailbox("μβχ_2", "Πωλήσεις", null, { unclaimed: 0, claimed: 0, mine: 0 })])] },
    "GET /api/mailboxes/readable": { mailboxes: [{ id: "μβχ_1", name: "Υποστήριξη" }] },
    // A kept forward (ADR 47) whose latest attempt Cloudflare refused, so People draws the line with the Node's words.
    "GET /api/forwards": {
      forwards: list([{
        address: SUPPORT, mailboxId: "μβχ_1", to: OUTSIDE, verified: "verified", checkedAt: AT,
        last: {
          state: "refused", at: AT, error: "destination address not verified",
          // A copy the refusal asked for, refused (ADR 47 amended), so its reason is drawn in the Node's words too.
          copy: { state: "refused", at: AT, error: "the message is quarantined in its mailbox, and a copy would send what the mailbox held back", sendId: null, sendState: null },
        },
        lastHandedOverAt: AT, copy: { by: "υσρ_ανα", at: AT },
      }]),
    },
    "GET /api/mailboxes/μβχ_1/cases": {
      cases: list([
        caseRow("ψασ_1"),
        caseRow("ψασ_2", { state: "claimed", assignee: "υσρ_βοβ", assignee_email: BOB, claimed_at: AT, response_breached_at: AT }),
        caseRow("ψασ_3", { state: "claimed", assignee: "υσρ_ανα", assignee_email: ANA, claimed_at: AT, first_response_at: AT }),
      ]),
    },
    "GET /api/mailboxes/μβχ_2/cases": { cases: [] },
    "GET /api/messages": (url: URL) => {
      const place = url.searchParams.get("place") ?? "inbox";
      const conversation = url.searchParams.get("conversation");
      const rows = list(messages).filter((row) => (conversation === null ? row.place === place : true));
      return { messages: rows, next_cursor: null, lookback_exhausted: !full, max_lookback: 365 };
    },
    ...Object.fromEntries(messages.flatMap((row) => [[`GET /api/messages/${row.id}/body`, BODY], [`GET /api/messages/${row.id}/headers`, HEADERS]])),
    "GET /api/sends": { sends: list(SENDS), truncated: false, daily: { day: "2026-09-26", handedOver: full ? 12 : 0, throttledAtCount: null, firstThrottledAt: null }, capability: { canSend: true, arbitraryRecipients: true, verifiedAt: AT, detail: NODE_SAYS.detail } },
    // The list, or the composer's resume of a reply (`?inReplyTo=`), which this Node has no draft for.
    "GET /api/drafts": (url: URL) => (url.searchParams.has("inReplyTo")
      ? { draft: null }
      : {
        drafts: list([{ id: "δρφ_1", mailboxId: "μβχ_1", inReplyToMessageId: null, to: [OUTSIDE], subject: "Πρόχειρο θέμα", updatedAt: AT, caseId: null }]),
        truncated: false,
      }),
    "GET /api/drafts/δρφ_1": {
      draft: { id: "δρφ_1", mailboxId: "μβχ_1", inReplyToMessageId: null, to: [OUTSIDE], cc: [], bcc: [], subject: "Πρόχειρο θέμα", body: "Καλημέρα", updatedAt: AT, caseId: null },
    },
    "GET /api/notifications": {
      truncated: false,
      notifications: list([
        {
          id: "ντφ_1", kind: "supervised_read", subjectId: "σγρ_1", mailboxId: "μβχ_1", matterId: "ματ_1", dueAt: null, deliveredAt: null,
          body: { readerEmail: BOB, mailboxName: "Υποστήριξη", scope: "content", grantedAt: AT, expiresAt: LATER, matterId: "ματ_1", matterType: "legal_hold", grantId: "σγρ_1", acts: { queries: 1, listed: 1, opened: 3, attachments: 1 } },
        },
        {
          id: "ντφ_2", kind: "approval_request", subjectId: "απρ_1", mailboxId: null, matterId: null, dueAt: null, deliveredAt: null,
          body: { subjectKind: "send_manifest", approvalId: "απρ_1", requestedBy: BOB, requestedAt: AT },
        },
      ]),
    },
    "GET /api/doctor": full ? DOCTOR : { ...DOCTOR, verdict: "ok", findings: [finding("inbound_routing", true)] },
    "GET /api/provider": provider(connected ? "connected" : kind === "first-run" ? "bare" : "installed"),
    "GET /api/provider/email-routing": { routing: full ? ROUTING : [ROUTING[0]] },
    "GET /api/provider/delivery-events": { delivery: full ? DELIVERY : [DELIVERY[0]] },
    "GET /api/transport": { transport: { adapter: "cloudflare", capability: { canSend: true, arbitraryRecipients: false, verifiedAt: AT, detail: NODE_SAYS.detail }, available: { binding: true, rest: { accountId: "αψψ_1", configuredAt: AT } } } },
    "GET /api/quarantine": {
      truncated: false,
      quarantined: list([
        { messageId: "μσγ_θ1", receiptId: "ρψπτ_θ1", mailboxId: "μβχ_1", mailboxAddress: SUPPORT, subject: "Ύποπτο", fromAddr: OUTSIDE, fromDomain: "βόρειος.δοκ", dmarcPolicy: "reject", acceptedAt: AT, quarantinedAt: AT, reason: "dmarc_fail_reject", note: null },
        { messageId: "μσγ_θ2", receiptId: "ρψπτ_θ2", mailboxId: "μβχ_1", mailboxAddress: SUPPORT, subject: "Συνημμένο", fromAddr: OUTSIDE, fromDomain: "βόρειος.δοκ", dmarcPolicy: null, acceptedAt: AT, quarantinedAt: AT, reason: "attachment_dangerous", note: NODE_SAYS.detail },
      ]),
    },
    "GET /api/audit": (url: URL) => (url.searchParams.get("action") === "access.revoked"
      ? { entries: [], truncated: false }
      : {
        truncated: false,
        entries: list([
          { id: "αυδ_1", seq: 1, at: AT, actor_user_id: "υσρ_ανα", actor_kind: "user", delegator_user_id: null, action: "send.propose", subject: "σνδ_1", outcome: "ok", detail: "{}", hash: "0123456789012345678901234567890123456789012345678901234567890123" },
          { id: "αυδ_2", seq: 2, at: AT, actor_user_id: "αγτ_1", actor_kind: "agent", delegator_user_id: "υσρ_ανα", action: "access.revoked", subject: "υσρ_βοβ", outcome: "refused", detail: "{}", hash: "1234567890123456789012345678901234567890123456789012345678901234" },
        ]),
      }),
    "GET /api/logs": {
      truncated: false,
      entries: list([{ id: "λογ_1", at: AT, level: "error", event: "outbound.attempt", message: NODE_SAYS.error, detail: "{}", request_id: "ρεθ_1" }]),
      counts: list([{ level: "error", n: 1 }, { level: "info", n: 40 }]),
    },
    "GET /api/search/failed": { failed: list([{ messageId: "μσγ_1", state: "retryable", attempts: 2, error: NODE_SAYS.error }]) },
    "GET /api/auth/passkeys": { passkeys: list([{ id: "πκ_1", label: "Φορητός υπολογιστής", createdAt: EARLIER, lastUsedAt: AT, transports: ["internal"] }]) },
    "GET /api/approvals": {
      approvals: list([
        { id: "απρ_1", subjectKind: "send_manifest", subjectId: "σνδ_3", scopeId: "μβχ_1", actorUserId: "υσρ_βοβ", state: "pending", requestedAt: AT, resolvedAt: null, expiresAt: LATER, stages: [{ count: 1, teamId: null }], openStage: 0, decidedByMe: false, reason: "Χρειάζεται δεύτερη ματιά", actorLabel: "βοβ@παράδειγμα.δοκ", scopeName: "Υποστήριξη", send: { manifestId: "σνδ_3", from: "υποστήριξη@παράδειγμα.δοκ", to: ["πελάτης@παράδειγμα.δοκ"], cc: [], bcc: ["έλεγχος@παράδειγμα.δοκ"], subject: "Η προσφορά σας" } },
        { id: "απρ_2", subjectKind: "domain_pause", subjectId: "δπ_1", scopeId: "οργ_χ", actorUserId: "υσρ_βοβ", state: "pending", requestedAt: AT, resolvedAt: null, expiresAt: LATER, stages: [{ count: 2, teamId: "τμ_1" }], openStage: 0, decidedByMe: false, reason: null, domainPause: { pauseId: "δπ_1", domain: DOMAIN, reason: "Πολλές αναπηδήσεις" } },
        { id: "απρ_3", subjectKind: "supervised_read", subjectId: "σγρ_1", scopeId: "μβχ_1", actorUserId: "υσρ_ανα", state: "pending", requestedAt: AT, resolvedAt: null, expiresAt: LATER, stages: [{ count: 1, teamId: null }], openStage: 0, decidedByMe: true, reason: null, supervised: { grantId: "σγρ_1", subjectId: "υσρ_βοβ", subjectEmail: "βοβ@παράδειγμα.δοκ", scope: "content", matterId: "ματ_1", matter: { type: "security_incident", description: "Κανόνας προώθησης που δεν όρισε κανείς" }, expiresAt: LATER } },
      ]),
    },
    // The send απρ_1 asks about, as the content route answers its approver.
    "GET /api/approvals/απρ_1/content": { approvalId: "απρ_1", manifestId: "σνδ_3", body: "Γεια σας,\n\nη προσφορά επισυνάπτεται.", attachments: [{ id: "σατ_1", filename: "προσφορά.πδφ", contentType: "εφαρμογή/πδφ", bytes: 52000 }] },
    "GET /api/policies": {
      policies: list([
        { policy_id: "πολ_1", name: "εξωτερικοί-παραλήπτες", version_id: "πω_1", version: 1, state: "published", outcome: "require_approval", when_mailbox_id: "μβχ_1", when_actor_user_id: null, when_recipient_external: 1, when_is_reply: null, when_org_daily_volume_min: 500, when_reply_to_dmarc_fail: null, created_at: EARLIER, published_at: AT, superseded_at: null },
        { policy_id: "πολ_2", name: "άρνηση", version_id: "πω_2", version: null, state: "draft", outcome: "deny", when_mailbox_id: null, when_actor_user_id: "υσρ_βοβ", when_recipient_external: null, when_is_reply: 1, when_org_daily_volume_min: null, when_reply_to_dmarc_fail: 1, created_at: AT, published_at: null, superseded_at: null },
      ]),
    },
    "GET /api/people": { people: list(PEOPLE) },
    "GET /api/teams": { teams: list([{ id: "τμ_1", name: "Νομικό τμήμα", createdAt: EARLIER, memberCount: 1 }]) },
    "GET /api/teams/τμ_1/members": { members: ["υσρ_ανα"] },
    "GET /api/invitations": {
      invitations: list([
        { id: "ινω_1", email: "κλειώ@παράδειγμα.δοκ", invitedBy: "υσρ_ανα", createdAt: EARLIER, expiresAt: LATER, expired: false },
        { id: "ινω_2", email: "δανάη@παράδειγμα.δοκ", invitedBy: "υσρ_ανα", createdAt: EARLIER, expiresAt: EARLIER, expired: true },
      ]),
    },
    "GET /api/people/υσρ_ανα/mailboxes": { mailboxes: [{ mailboxId: "μβχ_1", mailboxName: "Υποστήριξη", relations: ["mailbox.metadata.read", "mailbox.content.read", "send.propose"] }] },
    "GET /api/agent-capabilities": {
      capabilities: [{ id: "mailbox.metadata.read", says: NODE_SAYS.says, reachesContent: false, requires: ["mailbox.metadata.read"], routes: ["GET /api/messages"] }],
    },
    "GET /api/agents": { agents: list([AGENT, { ...AGENT, id: "αγτ_2", revokedAt: AT, unnamed: [] }]) },
    // What a Butler holds, for its access grid (`?subject=` is a query, so the key is the path alone).
    "GET /api/access": { subjectId: "βτλ_1", relations: [{ relation: "send.propose", objectType: "mailbox", objectId: "μβχ_1", createdAt: AT }] },
    "GET /api/butlers": {
      butlers: list([
        butler("βτλ_1"),
        butler("βτλ_2", { name: "σε-παύση", pause: { pauseId: "βπ_1", butlerId: "βτλ_2", butlerName: "σε-παύση", reason: "loop_detected", detail: NODE_SAYS.detail, trippedBy: "ρυν_1", placedAt: AT } }),
        butler("βτλ_3", { name: "νέος", live_version_id: null, live_version: null, published_at: null }),
      ]),
    },
    "GET /api/butler-runs": {
      runs: list([
        { id: "ρυν_1", butler_id: "βτλ_1", version_id: "βω_2", trigger_event: "message.received", trigger_key: "ρψπτ_1", state: "finished", outcome_reason: null, started_at: AT, finished_at: AT, nodes_executed: 4, effects: 1, refusals: 0, subrequests_spent: 2, replay_of: null, replayed_by: null },
        { id: "ρυν_2", butler_id: "βτλ_1", version_id: "βω_2", trigger_event: "message.received", trigger_key: "ρψπτ_2", state: "refused", outcome_reason: "budget_exhausted", started_at: AT, finished_at: AT, nodes_executed: 2, effects: 0, refusals: 1, subrequests_spent: 1, replay_of: null, replayed_by: null },
      ]),
    },
    "GET /api/breakers": {
      breakers: [
        { breaker: "bounce_rate", sentence: NODE_SAYS.sentence, observations: 200, observed: 4, percent: 2, limit: 5, windowSeconds: 86_400, armed: true, unarmedReason: null, tripped: false },
        { breaker: "complaint_rate", sentence: NODE_SAYS.sentence, observations: 0, observed: 0, percent: null, limit: 1, windowSeconds: 86_400, armed: false, unarmedReason: "no_observations", tripped: false },
        ...list([{ breaker: "volume", sentence: NODE_SAYS.sentence, observations: 900, observed: 900, percent: null, limit: 800, windowSeconds: 3_600, armed: true, unarmedReason: null, tripped: true }]),
      ],
    },
    "GET /api/domain-pauses": { pauses: list([{ id: "δπ_1", domain: DOMAIN, placedAt: AT, reason: "Πολλές αναπηδήσεις" }]) },
    "GET /api/suppressions": { truncated: false, suppressed: list([{ address: OUTSIDE, cause: "hard_bounce", detail: NODE_SAYS.error, observedAt: AT, eventId: "εωτ_1" }]) },
    "GET /api/matters": {
      matters: list([
        { id: "ματ_1", type: "legal_hold", description: "Διαφορά με προμηθευτή", openedBy: "υσρ_ανα", openedAt: EARLIER, closedAt: null, closedBy: null },
        { id: "ματ_2", type: "security_incident", description: "Κλειστή υπόθεση", openedBy: "υσρ_ανα", openedAt: EARLIER, closedAt: AT, closedBy: "υσρ_ανα" },
      ]),
    },
    "GET /api/holds": {
      holds: list([{ id: "ηλδ_1", matterId: "ματ_1", mailboxId: "μβχ_1", fromDate: EARLIER, toDate: null, placedBy: "υσρ_ανα", placedAt: AT, mailboxExists: true, pendingLift: { liftId: "ηλ_1", approvalId: "απρ_9", requestedBy: "υσρ_βοβ", reason: "Τέλος υπόθεσης" } }]),
    },
    "GET /api/supervised": { supervised: list([{ id: "σγρ_1", subjectId: "υσρ_βοβ", mailboxId: "μβχ_1", scope: "content", matterId: "ματ_1", requestedAt: AT, expiresAt: LATER, grantedAt: AT, live: true }]) },
    "GET /api/exports": {
      exports: list([
        { id: "εχπ_1", matterId: "ματ_1", mailboxId: "μβχ_1", requestedBy: "υσρ_ανα", maxMessages: 1000, state: "completed", stateReason: null, messagesEmitted: 3, requestedAt: AT, completedAt: AT },
        { id: "εχπ_2", matterId: "ματ_1", mailboxId: "μβχ_1", requestedBy: "υσρ_ανα", maxMessages: 1000, state: "aborted", stateReason: NODE_SAYS.error, messagesEmitted: 0, requestedAt: AT, completedAt: null },
      ]),
    },
    "GET /api/exports/εχπ_1/objects/manifest.json": { count: 1, messages: [{ receiptId: "ρψπτ_1", object: "ρψπτ_1.εμλ", bytes: 14_090, sha256: "0123456789" }] },
    "GET /api/butlers/βτλ_2": { butler: { id: "βτλ_2", name: "σε-παύση" }, versions: [] },
    "GET /api/butlers/βτλ_3": { butler: { id: "βτλ_3", name: "νέος" }, versions: [] },
    "GET /api/butlers/βτλ_1": {
      butler: { id: "βτλ_1", name: "απάντηση-σε-πελάτες" },
      versions: [
        { id: "βω_3", version: null, state: "draft", ast_sha256: "0123", source_sha256: "4567", created_by: "υσρ_ανα", created_at: AT, published_by: null, published_at: null, superseded_at: null, source_text: BUTLER_SOURCE, source_format: "json" },
        { id: "βω_2", version: 2, state: "published", ast_sha256: "0123", source_sha256: "4567", created_by: "υσρ_ανα", created_at: AT, published_by: "υσρ_ανα", published_at: AT, superseded_at: null, source_text: BUTLER_SOURCE, source_format: "json" },
      ],
    },
  };
}

/**
 * The Butler this layer actually ships, used by every test in this package.
 *
 * Deliberately §16's worked example **as far as the shipped node set reaches**: mail arrives, a guard drops
 * anything not clean, the case is assigned, a reply is drafted and a send is proposed. §16's `llm.extract`,
 * `case.upsert` with typed fields and `mail.template.render` are absent because all three are reserved, and
 * that gap is the honest shape of what Layer 4 delivers — "assign it and draft a reply", not "assign it and
 * send the standard acknowledgement".
 *
 * A plain object rather than a builder, because a fixture whose shape is computed is a fixture that can
 * drift into agreeing with whatever the code does.
 */
export function leadIntake(): Record<string, unknown> {
  return {
    apiVersion: "mailda/v1",
    kind: "Butler",
    metadata: { name: "sales-enquiries", owner: "team:sales" },
    trigger: { event: "mail.received", mailbox: "enquiries@example.com" },
    entry: "security_guard",
    nodes: [
      {
        id: "security_guard",
        type: "guard",
        when: "${event.security.malware} == \"clean\"",
        then: "assign",
        otherwise: "drop",
      },
      { id: "drop", type: "stop", reason: "not clean" },
      {
        id: "assign",
        type: "case.assign",
        caseId: "${event.case_id}",
        assignee: "${org.rota.on_call}",
        next: "acknowledge",
      },
      {
        id: "acknowledge",
        type: "draft",
        mailboxId: "${event.mailbox_id}",
        to: ["${event.from}"],
        subject: "Re: ${event.subject}",
        body: "Thanks — we have your enquiry and somebody will reply.",
        inReplyTo: "${event.message_id}",
        as: "reply",
        next: "propose",
      },
      { id: "propose", type: "mail.send.propose", draft: "${steps.reply.draft_id}", next: null },
    ],
  };
}

/** The same document with a bounded loop over the recipients of a digest. */
export function withLoop(maxItems: unknown): Record<string, unknown> {
  const ast = leadIntake();
  const nodes = ast["nodes"] as Array<Record<string, unknown>>;
  nodes.push({
    id: "fan_out",
    type: "foreach",
    over: "${steps.reply.recipients}",
    as: "recipient",
    maxItems,
    body: "note_one",
    next: null,
  });
  nodes.push({ id: "note_one", type: "transform", as: "noted", value: "${recipient}", next: null });
  (nodes.find((node) => node["id"] === "propose") as Record<string, unknown>)["next"] = "fan_out";
  return ast;
}

/** Rebuilds a JSON value with every object's keys reversed. Same document, opposite insertion order. */
export function withReversedKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withReversedKeys) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).reverse()) {
      out[key] = withReversedKeys((value as Record<string, unknown>)[key]);
    }
    return out as unknown as T;
  }
  return value;
}

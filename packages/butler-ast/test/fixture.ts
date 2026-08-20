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
    // The pinned ceiling (#51). Exactly the actions this graph needs — `case.assign`, `draft` and
    // `mail.send.propose` each take `send.propose` — because publication refuses both halves of the
    // inequality: an action a node needs and the ceiling omits, and an action the ceiling declares and no
    // node needs.
    capabilities: [{ action: "send.propose", resource: "mailbox:enquiries@example.com" }],
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
        // No `to`. The Node addresses a Butler's reply from the delivery that triggered it (#52).
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

/**
 * The same document with a bounded loop that proposes one send per recipient of a digest.
 *
 * **The body used to be a bare `transform`, and #54 changed it.** That matters enough to say here rather
 * than in a commit message: a `transform` performs no I/O, so a loop over one costs **nothing** in the only
 * currency the affordability pass has a measurement for, and a `maxItems` of a million over a body like that
 * is genuinely affordable. Pinning "a million is refused" on that fixture would have needed an invented
 * per-iteration cost — a number with no receipt, in a file whose whole subject is numbers with receipts.
 *
 * So the fixture became the loop `docs/receipts/butler-step-cost.md` actually does its arithmetic about:
 * *"a foreach of 200 items each proposing a send"*. What is asserted about a million is now asserted about a
 * loop that spends, and what remains true of a loop that spends nothing is asserted separately and on
 * purpose — see `loopOfPureTransforms` and the test that uses it.
 */
export function withLoop(maxItems: unknown): Record<string, unknown> {
  const ast = leadIntake();
  const nodes = ast["nodes"] as Array<Record<string, unknown>>;
  nodes.push({
    id: "fan_out",
    type: "foreach",
    over: "${steps.reply.recipients}",
    as: "recipient",
    maxItems,
    body: "send_one",
    next: null,
  });
  nodes.push({
    id: "send_one",
    type: "mail.send.propose",
    draft: "${steps.reply.draft_id}",
    next: null,
  });
  (nodes.find((node) => node["id"] === "propose") as Record<string, unknown>)["next"] = "fan_out";
  return ast;
}

/**
 * A loop whose body does no I/O at all, at any bound.
 *
 * The honest boundary of the affordability pass, held as a fixture so it is a stated property rather than an
 * accident of which numbers happen to be in the receipts. Subrequests are the one currency with a
 * measurement behind it; CPU cannot be metered from inside a Worker at all
 * (`authz-check-rows-read.md`: `performance.now()` is Spectre-clamped and reported p50 = 1.000 ms for every
 * scenario), so `butler-step-cost.md` records *"which limit binds first, CPU or subrequests, is
 * unestablished"*. A million bindings of a value cost zero subrequests and this pass says so.
 */
export function loopOfPureTransforms(maxItems: unknown): Record<string, unknown> {
  return {
    apiVersion: "mailda/v1",
    kind: "Butler",
    metadata: { name: "count-them", owner: "team:sales" },
    // Empty, and legitimately so: a loop and a transform touch no storage, so this Butler needs no
    // authority at all. Empty is a real ceiling; absent is not representable.
    capabilities: [],
    trigger: { event: "mail.received", mailbox: "enquiries@example.com" },
    entry: "fan_out",
    nodes: [
      {
        id: "fan_out", type: "foreach", over: "${event.recipients}", as: "recipient",
        maxItems, body: "note_one", next: null,
      },
      { id: "note_one", type: "transform", as: "noted", value: "${recipient}", next: null },
    ],
  };
}

/**
 * A chain of `count` cheap nodes and nothing else — no loop, no single expensive node.
 *
 * The case a per-node affordability check would publish and this one refuses, which is the entire reason the
 * receipt's rule says *sum the graph*. `case.close` is the cheapest effect in the shipped set, so if this
 * shape can exhaust a run then any shape can.
 */
export function manyCheapNodes(count: number): Record<string, unknown> {
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `close_${index}`,
    type: "case.close",
    caseId: "${event.case_id}",
    next: index === count - 1 ? null : `close_${index + 1}`,
  }));
  return {
    apiVersion: "mailda/v1",
    kind: "Butler",
    metadata: { name: "tidy-up", owner: "team:sales" },
    capabilities: [{ action: "send.propose", resource: "mailbox:enquiries@example.com" }],
    trigger: { event: "mail.received", mailbox: "enquiries@example.com" },
    entry: "close_0",
    nodes,
  };
}

/**
 * A chain of `count` `case.assign` nodes, priced at 8 each — so 1,250 of them cost the Paid pot **exactly**.
 *
 * The boundary the comparison is made of. `>` and `>=` differ on precisely one input and every other fixture
 * in this file is on one side or the other of it, so without this one the difference between "spends the whole
 * pot" and "spends one more than the pot" is untested. Spending the pot exactly is affordable: the ceiling is
 * where the invocation dies, not where it starts to be at risk, and the per-node headroom that makes 8 a
 * bound rather than the measured 5 is the margin.
 */
export function assignChain(count: number): Record<string, unknown> {
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `assign_${index}`,
    type: "case.assign",
    caseId: "${event.case_id}",
    assignee: "${org.rota.on_call}",
    next: index === count - 1 ? null : `assign_${index + 1}`,
  }));
  return {
    apiVersion: "mailda/v1",
    kind: "Butler",
    metadata: { name: "hand-it-around", owner: "team:sales" },
    capabilities: [{ action: "send.propose", resource: "mailbox:enquiries@example.com" }],
    trigger: { event: "mail.received", mailbox: "enquiries@example.com" },
    entry: "assign_0",
    nodes,
  };
}

/**
 * `depth` loops of `maxItems` each, nested one inside the next, with one `case.close` at the bottom.
 *
 * Exists to overflow on purpose: four loops of a million multiply to 10^24, which is past what a double
 * represents exactly, and a total that silently lost precision would be a wrong number in whichever
 * direction the rounding fell.
 */
export function nestedLoops(depth: number, maxItems: number): Record<string, unknown> {
  const nodes: Array<Record<string, unknown>> = Array.from({ length: depth }, (_, level) => ({
    id: `loop_${level}`,
    type: "foreach",
    over: level === 0 ? "${event.recipients}" : `\${item_${level - 1}.children}`,
    as: `item_${level}`,
    maxItems,
    body: level === depth - 1 ? "close_it" : `loop_${level + 1}`,
    next: null,
  }));
  nodes.push({ id: "close_it", type: "case.close", caseId: "${event.case_id}", next: null });
  return {
    apiVersion: "mailda/v1",
    kind: "Butler",
    metadata: { name: "all-the-way-down", owner: "team:sales" },
    capabilities: [{ action: "send.propose", resource: "mailbox:enquiries@example.com" }],
    trigger: { event: "mail.received", mailbox: "enquiries@example.com" },
    entry: "loop_0",
    nodes,
  };
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

import { ID_PREFIXES } from "@mailda/runtime";
import { CAPABILITIES, heldCapabilities, offerableCapabilities, requiresOf, unsatisfiedCapabilities } from "@mailda/contract/capability";
import { unprocessable } from "../errors.ts";
import { agentFor } from "../agents.ts";
import { agentReach, listAgents, mintAgent, revokeAgent, sponsorReach } from "../agents.ts";
import { principalFor } from "../authz-read.ts";
import { assertAdmin, type MailboxRelation } from "../access.ts";
import { unauthenticated, isId, notFound } from "./support.ts";
import type { Some } from "../router.ts";

export const machine = {
  /**
   * The MCP server (#89, ADR 12).
   *
   * `POST /mcp` — one endpoint, MCP's Streamable HTTP transport, JSON-RPC 2.0 over it.
   *
   * **On this Worker rather than beside it**, which was #89's actual question. A second Worker breaks
   * ADR 18's one-Worker rule and gives ADR 24 a second artifact to keep byte-identical; a separately-run
   * bridge would be the first component in this product holding credentials for a Node it is not part of,
   * which is the shape ADR 7's custody premise exists to rule out. Here, the mail never leaves the Node
   * that holds it and no account resource is added. `src/mcp.ts` carries the full argument and the cost.
   *
   * Authenticated by the caller's own session, deliberately: every act lands in the audit trail under the
   * person who set it going rather than under a machine.
   */
  "POST /mcp": async ({ request, env, clock, reenter }) => {
    const { handleMcp } = await import("../mcp.ts");
    /*
     * The router itself is handed in, so a tool call re-enters it in process. Not `fetch` against this
     * Worker's own origin: that goes back out through the edge, spends a subrequest from a budget this
     * Node counts, and fails outright in workerd. The property the round trip was for — same handler,
     * same guards, same refusals — survives without it.
     */
    /*
     * **Which class of caller**, decided here because this is where the credential is.
     *
     * One catalogue treated every machine alike, and the cost was `POST /api/butlers/:butlerId/simulate`:
     * #87 built the dry run to be offered to machines, its handler requires `org.admin`, and a delegated
     * agent can never hold that — so a single list had to withhold it from the administrator as well.
     *
     * A person's session acts with that person's authority; a delegated credential acts within the ceiling
     * pinned when it was minted. Advertising a tool outside that ceiling teaches a retry loop against a
     * route that will refuse, which is the same defect as offering an `org.admin` tool to an agent.
     *
     * Nothing here authorizes anything. Every tool call re-enters `handler.fetch` and meets `principalFor`,
     * the route's own check and its audit entry — this only decides what the caller is *told* exists.
     */
    /*
     * The same extraction `principalFor` does. Read here rather than returned by it, because a `Principal`
     * deliberately carries no credential — the token is a secret and the principal is the fact derived
     * from it, which is the separation that keeps the token out of every downstream signature.
     */
    const authorization = request.headers.get("authorization");
    const bearer = authorization?.startsWith("Bearer ") === true ? authorization.slice(7) : "";

    const who = await principalFor(env, clock, request);
    const caller = who === null
      ? { kind: "anonymous" as const }
      : who.userId.startsWith(ID_PREFIXES.agent)
        ? {
          kind: "agent" as const,
          ceiling: (await agentFor(env, clock, bearer))?.actions ?? [],
        }
        : { kind: "session" as const };

    return await handleMcp(request, reenter, caller);
  },

  /*
   * Delegated agent principals (#109 L2).
   *
   * Administrator-gated, and the sponsor is a parameter rather than the caller — so the person who
   * authorises a machine identity need not be the person whose authority it borrows. That separation is
   * what supervised grants already have, and it matters here for the same reason: an administrator minting
   * an agent for themselves is one person deciding both halves of a delegation.
   *
   * The token is in the mint's response and nowhere else. Nothing stores it, nothing can produce it again,
   * and there is no route that widens an agent's ceiling afterwards — re-minting is the only way to change
   * what one may do, which is what "pinned" means here.
   */
  "POST /api/agents": async ({ request, env, clock }) => {
    const who = await principalFor(env, clock, request);
    if (who === null) {
      return Response.json(
        { error: "unauthenticated", message: "Sign in to mint an agent.", refreshable: true },
        { status: 401 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as {
      name?: string; sponsorUserId?: string; capabilities?: string[]; lifetimeDays?: number;
      grants?: { mailboxId: string; relation: MailboxRelation }[];
    };
    /*
     * **Administration first.** `mintAgent` opens with `assertAdmin` and says why — minting confers a
     * machine identity that acts on mail — and putting a validation refusal in front of it made an ordinary
     * member's request answer `422 E_AGENT_CAPABILITY_UNSATISFIABLE` instead of the administrator refusal.
     * That tells somebody who may not mint at all how to write a request that would, and it contradicts a
     * rule stated in the file this route calls into. Asserted here rather than left to the call below,
     * because the check underneath it has to run before the mint.
     */
    await assertAdmin(env, who.orgId, who.userId);

    /*
     * Through the product, minting is **one** step, so an empty mailbox list is a mistake rather than a plan.
     *
     * `mintAgent` deliberately allows no grants at all — it is also the building block for the two-step case
     * where an agent is given a relation its sponsor does not hold, which `grants` cannot express. Nothing
     * reaches this route that way: an administrator selecting `mail.read` and no mailbox gets a credential
     * that authenticates and is refused on every route the capability names, and finds out days later
     * through a 403 that reads like a defect in this Node.
     *
     * Same function as the domain check, with `grantsAreComplete` — so the rule has one definition and the
     * two callers differ only in what they know.
     */
    const unmet = unsatisfiedCapabilities(
      CAPABILITIES.filter((one) => (body.capabilities ?? []).includes(one.id)),
      body.grants ?? [],
      { grantsAreComplete: true },
    );
    if (unmet.length > 0) {
      throw unprocessable("E_AGENT_CAPABILITY_UNSATISFIABLE", {
        what: unmet.map((one) => `${one.id} needs ${one.requires.join(" and ")} on one mailbox`).join("; "),
        why: "an agent's authority is its capabilities intersected with its relations, so a capability whose "
          + "relations no single granted mailbox carries is authority it can never exercise",
        fix: "grant every relation the capability needs on at least one mailbox — all of them on the same "
          + "mailbox, because reach is decided per mailbox — or do not select the capability",
      });
    }
    const minted = await mintAgent(env, clock, who.orgId, who.userId, {
      name: body.name ?? "",
      sponsorUserId: body.sponsorUserId ?? who.userId,
      capabilities: body.capabilities ?? [],
      grants: body.grants ?? [],
      ...(body.lifetimeDays === undefined ? {} : { lifetimeDays: body.lifetimeDays }),
    });
    return Response.json({
      /*
       * The **summary** shape, not the bare agent. `agentSummary` carries `held` and `unnamed` — the
       * ceiling read back in capability terms — and returning the narrower object made this success path
       * violate its own strict schema. It went unnoticed because nothing drove it: `schemaCoverage()` proves
       * a route *has* a schema, never that a test executes it.
       */
      /*
       * Reach included, from the same query the list uses rather than from the request body. A mint that
       * echoed back what was asked for would report `effective: true` on every relation by construction —
       * and the sponsor check above means it *is* true at this instant, which makes the echo look right and
       * be a different fact.
       */
      agent: {
        ...minted.agent,
        ...heldCapabilities(minted.agent.actions),
        grants: (await agentReach(env, who.orgId)).get(minted.agent.id) ?? [],
      },
      token: minted.token,
      notice: "This token is shown once and cannot be shown again. It expires on "
        + `${minted.agent.expiresAt} and there is no refresh — re-mint to renew.`,
    });
  },

  /*
   * The vocabulary itself, so a client does not restate it. An interface offering capabilities has to know
   * their names and what each one says, and a copy in the client would be the second place that answer
   * lives — the divergence `packages/contract/src/agent.ts` exists to prevent for the tier question, and
   * the same argument applies here.
   *
   * `operator`, like the three routes below it: a machine reading the list of what machines may be granted
   * is reading a map of how to escalate.
   */
  "GET /api/agent-capabilities": async ({ request, env, clock }) => {
    const who = await principalFor(env, clock, request);
    if (who === null) {
      return Response.json(
        { error: "unauthenticated", message: "Sign in to read the capability list.", refreshable: true },
        { status: 401 },
      );
    }
    await assertAdmin(env, who.orgId, who.userId);
    /*
     * `requires` is **computed** and sent, rather than a field on the literal. The client needs it to warn
     * per capability, and deriving it here keeps the one source in `authority.ts`: a client copy would be
     * the correspondence table this whole layer removed.
     */
    return Response.json({
      capabilities: offerableCapabilities().map((one) => ({ ...one, requires: requiresOf(one) })),
    });
  },

  /*
   * The administrator's resource catalogue for minting: every mailbox, with what the **named sponsor** holds
   * on each. The form used the work-queue rail, which lists mailboxes the *caller* sends from — so a
   * read-only sponsor's mailboxes were unselectable and an administrator could not provision an agent for a
   * mailbox they administer but do not work in.
   */
  "GET /api/people/:userId/mailboxes": async ({ request, env, clock, params }) => {
    if (!isId(ID_PREFIXES.user, params.userId)) return notFound();
    const who = await principalFor(env, clock, request);
    if (who === null) return unauthenticated();
    await assertAdmin(env, who.orgId, who.userId);
    return Response.json({ mailboxes: await sponsorReach(env, who.orgId, params.userId) });
  },

  "GET /api/agents": async ({ request, env, clock }) => {
    const who = await principalFor(env, clock, request);
    if (who === null) {
      return Response.json(
        { error: "unauthenticated", message: "Sign in to list agents.", refreshable: true },
        { status: 401 },
      );
    }
    await assertAdmin(env, who.orgId, who.userId);
    /*
     * The ceiling comes back as capabilities **and** as the routes actually pinned. `heldCapabilities`
     * reports held-of-total rather than a bare name, because an agent minted before a capability grew holds
     * fewer routes than the capability now lists — and a name alone would imply authority the pinned
     * ceiling does not carry and never will.
     */
    const agents = await listAgents(env, who.orgId);
    /*
     * Reach is joined in, with `effective` per relation. The list used to answer capabilities and standing
     * and say nothing about **which mailboxes** — so an access review could not ask the question it exists
     * to ask, and could not see that a sponsor losing access had quietly narrowed an agent.
     */
    const reach = await agentReach(env, who.orgId);
    return Response.json({
      agents: agents.map((agent) => ({
        ...agent,
        ...heldCapabilities(agent.actions),
        grants: reach.get(agent.id) ?? [],
      })),
    });
  },

  /*
   * The id pattern comes from the registry, never written here. `id-prefix-world.test.ts` refused the
   * hand-written alphabet this line first carried — which is the check earning its place for the third
   * time, and the reason it exists: `case_` and `cas_` came to disagree exactly this way.
   */
  "DELETE /api/agents/:agentId": async ({ request, env, clock, params }) => {
    if (!isId(ID_PREFIXES.agent, params.agentId)) return notFound();
    const who = await principalFor(env, clock, request);
    if (who === null) {
      return Response.json(
        { error: "unauthenticated", message: "Sign in to revoke an agent.", refreshable: true },
        { status: 401 },
      );
    }
    await revokeAgent(env, clock, who.orgId, who.userId, params.agentId);
    return Response.json({
      revoked: true,
      // A column rather than a delete, so the trail's references to this id still resolve to a name and a
      // sponsor. An audit entry naming an identifier nothing can explain is a trail that decays.
      message: "Withdrawn. The credential stops working on the next request; the agent's history remains.",
    });
  },
} satisfies Some;

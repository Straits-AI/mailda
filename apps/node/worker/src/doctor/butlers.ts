import { deliveryActivity, isPauseReason, publishedButlerState } from "../butler/pause.ts";
import { type Finding } from "../doctor.ts";
/**
 * Says what a Butler can do here, which since #50 includes **running**.
 *
 * ## What this check was, and why the sentence had to change rather than stay
 *
 * It used to say that a Butler could be published and could not run, because migration 0027 shipped the
 * store and the checker with no engine. `test/node/butler-execution-world.test.ts` existed to make that
 * sentence fail the day an engine landed — the hazard in a permanently-true `detail` is that it stays in the
 * file long after it stops describing the code, and *nothing looks wrong*: the check still runs, still
 * passes, still reads as verified. The engine has landed, so the sentence is rewritten and that test now
 * asserts the opposite absence: that the binding and the class are both present, and that this text no
 * longer claims otherwise.
 *
 * ## Still `report`, still `ok: true`, and still costing nothing
 *
 * It reports how far this layer is built rather than a fault, so it fails on no Node — `sendingEventsConsumer`
 * is the precedent and the argument is the same: a finding that fails on every Node forever is one somebody
 * mutes. And it asks this Node's tables nothing, so it adds no subrequest to `doctor.max_subrequests_per_run`,
 * whose receipt names exactly that as a staleness clause. A count of runs would be evidence and would also be
 * a new fixed-cost query on every run of `doctor`; the gap being reported is a property of the bundle.
 *
 * ## What is still not built, named here because an operator is entitled to the list
 *
 * The capability ceiling at publication, static taint tracking (#52), the run ledger and its four replay
 * modes (#53), simulation, and every trigger except `mail.received`. Two of those are §16 guarantees this
 * Node does not yet keep, and saying so in the report is the difference between a layer that is honest about
 * its edges and one that lets an absence read as a feature.
 */
export function butlerExecutionCheck(): Finding {
  return {
    check: "butler_execution",
    severity: "report",
    // The shape of the bundle and the names of tickets. No organization content, so this survives into the
    // reduced report an unauthenticated locked-out operator sees.
    discloses: "infrastructure",
    ok: true,
    detail:
      "Butlers run on this Node. A published Butler fires when mail arrives at the mailbox its trigger " +
      "names: one generic Workflow interprets the version's frozen AST, and the run's id is the Butler " +
      "version plus the delivery, so the same message cannot start two runs — the platform refuses the " +
      "duplicate. Every effect goes through the same code a person's does, with the **Butler itself** as " +
      "the principal: it holds only the relations an administrator granted to its btl_ id, revoking one " +
      "stops it on the next node, and audit entries name it with actor_kind=butler. A send a Butler " +
      "proposes is sealed awaiting a human release and will not be handed over until somebody who may " +
      "send as that mailbox releases it. Every run leaves a record in butler_runs with one row per effect " +
      "and per refusal. Reserved nodes (llm.*, label, route, archive, quarantine, case.upsert, case.task, " +
      "case.note, connector.*, approval.request, template.render) are refused at publication and refused " +
      "again at run start, so a hand-edited AST cannot execute one. A published version's AST and source " +
      "text are frozen, enforced by database triggers, so the Butler that runs is the exact program that " +
      "was published. A Butler that could not afford to run is also refused: the whole graph is priced " +
      "against one Workflow instance's subrequest pot, which this Node divides at the Workers Paid figure " +
      "of 10,000 because it cannot detect its own plan and ADR 25 requires Paid. On Workers Free the pot " +
      "is 1,000 and every such refusal prints that row too — and the engine re-prices the graph at run " +
      "start with its own overhead added, then meters itself and refuses an effect it cannot afford rather " +
      "than being killed mid-loop. A Butler that re-triggers itself off its own mail is stopped: the run " +
      "record and the manifests it sealed make that chain a join, so a windowed count of self-provoked runs " +
      "latches a pause on the **Butler** — not on a version, so republishing a fixed Butler does not clear " +
      "it — and one administrator resumes it alone with a reason. What is still not built: the capability " +
      "ceiling at publication, static taint tracking (#52), the run ledger and its four replay modes (#53), " +
      "simulation, and every trigger except mail.received.",
  };
}


/**
 * Is a Butler stopped, has one gone quiet, and can the loop detector see anything at all? (#75)
 *
 * ## Three findings, because a paused Butler's observable is **silence**
 *
 * #66's rate breakers gate a *send*, and a gated send is a row somebody can look at. A Butler pause stops a
 * *Butler*, and what that produces is **no runs** — which is exactly what a Butler nothing has triggered
 * produces, and exactly what a Butler whose trigger names a mailbox that was renamed produces. Silence is
 * what `doctor` exists to distinguish from health, so all three questions are asked:
 *
 *   butler_paused           is a human decision — or in this case a machine one — currently stopping a Butler
 *   butler_run_silence      has a published Butler produced no runs while mail was arriving at the address
 *                           its trigger names
 *   butler_loop_detection   can the loop detector fire at all, or is it reading zero because it is blind
 *
 * ## `butler_run_silence` is the hard one, and this is what makes it answerable
 *
 * From `butler_runs` alone, *stopped* and *never triggered* are the same reading — the `no_observations` shape
 * `checkBreakers` names one function up. What separates them is whether **mail arrived at the address the
 * trigger names**, and both halves of that are available: the address is in the frozen AST (parsed, never
 * projected into a column, for `triggerButlers`' reason), and the arrivals are one grouped read of
 * `ingress_receipts`.
 *
 * So the answer is a real one rather than a hedge:
 *
 *   mail arrived after publication, no runs   **degraded** — it should have run and did not
 *   no mail arrived after publication         **report** — nothing has triggered it, which is not a fault
 *   the stored AST will not parse             **degraded** — it can never run, and `triggerButlers` agrees
 *
 * Anchored on `published_at` rather than on a window, deliberately: a window would need a figure for *"how
 * long may a Butler legitimately go without running"*, and a Butler on a quiet mailbox may honestly go a
 * month. Publication is an instant this schema already records.
 *
 * **A paused Butler is excluded from that count**, because its silence is explained and reporting it twice
 * would make the second finding fire on every Node with a pause — a permanent WARN is the muted check
 * `DELIVERY_SILENCE_MS` names three hundred lines up.
 *
 * ## Cost: one statement, two when this Node has a Butler
 *
 * The pause fields, the run counts and both visibility figures are sub-selects on one read of published
 * versions. The delivery activity is a second statement, issued only when that read found something — the
 * mechanism `checkBreakers` uses for its pause listing, and what keeps this whole feature at **+1** on a Node
 * with no Butlers. Measured: `docs/receipts/butler-pause.md`, and `doctor-check-cost.md`'s `stale_when` names
 * "any new fixed-cost check", which this is.
 */
export async function checkButlerPauses(env: Env, orgId: string | null): Promise<Finding[]> {
  if (orgId === null) {
    return [{
      check: "butler_paused",
      severity: "report",
      discloses: "data",
      ok: true,
      detail: "No organization yet, so there are no Butlers to pause.",
    }];
  }

  const report = await publishedButlerState(env, orgId).catch(() => null);
  if (report === null) {
    return [{
      check: "butler_paused",
      severity: "degraded",
      discloses: "infrastructure",
      ok: false,
      detail: "Could not read butler_pauses or butler_versions, so this Node cannot say whether any Butler "
        + "is stopped.",
      fix: "check the migrations_applied finding first",
    }];
  }

  const findings: Finding[] = [];
  const stopped = report.butlers.filter((butler) => butler.paused !== null);

  findings.push({
    check: "butler_paused",
    severity: stopped.length === 0 ? "report" : "degraded",
    discloses: "data",
    ok: stopped.length === 0,
    detail: stopped.length === 0
      ? `${report.butlers.length} published Butler(s), none paused.`
      : stopped.map((butler) =>
        `${butler.butlerName} (${butler.butlerId}) paused since ${butler.paused!.placedAt} `
        + `(${butler.paused!.pauseId}, ${butler.paused!.reason}`
        // A stored reason this build does not declare. Named rather than rendered as though it were
        // understood: a `butler_pauses` row is data, and the row that says a Butler is stopped for a reason
        // nobody can look up is exactly the one an operator must be told about.
        + `${isPauseReason(butler.paused!.reason) ? "" : " — NOT a reason this build declares"}) `
        + `by delivery ${butler.paused!.trippedBy}: "${butler.paused!.detail}"`,
      ).join(" | "),
    ...(stopped.length === 0 ? {} : {
      fix: "these Butlers start no runs, and mail into their mailboxes is arriving unautomated — it is still "
        + "filed, still visible and still answerable by hand, which is why this is degraded rather than "
        + `refuse. One administrator resumes one alone, with a reason: POST /api/butler-pauses/`
        + `${stopped[0]!.paused!.pauseId}/resume with {"reason":"..."}. **Publishing a new version does not `
        + "resume it** — the pause is keyed on the Butler, deliberately, so that fixing a looping Butler and "
        + "deciding it is safe to run again are two separate acts",
    }),
    receipt: "docs/receipts/butler-pause.md",
  });

  if (report.butlers.length === 0) {
    // No Butlers, so no silence to explain and nothing that could loop. The second statement is not issued.
    return findings;
  }

  const activity = await deliveryActivity(env, orgId, earliest(report.butlers)).catch(() => null);
  findings.push(silenceFinding(report.butlers, activity));
  findings.push(loopDetectionFinding(report.visibility));
  return findings;
}


/** The earliest publication among live Butlers: the epoch the delivery scan is bounded by. */
export function earliest(butlers: readonly { publishedAt: string | null }[]): string {
  const dates = butlers.map((butler) => butler.publishedAt).filter((at): at is string => at !== null);
  // No `published_at` anywhere means a hand-written row, since `publishButler` always writes one. The epoch
  // is then the beginning of time rather than now: an unbounded scan is the honest fallback, because a bound
  // of "now" would report every Butler as never triggered.
  return dates.length === 0 ? "0000" : dates.sort()[0]!;
}


/**
 * A published Butler that has produced no runs since it went live, and whether that is a fault.
 *
 * `activity` is `null` when the delivery scan failed, and that is reported rather than assumed benign: the
 * whole point of the second statement is to be the discriminator, so without it the honest answer is *this
 * check cannot tell* and not *nothing is wrong*.
 */
export function silenceFinding(
  butlers: readonly Awaited<ReturnType<typeof publishedButlerState>>["butlers"][number][],
  activity: Awaited<ReturnType<typeof deliveryActivity>> | null,
): Finding {
  if (activity === null) {
    return {
      check: "butler_run_silence",
      severity: "degraded",
      discloses: "infrastructure",
      ok: false,
      detail: "Could not read the deliveries a Butler's trigger would have matched, so this Node cannot tell "
        + "a Butler that stopped running from one nothing has triggered.",
      fix: "check the migrations_applied finding first",
    };
  }

  const lastAt = new Map(activity.map((row) => [row.address, row.lastAt]));
  const quiet: string[] = [];
  const idle: string[] = [];
  const unreadable: string[] = [];

  for (const butler of butlers) {
    // A paused Butler's silence is explained by the finding above, and saying it twice would make this one
    // fail on every Node with a pause — a permanent WARN is a muted check.
    if (butler.paused !== null) continue;
    if (butler.triggerMailbox === null) {
      unreadable.push(`${butler.butlerName} (${butler.versionId})`);
      continue;
    }
    if (butler.runsSincePublished > 0) continue;
    const arrived = lastAt.get(butler.triggerMailbox) ?? null;
    if (arrived !== null && (butler.publishedAt === null || arrived >= butler.publishedAt)) {
      quiet.push(`${butler.butlerName} (${butler.butlerId}) listens on ${butler.triggerMailbox}, which last `
        + `received mail at ${arrived}, and has produced no run since it was published at `
        + `${butler.publishedAt ?? "an unrecorded time"}`);
    } else {
      idle.push(`${butler.butlerName} on ${butler.triggerMailbox}`);
    }
  }

  const broken = [...quiet, ...unreadable.map((one) => `${one}: its stored AST will not parse`)];
  return {
    check: "butler_run_silence",
    severity: broken.length === 0 ? "report" : "degraded",
    discloses: "data",
    ok: broken.length === 0,
    detail: broken.length > 0
      ? broken.join(" | ")
      : idle.length === 0
        ? "Every published Butler has run since it was published."
        : `${idle.length} published Butler(s) have not run, and no mail has arrived at the addresses their `
          + `triggers name since they were published — nothing has triggered them, which is not a fault: `
          + idle.join(", "),
    ...(broken.length === 0 ? {} : {
      fix: "mail arrived at the address these Butlers listen on and no run started, so this is not a quiet "
        + "mailbox. Three causes, in the order they are worth checking: the trigger's mailbox no longer "
        + "matches any address on this Node (compare it against GET /api/mailboxes — the comparison is "
        + "case-insensitive and trimmed and nothing else); the stored AST will not parse, which this detail "
        + "names when it is the cause; or the outbox is not being swept, which the outbox finding above "
        + "reports. GET /api/butler-runs shows what did run",
    }),
    receipt: "docs/receipts/butler-pause.md",
  };
}


/**
 * Can the loop detector fire at all? (#75)
 *
 * `checkBreakers`' `no_observations` reasoning, one layer along and with a different denominator. The causal
 * link the detector counts on is `messages.in_reply_to` matching a manifest this Node authored, so a Node
 * whose correspondents never set `In-Reply-To` — or whose inbound headers do not parse — has a loop detector
 * that reads zero for ever and cannot fire. Reporting that as *"no loops"* is the reassuring-zero failure the
 * whole breaker mechanism exists to refuse.
 *
 * **`degraded` only when there is something that could be looping**, which is the line `checkBreakers` draws
 * with `blind` and for the same reason: `ok: false` on every Node with no threaded inbound would fail on every
 * freshly installed Node for ever, and a finding that always fails is one somebody mutes. A Butler has to have
 * proposed at least one send before an unseen reply to it is possible at all.
 */
export function loopDetectionFinding(visibility: { threadedInbound: number; butlerSends: number }): Finding {
  const armed = visibility.threadedInbound > 0;
  const couldLoop = visibility.butlerSends > 0;
  const blind = !armed && couldLoop;
  return {
    check: "butler_loop_detection",
    severity: blind ? "degraded" : "report",
    discloses: "data",
    ok: !blind,
    detail: armed
      ? `armed=true — ${visibility.threadedInbound} inbound message(s) carry an In-Reply-To this Node can `
        + `read, and Butlers have proposed ${visibility.butlerSends} send(s). A reply to one of those is `
        + "traceable back to it, which is what the detector counts."
      : `armed=false (no_threaded_replies) — no inbound message on this Node carries an In-Reply-To, and `
        + `Butlers have proposed ${visibility.butlerSends} send(s). The loop detector matches an inbound `
        + "In-Reply-To against a manifest this Node authored, so it is reading zero because it cannot see, "
        + "not because there is no loop. It is NOT a clean bill of health.",
    ...(blind ? {
      fix: "a Butler has proposed mail and nothing coming back is threaded, so a reply provoked by that mail "
        + "would be invisible to the loop detector. Check that inbound mail is being parsed at all — a "
        + "message whose headers could not be read carries parse_error and no In-Reply-To — and read "
        + "docs/receipts/butler-pause.md, which records this blindness as the named absence rather than "
        + "pretending the detector is total. What still bounds a runaway Butler meanwhile is the volume "
        + "breaker on its sends and the per-run subrequest guard",
    } : {}),
    receipt: "docs/receipts/butler-pause.md",
  };
}

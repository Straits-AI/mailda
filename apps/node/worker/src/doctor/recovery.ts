import type { Ctx } from "@mailda/runtime";
import { vault } from "../keyvault.ts";
import { escrowState, RESTORE_LEASE_MS } from "../recovery.ts";
import { conflictKey, restoreDetail } from "../restore-detail.ts";
import { type Finding } from "../doctor.ts";
/**
 * Whether this Node's keys can be recovered if its Durable Object storage is lost (#92, ADR 28/29).
 *
 * ## Why this is the finding that matters most on this report
 *
 * `keyvault.ts` calls that storage the crown jewels and says losing it makes every message permanently
 * unreadable. Every other check here reports something recoverable; this one reports whether the
 * *irrecoverable* thing has a way back. It is `degraded` rather than `report` when the escrow is missing,
 * which no other honesty check in this file is — a Node holding mail it cannot recover is not healthy, and
 * calling it healthy is the kind of reassurance this repository keeps finding and removing.
 *
 * ## Stale is a distinct state from absent, and it is the more dangerous one
 *
 * `rotate()` mints a new generation, and objects sealed after it are opened only by that key. An escrow taken
 * before the rotation therefore restores a vault that can read old mail and not new — a **half recovery that
 * reports success**, discovered at the worst possible moment. So the escrow records which generations it
 * carries and this compares them against the vault's own inventory, rather than checking that some codes
 * exist. "Ten codes are present" is exactly the sort of true-and-useless statement a check like this
 * degenerates into.
 */
export async function checkRecoveryEscrow(env: Env, orgId: string | null): Promise<Finding[]> {
  if (orgId === null) return [];
  const [state, inventory] = await Promise.all([
    escrowState(env, orgId),
    vault(env).inventory().catch(() => null),
  ]);

  if (state === null) {
    return [{
      check: "recovery_escrow",
      severity: "degraded",
      discloses: "infrastructure",
      ok: false,
      detail: "No key escrow. This Node's content and credential keys exist **only** in its Durable Object "
        + "storage, so losing that storage makes every message permanently unreadable — which is the "
        + "condition ADR 28 says it does not ship without covering.",
      /*
       * This said there was no route that mints a set for such a Node and recommended migrating to a freshly
       * claimed one. `POST /api/recovery-codes/rotate` exists now, so the remedy was telling an operator to
       * abandon a Node they could have recovered — the most expensive kind of stale sentence, in the finding
       * that fires when everything else has already gone wrong.
       */
      fix: "an administrator can mint a set now: `mailda recovery-codes rotate`, then store the sheet and "
        + "`mailda recovery-codes confirm` one of the codes. Mail already sealed on this Node is covered "
        + "from that moment; nothing recovers content whose keys are lost before the escrow exists, which is "
        + "why the escrow is normally written at claim",
    }];
  }

  const stale = inventory !== null
    && (state.content < inventory.content || state.credential < inventory.credential);

  /*
   * Codes minted before the encoder carried its full 128 bits (audit, ADR 29). `formatCode` emitted one
   * base32 character per source byte, so sixteen random bytes became sixteen characters — 80 bits, not 128.
   *
   * **A hash is one-way, so this cannot be repaired for the operator.** The escrow is opened by the code's
   * plaintext, which this Node has never held; a stronger code means a new escrow, and a new escrow means
   * codes somebody has to write down. So the finding asks, and asks at `degraded` rather than `report`,
   * because a weak code is a live weakness in the one artifact that can decrypt all of an organization's
   * mail and it will not fix itself.
   */
  const weak = state.weak > 0;

  /*
   * A set nobody has proved they hold (0043). Degraded, and it is the finding an operator is most likely to
   * think is pedantic: the rows are there, the hashes are good, the escrow is current. What is missing is any
   * evidence that the plaintext reached a human — and from this Node's side a lost mint response looks
   * exactly like a stored one, which is why it has to be asserted rather than assumed.
   *
   * `confirmed === 0` and not `unconfirmed > 0`, since audit P1-2 let an active sheet outlive a rotation. Two
   * sets can now be present, and an operator holding the active one while a fresh pending one waits is
   * **recoverable** — the older form went degraded on exactly that state, which is the healthy one.
   */
  const unconfirmed = state.confirmed === 0 && state.unredeemed > 0;

  /*
   * **Every code spent**, which reported `ok: false` at severity `report` — and the overall verdict only
   * escalates on a failing `degraded` or `refuse`. So a Node with no remaining way to recover its vault
   * answered `ok` overall, with the honest fix printed underneath where nothing was reading it.
   *
   * `unredeemed > 0` guarded the other three conditions rather than being one, which is how it hid: each of
   * them is about the codes that remain, and the state where none remain has no code to be stale or weak or
   * unconfirmed. It is the worst of the four and it fell through the gap between them.
   */
  const exhausted = state.unredeemed === 0;

  return [{
    check: "recovery_escrow",
    severity: stale || weak || unconfirmed || exhausted ? "degraded" : "report",
    discloses: "data",
    ok: !stale && !weak && !unconfirmed && !exhausted,
    detail: unconfirmed && !weak && !stale
      ? `${state.unredeemed} recovery codes exist and **nobody has confirmed holding one**. The codes are `
        + "returned once by the mint and cannot be produced again, so a response that was lost or a terminal "
        + "that was closed leaves this Node looking exactly as it would if they had been written down. Until "
        + "one is typed back, this organization may have no way to recover its keys and no way to find out "
        + "except during the incident."
      : weak
      ? `${state.weak} of ${state.unredeemed} unspent recovery codes were minted by an encoder that carried `
        + "**80 bits and not the 128 ADR 29 states**: it rendered one base32 character per random byte, so "
        + "sixteen bytes became sixteen characters. These codes open the escrow holding the keys to all of "
        + "this organization's mail. They cannot be upgraded — this Node keeps a hash and never held the "
        + "plaintext — so the remedy is a fresh set."
      : stale
      ? `The escrow carries content generation ${state.content} and credential generation `
        + `${state.credential}; the vault is now at ${inventory.content} and ${inventory.credential}. A `
        + "restore from these codes would recover mail sealed before the rotation and **not** mail sealed "
        + `since — a half recovery that looks like a whole one. ${state.unredeemed} of ${state.total} codes `
        + "are unspent."
      : `${state.unredeemed} of ${state.total} recovery codes unspent, carrying content generation `
        + `${state.content} and credential generation ${state.credential} — current. The codes themselves `
        + "are not here and cannot be: this Node keeps a hash that recognises one and an escrow only the "
        + "code itself opens.",
    ...(unconfirmed && !weak && !stale
      ? { fix: "run `mailda recovery-codes confirm` and type one of the codes. It is compared and not spent, "
          + "so all ten stay usable. If none of them match, the printout is from a replaced set — mint again" }
      : weak
      ? { fix: "mint a fresh set of codes and store them. The old set keeps working until you do, because a "
          + "weak code is still better than no code — but it is the weaker of the two states and this "
          + "finding stays degraded until it is replaced" }
      : stale
      /*
       * The old wording said minting invalidates the previous set immediately. It has not since the sheets
       * gained identities: a **confirmed** sheet survives a rotation until the replacement is confirmed, and
       * an operator following the old sentence would destroy the still-working printout before the new one
       * was proven held — which is the exact loss that change was made to prevent.
       */
      ? { fix: "mint a fresh set, which re-escrows every generation the vault now holds. Store the new sheet, "
          + "confirm one of its codes, and only then destroy the previous one: the old sheet keeps working "
          + "until the new one is confirmed, deliberately" }
      : state.unredeemed === 0
        ? { fix: "every code has been spent, so nothing can restore this vault. Mint a fresh set" }
        : {}),
  }];
}


/**
 * Whether anything can arrive here, and how much of that this Node is able to know (#101).
 *
 * ## Why this finding exists
 *
 * The empty inbox used to say *"This Node is claimed and routing is live."* It concluded that from an empty
 * result set, which establishes neither half. Every way of being broken — Email Routing never enabled, MX
 * records absent or pointing elsewhere, a catch-all aimed at a different Worker, no address configured at
 * all, inbound failing SPF upstream — produces exactly that screen, so somebody would be told the thing
 * works and wait. It is the same defect `planCheck` above describes in its own words: a status derived from
 * nothing, phrased with the confidence of a check.
 *
 * The screen now says only what an empty list means and points here. So this has to be worth arriving at.
 *
 * ## What is knowable from inside, and what is not
 *
 * Two things are provable without leaving the Worker, and both are evidence rather than inference:
 *
 *   - **is there an address at all** — no row in `addresses` means nothing routed here has anywhere to land,
 *     and `email()` rejects an unknown recipient. A Node in that state cannot receive, whatever DNS says.
 *   - **has anything ever arrived** — one `ingress_receipts` row is proof that routing reached this Worker
 *     at least once. It is the only positive evidence available, and it is conclusive as far as it goes.
 *
 * One thing is **not** knowable and this finding says so rather than guessing: whether Email Routing is
 * enabled on the zone and pointing at this Worker *right now*. That lives in the account, needs a token this
 * Node deliberately does not hold (ADR 22, ADR 24), and a Node that has received mail before can have had
 * its routing changed a minute ago. So "has received" is history, not a live status, and the detail is
 * careful to be worded as history.
 *
 * `discloses: "data"` because the counts are derived from an organization's mail (§5C).
 */

/**
 * Key collisions that were never resolved, across **every** restore rather than the latest one.
 *
 * ## Why the latest row cannot answer this
 *
 * `recovery_restore_state` reports the most recent operation, which is right for *"is a restore stuck"* and
 * wrong for *"is any mail permanently unreadable"*. A conflict means the vault already held a different key
 * under a generation the escrow also carried, so the escrowed one was not installed and mail sealed under it
 * stays unreadable — permanently, because two secrets cannot share one generation number.
 *
 * A later clean restore then becomes the newest row and the earlier conflict disappears from the verdict
 * without anything having repaired it. Nothing repaired it; nothing can.
 *
 * So this scans the whole table. It stays degraded until somebody says otherwise, which is deliberate: the
 * remedy is an assessment of what was lost, not a command, and a finding that clears itself when the next
 * operation succeeds is one that will clear itself exactly when an operator stops looking.
 *
 * ## Acknowledgement, which is now built
 *
 * "Stays degraded until somebody says otherwise" was true and there was no way to say otherwise, so it stayed
 * degraded full stop. That is the failure mode of every permanent alarm: an operator who has assessed the loss
 * still sees it every morning, `degraded` stops carrying information, and the next real one is read as the
 * same old noise.
 *
 * `POST /api/recovery/conflicts/:restoreId/acknowledge` records the assessment — who, when, what was examined,
 * what was concluded — and this check reads it. The severity drops to `report`; **`ok` stays false**, because
 * nothing repaired anything and the report must go on saying so. Acknowledged is not healthy.
 *
 * Keyed to the restore *and* the conflicted generations, so acknowledging one collision is not acknowledging
 * whatever that restore is later found to have collided with. A set that has changed since it was assessed
 * reads as unassessed again.
 */
export async function checkRecoveryConflicts(env: Env, orgId: string | null): Promise<Finding[]> {
  if (orgId === null) return [];

  const rows = await env.CATALOG.prepare(
    `SELECT id, started_at, detail FROM recovery_restores
      WHERE org_id = ? AND state = 'completed' ORDER BY started_at`,
  ).bind(orgId).all<{ id: string; started_at: string; detail: string | null }>().catch(() => null);
  if (rows === null) return [];

  const acknowledged = await env.CATALOG.prepare(
    `SELECT restore_id, generations, assessed_by, assessed_at
       FROM recovery_key_conflict_acknowledgements WHERE org_id = ?`,
  ).bind(orgId).all<{ restore_id: string; generations: string; assessed_by: string; assessed_at: string }>()
    .catch(() => null);
  const assessed = new Map(
    (acknowledged?.results ?? []).map((row) => [`${row.restore_id}::${row.generations}`, row]),
  );

  const conflicted = rows.results
    .map((row) => ({ row, carried: restoreDetail(row.detail) }))
    .filter((one) => one.carried.readable && one.carried.conflicted.length > 0)
    /*
     * Keyed on the **generations**, not the restore. Acknowledging one collision is not acknowledging whatever
     * that restore might later be found to have collided with, so a set that has changed since it was assessed
     * reads as unacknowledged again — the fail-closed direction, and the only one that keeps the record
     * meaning what it says.
     */
    .map((one) => ({
      ...one,
      key: `${one.row.id}::${conflictKey(one.carried.conflicted)}`,
    }))
    .map((one) => ({ ...one, ack: assessed.get(one.key) }));

  const unresolved = conflicted.filter((one) => one.ack === undefined);
  const settled = conflicted.filter((one) => one.ack !== undefined);

  const describe = (one: typeof conflicted[number]) =>
    `${one.row.id} (${one.row.started_at}): ${one.carried.conflicted.join(", ")}`;

  /*
   * ## Acknowledged is not healthy, and `ok` stays false to say so
   *
   * The severity drops to `report` — so an assessed collision no longer decides the verdict — and `ok` remains
   * `false`, because nothing repaired anything. Two different secrets still cannot share one generation
   * number, and the mail sealed under that generation is still unreadable.
   *
   * That split is the whole design. A permanent `degraded` nobody can discharge is a warning an operator
   * learns to scroll past, and then the next real one is read as the same old noise; a finding that
   * disappeared on acknowledgement would be a record of a loss that the record no longer mentions. This
   * reports the loss for ever and stops it drowning everything else.
   */
  return [{
    check: "recovery_key_conflicts",
    severity: unresolved.length > 0 ? "degraded" : "report",
    discloses: "infrastructure",
    ok: conflicted.length === 0,
    detail: conflicted.length === 0
      ? "No vault restore on this Node has collided with a live key."
      : [
        unresolved.length === 0
          ? `${settled.length} restore(s) collided with a live key. Every one has been assessed, and every `
            + "collision is still permanent: the loss does not clear, only the alarm does."
          : `${unresolved.length} restore(s) collided with a live key and have not been assessed: `
            + `${unresolved.map(describe).join("; ")}. Two different secrets cannot share one generation `
            + "number, so mail sealed under the escrowed key of that generation stays unreadable. A "
            + "collision against a generation this Node had already sealed under is permanent, and that is "
            + "the only kind recorded since a reserved generation began being adopted instead — an older "
            + "record may clear on the next redemption. `recovery_restore_state` above reports the newest "
            + "operation only, so a later clean restore does not repair this record and must not appear to.",
        ...settled.map((one) =>
          `Assessed: ${describe(one)} — by ${one.ack!.assessed_by} on ${one.ack!.assessed_at}.`
        ),
      ].join(" "),
    ...(unresolved.length === 0 ? {} : {
      /*
       * **This used to say the collision was permanent and that nothing could repair it** (#138). That was
       * true of every collision the vault could produce at the time, and it stopped being true: a generation
       * nothing has ever sealed under is now adopted rather than refused, so a record written before that
       * change may describe a collision a fresh redemption resolves. A collision recorded *since* is against
       * a generation that had already sealed, and that one is permanent.
       *
       * `doctor` cannot tell the two apart from the record — the outcome was stored, the reason was not — so
       * it names the cheap thing to try instead of asserting a loss it cannot confirm. Claiming permanence
       * where a recovery code would have worked is the worse of the two mistakes: it tells somebody holding
       * the remedy not to bother.
       */
      fix: "redeem a recovery code and read this finding again. A generation nothing had sealed under is "
        + "adopted rather than refused, so a collision recorded before that behaviour existed may clear. If "
        + "it does not, the generation had already sealed and the loss is permanent: assess what was under "
        + "it — `evidence_lifecycle` describes the window — and record the outcome with "
        + "POST /api/recovery/conflicts/:restoreId/acknowledge, which does not repair the collision but "
        + "records that somebody established what was lost",
    }),
  }];
}



/**
 * What the last vault restore did, and whether one is stuck.
 *
 * ## Why the escrow check cannot answer this
 *
 * `recovery_escrow` compares **generation numbers**, and the failure that matters most is invisible to a
 * number: lose the vault, let the Node keep working, and `sealingKey` mints a fresh generation 1 with a
 * different secret. The escrow also carries a generation 1. `vault.restore` keeps the live key and reports a
 * conflict — correctly, because the alternative trades newer mail for older — and the inventory still says
 * generation 1. Both sides agree on the number and disagree on the key, so mail sealed before the loss stays
 * unreadable and every count in that finding looks healthy.
 *
 * The evidence is in `recovery_restores.detail.conflicted` and nothing read it. The redemption's *response*
 * carries the conflict, and a lost response is the exact failure the saga was built for — so the durable copy
 * has to be reported, or persisting it bought nothing.
 *
 * ## It stays in the reduced report
 *
 * `runDoctor` answers unauthenticated in a narrowed form, and this belongs in it: the moment an operator most
 * needs to know whether the restore finished is the moment the credential vault is being restored, when
 * signing in is exactly what does not work.
 */
export async function checkRecoveryRestores(env: Env, ctx: Ctx, orgId: string | null): Promise<Finding[]> {
  if (orgId === null) return [];

  const latest = await env.CATALOG.prepare(
    `SELECT id, code_id, state, started_at, settled_at, detail FROM recovery_restores
      WHERE org_id = ? ORDER BY started_at DESC LIMIT 1`,
  ).bind(orgId)
    .first<{
      id: string; code_id: string; state: string; started_at: string; settled_at: string | null;
      detail: string | null;
    }>()
    .catch(() => undefined);

  if (latest === undefined) {
    return [{
      check: "recovery_restore_state",
      severity: "degraded",
      discloses: "infrastructure",
      ok: false,
      detail: "The catalog could not be read, so this report cannot say whether a vault restore is in "
        + "progress or was interrupted.",
      fix: "check the `catalog_reachable` finding in this same report first — this one is downstream of it",
    }];
  }

  if (latest === null) {
    // Never attempted, which is the ordinary state and not a finding to act on.
    return [{
      check: "recovery_restore_state",
      severity: "report",
      discloses: "infrastructure",
      ok: true,
      detail: "No vault restore has been attempted on this Node.",
    }];
  }

  /*
   * The detail is this Node's own JSON and is still parsed defensively: a row written by an older version, or
   * a truncated write, must not turn the whole report into a 500 — `doctor` is what somebody reads when
   * things are already wrong.
   */
  const carried = restoreDetail(latest.detail);
  const conflicted = carried.conflicted;
  const installed = carried.restored;
  if (!carried.readable) {
    return [{
      check: "recovery_restore_state",
      severity: "degraded",
      discloses: "infrastructure",
      ok: false,
      detail: `The last vault restore (${latest.id}) recorded a result this version cannot read. Its state is `
        + `\`${latest.state}\`; what it installed and what collided are not legible from the row.`,
      fix: "read the `recovery.vault_restored` entry for this attempt in the audit trail — the entry carries "
        + "the same outcome and the chain proves it was not edited",
    }];
  }
  const lapsed = latest.state === "started"
    && Date.parse(latest.started_at) <= ctx.now() - RESTORE_LEASE_MS;

  if (latest.state === "started") {
    return [{
      check: "recovery_restore_state",
      severity: lapsed ? "degraded" : "report",
      discloses: "infrastructure",
      ok: !lapsed,
      detail: lapsed
        ? `A vault restore (${latest.id}) began at ${latest.started_at} and never settled. Its reservation `
          + "has lapsed, so the code it used can be redeemed again — the restore is resumable and every step "
          + "of it is idempotent, so running it again resumes rather than repeats."
        : `A vault restore (${latest.id}) is in progress, started at ${latest.started_at}.`,
      ...(lapsed
        ? { fix: "redeem the same recovery code again. It was not spent, because an attempt that does not "
            + "finish must not cost one of ten" }
        : {}),
    }];
  }

  if (latest.state === "failed") {
    return [{
      check: "recovery_restore_state",
      severity: "degraded",
      discloses: "infrastructure",
      ok: false,
      detail: `The last vault restore (${latest.id}) failed after installing ${installed} generation(s)`
        + `${carried.error === undefined ? "" : `: ${carried.error.slice(0, 200)}`}. The code was not spent.`,
      fix: "redeem the same recovery code again — every step is idempotent, so it resumes",
    }];
  }

  /*
   * Completed **with conflicts** is the case this finding exists for, and it is the one that looks healthy
   * everywhere else. A conflict means the vault kept a live key under a generation the escrow also carried
   * with a different secret, so mail sealed under the escrowed one stays unreadable — and the generation
   * numbers, which is all `recovery_escrow` compares, agree.
   */
  return [{
    check: "recovery_restore_state",
    severity: conflicted.length > 0 ? "degraded" : "report",
    discloses: "infrastructure",
    ok: conflicted.length === 0,
    detail: conflicted.length === 0
      ? `The last vault restore (${latest.id}) completed at ${latest.settled_at}, installing ${installed} `
        + "generation(s) with no collisions."
      : `The last vault restore (${latest.id}) completed and **${conflicted.length} generation(s) collided `
        + `with a live key and were not installed**: ${conflicted.join(", ")}. The vault kept the live key, `
        + "which preserves mail sealed since the loss — and mail sealed under the escrowed key of the same "
        + "generation number stays unreadable. Generation counts agree, so the `recovery_escrow` finding "
        + "above cannot see this.",
    ...(conflicted.length === 0 ? {} : {
      fix: "there is no repair for a collision: two different keys cannot share one generation number. Treat "
        + "mail from before the loss as unreadable, and check `evidence_lifecycle` for what that covers",
    }),
  }];
}

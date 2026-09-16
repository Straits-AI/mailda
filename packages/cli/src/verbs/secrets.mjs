import { fail, run, flag, sessionCookie, readSecret } from "../support.mjs";
/* ------------------------------------------------------------------ claim-secret ------------------- */

/**
 * Writes the secret that lets somebody claim this Node, and prints it once.
 *
 * `seedClaimSecret` was documented as *"Called by `mailda deploy`"* and had no caller but its own test, so
 * the install path had no producer at all. This is it. Generated rather than chosen, because a claim secret
 * an operator invents is one they can reuse, and it is the single credential between an unclaimed Node and
 * whoever finds its URL first.
 */
export function claimSecret(argv) {
  process.exit(run("node", [
    "--experimental-strip-types", "scripts/seed-claim-secret.mjs",
    ...(argv.includes("--local") ? ["--local"] : []),
  ]));
}


/* ------------------------------------------------------------------ set-password ------------------- */

/** The existing operator tool, under the name every document already uses. */
export function setPassword(argv) {
  const email = argv[0];
  if (email === undefined) fail("usage: mailda set-password <email>");
  process.exit(run("node", ["--experimental-strip-types", "scripts/set-password.mjs", email]));
}


/**
 * Minting a replacement set of recovery codes, and confirming one landed.
 *
 * ## Why this is a command and not a dashboard button
 *
 * `doctor` tells an operator to "mint a fresh set" — it has since #92, and migration 0042 made it say so to
 * every Node whose codes predate the encoder fix. Until now there was **no supported way to do it**: the mint
 * was reachable from the initial claim and from nothing else, so the instruction named no door.
 *
 * ## Two steps on purpose
 *
 * The plaintext is returned once and cannot be produced again. If that response is lost — a closed terminal,
 * a dropped connection — this Node looks exactly as it would if the codes had been written down: ten rows,
 * good hashes, current escrow. `doctor` would report health over an organization that cannot recover, and it
 * would find out during the incident.
 *
 * So `rotate` prints and `confirm` proves. Confirmation compares a code against its stored hash and does
 * **not** spend it, so all ten stay usable; until it happens, `doctor` holds the finding at degraded.
 *
 * Credentials come from the environment, which is this file's rule throughout: a password on a command line
 * ends up in shell history, and the thing being protected here is the last resort.
 */
export async function recoveryCodes(argv) {
  const action = argv[0];
  if (action !== "rotate" && action !== "confirm" && action !== "redeem") {
    fail("usage: mailda recovery-codes rotate|confirm|redeem --url https://your-node.workers.dev\n"
      + "  rotate   mint ten replacement codes and print them once\n"
      + "  confirm  type one back, proving you hold the set. Compared, never spent\n"
      + "  redeem   spend one to restore this Node's key vault. The disaster path\n"
      + "  why      the codes open the escrow holding this Node's content and credential keys. They are\n"
      + "           shown once, so an unconfirmed set is one nobody can prove reached a human\n"
      + "  fix      set MAILDA_EMAIL and MAILDA_PASSWORD, then pass --url");
  }

  /*
   * **Typed at a prompt, not passed as a flag** (#136), for two reasons and the second is the load-bearing one.
   *
   * This command required `--code` while `redeem`, forty lines up, refuses one — and confirm's leak is the
   * worse of the two. A redeemed code in a shell history is a *spent* code; a confirmed one is live, because
   * confirming deliberately does not spend it. So the command with the gentler verb was the one putting a
   * working key to the escrow into `~/.zsh_history`, a CI log and a `ps` snapshot.
   *
   * And a code a script reads from a file cannot make this assertion at all. Confirmation asserts exactly one
   * thing — that a **person** holds the sheet — and `doctor`'s warning is worded as that: *"nobody has
   * confirmed holding one"*. Automating it clears the warning without the fact becoming true, which is 2b: an
   * assertion that cannot fail. The agent that found this had just rotated a Node's codes and could have
   * cleared its warning from the file it had written, making the Node claim a human held codes no human had
   * read.
   *
   * `--code` is refused **by name** rather than ignored, because somebody has it in a script and a silent
   * behaviour change would leave them with a Node that stays degraded for no stated reason.
   *
   * **Checked here, before anything reaches the network.** It sat inside the `confirm` branch, below a
   * sign-in — so passing `--code` to an unreachable Node reported *sign-in failed* and never mentioned the
   * argument that was actually wrong. A usage error answered after a round trip is a usage error the
   * operator debugs in the wrong place. Above the branch it also covers every verb, which is what
   * `recovery-code-entry.test.ts` says this rule is: not `confirm`'s rule, the function's.
   */
  /*
   * `!== null`, and it read `!== undefined` from the day it was written. `flag` answers **null** for a flag
   * that is absent and never `undefined`, so this fired on every invocation and `confirm` refused
   * unconditionally — including the exact command its own `fix` line told the operator to run.
   *
   * Nothing caught it because every test here is about the *presence* of `--code`, and this guard is what
   * they assert. A refusal that cannot not-happen is AGENTS.md 2b wearing its other face: not an assertion
   * that cannot fail, but a **guard that cannot pass**. `test/node/recovery-confirm-runs.test.ts` runs the
   * command both ways, because the only way to catch this was to take the branch nobody was testing.
   *
   * The consequence was not cosmetic: `recovery_escrow` is ADR 28's shipping precondition, its only remedy
   * is this command, and the command could not be run. A Node could mint an escrow and never confirm it.
   */
  if (flag(argv, "code") !== null) {
    fail("--code is not accepted; the code is typed at a prompt.\n\n"
      + "  why      confirming does not spend the code, so one on a command line is a live key to this\n"
      + "           organization's escrow sitting in shell history — worse than the spent one `redeem`\n"
      + "           already refuses to take that way. And a code a script reads from a file proves nothing\n"
      + "           about a person holding the sheet, which is the only thing confirmation asserts\n"
      + `  fix      mailda recovery-codes ${action} --url <your node>`);
  }

  /*
   * **Redeem is handled before anything else, because it is the one that must work when nothing does** (#134).
   *
   * `POST /api/recovery/redeem` is deliberately unauthenticated: the state it exists for is one where the
   * signing key cannot be unwrapped, so no session can be issued and no administrator can prove they are one.
   * Requiring credentials here would put the door behind the lock it opens — measured during #92's restore
   * drill, where the destination Node answered 500 to every sign-in and its own doctor said
   * `signing_key: E_EVIDENCE_AUTH_FAILED`.
   *
   * It had no interface at all until now: no screen, and no verb here. The only way to spend a code was a
   * hand-written `curl`, for the operation whose entire purpose is to be performed during a disaster by
   * somebody who has lost everything else.
   */
  if (action === "redeem") {
    const origin = (flag(argv, "url") ?? process.env.MAILDA_URL ?? "").replace(/\/$/, "");
    if (origin === "") fail("usage: mailda recovery-codes redeem --url https://your-node.workers.dev");

    // Read from the terminal, never from a flag: the CLI's own rule, and a recovery code in shell history is
    // a recovery code in a backup of the shell history.
    const code = (await readSecret("Recovery code: ")).trim();
    if (code === "") fail("no code entered; nothing was spent.");

    const response = await fetch(`${origin}/api/recovery/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    }).catch((error) => fail(`could not reach ${origin}: ${error.message}`));
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      fail(
        `the Node refused the code (${response.status}).\n\n`
        + `  why      ${body.message ?? body.error ?? "no detail given"}\n`
        + "  fix      each code is single-use, so a code spent earlier will not work twice. Try another\n"
        + "           from the same set — the set that was shown when this Node was claimed.",
      );
    }

    /*
     * **Read what came back before saying what happened** (#138).
     *
     * This printed `the vault is restored` over whatever the body said, and #92's drill answered:
     *
     *     HTTP 200
     *     {"restored":{"content":[],"credential":[]},"conflicted":{"content":[1],"credential":[1]}}
     *
     * Nothing installed, a single-use code spent, and this command called it a restore. A generation the
     * vault already holds under a *different* key cannot take the escrowed one — `redeemForVault` keeps the
     * live key deliberately, because losing newer mail to recover older is the worse trade — and the mail
     * sealed under the escrowed key stays unreadable. That is the moment an operator has to be told, and it
     * was the moment this told them the opposite.
     *
     * Counted rather than described: the sum is what decides which of the three things happened, so a partial
     * restore cannot read as either a success or a failure.
     */
    const installed = (body.restored?.content?.length ?? 0) + (body.restored?.credential?.length ?? 0);
    const collided = (body.conflicted?.content?.length ?? 0) + (body.conflicted?.credential?.length ?? 0);

    const displaced = (body.adopted?.content?.length ?? 0) + (body.adopted?.credential?.length ?? 0);

    if (installed > 0) {
      process.stdout.write(
        `\n   ${installed} key generation(s) installed`
        + (displaced > 0
          ? `, ${displaced} of them replacing a generation this Node had reserved and never sealed under`
          : "")
        + (collided > 0 ? `, and ${collided} could not be — see below` : "") + ".\n\n"
        + "   That code is spent. Run `mailda doctor --url " + origin + "` to see what the Node says now —\n"
        + "   a restored vault should clear the signing-key refusal, and the Node should sign people in again.\n\n",
      );
    }

    if (collided > 0) {
      /*
       * The **Node's** words when it has them, and the decision made from the counts either way.
       *
       * Deciding on `body.notice` alone would make an older Node — one that answers without the field, which
       * is every Node deployed before this — look like a clean restore again, which is the whole defect. And
       * restating the explanation here would give an operator two texts to reconcile during an incident.
       *
       * `fail` rather than a note, even when something was installed: a generation that could not be put back
       * is mail that cannot be read, and an exit code is the only part of this a script notices.
       */
      fail(
        `${collided} escrowed key generation(s) could NOT be installed`
        + (installed === 0 ? " — nothing was restored" : "") + ".\n\n"
        + "  what     content " + JSON.stringify(body.conflicted?.content ?? [])
        + ", credential " + JSON.stringify(body.conflicted?.credential ?? []) + "\n"
        + "  why      " + (typeof body.notice === "string" && body.notice !== ""
          ? body.notice
          : "this Node already holds keys of those generation numbers under a different secret, and one "
            + "number cannot hold both. The code is spent and mail sealed under the escrowed key stays "
            + "unreadable. Another code will not help — all ten carry the same generations")
        + "\n"
        + "  fix      do NOT spend more codes on it. See #138.",
      );
    }

    if (installed === 0) {
      // Neither installed nor collided: a 200 that did nothing at all, which no known path produces.
      fail(
        "the Node answered success and reported no keys at all.\n\n"
        + `  what     ${JSON.stringify(body)}\n`
        + "  why      unknown. A redemption installs generations, collides with them, or refuses — this is\n"
        + "           none of the three, so nothing here will guess which\n"
        + "  fix      `mailda doctor --url " + origin + "` and read `recovery_restore_state`.",
      );
    }
    return;
  }

  const origin = (flag(argv, "url") ?? process.env.MAILDA_URL ?? "").replace(/\/$/, "");
  if (origin === "") fail("pass --url https://your-node.workers.dev, or set MAILDA_URL");

  const email = process.env.MAILDA_EMAIL;
  const password = process.env.MAILDA_PASSWORD;
  if (email === undefined || password === undefined) {
    fail("set MAILDA_EMAIL and MAILDA_PASSWORD\n"
      + "  why      both routes are administrator-only: minting destroys the current set, and confirming\n"
      + "           asserts that a person holds the replacement\n"
      + "  fix      export them, or use the dashboard");
  }

  /*
   * A **cookie**, not a bearer token. `POST /api/auth/login` answers
   * `{signedIn, userId, organizationId, accessExpiresAt}` and sets cookies — it has never returned an
   * `access_token`. This read `(await signIn.json()).access_token`, which is `undefined`, and sent
   * `Authorization: Bearer undefined`, so every one of these routes answered 401. Found by running the
   * command against a real claimed Node; nothing in the suite could see it, because the tests drive the
   * routes directly and never the CLI's own sign-in.
   */
  const cookie = await sessionCookie(origin);
  if (cookie === null) fail("could not sign in — these routes need an administrator.");

  const post = async (path, body) => {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body ?? {}),
    }).catch((error) => fail(`could not reach ${origin}: ${error.message}`));
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      fail(`${path} refused (${response.status})\n  ${payload.what ?? payload.message ?? "no detail"}`);
    }
    return payload;
  };

  if (action === "rotate") {
    const { codes, notice } = await post("/api/recovery-codes/rotate");
    process.stdout.write("\n== ten replacement recovery codes, shown once\n\n");
    for (const code of codes) process.stdout.write(`   ${code}\n`);
    process.stdout.write(`\n${notice}\n\n`);
    /*
     * The next step is printed rather than assumed. An operator who stops here has a Node that reports
     * degraded and codes nothing has verified they hold, which is the state this command pair exists to
     * remove — and it is exactly the state somebody reaches by reading the codes and closing the terminal.
     */
    process.stdout.write("   next: mailda recovery-codes confirm --url " + origin + "\n\n");
    return;
  }

  const typed = (await readSecret("Recovery code: ")).trim();
  if (typed === "") fail("no code entered; nothing was confirmed.");
  const { message } = await post("/api/recovery-codes/confirm", { code: typed });
  process.stdout.write(`\n${message}\n\n`);
}

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../..");

/**
 * Every `mailda` command a document tells an operator to run exists (#92, #103).
 *
 * ## Why a runbook needs this more than other prose
 *
 * A runbook is read once, under pressure, by somebody who cannot check whether it is current. A command that
 * no longer exists fails at the moment its reader has least capacity to work out why — and the failure looks
 * like the *Node* being broken rather than the document being stale.
 *
 * It is also the #103 defect in a new place. The path-reference tripwire catches a comment citing a file that
 * is not there; nothing caught a document citing a **command** that is not there. Both are claims a reader
 * follows and nothing resolves.
 *
 * ## What it does not check
 *
 * The **flags**. `--verify`, `--out`, `--in` are parsed with `argv.includes` and `flag()` rather than a
 * declared schema, so there is no list to compare against and a lexical scan for them would report whatever
 * strings happen to appear in the source. Stated rather than quietly omitted: this checks verbs, and a
 * renamed flag would go unnoticed.
 *
 * The `wrangler` subcommands are not checked either — that needs the network, and a test that shells out to
 * npx is a test that fails on a train. They were confirmed against 4.118.0 by hand when the runbook was
 * written, and `docs/disaster-recovery.md` says which version.
 */

/** The verbs `mailda` dispatches on, read from the CLI rather than restated here. */
function verbs(): string[] {
  const cli = readFileSync(join(ROOT, "packages/cli/src/mailda.mjs"), "utf8");
  const dispatch = cli.slice(cli.indexOf("switch (verb)"));
  expect(dispatch.length, "the CLI's dispatch could not be found").toBeGreaterThan(100);
  return [...dispatch.matchAll(/^\s*case "([a-z-]+)":/gm)].map((one) => one[1] as string);
}

/** Every `mailda <verb>` a document names, with the file it came from. */
function cited(): Array<{ file: string; verb: string }> {
  const found: Array<{ file: string; verb: string }> = [];
  const roots = ["docs", "."];
  const seen = new Set<string>();

  for (const dir of roots) {
    let names: string[] = [];
    try {
      names = readdirSync(join(ROOT, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const path = dir === "." ? name : `${dir}/${name}`;
      if (seen.has(path)) continue;
      seen.add(path);
      const text = readFileSync(join(ROOT, path), "utf8");
      /*
       * Both spellings, and the second is the one that mattered. A mutation renaming a command in the
       * runbook's own code block survived: the pattern was `\bmailda\s+`, and an actual invocation reads
       * `node packages/cli/src/mailda.mjs backup` — after "mailda" comes ".mjs", not a space. So the scan was
       * finding the **prose** mentions and none of the commands an operator copies, which are the only ones
       * that fail at three in the morning.
       *
       * Inside fenced blocks as well as outside, which is the opposite of the path-reference rule and
       * deliberate. A fence there marks an illustrative literal; a fence here is where the instruction is.
       */
      /*
       * `[ \t]` rather than `\s`, because `\s` crosses a newline. A reset block ending one line with the
       * Worker's name — `wrangler queues consumer worker remove mailda-sending-events mailda` — and beginning
       * the next with `pnpm` was reported as `mailda pnpm`, a command nothing dispatches. An invocation is on
       * one line by construction, so matching across a break can only ever be wrong.
       */
      for (const match of text.matchAll(/\bmailda(?:\.mjs)?[ \t]+([a-z][a-z-]+)\b/g)) {
        found.push({ file: path, verb: match[1] as string });
      }
    }
  }
  return found;
}

describe("a document cannot tell an operator to run a command that does not exist", () => {
  it("finds the CLI's verbs, so nothing below passes by comparing against nothing", () => {
    const declared = verbs();
    expect(declared).toContain("backup");
    expect(declared).toContain("verify-evidence");
    expect(declared.length).toBeGreaterThan(6);
  });

  it("finds citations, so nothing below passes by scanning no documents", () => {
    const citations = cited();
    expect(citations.length).toBeGreaterThan(10);
    expect(citations.some((one) => one.file === "docs/disaster-recovery.md")).toBe(true);
  });

  it("names only verbs the CLI dispatches", () => {
    const declared = new Set(verbs());
    /*
     * Two documents describe a **designed** surface rather than instructing anybody, and a command they name
     * may legitimately not exist yet. Exempted by file with the reason, rather than by a heuristic:
     *
     *   - the blueprint sketches thirty-three verbs across its sections, which is what a design document is
     *     for. Requiring them to exist would make the blueprint unwritable ahead of the code, and #92's own
     *     layering is the argument that design precedes implementation here.
     *   - `AGENTS.md` names `mailda butler compile` and `mailda policy set …` as **illustrations of an error
     *     message's shape**, in the section about what a budget failure must say. They are examples of
     *     formatting, not steps.
     *
     * Everything else is in scope: the README, and every operational document under `docs/`. Those instruct.
     *
     * A rule like "ignore anything inside a code block" was considered and rejected — a runbook's commands
     * *are* code blocks, so it would exempt exactly the ones that matter most. That is the opposite of the
     * fencing convention for path references, and the difference is intent: there, a fence marks a literal;
     * here, it marks the instruction.
     */
    const designs = new Set(["Mailda-Full-Engineering-Blueprint.md", "AGENTS.md"]);
    const scanned = cited();
    expect(
      scanned.some((one) => !designs.has(one.file)),
      "every document naming a mailda command is exempt, so this checks nothing",
    ).toBe(true);
    /*
     * And the runbook specifically, by name. Adding it to `designs` would leave the general non-vacuity check
     * above satisfied by the README while exempting the one document this test was written for — a mutation
     * that did exactly that passed.
     */
    expect(
      scanned.some((one) => one.file === "docs/disaster-recovery.md" && !designs.has(one.file)),
      "the runbook is exempt from the check that exists for it",
    ).toBe(true);

    const offending = scanned
      .filter((one) => !designs.has(one.file))
      .filter((one) => !declared.has(one.verb));

    expect(
      offending.map((one) => `${one.file} names \`mailda ${one.verb}\``),
      "a document tells an operator to run a command this CLI does not have. A runbook is read once, under "
        + "pressure, by somebody who cannot tell a stale document from a broken Node.",
    ).toEqual([]);
  });
});

describe("the runbook says what it has not established", () => {
  const runbook = readFileSync(join(ROOT, "docs/disaster-recovery.md"), "utf8");

  it("states that the restore does not complete, and names the reason", () => {
    /*
     * This asserted `has not been run end to end` until the drill ran it end to end (#138). The phrase had to
     * go, and what replaces it guards the same property from the other side: the risk was a runbook reading as
     * *tested* when it was not, and the risk now is one reading as *working* when it does not.
     *
     * It does not work. The redemption answers 200 and installs nothing, because a fresh Node mints its own
     * generation 1 before it can be claimed and the escrow carries generation 1 too. So the escrow has never
     * been installed on any Node, and this document has to say that where somebody reaches it during an
     * incident rather than where a reader might scroll past.
     */
    expect(runbook).toContain("#138");
    expect(runbook).toContain("the escrow has never been installed on any");
    // And the sentence that stops an operator spending the other nine codes on the same answer.
    expect(runbook).toContain("all ten carry the same generations");
  });

  it("splits RTO rather than offering one number", () => {
    /*
     * restore-to-readable is measurable; restore-to-receiving needs DNS propagation, which is not the
     * product's to control. One number covering both would mean whatever the reader assumed — and #92 asks
     * for a measured figure, which makes the distinction the substance rather than a caveat.
     */
    expect(runbook).toContain("restore-to-readable");
    expect(runbook).toContain("restore-to-receiving");
    expect(runbook).toContain("Unmeasured");
  });

  it("says the evidence bytes are not in the backup", () => {
    // The half an operator will assume the backup did. An inventory without the objects restores nothing.
    expect(runbook).toContain("evidence bytes are not in the backup");
  });
});

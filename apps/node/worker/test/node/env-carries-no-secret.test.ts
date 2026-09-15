import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readWranglerConfig } from "./wrangler-world.ts";

/**
 * ADR 22's surviving rule, enforced (#1's implementation audit).
 *
 * ADR 22 was amended twice. What survives both amendments is the half that mattered:
 *
 * > every credential that authorizes an external effect — transport tokens, model API keys, webhook signing
 * > secrets — is a **Secrets Store** binding, never a plaintext Worker secret and never a plain property of
 * > `env`. Access is `await env.NAME.get()` at the moment of use, **so serializing `env` discloses nothing**
 * > and a value has no lifetime beyond the call that needs it.
 *
 * ADR 28 later moved the *store* to Durable Object storage, and the ADR says so: *"The `await env.NAME.get()`
 * rule survives intact and is the part that mattered."*
 *
 * **Nothing enforced it.** An audit of the locked set against the tree found ADR 22 to be the only decision of
 * its kind with no tripwire — honoured by `kek.ts` and `keyvault.ts`, and one `wrangler.jsonc` edit away from
 * silently not being. The failure would be quiet in the worst way: a plaintext secret in `env` is not a
 * broken test or a wrong answer, it is a value that leaks the first time anything serializes the environment
 * — a log line, an error report, a `JSON.stringify` in a debug path.
 *
 * ## Why the generated types are the right thing to scan
 *
 * `worker-configuration.d.ts` is produced by `wrangler types` **from `wrangler.jsonc`**, so it is the one
 * place every binding this Worker will actually receive is enumerated, whatever shape it was declared in. A
 * `vars` entry or a plaintext secret arrives here as a `string`; a Secrets Store binding arrives as
 * `SecretsStoreSecret`, which has `.get()` and no value to read directly.
 *
 * Scanning `wrangler.jsonc` instead would mean re-implementing wrangler's own mapping from config to types,
 * which is the correspondence problem this repository keeps paying for.
 *
 * ## What a primitive in `env` means, and why it fails rather than warns
 *
 * A `string` member is not automatically a secret — it could be innocuous config. But this Node has **no
 * `vars` at all**, deliberately: ADR 24 requires the repository to contain nothing customer-specific, so
 * per-install configuration lives in D1 (`node_claim`, `node_capabilities`) rather than in the bundle. So a
 * primitive appearing here is a new decision either way, and it should be made on purpose with an argument
 * rather than by a config edit nobody reviewed. If a genuinely non-secret `var` is ever wanted, this test is
 * where the exemption gets written down — the same treatment `content-deletion-world.test.ts` gives a
 * `DELETE`.
 */

const GENERATED = join(import.meta.dirname, "../../worker-configuration.d.ts");

/** The binding types this Worker legitimately receives. Anything else has to be argued for here. */
const BINDING_TYPES = [
  "R2Bucket",
  "D1Database",
  "SendEmail",
  "Queue",
  "DurableObjectNamespace",
  "Workflow",
  /*
   * Present in the allowed set even though nothing uses one yet, because it is the shape ADR 22 *names* as
   * correct. A future transport token belongs here: `SecretsStoreSecret` exposes `.get()` and no readable
   * property, which is the rule the ADR states rather than a convention around it.
   */
  "SecretsStoreSecret",
  /*
   * The first member here that is **plain readable data**, so it needs the argument this list asks for rather
   * than a place in it.
   *
   * `WorkerVersionMetadata` is `{ id, tag, timestamp }` describing the deployed version. Nothing in it is a
   * credential, and nothing about it is per-install: Cloudflare populates it from the version being run, so
   * it cannot carry an account id, a token or a customer's configuration — the two things ADR 22 and ADR 24
   * respectively exist to keep off `env`.
   *
   * It is also **deliberately disclosed**. `/api/doctor` returns the id, because `mailda deploy` checks a
   * canary through a version override and has to know which version answered
   * (`docs/receipts/preview-urls-and-durable-objects.md`). Cloudflare's own guidance is the same: return the
   * version id to clients "for faster and more transparent debugging". A value published on purpose is not a
   * value whose serialization is a leak.
   *
   * The rule this does not weaken: a *credential* still has to be a `.get()` binding. This exception is
   * narrow, and it is one type rather than a general tolerance for plain values.
   */
  "WorkerVersionMetadata",
] as const;

/**
 * The members of the base Env interface, as `[name, type]`.
 *
 * Read from `__BaseEnv_Env` specifically. The file also declares `Cloudflare.TestEnv` and an `Env` that
 * extends the base, and scanning all of them would count the same binding three times — which would make the
 * anti-vacuity check below pass on duplicates rather than on real bindings.
 */
function envMembers(): Array<[string, string]> {
  const source = readFileSync(GENERATED, "utf8");
  const start = source.indexOf("interface __BaseEnv_Env {");
  expect(start, "the generated types no longer declare __BaseEnv_Env — re-run `wrangler types`")
    .toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf("\n}", start));
  return [...body.matchAll(/^\s*([A-Za-z_][\w]*)\s*:\s*(.+?);\s*$/gm)].map(
    (match) => [match[1]!, match[2]!.trim()],
  );
}

describe("no credential is a plain property of env (ADR 22)", () => {
  it("finds the bindings, so nothing below passes by scanning nothing", () => {
    const members = envMembers();
    // The five this Node has carried since Layer 5 shipped. A drop below that means the scan lost its subject.
    expect(members.length).toBeGreaterThanOrEqual(5);
    expect(members.map(([name]) => name)).toContain("CATALOG");
    expect(members.map(([name]) => name)).toContain("EVIDENCE");
  });

  it("gives every member a binding type, and never a primitive", () => {
    const offenders = envMembers().filter(
      ([, type]) => !BINDING_TYPES.some((allowed) => type.startsWith(allowed)),
    );
    expect(
      offenders.length === 0 ? null
        : `${offenders.map(([name, type]) => `${name}: ${type}`).join(", ")} — ADR 22 requires every `
          + "credential to be reached with `await env.NAME.get()` so that serializing `env` discloses "
          + "nothing. A plain value here leaks the first time anything stringifies the environment. Use a "
          + "Secrets Store binding, or put per-install configuration in D1 as ADR 24 requires — and if this "
          + "really is innocuous, add it to BINDING_TYPES with the argument.",
    ).toBeNull();
  });

  it("recognises a primitive as an offender, so the check above is live", () => {
    /*
     * Anti-vacuity against the *classifier* rather than the file: the scan can only be trusted if a
     * `string` member would actually be rejected, and the generated file has none to point at.
     */
    const wouldReject = (type: string) => !BINDING_TYPES.some((allowed) => type.startsWith(allowed));
    expect(wouldReject("string")).toBe(true);
    expect(wouldReject("number")).toBe(true);
    // The near-miss that matters: a Secrets Store binding is allowed, a bare secret string is not.
    expect(wouldReject("SecretsStoreSecret")).toBe(false);
    expect(wouldReject("R2Bucket")).toBe(false);
  });

  /**
   * Every `vars` entry this config may declare, and why each is not a credential.
   *
   * **This used to assert there were none at all**, on the argument that zero `vars` is what makes adding a
   * primitive a deliberate decision. A `vars` block appeared (#163 L2) and the check did precisely what its
   * own comment promised: it made somebody read the reasoning before the value shipped.
   *
   * Revisited, and the conclusion is narrower rather than weaker. ADR 22 is about **credentials** — a plain
   * value leaks the first time anything stringifies `env`. That argument has no force against a value that
   * is already public, and it has full force against anything else. So the rule is now an allowlist with an
   * argument per entry, and an unlisted var fails exactly as a secret would have.
   */
  const ALLOWED_VARS: Record<string, string> = {
    WORKER_NAME:
      "the Worker's own name, which is public by construction — it is in the hostname every request "
      + "arrives on. A Worker is not told its name, and `onboardReceiving` must name itself as an Email "
      + "Routing rule's destination; a rule naming the wrong Node hands it somebody else's mail. Nothing "
      + "is disclosed by serializing it that the URL does not already say.",
  };

  it("declares no var that is not on the allowlist, with its argument", () => {
    const config = readWranglerConfig();
    const scopes: Array<[string, unknown]> = [
      ["top level", config.vars],
      ...Object.entries((config.env ?? {}) as Record<string, { vars?: unknown }>)
        .map(([name, scope]) => [`env.${name}`, scope?.vars] as [string, unknown]),
    ];

    const offenders: string[] = [];
    for (const [where, block] of scopes) {
      if (block === undefined) continue;
      for (const name of Object.keys(block as Record<string, unknown>)) {
        if (!(name in ALLOWED_VARS)) offenders.push(`${where}: ${name}`);
      }
    }

    expect(
      offenders.length === 0 ? null
        : `${offenders.join(", ")} — a \`vars\` entry is a plain property of \`env\` and leaks the first `
          + "time anything stringifies it. ADR 22 requires a credential to be reached with "
          + "`await env.NAME.get()`. If this value really is public, add it to ALLOWED_VARS with the "
          + "argument for why — the list is the decision, not a formality.",
    ).toBeNull();
  });

  it("rejects a var that is not on the list, so the allowlist is not decoration", () => {
    // Anti-vacuity against the rule itself: the check is only worth having if an unlisted name fails.
    expect("WORKER_NAME" in ALLOWED_VARS).toBe(true);
    expect("MAILDA_API_TOKEN" in ALLOWED_VARS).toBe(false);
    expect("CLOUDFLARE_API_KEY" in ALLOWED_VARS).toBe(false);
  });
});

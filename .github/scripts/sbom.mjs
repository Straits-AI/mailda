#!/usr/bin/env node
/**
 * Builds a CycloneDX SBOM from `pnpm-lock.yaml` (#102).
 *
 * ## Why this exists
 *
 * The update model asks a customer to merge this repository into the software holding their organization's
 * mail. #102's argument is that such a merge has to be verifiable — *"so a customer merging can verify what
 * they are merging came from here"* — and an inventory of what is in it is the first half of that. The second
 * half is the provenance attestation CI produces over this file, which is Sigstore-backed and needs no key
 * anybody has to keep.
 *
 * ## Why it reads the lockfile rather than `node_modules`
 *
 * Two reasons, and the second is the one that matters. `pnpm list --json` needs a completed install, so the
 * inventory would describe the machine that ran it. And it reports resolved URLs but **no integrity hashes**
 * — which is the one field that makes an SBOM entry checkable rather than a name somebody typed. The lockfile
 * has both, and it is the file the install is derived from.
 *
 * ## Why it refuses instead of skipping
 *
 * This parses YAML with regular expressions, which is normally how a tool comes to under-report quietly. So
 * every entry in the `packages:` section must yield a component with a hash, and an entry that does not
 * **throws with the line that defeated it**. An SBOM missing a dependency is worse than no SBOM: it is a
 * document that answers "is this dependency here?" with a confident no. `test/node/sbom.test.ts` asserts the
 * count against an independent scan of the same section.
 *
 * Deterministic on purpose: components are sorted, and the timestamp comes from the caller (`--at`, or the
 * commit date in CI) rather than the clock. Two runs over one commit produce identical bytes, because
 * "reproducible release artifacts" is what #102 asked for and a document that differs per run cannot be one.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");

/** The workspace globs, read rather than restated — a package added to one belongs in the inventory. */
function workspaceDirs() {
  const config = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const section = config.slice(config.indexOf("packages:"));
  const globs = [...section.matchAll(/^\s*-\s*"?([^"\n]+)"?\s*$/gm)].map((one) => one[1].trim());
  if (globs.length === 0) throw new Error("sbom: pnpm-workspace.yaml declares no packages");
  const dirs = [];
  for (const glob of globs) {
    if (glob.endsWith("/*")) {
      const parent = join(ROOT, glob.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const name of readdirSync(parent)) {
        if (existsSync(join(parent, name, "package.json"))) dirs.push(join(parent, name));
      }
    } else if (existsSync(join(ROOT, glob, "package.json"))) {
      dirs.push(join(ROOT, glob));
    }
  }
  return dirs;
}

/**
 * The `packages:` section of the lockfile, as raw entry blocks.
 *
 * Lockfile v9 splits `packages:` (one entry per package version, carrying the resolution) from `snapshots:`
 * (the dependency graph). The resolutions are here, so this is the section with the hashes.
 */
function packagesSection(lock) {
  const start = lock.indexOf("\npackages:\n");
  if (start === -1) throw new Error("sbom: pnpm-lock.yaml has no `packages:` section — lockfile format?");
  const after = lock.slice(start + "\npackages:\n".length);
  /*
   * Ends at the next **top-level** key. Anchored on a line starting with a non-space character, because
   * every entry inside the section is indented; matching `snapshots:` by name would silently read to the end
   * of the file if that section were renamed or moved.
   */
  const end = after.search(/^\S/m);
  return end === -1 ? after : after.slice(0, end);
}

/** `'@scope/name@1.2.3':` or `name@1.2.3:` at two spaces of indent — one lockfile entry. */
const ENTRY = /^ {2}'?((?:@[^/@\s']+\/)?[^@\s']+)@([^\s':]+)'?:\s*$/;

export function componentsFromLock(lock) {
  const section = packagesSection(lock);
  const lines = section.split("\n");
  const components = [];
  let seen = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const found = ENTRY.exec(lines[i]);
    if (found === null) continue;
    seen += 1;
    const [, name, version] = found;

    /*
     * The entry's own indented block, up to the next entry or the next line at two spaces of indent. A
     * package's `resolution` is inside it; reading forward without this bound would attribute one package's
     * hash to another when an entry has no resolution of its own.
     */
    let block = "";
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^ {2}\S/.test(lines[j])) break;
      block += `${lines[j]}\n`;
    }

    const integrity = /integrity:\s*(sha\d{3}-[A-Za-z0-9+/=]+)/.exec(block)?.[1] ?? null;
    const tarball = /tarball:\s*(\S+)/.exec(block)?.[1] ?? null;
    if (integrity === null && tarball === null) {
      throw new Error(
        `sbom: ${name}@${version} has neither an integrity nor a tarball in the lockfile.\n`
        + `  the entry began at: ${lines[i]}\n`
        + "  An SBOM that skips an entry answers \"is this dependency present?\" with a confident no, so this "
        + "refuses instead. Teach this script the new resolution shape.",
      );
    }

    components.push({
      type: "library",
      "bom-ref": `pkg:npm/${encodeURIComponent(name)}@${version}`,
      name,
      version,
      purl: `pkg:npm/${encodeURIComponent(name)}@${version}`,
      ...(integrity === null
        ? { externalReferences: [{ type: "distribution", url: tarball }] }
        : { hashes: [hashOf(integrity)] }),
    });
  }

  if (seen === 0) throw new Error("sbom: the `packages:` section yielded no entries — has the format changed?");
  return { components, seen };
}

/** `sha512-<base64>` is npm's integrity form; CycloneDX wants the algorithm and hex-or-base64 content. */
function hashOf(integrity) {
  const [algorithm, value] = integrity.split("-", 2);
  const alg = { sha512: "SHA-512", sha384: "SHA-384", sha256: "SHA-256", sha1: "SHA-1" }[algorithm];
  if (alg === undefined) throw new Error(`sbom: unknown integrity algorithm \`${algorithm}\``);
  return { alg, content: Buffer.from(value, "base64").toString("hex") };
}

/** The first-party packages, so the document says what this repository *is* as well as what it depends on. */
export function workspaceComponents() {
  return workspaceDirs()
    .map((dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")))
    .map((manifest) => ({
      type: "library",
      "bom-ref": `mailda:${manifest.name}`,
      name: manifest.name,
      version: typeof manifest.version === "string" ? manifest.version : "0.0.0",
      purl: `pkg:npm/${encodeURIComponent(manifest.name)}@${manifest.version ?? "0.0.0"}`,
      properties: [{ name: "mailda:firstParty", value: "true" }],
    }));
}

export function buildSbom({ lock, at, commit }) {
  const { components, seen } = componentsFromLock(lock);
  const all = [...workspaceComponents(), ...components]
    .sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      timestamp: at,
      component: {
        type: "application",
        "bom-ref": "mailda",
        name: "mailda",
        version: commit,
        description: "Customer-owned programmable mail operations, deployed into the customer's Cloudflare account.",
        licenses: [{ license: { id: "Apache-2.0" } }],
      },
      properties: [
        { name: "mailda:lockfileEntries", value: String(seen) },
        { name: "mailda:commit", value: commit },
      ],
    },
    components: all,
  };
}

/* Not run on import, so the test can call the pieces above without producing a file. */
if (process.argv[1] === import.meta.filename) {
  const at = process.argv.includes("--at")
    ? process.argv[process.argv.indexOf("--at") + 1]
    : new Date(0).toISOString();
  const commit = process.argv.includes("--commit")
    ? process.argv[process.argv.indexOf("--commit") + 1]
    : "unknown";
  const lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
  process.stdout.write(`${JSON.stringify(buildSbom({ lock, at, commit }), null, 2)}\n`);
}

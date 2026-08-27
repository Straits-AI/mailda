import m0001 from "../migrations/0001_init.sql";
import m0002 from "../migrations/0002_message_metadata.sql";
import m0003 from "../migrations/0003_ingress.sql";
import m0004 from "../migrations/0004_auth.sql";
import m0005 from "../migrations/0005_key_generation.sql";
import m0006 from "../migrations/0006_threading.sql";
import m0007 from "../migrations/0007_outbound.sql";
import m0008 from "../migrations/0008_audit.sql";
import m0009 from "../migrations/0009_send_authorization.sql";
import m0010 from "../migrations/0010_send_recipients.sql";
import m0011 from "../migrations/0011_per_recipient_submission.sql";
import m0012 from "../migrations/0012_drafts.sql";
import m0013 from "../migrations/0013_delivery_is_the_unit.sql";
import m0014 from "../migrations/0014_conversations_and_cases.sql";
import m0015 from "../migrations/0015_org_admin.sql";
import m0016 from "../migrations/0016_backfill_conversations_and_cases.sql";
import m0017 from "../migrations/0017_first_response_clock.sql";
import m0018 from "../migrations/0018_legal_hold.sql";
import m0019 from "../migrations/0019_policy.sql";
import m0020 from "../migrations/0020_approvals.sql";
import m0021 from "../migrations/0021_hold_lift.sql";
import m0022 from "../migrations/0022_approval_expiry.sql";
import m0023 from "../migrations/0023_supervised_read.sql";
import m0024 from "../migrations/0024_supervised_acts_and_notices.sql";
import m0025 from "../migrations/0025_ediscovery_export.sql";
import m0026 from "../migrations/0026_send_breakers.sql";
import m0027 from "../migrations/0027_butlers.sql";
import m0028 from "../migrations/0028_butler_runs.sql";
import m0029 from "../migrations/0029_butler_pauses.sql";
import m0030 from "../migrations/0030_run_ledger.sql";
import m0031 from "../migrations/0031_butler_sponsor.sql";
import m0032 from "../migrations/0032_teams.sql";
import m0033 from "../migrations/0033_one_live_butler_version.sql";
import m0034 from "../migrations/0034_invitations.sql";
import m0035 from "../migrations/0035_butler_source_format.sql";
import m0036 from "../migrations/0036_sending_transport.sql";
import m0037 from "../migrations/0037_passkeys.sql";
import m0038 from "../migrations/0038_inbox_page_order.sql";
import m0039 from "../migrations/0039_recovery_codes.sql";
import m0040 from "../migrations/0040_message_search.sql";

import { statementsOf } from "./sql-statements.ts";

/**
 * The Node applies its own schema.
 *
 * ## Why this exists at all
 *
 * `wrangler deploy` provisions the D1 database and does not migrate it. A real Deploy to Cloudflare
 * install therefore finished with a green build, one table, and every request answering 500 — because
 * Cloudflare ran `npx wrangler deploy` rather than this repository's `deploy` script (receipt:
 * `deploy-button-install.md`). Depending on somebody else's script detection to produce a working mail
 * server is not a design; it is a hope with a 500 attached.
 *
 * The alternatives were a documented post-install command — which turns §5A's one resumable setup state
 * into "and now open a terminal", for a persona who was handed a checklist rather than a shell — and
 * fixing the detection, which leaves the failure one heuristic change away from returning. Making the
 * schema the Node's own responsibility is the only answer that holds on **every** install path,
 * including ones that do not exist yet.
 *
 * ## Compatible with wrangler, not parallel to it
 *
 * This writes the **same ledger** `wrangler d1 migrations apply` uses:
 *
 *     d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP …)
 *
 * so a Node migrated by the CLI and one that migrated itself agree about what has been applied, in
 * either order. A second private ledger would have been easier and would have made `wrangler d1
 * migrations apply` re-run everything on a self-migrated Node.
 *
 * ## `name TEXT UNIQUE` is the lock
 *
 * Two isolates can reach this at once. Neither takes a lease and there is no Durable Object on the
 * path: both attempt the same migration, and the UNIQUE name means the database settles it — one insert
 * wins, the loser sees a constraint violation and treats it as "already applied", which it is. That is
 * #9's shape, the same one the audit chain and the outbox use: the conflict *is* the signal.
 *
 * ## Each migration is one transaction
 *
 * Statements are applied through `batch()`, which D1 runs as a single transaction — asserted rather
 * than assumed in `test/audit.test.ts`. The ledger insert rides in the *same* batch as the DDL it
 * records, so a migration cannot be applied without being recorded or recorded without being applied.
 * `wrangler`'s own applier does not offer that; a half-applied migration here is not representable.
 */

/**
 * Every migration, in order, bundled as text.
 *
 * Listed explicitly because a Worker cannot glob a directory — and that turns out to be the better
 * shape anyway: `test/node/schema-tables.test.ts` fails when this list and `migrations/` disagree, so
 * an unlisted migration cannot ship silently. `.sql` arrives as text through wrangler's default Text
 * rule, which `wrangler.jsonc` deliberately keeps via `fallthrough`.
 */
const MIGRATIONS: ReadonlyArray<{ name: string; sql: string }> = [
  { name: "0001_init.sql", sql: m0001 },
  { name: "0002_message_metadata.sql", sql: m0002 },
  { name: "0003_ingress.sql", sql: m0003 },
  { name: "0004_auth.sql", sql: m0004 },
  { name: "0005_key_generation.sql", sql: m0005 },
  { name: "0006_threading.sql", sql: m0006 },
  { name: "0007_outbound.sql", sql: m0007 },
  { name: "0008_audit.sql", sql: m0008 },
  { name: "0009_send_authorization.sql", sql: m0009 },
  { name: "0010_send_recipients.sql", sql: m0010 },
  { name: "0011_per_recipient_submission.sql", sql: m0011 },
  { name: "0012_drafts.sql", sql: m0012 },
  { name: "0013_delivery_is_the_unit.sql", sql: m0013 },
  { name: "0014_conversations_and_cases.sql", sql: m0014 },
  { name: "0015_org_admin.sql", sql: m0015 },
  { name: "0016_backfill_conversations_and_cases.sql", sql: m0016 },
  { name: "0017_first_response_clock.sql", sql: m0017 },
  { name: "0018_legal_hold.sql", sql: m0018 },
  { name: "0019_policy.sql", sql: m0019 },
  { name: "0020_approvals.sql", sql: m0020 },
  { name: "0021_hold_lift.sql", sql: m0021 },
  { name: "0022_approval_expiry.sql", sql: m0022 },
  { name: "0023_supervised_read.sql", sql: m0023 },
  { name: "0024_supervised_acts_and_notices.sql", sql: m0024 },
  { name: "0025_ediscovery_export.sql", sql: m0025 },
  { name: "0026_send_breakers.sql", sql: m0026 },
  { name: "0027_butlers.sql", sql: m0027 },
  { name: "0028_butler_runs.sql", sql: m0028 },
  { name: "0029_butler_pauses.sql", sql: m0029 },
  { name: "0030_run_ledger.sql", sql: m0030 },
  { name: "0031_butler_sponsor.sql", sql: m0031 },
  { name: "0032_teams.sql", sql: m0032 },
  { name: "0033_one_live_butler_version.sql", sql: m0033 },
  { name: "0034_invitations.sql", sql: m0034 },
  { name: "0035_butler_source_format.sql", sql: m0035 },
  { name: "0036_sending_transport.sql", sql: m0036 },
  { name: "0037_passkeys.sql", sql: m0037 },
  { name: "0038_inbox_page_order.sql", sql: m0038 },
  { name: "0039_recovery_codes.sql", sql: m0039 },
  { name: "0040_message_search.sql", sql: m0040 },
];

/** Wrangler's ledger, created exactly as wrangler creates it so the two cannot disagree. */
const LEDGER = `CREATE TABLE IF NOT EXISTS d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

export interface MigrationOutcome {
  /** Names applied by this call. Empty when the schema was already current. */
  applied: string[];
  /** Names another writer applied while this call was running. Not an error — see the header. */
  raced: string[];
  alreadyCurrent: boolean;
}

function isAlreadyApplied(error: unknown): boolean {
  // Named to d1_migrations on purpose: a UNIQUE violation from the migration's own DDL is a real
  // failure, and swallowing it would mark a broken migration as applied.
  return /UNIQUE constraint failed:\s*d1_migrations/i.test((error as Error).message ?? "");
}

/**
 * Applies whatever is missing. Safe to call concurrently, and safe to call on a current Node.
 *
 * Cheap when there is nothing to do: one query to read the ledger, then nothing.
 */
export async function migrate(env: Env): Promise<MigrationOutcome> {
  await env.CATALOG.prepare(LEDGER).run();

  const done = await env.CATALOG.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
  const applied = new Set(done.results.map((row) => row.name));

  const outcome: MigrationOutcome = { applied: [], raced: [], alreadyCurrent: true };

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    outcome.alreadyCurrent = false;

    // The ledger insert goes **first**, and that ordering is the lock rather than bookkeeping.
    //
    // It was last, which looked fine and lost the race: with the DDL ahead of it, the loser's
    // `CREATE TABLE` failed with "table already exists" before the insert was ever reached, so the
    // conflict arrived as an unrecognisable error instead of the UNIQUE violation the retry logic
    // reads. Putting the insert first makes claiming the name the first thing that happens, so the
    // loser fails on `UNIQUE constraint failed: d1_migrations.name` — which is exactly the signal
    // meaning "somebody else has this". Same lesson as the audit gate: a statement that guards the
    // others has to precede them.
    //
    // Still one transaction, so a migration cannot be recorded without being applied: if any statement
    // below fails, the ledger row rolls back with it.
    const statements = [
      env.CATALOG.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(migration.name),
      ...statementsOf(migration.sql).map((sql) => env.CATALOG.prepare(sql)),
    ];

    try {
      await env.CATALOG.batch(statements);
      outcome.applied.push(migration.name);
    } catch (error) {
      if (!isAlreadyApplied(error)) {
        // Deliberately not swallowed. A migration that cannot be applied must stop the run rather than
        // leave later migrations to fail against a schema that is missing what they depend on.
        throw new Error(
          `E_MIGRATION_FAILED  ${migration.name} could not be applied\n` +
            `  why      ${(error as Error).message.split("\\n")[0]}\n` +
            `  state    nothing from this migration was committed; D1 runs a batch as one transaction\n` +
            `  fix      apply it by hand with \`wrangler d1 execute CATALOG --remote --file ` +
            `migrations/${migration.name}\` to see the failing statement`,
        );
      }
      outcome.raced.push(migration.name);
    }
  }

  return outcome;
}

/** The names this Node expects to have applied. Used by `doctor` to say how far behind a schema is. */
export function migrationNames(): string[] {
  return MIGRATIONS.map((migration) => migration.name);
}

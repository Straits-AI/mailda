import { describe, expect, it } from "vitest";

import { BUDGETS, BUDGET_ORIGINS } from "@mailda/budgets";

/**
 * Does every budget figure whose size depends on the customer's Cloudflare plan say which plan in its name?
 *
 * ## Why this is a test and not a review habit
 *
 * Three times now a plan-conditional figure has shipped under a name with no plan in it, and all three were
 * caught by a human noticing a name:
 *
 * | figure | what the unnamed plan cost |
 * |---|---|
 * | `d1.*.max_queries_per_invocation` | the subrequest ceiling restated under a D1 name; the changelog that withdrew it did not look relevant, so it sat wrong for six months (`d1-platform-limits.md`) |
 * | `doctor.max_subrequests` | `doctor` printed **1,000** to operators for six months after Cloudflare moved it to 10,000, then printed 10,000 to an operator who might be on Free (`doctor-check-cost.md`) |
 * | `workflow.subrequest_budget_per_instance` | `butler-step-cost.md` derived "10,000 / 20 = 500 sends exhausts a run" from the Paid figure; on Free it is 50, and the rule was to become a publication-time refusal (#68) |
 *
 * A reviewer noticing a name is not a mechanism. This file is the mechanism, and the fourth instance —
 * `cron.trigger_ceiling_per_account`, the Paid column of a table whose Free column reads 5 — was found by it
 * rather than by a person, which is the whole argument for having it.
 *
 * ## The rule, and why it is defensible
 *
 * A figure is **plan-scoped** when the provider's number for the thing it names is different on Workers Free
 * than on Workers Paid, *or* the thing exists on only one of the two plans. Plan-scoped figures must name
 * their plan; everything else must not, because a plan in the name of a figure the plan does not touch is the
 * same overclaim pointing the other way (AGENTS.md §4).
 *
 * Whether a given figure is plan-scoped cannot be derived from its name, its value, or its receipt's `kind` —
 * `doctor.max_subrequests` was a platform ceiling living in a `measured-tripwire` receipt, which is exactly
 * how it escaped. So it is **declared**, one entry per figure, in `FIGURES` below. What is *enforced* is
 * everything around the declaration:
 *
 * - every budget in `BUDGETS` is classified, and every classification still describes a live budget, so the
 *   registry cannot silently go stale — that was #71's defect, and `test/node/wrangler-world.ts` is the shape
 *   this repository now prefers for a closed world;
 * - a plan-scoped figure's name carries a plan segment, and a figure that is not plan-scoped carries none;
 * - a `derived` figure names the live budgets it was computed from, so a figure derived from a plan-scoped
 *   ceiling cannot lose sight of which plan's ceiling it divided;
 * - a figure recorded under a second name in another receipt is **pinned equal to it, per plan**, so the
 *   restatement that hid the withdrawn subrequest cap cannot drift again.
 *
 * The per-figure `ground` and `why` are human judgements and this file cannot check them — a reader who
 * wants to know whether Cloudflare really publishes one figure for both plans has to read the receipt named
 * in the failure message. **That is stated rather than glossed:** what a test can hold is the shape, the
 * coverage and the arithmetic between figures, and it holds all three.
 *
 * ## The identity of a figure is its name with the plan taken out
 *
 * `d1.paid.max_queries_per_invocation` and `d1.free.max_queries_per_invocation` are two names for one
 * figure, so they share one entry, keyed `d1.max_queries_per_invocation`. This is what makes the check bite
 * rather than shrug: renaming a plan-named key to drop its plan lands on the **same** entry and fails the
 * naming rule, instead of arriving as an unknown key and failing as a paperwork error.
 */

/** A dotted segment that names a plan, and the plan it names. `freeplan.*` is the free-plan probe's namespace. */
const PLAN_SEGMENTS: Record<string, string> = {
  paid: "Workers Paid",
  free: "Workers Free",
  freeplan: "Workers Free",
};

type Ground =
  /** Measured from Mailda's own code, build output or corpus. The customer's plan is not an input to it. */
  | "mailda"
  /** A provider figure or behaviour recorded as one number for both plans. */
  | "single_figure"
  /** A provider figure that differs by plan, or exists on one plan only. Must name its plan. */
  | "plan_scoped"
  /** Computed by Mailda from other budgets. Names them, so an inherited plan stays visible. */
  | "derived";

interface Classification {
  readonly ground: Ground;
  /** The evidence for the ground: what the source says, or why the plan is not an input. */
  readonly why: string;
  /** `derived` only: the live budget keys this figure was computed from. */
  readonly from?: readonly string[];
  /** The identity of the same figure recorded under another name elsewhere. Pinned equal, per plan. */
  readonly sameFigureAs?: string;
}

function group(ground: Ground, why: string, keys: readonly string[]): Record<string, Classification> {
  return Object.fromEntries(keys.map((key) => [key, { ground, why }]));
}

const mailda = (why: string, ...keys: string[]) => group("mailda", why, keys);
const bothPlans = (why: string, ...keys: string[]) => group("single_figure", why, keys);
const planScoped = (why: string, ...keys: string[]) => group("plan_scoped", why, keys);
const derived = (why: string, from: readonly string[], ...keys: string[]) =>
  Object.fromEntries(keys.map((key) => [key, { ground: "derived" as const, why, from }]));

/**
 * Every figure this repository records, and whether the Cloudflare plan changes it. Grouped by the receipt
 * that established it, because that is the file a reader has to open to dispute an entry.
 *
 * A new budget fails here until it is classified. That is the point: classifying one takes a line, and the
 * alternative is a default, which would be permissive for exactly the figure nobody thought about.
 */
const FIGURES: Record<string, Classification> = {
  // docs/receipts/audit-and-log-retention.md
  ...mailda(
    "disclosure and retention bounds on Mailda's own tables",
    "audit.max_detail_bytes", "audit.verify_batch",
    "log.max_detail_bytes", "log.retained_entries", "log.trim_batch",
  ),

  // docs/receipts/authz-check-rows-read.md
  ...mailda(
    "the cost of Mailda's own authorization queries, measured in workerd",
    "authz.check.max_queries", "authz.check.max_rows_read", "authz.list.max_rows_read",
    // Same receipt, same instrument, and plan-independent for the same reason as its siblings: it is the
    // check's two round trips plus the audit append's two, all four of them Mailda's own queries against
    // Mailda's own schema. Nothing Cloudflare publishes per plan appears in the figure — the subrequest
    // *ceiling* does, but that is `doctor.free.max_subrequests` and this is nowhere near it.
    "authz.supervised_read.max_queries",
  ),

  // docs/receipts/supervised-notice-scan.md
  ...mailda(
    "how many notices one cron tick delivers, measured with metering() against Mailda's own scan. The Free "
      + "plan's subrequest ceiling is what it is *sized against*, and that ceiling is recorded as "
      + "doctor.free.max_subrequests — this figure is the batch Mailda chose under it, not the ceiling",
    "notify.scan_batch",
  ),
  ...derived(
    "how long a due notice may stay undelivered before doctor calls it overdue: the trigger's propagation "
      + "ceiling after a deploy, plus the one-minute schedule and the measured p99 dispatch lateness, then "
      + "sized 3.7x past their sum. Propagation dominates and is the same on both plans "
      + "(cron-lateness.md records the ceiling without a plan column), so the derived figure is not "
      + "plan-scoped either — what *is* plan-scoped in that receipt is the per-account trigger count, which "
      + "does not enter this arithmetic",
    ["cron.propagation_ceiling_seconds", "cron.observed_lateness_p99_ms"],
    "notify.overdue_grace_seconds",
  ),

  // docs/receipts/binding-relink-on-id-removal.md
  ...bothPlans(
    "what wrangler does with a binding whose id was removed; account tooling behaviour, published without a plan column",
    "binding.relinks_when_id_and_name_removed",
    "binding.reprovisions_when_id_and_name_removed",
    "binding.secrets_store_relinks_when_id_removed",
  ),

  // docs/receipts/body-render-bounds.md
  ...mailda(
    "bounds on Mailda's own render path and the bundles it ships",
    "render.max_attributes_per_element", "render.max_body_bytes",
    "render.postal_mime_bundle_kib", "render.sanitizer_bundle_kib",
  ),

  // docs/receipts/butler-step-budget.md
  ...planScoped(
    "the per-invocation subrequest ceiling: 10,000 on Paid (measured), 1,000 to internal services on Free (documented)",
    "workflow.subrequest_budget_per_instance",
  ),
  ...bothPlans(
    "that a Workflow instance is one invocation for the ceiling is structural, not a quantity a plan scales",
    "workflow.budget_unit_is_instance",
  ),

  // docs/receipts/butler-step-cost.md
  ...mailda(
    // Not plan-scoped, and #54 is the ticket that made the distinction load-bearing rather than tidy: these
    // five are now *divided into* the plan-scoped pot by `packages/butler-ast/src/cost.ts`, which prices a
    // whole Butler and refuses to publish one that cannot afford itself. The plan lives in the pot's name —
    // `workflow.paid.subrequest_budget_per_instance`, the row that pass chose and argues for — and nowhere in
    // the cost of a node, because no Cloudflare plan changes how many queries `sealManifest` performs.
    // `butler.step_cost_max_lookup` joined them on 20 August, measured at 1 across all five lookup entities
    // and bounded at 4 so an authority re-check (`authz.check.max_queries`) would still fit: it was the third
    // shipped node with no figure, which that receipt's own stale_when named and nothing enforced until the
    // cost table became exhaustive over the shipped set by construction.
    "what Mailda's own Butler nodes cost in subrequests; the plan does not change what the code does",
    "butler.step_cost_max_case_assign", "butler.step_cost_max_case_close",
    "butler.step_cost_max_draft", "butler.step_cost_max_send_propose",
    "butler.step_cost_max_lookup",
  ),

  // docs/receipts/butler-run-cost.md
  ...mailda(
    // Not plan-scoped, for exactly the reason `butler-step-cost.md`'s five are not, and it needed checking
    // rather than inheriting because this receipt's whole subject is a *division* into a plan-scoped pot:
    // these count operations Mailda's own engine performs around each node, and no Cloudflare plan changes
    // how many statements `interpret` runs. The plan lives in the pot's name —
    // `workflow.paid.subrequest_budget_per_instance` — and in the one place the division happens, which is
    // the runtime guard in `src/butler/interpret.ts` and the arithmetic in `packages/butler-ast/src/cost.ts`.
    // `butler.run_cost_engine_fixed` is the same kind of figure one level smaller: a count of three
    // statements in one file.
    "what Mailda's own Butler engine costs per node and per run, measured with metering() in workerd; the "
      + "plan changes the size of the pot these spend from, never how many operations the engine performs",
    "butler.run_cost_max_draft", "butler.run_cost_max_send_propose", "butler.run_cost_max_case_assign",
    "butler.run_cost_max_case_close", "butler.run_cost_max_lookup", "butler.run_cost_engine_fixed",
  ),

  // docs/receipts/butler-pause.md
  ...mailda(
    // Not plan-scoped, and the argument is made rather than inherited from the two Butler groups above,
    // because these two are *governance* figures where those were cost ones. What counts as a loop is
    // Mailda's own opinion about its own run records — the same class as `breaker.bounce_max_percent` and
    // `approval.send_expiry_seconds`, which this file already classifies here — and no Cloudflare plan has a
    // view on how many times a Butler may re-trigger itself. `butler.pause_check_added_subrequests` joins
    // them as a cost figure over Mailda's own statements, exactly like every other cost group: the plan
    // changes the size of the pot, never the number of operations, and this one's number of operations is
    // zero because both questions ride on statements that were already being issued.
    "what this Node calls a Butler looping, and what asking costs; the plan changes neither",
    "butler.loop_window_seconds", "butler.loop_max_self_provoked_runs",
    "butler.pause_check_added_subrequests",
  ),

  // docs/receipts/cloudflare-email-sending.md
  "send.included_per_month": {
    ground: "plan_scoped",
    why: "the pricing table reads 'Workers Free: Not available. Workers Paid: 3,000 included per month'",
    sameFigureAs: "plan.emails_included_per_month",
  },
  ...planScoped(
    "the overage price of a product the pricing table lists as unavailable on Free",
    "send.cost_per_thousand_cents",
  ),
  ...bothPlans(
    "Email Sending's published limits carry no plan column, and verified-destination sends are free 'on any plan'",
    "send.max_custom_headers", "send.max_header_value_bytes", "send.max_headers_total_bytes",
    "send.max_references_entries_for_reply", "send.delivers_to_same_account_routing",
    "send.preserves_authored_message_id", "send.delivers_externally", "send.daily_limit_is_published",
    "send.bounce_dsn_reaches_node", "send.counts_per_recipient",
  ),
  ...derived(
    "an order of magnitude clear of Cloudflare's rejection threshold for an incoming reply's chain",
    ["send.max_references_entries_for_reply"],
    "send.references_emitted_max",
  ),
  ...mailda(
    "the undo-send window: a preference about human regret, which no measurement could settle",
    "send.hold_window_default_seconds",
  ),

  // docs/receipts/cloudflare-email-service-limits.md
  ...bothPlans(
    "the Email Service limits page states one figure per row, with no plan column",
    "email.inbound.max_bytes", "email.outbound.max_bytes", "email.outbound.max_bytes_verified_destination",
    "email.max_recipients_per_message", "email.max_subject_chars", "email.max_custom_header_bytes",
    "email.max_routing_rules_per_domain", "email.max_destination_addresses_per_account",
    "email.max_domains_per_zone",
  ),

  // docs/receipts/cloudflare-plan-costs.md — the receipt that reads the plan comparison itself.
  ...planScoped(
    "read from the Workers, Email Service and Queues pricing tables, which are per plan",
    "plan.monthly_usd_minimum", "plan.queue_operations_per_day", "plan.queue_retention_seconds",
    "plan.d1_rows_read_per_day", "plan.d1_rows_written_per_day", "plan.build_minutes_per_month",
  ),
  "plan.emails_included_per_month": {
    ground: "plan_scoped",
    why: "the included outbound quota, which the Free column of the same table reads 'Not available' for",
    sameFigureAs: "send.included_per_month",
  },
  "plan.d1_max_database_bytes": {
    ground: "plan_scoped",
    why: "the free plan's 500 MB per-database ceiling, from the plan comparison",
    sameFigureAs: "d1.max_database_bytes",
  },

  // docs/receipts/contrast-tokens.md
  ...mailda(
    "WCAG ratios and the worst pair in Mailda's own tokens, computed from the stylesheet",
    "contrast.aa_large_ratio", "contrast.aa_normal_ratio",
    "contrast.dim_dark_worst", "contrast.dim_light_worst",
  ),

  // docs/receipts/cron-lateness.md
  ...planScoped(
    "the Cron Trigger ceiling per account: 250 Paid, 5 Free, in the same limits table (#68 found this one by this test)",
    "cron.trigger_ceiling_per_account",
  ),
  ...bothPlans(
    "the documented 'up to 15 minutes' propagation ceiling, published once",
    "cron.propagation_ceiling_seconds",
  ),
  ...bothPlans(
    "observed dispatch lateness; Cloudflare publishes no lateness figure for either plan, let alone two",
    "cron.observed_lateness_p99_ms",
  ),

  // docs/receipts/d1-auto-provisioning.md — measured on a Workers Free account, which is itself the evidence.
  ...bothPlans(
    "what wrangler provisions for a D1 binding, measured on Free; the deploy-button receipts saw the same on Paid",
    "provisioning.databases_created_per_worker", "provisioning.ids_written_back_to_config",
    "provisioning.shared_across_workers",
  ),

  // docs/receipts/d1-platform-limits.md
  ...planScoped(
    "the D1 limits page has a Workers Free column and a Workers Paid column, and these rows differ",
    "d1.max_database_bytes", "d1.max_account_storage_bytes", "d1.max_databases_per_account",
    "d1.time_travel_days",
  ),
  "d1.max_queries_per_invocation": {
    ground: "plan_scoped",
    why: "not a D1 limit at all: the subrequest ceiling restated under a D1 name, per that receipt's 13 August correction",
    sameFigureAs: "workflow.subrequest_budget_per_instance",
  },
  ...bothPlans(
    "the D1 limits page lists these under 'Both plans'",
    "d1.max_columns_per_table", "d1.max_sql_statement_bytes", "d1.max_bound_parameters",
    "d1.max_sql_function_args", "d1.max_row_bytes", "d1.max_query_duration_seconds",
    "d1.max_time_travel_restores_per_10min",
  ),

  // docs/receipts/deploy-button-behaviour.md
  ...bothPlans(
    "what one Deploy to Cloudflare click does; a behaviour of the install path, not a quantity a plan scales",
    "builds.workers_deployable_per_project", "builds.provisions_d1", "builds.provisions_queues",
    "builds.writes_resource_ids_to_repo",
  ),

  // docs/receipts/deploy-button-install.md
  ...bothPlans(
    "what the one-click install leaves behind in a customer's repository; behaviour, not a plan-scaled quantity",
    "install.writes_resource_ids_to_clone", "install.preserves_upstream_history",
    "install.strips_github_workflows", "install.renames_root_package", "install.detects_deploy_script",
    "install.applies_migrations", "install.provisions_d1_in_build", "install.provisions_r2_in_build",
  ),

  // docs/receipts/doctor-check-cost.md
  "doctor.max_subrequests": {
    ground: "plan_scoped",
    why: "the platform's per-invocation ceiling, printed to the operator; measured in butler-step-budget.md",
    sameFigureAs: "workflow.subrequest_budget_per_instance",
  },
  ...derived(
    "the receipt divides the ceiling it was derived against — 1,000, today's Free figure — leaving ~790 headroom",
    ["doctor.free.max_subrequests"],
    "doctor.evidence_sample_size",
  ),
  ...derived(
    "the fixed checks plus a full sample; a tripwire on Mailda's own run cost, not on the platform's ceiling",
    ["doctor.evidence_sample_size"],
    "doctor.max_subrequests_per_run",
  ),

  // docs/receipts/email-routing-subdomain-onboarding.md
  ...bothPlans(
    "which Email Routing operations have an API; inbound routing is unlimited and free on both plans",
    "routing.subdomain_api_available", "routing.subdomain_dashboard_only",
    "routing.mx_records_visible_in_dns_api", "routing.subdomain_receives_external_mail",
    "routing.cf_sending_reaches_own_routing_domain",
  ),

  // docs/receipts/email-sending-events.md
  ...bothPlans(
    "the shape of the event stream and what one event carries; a schema, which no plan varies",
    "events.schema_version", "events.types_published", "events.is_per_recipient",
    "events.carries_terminal_flag", "events.carries_bounce_type", "events.subscription_scope_is_one_domain",
    "events.routing_events_published", "events.submit_id_matches_event_id",
    "events.bounce_event_seconds_observed", "events.delivery_silence_minutes",
  ),

  // docs/receipts/evidence-frame-size.md
  ...mailda(
    "Mailda's own AEAD frame layout and the time its own code takes to seal and open one",
    "evidence.frame_bytes", "evidence.header_bytes", "evidence.tag_bytes",
    "evidence.max_seal_ms_25mib", "evidence.max_open_ms_25mib", "evidence.max_ttfb_ms",
  ),

  // docs/receipts/evidence-lifecycle.md
  ...mailda(
    "the subrequests Mailda's own reseal and reconcile paths spend per message and per scan",
    "reseal.subrequests_per_message", "reconcile.list_limit", "reconcile.orphan_grace_seconds",
  ),
  ...derived(
    "a full batch has to fit inside the ceiling; 200 would not, which is why the batch is 100",
    ["reseal.subrequests_per_message", "doctor.free.max_subrequests"],
    "reseal.batch_size",
  ),

  // docs/receipts/r2-list-page-size.md
  ...bothPlans(
    // Checked rather than inherited from its neighbours: R2's operation limits table states one figure per
    // row with no plan column, and the Workers plan changes what an account is billed for rather than how
    // many keys one API call returns. The plan-scoped figure in this neighbourhood is the *subrequest
    // ceiling*, which is `doctor.{free,paid}.max_subrequests` and bounds how many listings a pass may make —
    // a different question, recorded elsewhere and deliberately not restated here.
    // Two figures because they are two different calls: a bare listing caps at 1,000 and a listing that asks
    // for customMetadata caps at 100, measured against workerd. Both are published-once platform limits, and
    // conflating them is what made an export above a hundred messages unable to finish.
    "the maximum keys one R2Bucket.list() call returns, with and without customMetadata; published once, "
      + "and measured against workerd",
    "r2.list_max_keys_per_call", "r2.list_max_keys_with_metadata",
  ),

  // docs/receipts/ediscovery-export-cost.md
  ...mailda(
    // Not plan-scoped, for the reason the policy, approval and dispatch cost figures are not: these count
    // operations Mailda's own export performs. The plan changes the size of the pot they spend from, never
    // how many of them the code performs — and because an export checkpoints (blueprint:1276), the pot only
    // decides how many invocations a run takes rather than whether it finishes.
    "the R2 and vault operations one exported message costs, with and without the run-scoped key cache, "
      + "measured with metering() in workerd",
    "export.subrequests_per_message", "export.subrequests_per_message_cached",
  ),
  ...derived(
    "messages per invocation before the cursor checkpoints: a full page with the cache sits at a fifth of "
      + "the Free ceiling, and the same argument reseal.batch_size records applies — the ceiling no longer "
      + "binds the choice, a failing page costs a retry of the whole page",
    ["export.subrequests_per_message_cached", "doctor.free.max_subrequests"],
    "export.page_size",
  ),
  ...derived(
    "the largest export this Node will authorize: the manifest build pages one R2 listing and stops at this "
      + "many objects, so the ceiling is a bare listing's cap and blueprint:1280 says to name the boundary "
      + "rather than work around it. Not the metadata cap, which decides how many pages the build spends "
      + "rather than how many objects it can name",
    ["r2.list_max_keys_per_call"],
    "export.max_messages_ceiling",
  ),

  // docs/receipts/free-plan-node-capability.md — the plan is in the namespace, which is what these figures are about.
  ...planScoped(
    "measured on a live Workers Free account: what a Free Node can and cannot do",
    "inbound_to_worker", "send_to_verified_destination", "send_to_arbitrary_recipient",
    "send_error_names_the_plan",
  ),

  // docs/receipts/message-metadata-bytes.md
  ...mailda(
    "bytes per row of Mailda's own metadata, measured on remote D1; SQLite page accounting does not vary by plan",
    "message.metadata.bytes_per_message", "message.metadata.bytes_per_extra_delivery",
  ),
  ...derived(
    "§11B's 70/85/90% marks of the **Paid** 10 GB per-database ceiling, divided by the measured bytes per message",
    ["message.metadata.bytes_per_message", "d1.paid.max_database_bytes"],
    "shard.plan_warn_messages", "shard.plan_stop_messages", "shard.plan_route_messages",
  ),

  // docs/receipts/message-page-size.md
  ...mailda(
    "how many messages one inbox page returns, measured as rows read by Mailda's own listing in workerd. "
      + "Plan-independent for its siblings' reason: the figure is D1 rows scanned by our query against our "
      + "own schema, and the ceilings it is sized under — authz.list.max_rows_read and audit.max_detail_bytes "
      + "— are both Mailda's own",
    "messages.page_size",
  ),

  // docs/receipts/mime-header-parse.md
  ...mailda(
    "the parser bundle Mailda ships and the header bounds its own parse path imposes",
    "mime.postal_mime_bundle_kib", "mime.postal_mime_gzip_kib",
    "mime.max_header_bytes", "mime.max_references_depth",
  ),

  // docs/receipts/hsts-max-age.md
  ...bothPlans(
    // The provider is **the browser**, not Cloudflare, which is why this reads oddly against the rest of the
    // table and is filed here anyway: it is a figure somebody else publishes, identical for every Node on
    // every plan, and the plan is not an input to it in either direction. The receipt says why it cannot be
    // adapter capability data — a browser tells a server nothing about its HSTS policy, so there is no probe.
    "the HSTS preload list's stated minimum max-age; a browser-side figure, and Cloudflare's plan is not an input",
    "security.hsts_max_age_seconds",
  ),

  // docs/receipts/passkey-verification.md
  ...mailda(
    // Not plan-scoped, for the same reason the YAML figures are not: this is what one dependency costs
    // Mailda's bundle, which is a property of the package and identical on both plans. The *script size
    // limit* it is weighed against is plan-conditional, and that comparison is made in the receipt's prose.
    "what the WebAuthn verifier costs Mailda's bundle",
    "auth.webauthn_bundle_kib", "auth.webauthn_gzip_kib",
  ),

  // docs/receipts/butler-source-format.md
  ...mailda(
    // Not plan-scoped, and the near-miss is worth naming: the *script size limit* these figures are weighed
    // against is emphatically plan-conditional — 3 MB on Free, 10 MB on Paid. These are not that limit. They
    // are what one parser costs, which is a property of the dependency and identical on both plans. The
    // ceiling they were compared against lives in the receipt's prose, where the comparison is made.
    "what the YAML parser costs Mailda's bundle, and the alias bound Mailda's own parse path sets",
    "butler.yaml_parser_bundle_kib", "butler.yaml_parser_gzip_kib", "butler.yaml_max_alias_count",
  ),

  // docs/receipts/password-hash-cost.md
  ...bothPlans(
    "the Workers crypto API's per-call PBKDF2 iteration ceiling, measured in the runtime; not a plan entitlement",
    "auth.pbkdf2_platform_max_iterations",
  ),
  ...derived(
    "rounds × the platform's per-call ceiling, which is the only way to reach a real iteration count here",
    ["auth.pbkdf2_rounds", "auth.pbkdf2_platform_max_iterations"],
    "auth.pbkdf2_effective_iterations",
  ),
  ...mailda(
    "Mailda's own session, token and lockout policy, and the CPU its own hashing spends",
    "auth.pbkdf2_rounds", "auth.pbkdf2_max_derivation_ms", "auth.access_token_ttl_seconds",
    "auth.refresh_token_ttl_seconds", "auth.signing_key_verify_grace_seconds",
    "auth.signing_key_cache_seconds", "auth.refresh_replay_window_seconds",
    "auth.access_token_refresh_margin_seconds", "auth.max_failed_logins_per_15min",
    // #83's invitation window. Mailda's own policy about how long a bearer credential for membership stays
    // usable — the plan has no opinion about it, and no platform limit bounds it.
    "auth.invitation_expiry_seconds",
    // #84's passkey policy: how long a challenge stays redeemable and how many credentials an account may
    // hold. Mailda's own decisions — WebAuthn bounds neither, and no platform limit touches either.
    "auth.passkey_challenge_ttl_seconds", "auth.passkeys_per_user_max",
  ),

  // docs/receipts/approval-decision-cost.md
  ...mailda(
    // Not plan-scoped, for the reason the policy figures below are not: these count operations Mailda's own
    // code performs. The plan changes the size of the pot they spend from, never how many of them the code
    // performs, and the pot is plan-named where the division happens (butler-step-cost.md).
    "the D1 operations Mailda's own eligibility check and approval decisions perform, measured in workerd",
    "approval.eligibility_max_subrequests", "approval.decision_max_subrequests",
  ),

  // docs/receipts/policy-evaluation-cost.md
  ...mailda(
    // Not plan-scoped, and worth saying why rather than defaulting: these count operations Mailda's own code
    // performs, and the plan changes the size of the *pot* those operations spend from, never how many of
    // them the code performs. The pot is `workflow.{paid,free}.subrequest_budget_per_instance`, which is
    // plan-named, and the arithmetic dividing it lives in butler-step-cost.md — so the plan stays visible
    // exactly once, where the division happens, instead of leaking into the name of every cost figure.
    "the D1 operations Mailda's own policy evaluation and publication perform, measured in workerd",
    "policy.evaluate_max_subrequests", "policy.publish_max_subrequests",
  ),

  // docs/receipts/dispatch-recheck-cost.md
  ...mailda(
    // Not plan-scoped, for the same reason as the two groups above and below: these count operations Mailda's
    // own dispatcher performs. The plan changes the size of the pot — 1,000 subrequests per invocation on Free
    // against 10,000 on Paid, which `doctor.{free,paid}.max_subrequests` already names — never how many
    // operations the code performs. The one place the division shows up is that receipt's paragraph on how many
    // sends one sweep can carry, and it names both plans there rather than in either figure's name.
    "the operations one dispatch performs, with and without #62's approved-path recheck, measured in workerd",
    "send.dispatch_approved_max_subrequests", "send.dispatch_unapproved_max_subrequests",
  ),
  ...mailda(
    // Emphatically not plan-scoped: it is a duration, and it is Mailda's own governance preference about how
    // long a human approval stays good — the same kind of figure as `send.hold_window_default_seconds`, which
    // `cloudflare-email-sending.md` records as having no measurement behind it either. No Cloudflare plan
    // changes how long an approver's weekend is.
    "how long an approval of a send stays good for; Mailda's own policy, sized rather than measured",
    "approval.send_expiry_seconds",
  ),

  // docs/receipts/send-breakers.md
  ...mailda(
    // Not plan-scoped, and this group needed the argument made twice rather than inherited, because the
    // sizing paragraph in that receipt *mentions* a plan-scoped figure: `send.included_per_month` is 3,000 on
    // Paid and "Not available" on Free, and it is what fixes the order of magnitude an ordinary Node sends
    // at. It is **context, not an input** — nothing here is computed from it, which is why this is `mailda`
    // rather than `derived` on that key. Two independent reasons the plan cannot change these figures: a
    // Free Node cannot send to arbitrary recipients at all (`send_to_arbitrary_recipient`), so there is no
    // Free volume for a Free limit to be different for; and a *rate* breaker is Mailda's own governance
    // preference about what its own tables say is too fast, in the same class as
    // `send.hold_window_default_seconds` and `approval.send_expiry_seconds`, which this file already
    // classifies here for the same reason. `breaker.evaluate_max_subrequests` joins them as a cost figure
    // over Mailda's own query, exactly like the policy, approval, dispatch and export cost groups.
    "windows, thresholds and floors Mailda applies to its own sending, plus the cost of asking; the plan "
      + "changes the size of the pot the query spends from, never how many operations the code performs or "
      + "what this Node calls too fast",
    "breaker.volume_window_seconds", "breaker.volume_max_recipients",
    "breaker.bounce_window_seconds", "breaker.bounce_min_observations", "breaker.bounce_max_percent",
    "breaker.complaint_window_seconds", "breaker.complaint_min_observations",
    "breaker.complaint_max_percent",
    "breaker.evaluate_max_subrequests",
  ),

  // docs/receipts/queue-provisioning.md
  ...bothPlans(
    "which queue and subscription operations exist and by what path; capability facts, not plan-scaled quantities",
    "queues.producer_binding_provisions", "queues.consumer_block_provisions",
    "queues.consumer_attaches_when_producer_provisions", "queues.subscription_creatable_by_cli",
    "queues.email_sending_subscription_is_dashboard_only", "queues.subscription_creatable_by_api",
    // #72's pair. Config-parser behaviour, which has no plan column at all: the file is accepted or refused
    // before anything reaches an account, and the dry-run that measured both never touched one.
    "queues.producer_queue_name_omissible", "queues.consumer_queue_name_required",
  ),

  // docs/receipts/r2-auto-provisioning.md
  ...bothPlans(
    "what wrangler does with an R2 binding at deploy; account tooling behaviour",
    "provisioning.r2_created_without_bucket_name", "provisioning.r2_created_with_missing_bucket_name",
    "provisioning.r2_requires_interactive_confirmation",
  ),

  // docs/receipts/deploy-drill-live-account.md
  ...bothPlans(
    "what wrangler and the Workers platform do during a deploy: whether an upload shifts traffic, whether "
      + "it can create a Worker, whether auto-provisioned bindings exist before one, and whether a second "
      + "script may claim an account-level Workflow. Plan-independent — these are the deploy API's own "
      + "semantics, and the drill that measured them ran on one account without changing plan",
    "deploy.versions_upload_shifts_traffic", "deploy.versions_upload_creates_worker",
    "deploy.migrations_before_first_deploy", "deploy.workflow_name_is_account_level",
    "deploy.second_node_reassigns_workflow",
  ),

  // docs/receipts/cloudflare-oauth-node-as-client.md
  ...bothPlans(
    "how Cloudflare's OAuth authorization endpoint behaves — which redirect hosts it accepts, whether a "
      + "private client needs domain verification, and the minimum `state` it enforces. None of it varies "
      + "with the account's plan: OAuth is Cloudflare's identity surface rather than a metered product, and "
      + "ADR 42 rests on the first of these",
    "oauth.workers_dev_redirect_accepted", "oauth.private_client_needs_domain_verification",
    "oauth.min_state_length",
  ),

  // docs/receipts/temporary-account-provisioning.md
  ...bothPlans(
    "what a **temporary preview account** is and is not, which does not vary with the customer's Cloudflare "
      + "plan because a temporary account is always created on Workers Free — that is one of the reasons it "
      + "cannot host this Node, since ADR 25 requires Paid. The claim window and the refusal are properties "
      + "of the temporary-account product itself",
    "temporary.supports_mailda_node", "temporary.claim_window_minutes",
    "temporary.bindings_provisioned_before_refusal",
  ),

  // docs/receipts/contrast-tokens.md — the brand palette, the rail's own surface, and a control's edge
  ...mailda(
    "contrast ratios between Mailda's own design tokens, and the WCAG thresholds they are measured "
      + "against. A Cloudflare plan does not have a colour",
    "contrast.accent_text_light_worst", "contrast.accent_text_dark_worst", "contrast.accent_ui_worst",
    "contrast.aa_nontext_ratio", "contrast.rail_text_worst", "contrast.rail_dim_worst",
    "contrast.control_edge_light_worst",
  ),

  // docs/receipts/message-search-cost.md
  ...mailda(
    "rows read by Mailda's own listing statements, measured against a seeded corpus. The searched figures "
      + "price a ranked, capped plan and the unsearched ones price a seek against `ir_org_accepted`; both "
      + "are properties of statements this repository writes, not of anything Cloudflare sells",
    "search.max_rows_read_per_page", "search.windowed_rows_read",
    "page.rows_read_unbounded", "page.rows_read_short_window",
    "sender.rows_read_indexed", "sender.rows_read_unindexed",
  ),

  // docs/receipts/d1-fts5-search.md
  ...bothPlans(
    "which SQLite compile-time options D1's build ships — FTS5 itself, contentless tables, "
      + "`contentless_delete`, and whether `snippet()` degrades to null. A compiled binary is the same "
      + "binary on both plans: Cloudflare's D1 limits page scopes storage and row counts by plan and says "
      + "nothing about the SQL surface, and a feature present on paid and absent on free would be a "
      + "different engine rather than a different quota",
    "search.d1_supports_fts5", "search.contentless_index_matches", "search.contentless_stores_body",
    "search.contentless_delete_supported", "search.contentless_snippet_returns_null",
  ),

  // docs/receipts/react-shell-bundle.md
  ...mailda("the bytes Mailda's own shell ships", "shell.bundle_bytes", "shell.bundle_gzip_bytes", "shell.pre_auth_bundle_bytes"),

  // docs/receipts/react-shell-bundle.md — the webfonts, added with the branding
  ...mailda(
    "bytes of typeface this Node serves from its own origin. A Cloudflare plan does not change a font file",
    "shell.font_bytes",
  ),

  // docs/receipts/runtime-validator.md
  ...mailda(
    "Mailda's own validator: its bundle and the microseconds it spends on a command",
    "validator.typical_command_us", "validator.worst_realistic_command_us", "validator.bundle_bytes",
  ),

  // docs/receipts/evidence-integrity-cost.md
  ...mailda(
    "what it costs this Node to prove its own evidence still hashes to what ingress recorded",
    "evidence.verify_objects", "evidence.verify_subrequests_per_object", "evidence.verify_tables",
  ),

  // docs/receipts/preview-urls-and-durable-objects.md
  ...bothPlans(
    "how Cloudflare routes a canary: no preview URL for a Worker with Durable Objects, at most two versions "
    + "in one deployment, and 0% traffic to the one under test. None of it varies by plan — the Durable "
    + "Object exclusion and the deployment arity are properties of the platform, not of the account",
    "deploy.canary_preview_url_available", "deploy.canary_traffic_percent", "deploy.versions_per_deployment",
  ),

  // docs/receipts/false-claim-detectability.md
  ...mailda(
    "how much prose this repository carries, and how much of it names something absent on purpose",
    "prose.references.min_scanned", "prose.references.max_exemptions",
  ),

  // docs/receipts/test-timeout-headroom.md
  ...mailda(
    "how long Mailda's own suite takes on the machines that run it",
    "test.timeout_ms", "test.hook_timeout_ms", "test.slowest_test_ms_idle", "test.slowest_test_ms_under_load",
    "test.config_resolution_timeout_ms",
    "test.migration_hook_ms_under_load", "test.slowest_test_ms_ci", "test.headroom_ceiling_percent",
  ),

  // docs/receipts/workflow-provisioning.md
  ...bothPlans(
    "wrangler's provisioning behaviour, its version floor, and two Workflows limits the docs state once each"
      + " (schedules per account and instance-id length; the plan-split rows of that table — steps, retention,"
      + " concurrency — are not recorded as values here)",
    "workflow.provisioned_by_deploy", "workflow.schedules_min_wrangler",
    "workflow.schedule_cron_ceiling_per_account", "workflow.instance_id_max_chars",
  ),
  ...bothPlans(
    // Checked rather than assumed, because the sibling figures in this receipt *are* plan-split and it
    // would be easy to inherit that: Cloudflare's Workflows pricing page states "Workflows is included in
    // both the Free and Paid Workers plans", so the *ability* to provision one does not differ. What does
    // differ — steps per day, storage, instance-state retention (3 days Free, 30 Paid) — is prose in that
    // receipt and deliberately not recorded as values, exactly as the entry above says.
    "whether the Deploy button's Workers Builds token can create a workflow: measured on a Paid account,"
      + " but Workflows is available on both plans and creating one rides on Workers Scripts:Edit, which the"
      + " token carries regardless of plan",
    "workflow.provisioned_by_button",
  ),
};

function planSegmentsIn(key: string): string[] {
  return key.split(".").filter((segment) => segment in PLAN_SEGMENTS);
}

/** A figure's identity: its name with the plan taken out, so both siblings share one classification. */
function figureIdentity(key: string): string {
  return key.split(".").filter((segment) => !(segment in PLAN_SEGMENTS)).join(".");
}

function sameSegments(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

/** The other name for this figure carrying the same plan, or `null` if nothing does. */
function counterpartOf(budgets: Record<string, number>, identity: string, plans: readonly string[]): string | null {
  return Object.keys(budgets).find(
    (key) => figureIdentity(key) === identity && sameSegments(planSegmentsIn(key), plans),
  ) ?? null;
}

const RECEIPT_OF: Record<string, string> = Object.fromEntries(
  Object.entries(BUDGET_ORIGINS).map(([name, origin]) => [name, origin.receipt]),
);

const where = (key: string): string => RECEIPT_OF[key] ?? "no receipt — this budget is not in BUDGET_ORIGINS";

/**
 * Every way the budget set and this registry can disagree, one line each, naming the budget and its receipt.
 *
 * A pure function of a budget map so the checks can be run against a mutated copy — the tests below break
 * each rule deliberately and watch it fire, rather than trusting that a green run means a live check.
 */
export function planScopeComplaints(budgets: Record<string, number>): string[] {
  const complaints: string[] = [];

  for (const key of Object.keys(budgets)) {
    const identity = figureIdentity(key);
    const classified = FIGURES[identity];
    if (classified === undefined) {
      complaints.push(
        `  ${key}  (figure ${identity})  is not classified in FIGURES: nothing says whether the Cloudflare`
        + ` plan changes it. Receipt: ${where(key)}`,
      );
      continue;
    }

    const plans = planSegmentsIn(key);
    if (classified.ground === "plan_scoped" && plans.length === 0) {
      complaints.push(
        `  ${key}  records a plan-scoped figure (${classified.why}) and its name does not say which plan.`
        + ` Receipt: ${where(key)}`,
      );
    }
    if (classified.ground !== "plan_scoped" && plans.length > 0) {
      complaints.push(
        `  ${key}  names ${plans.map((plan) => PLAN_SEGMENTS[plan]).join(" and ")} but is classified`
        + ` ${classified.ground} (${classified.why}), so the plan in its name claims more than the figure is.`
        + ` Receipt: ${where(key)}`,
      );
    }

    for (const input of classified.from ?? []) {
      if (!(input in budgets)) {
        complaints.push(
          `  ${key}  was derived from ${input}, which is not a budget any receipt declares any more.`
          + ` Receipt: ${where(key)}`,
        );
      }
    }

    if (classified.sameFigureAs !== undefined) {
      const twin = counterpartOf(budgets, classified.sameFigureAs, plans);
      if (twin === null) {
        complaints.push(
          `  ${key}  is declared to be the same figure as ${classified.sameFigureAs}, and no budget of that`
          + ` figure carries the same plan. Receipt: ${where(key)}`,
        );
      } else if (budgets[twin] !== budgets[key]) {
        complaints.push(
          `  ${key} = ${budgets[key]} but ${twin} = ${budgets[twin]}, and they are declared to be one figure`
          + ` recorded twice. One receipt moved and the other did not: ${where(key)} and ${where(twin)}`,
        );
      }
    }
  }

  for (const identity of Object.keys(FIGURES)) {
    const live = Object.keys(budgets).some((key) => figureIdentity(key) === identity);
    if (!live) {
      complaints.push(
        `  ${identity}  is classified in FIGURES but no receipt declares a budget with that figure any more.`
        + ` Delete the entry, or restore the budget.`,
      );
    }
  }

  return complaints;
}

/** The failure an author meets, in the four-part form AGENTS.md §3 requires. */
function report(complaints: string[]): string {
  return [
    `E_BUDGET_PLAN_SCOPE  ${complaints.length} budget(s) disagree with test/node/budget-plan-scope.test.ts`,
    ...complaints,
    "  fix  classify the figure in FIGURES: plan_scoped if Cloudflare's number differs by plan or the thing",
    "       exists on one plan only — and then the key must be named x.paid.y or x.free.y in its receipt's",
    "       values: block, and `pnpm receipts` re-run. mailda for a measurement of our own code, single_figure",
    "       for a provider figure published once for both plans, derived for one computed from other budgets,",
    "       which it must name. Every entry states the evidence for its ground, because the next reader has to",
    "       be able to dispute it from the receipt.",
  ].join("\n");
}

describe("every plan-conditional budget names its plan", () => {
  const budgets: Record<string, number> = BUDGETS;

  it("finds the budgets, so this cannot pass by checking nothing", () => {
    // The vacuous-green failure mode: an empty budget map satisfies every rule below.
    expect(Object.keys(budgets).length).toBeGreaterThan(150);
    expect(budgets["workflow.paid.subrequest_budget_per_instance"]).toBe(10000);
    expect(budgets["workflow.free.subrequest_budget_per_instance"]).toBe(1000);
  });

  it("classifies every budget, and every classification describes a live budget", () => {
    const complaints = planScopeComplaints(budgets);
    expect(complaints.length === 0 ? "" : report(complaints)).toBe("");
  });

  it("fails when a plan-scoped figure loses the plan from its name", () => {
    // The defect itself, reproduced without touching a receipt: this is what #68 shipped, and what renaming
    // `d1.paid.max_queries_per_invocation` back to `d1.max_queries_per_invocation` in its receipt produces.
    const { "workflow.paid.subrequest_budget_per_instance": paid, ...rest } = budgets;
    // Asserted rather than asserted-away with `!`: if that key is ever renamed again, this mutation would
    // otherwise inject `undefined` and the test would go on passing against a value nothing recorded.
    expect(paid, "the key this mutation renames must still exist").toBeTypeOf("number");
    const complaint = planScopeComplaints({
      ...rest, "workflow.subrequest_budget_per_instance": paid as number,
    }).join("\n");
    expect(complaint).toContain("workflow.subrequest_budget_per_instance  records a plan-scoped figure");
    expect(complaint).toContain("does not say which plan");
  });

  it("fails when a figure the plan does not touch claims a plan in its name", () => {
    // The same overclaim pointing the other way: a reader who trusts `paid` in a name and is wrong has been
    // handed a landmine by whoever named it (AGENTS.md §4).
    const complaint = planScopeComplaints({ ...budgets, "email.paid.inbound.max_bytes": 26214400 }).join("\n");
    expect(complaint).toContain("email.paid.inbound.max_bytes  names Workers Paid");
    expect(complaint).toContain("claims more than the figure is");
  });

  it("fails on a budget nothing classifies, so the closed world is not vacuously closed", () => {
    const complaint = planScopeComplaints({ ...budgets, "butler.maxItems_default": 200 }).join("\n");
    expect(complaint).toContain("butler.maxItems_default");
    expect(complaint).toContain("is not classified in FIGURES");
  });

  it("fails on a classification whose budget has gone, so the registry cannot rot", () => {
    // #71's defect was a hand-maintained list that stopped matching the file it claimed to read. A registry
    // that keeps entries for figures nobody records any more is the same rot, one level along.
    const { "cron.observed_lateness_p99_ms": _gone, ...withoutOne } = budgets;
    const complaint = planScopeComplaints(withoutOne).join("\n");
    expect(complaint).toContain("cron.observed_lateness_p99_ms  is classified in FIGURES but no receipt");
  });

  it("pins the one ceiling recorded under four names, per plan", () => {
    // The subrequest ceiling is in three receipts under four names. That restatement is how the withdrawn
    // 1,000 survived six months in doctor-check-cost.md: the changelog that moved it did not look relevant
    // to a D1 receipt or a doctor receipt. Equality is now enforced rather than hoped for.
    const ceiling = budgets["workflow.paid.subrequest_budget_per_instance"];
    expect(budgets["d1.paid.max_queries_per_invocation"]).toBe(ceiling);
    expect(budgets["doctor.paid.max_subrequests"]).toBe(ceiling);
    expect(budgets["workflow.free.subrequest_budget_per_instance"]).toBe(1000);
    expect(budgets["d1.free.max_queries_per_invocation"]).toBe(1000);
    expect(budgets["doctor.free.max_subrequests"]).toBe(1000);

    const drifted = { ...budgets, "doctor.paid.max_subrequests": 50000 };
    const complaint = planScopeComplaints(drifted).join("\n");
    expect(complaint).toContain("doctor.paid.max_subrequests = 50000");
    expect(complaint).toContain("one figure");
  });

  it("keeps a derived figure's inputs live, so an inherited plan cannot go missing", () => {
    // `shard.plan_*_messages` divide the **Paid** 10 GB ceiling. Nothing renames that ceiling out from under
    // them silently: the derivation is declared, and the declaration is checked against the live budget set.
    const { "d1.paid.max_database_bytes": _renamed, ...withoutCeiling } = budgets;
    const complaint = planScopeComplaints(withoutCeiling).join("\n");
    expect(complaint).toContain("shard.plan_warn_messages  was derived from d1.paid.max_database_bytes");
  });
});

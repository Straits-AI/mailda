---
id: workflow-provisioning
kind: platform-limit
measured_on: 2026-08-13
stale_when: >
  wrangler changes how it resolves a workflow binding declared without an id; Workflows gains
  automatic-provisioning semantics different from the observed create-on-deploy; the schedules field
  becomes recognised by older wrangler releases; the scheduled-instance id format changes; or
  event.schedule.scheduledTime starts reporting the cron boundary rather than the dispatch time
values:
  workflow.provisioned_by_deploy: 1
  workflow.schedules_min_wrangler: 4.97
  workflow.schedule_cron_ceiling_per_account: 100
  workflow.instance_id_max_chars: 100
---

**Measured:** a scratch Worker (`mailda-workflow-probe`) with one `[[workflows]]` binding and one
`schedules` entry, deployed to a real Cloudflare account and then deleted. Method for each figure is
stated with it, because two of these contradict the obvious way to measure them.

This exists because Layer 4's engine choice is written against it, and because designing a Butler
engine around a primitive a customer's install cannot provision is the ADR 24 failure this project
has already hit once — `queue-provisioning.md` found that a consumer-only queue binding makes
`wrangler deploy` fail outright.

## `wrangler deploy` does provision a Workflow

The account held one workflow before the deploy (`fabric-jobs`, belonging to an unrelated Worker) and
two after, the new one carrying a `Created` timestamp matching the deploy to the second. So a Workflow
behaves like D1 and R2 rather than like Secrets Store: the binding declares `name`, `binding` and
`class_name` with **no resource id**, and the deploy creates what is missing.

The deploy also names it in its output — `workflow: mailda-workflow-probe-wf` — which matters, because
the schedule is the part it does *not* name. See below.

That makes a workflow binding ADR-24-safe on both counts: byte-identical config across a fork, and
provisioned by the install rather than by a step a customer has to be told about.

**Not measured, and it is the remaining risk:** whether a **Workers Builds auto-generated token** has
the scope to create a workflow. This deploy used an interactive OAuth token with Super Administrator
privileges, which is the *easy* case. §11A's one-click equivalence claim rests on the harder one, and
`queue-provisioning.md` needed a real Deploy-button click for exactly this reason. **Do not read
"provisioned by deploy" as "provisioned by the button".**

## `schedules` is silently dropped by the wrangler this repo permits

`schedules` shipped on **2 June 2026**, which puts the floor at **wrangler 4.97.0** (published that
day). The repo declares `"wrangler": "^4.68.0"`, so a customer resolving the bottom of that range is
**25 minor versions below the feature**.

What 4.68.0 does with it is the finding:

```
▲ [WARNING] Processing wrangler.jsonc configuration:
    - Unexpected fields found in workflows[0] field: "schedules"

Total Upload: 0.65 KiB / gzip: 0.40 KiB
--dry-run: exiting now.
```

**Exit code 0.** The field is discarded, the deploy succeeds, the binding table still reports
`env.PROBE (ProbeWorkflow) Workflow`, and nothing anywhere says the schedule does not exist. A Butler
with a schedule would deploy cleanly and never fire.

This is the same failure *shape* as `binding-relink-on-id-removal.md`'s Secrets Store result — silently
absent, exit code 0 — with one difference that makes it worse rather than better: there **is** a
warning, so it looks like the tooling is doing its job, and a warning in CI output is a line nobody
reads. Under 4.122.0 the warning is absent and the field is honoured.

Consequence for the repo: `^4.68.0` is not a supported range for anything using `schedules`. Raising
the floor is the fix; a `doctor` check cannot substitute, because the Worker has no way to see whether
a schedule it declared was registered (there is no schedule-inspection API — `wrangler workflows` has
`trigger` and no `schedules` subcommand).

## The schedule fires, tens of seconds after the boundary

Deployed at 05:44:47Z; the first instance was created at the next `*/5` boundary, 05:45:00Z. So
registration is effectively immediate — notably *unlike* top-level `triggers.crons`, where
`0017_first_response_clock.sql` records a 15-minute propagation delay.

A scheduled instance's id is **derived, not supplied**: `<cron expression>-<scheduledTimeMs>`, e.g.
`*/5 * * * *-1786599900000`. Two consequences:

1. **A caller-supplied id is unavailable for scheduled runs.** `create({ id })` accepts one for
   programmatic instances, but a schedule mints its own — so an ADR 9 effect key cannot *be* the
   instance id for a scheduled Butler, and a mapping is needed.
2. **The id is not URL-safe.** It contains `/` and spaces, and `wrangler workflows instances describe`
   interpolates it into the API path unescaped, producing `workflows.api.error.not_found` for an
   instance that plainly exists in `instances list`. Passing a pre-percent-encoded id works. So
   scheduled instances are listable but not addressable by the obvious command — worth knowing before
   a run ledger stores one as a foreign key.

### `event.schedule.scheduledTime` is the dispatch time, not the scheduled time

The single most important thing in this receipt, because it invalidates the obvious way to measure
lateness.

For the firing above, three clocks disagree:

| Source | Value |
|---|---|
| Instance id suffix | `2026-08-13T05:45:00.000Z` — the cron boundary |
| `event.schedule.scheduledTime` **inside the run** | `2026-08-13T05:45:31.944Z` |
| `Date.now()` in the step body | `2026-08-13T05:45:32.630Z` |

Computing lateness the documented way — wall clock minus `event.schedule.scheduledTime` — gives
**0.686 s**. Actual lateness against the boundary the cron expression names is **32.6 s**, a factor of
47 out, and the wrong number is the plausible-looking one. `scheduledTime` is approximately when the instance was dispatched, so subtracting it from the
wall clock measures how long the isolate took to start and nothing else.

This is the same class of instrument failure as the `performance.now()` clamping recorded in
`authz-check-rows-read.md`: a number that is plausible, stable, and answers a different question than
the one asked. **The usable ground truth is the instance id suffix.**

Queued at 05:45:19Z, started 05:45:32Z — so the 32 s splits into roughly 19 s before the instance
exists and 13 s of queue-to-start.

## Observed lateness

Five consecutive `*/5` firings, lateness measured as *step-body wall clock minus the boundary encoded
in the instance id*:

| Boundary (from instance id) | True lateness | Lateness via `scheduledTime` |
|---|---:|---:|
| `2026-08-13T05:45:00.000Z` | 32.6 s | 0.7 s |
| `2026-08-13T05:50:00.000Z` | 33.0 s | 1.1 s |
| `2026-08-13T05:55:00.000Z` | 33.2 s | 1.2 s |
| `2026-08-13T06:00:00.000Z` | 23.7 s | 0.7 s |
| `2026-08-13T06:05:00.000Z` | 24.2 s | 1.1 s |

Firings: **5**. True lateness min **23.7 s**, max **33.2 s**, mean **29.3 s**.

**The sample is confounded, and saying so is the point of a receipt.** The probe Worker was
**redeployed between the third and fourth firings** (to add the duplicate-id routes below). The first
three firings — all on the original version — cluster at 32.6–33.2 s; the last two, on the new version,
at 23.7–24.2 s. So the ~9 s drop coincides exactly with a version change and **cannot be attributed to
time of day, warmth, or a trend**. Do not read a direction into these five numbers.

What survives the confound is a **range**: a scheduled Workflow instance ran its first step body
**23.7–33.2 s after the boundary its cron expression names**, across five consecutive firings of a
`*/5` schedule on one account. That is enough to say the delay is tens of seconds rather than
sub-second, which is what §16's `maximum lateness` field and any Butler trigger expressed as a schedule
have to be designed against. It is **not** enough for a tail: five firings over twenty minutes on one
account, with a version change in the middle, is a sighting shot. [Cron lateness and the trigger-count
ceiling, measured](https://github.com/Straits-AI/mailda/issues/48) is where the real distribution
belongs, and its method now points at the right clock.

## Sized

- `workflow.provisioned_by_deploy = 1` — a fact, kept as a value so a change in it trips something.
- `workflow.schedules_min_wrangler = 4.97` — the floor below which `schedules` is discarded with exit
  code 0. Recorded as a number so a dependency bump downwards is a test failure and not a silent
  regression.
- `workflow.schedule_cron_ceiling_per_account = 100` — documented, not measured: "up to 100 cron
  expressions per account". **Per account**, not per Worker, which is the distinction the cron-trigger
  docs contradict themselves on. It bounds how many independently-scheduled Butlers one Node can own,
  and it is shared with every other Worker in the customer's account — so a Node cannot treat it as
  its own budget.
- `workflow.instance_id_max_chars = 100` — documented. A caller-supplied id must fit, which a
  `btl_<ulid>` plus a step discriminator comfortably does.

## Deleting the Worker does not delete the Workflow

Found while cleaning up, and worth a line because it is the uninstall path. `wrangler delete --name
mailda-workflow-probe` reported success and the workflow **remained**, still listing `Script name:
mailda-workflow-probe` — a script that no longer existed. It took a separate `wrangler workflows delete`
to remove it.

So a workflow is an **account-level resource whose lifecycle is not tied to the Worker that declared
it**, which puts it in the same family as the Queues event subscription: created by one path, removed by
another, and invisible to the Worker either way. The consequences worth carrying:

- **Uninstalling a Node leaves a workflow behind.** Whatever `mailda` eventually offers as a teardown has
  to name it explicitly, and a customer who deletes the Worker from the dashboard will not get it.
- **Provisioning is asymmetric with removal**, which is exactly the asymmetry ADR 32 records for R2
  objects and the reconciler: creation is automatic, deletion is deliberate.
- **An orphaned workflow is a live schedule.** Its instances stopped only because the script was gone;
  the schedule itself was still registered until the workflow was deleted.

## What this hands the other tickets

- **What executes a Butler run** — a workflow is provisionable by `wrangler deploy`, so §16's
  "Workflows handle waits and retryable long-running execution" is available rather than aspirational.
  The two live caveats are the wrangler floor and the untested Deploy-button token.
- **Cron lateness and the trigger-count ceiling, measured** — its stated method is wrong and this
  receipt says why. Measure against the instance id suffix, or against a stored intent for top-level
  `triggers.crons`, never against the platform's own `scheduledTime`.
- **The run ledger and the four replay modes** — instance state is **retained 3 days on Free and 30
  days on Paid** by default, configurable per instance. So a Workflow instance is *not* a durable
  record and the run ledger cannot be a view over it. `createBatch` is idempotent and **silently skips
  a duplicate id, excluding it from the returned array** — a fan-out that does not compare the
  returned length against the requested length drops runs with no error, which is a landmine in the
  AGENTS.md sense. `create` by contrast **throws** on a duplicate id within its retention window,
  which is the conflict-is-the-signal behaviour this codebase already relies on.

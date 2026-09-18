---
id: email-routing-rule-takeover
kind: platform-limit
measured_on: 2026-09-19
stale_when: >
  `PUT /zones/{zone_id}/email/routing/rules/{rule_id}` starts accepting a partial body, or more than one
  action per rule; or the catch-all stops appearing in the rules listing as a `type: all` matcher
values:
  routing.rule_put_replaces_action: 1
  routing.rule_put_read_back_agrees: 1
  routing.rule_actions_per_rule_max: 1
  routing.rule_put_partial_body_accepted: 0
  routing.catch_all_listed_among_rules: 1
  routing.rule_takeover_through_grant: 1
---

## Question

Can a Node take over an address whose routing rule already points somewhere else, and put it back? (#258)

## Method

Zone `mailda.site` (ours, account swmengappdev), the operator's wrangler OAuth token (`email_routing:write`),
19 September 2026. A rule `drill@mailda.site → drop` was created, updated, read back, updated again,
and deleted. Every call is below.

## Results

**`PUT …/rules/{id}` with the full body replaces the action.** Sent `actions: [{ type: "worker", value:
["mailda"] }]` with the same `name`, `enabled` and `matchers`; answered `success: true` with the worker
action. A separate `GET …/rules/{id}` afterwards agreed: `[{'type': 'worker', 'value': ['mailda']}]`. The
reverse `PUT`, back to `[{ type: "drop" }]`, also answered with the drop action. So a take-over is one
`PUT`, and a put-back is the same `PUT` with the actions the audit entry recorded.

**One action per rule.** `actions: [{ type: "drop" }, { type: "worker", … }]` was refused:

```
2007 Invalid Input: actions: only one action per rule is allowed.
```

So "forward to Gmail *and* send to the Node" is not a state a rule can be in. Taking over replaces; there is
no coexistence, and the put-back is what makes the replacement reversible.

**A partial body is refused.** `PUT` with only `actions`:

```
2007 Invalid Input: matchers: must have matchers.
```

So the Node re-sends `name`, `enabled` and `matchers` as it read them. The digest the confirmation carries
covers those same fields, so a rule edited in the dashboard between the listing and the confirm is refused
as stale rather than overwritten with what the Node last saw.

**The catch-all is in the rules listing.** `GET …/rules` on this zone answered one row: `matchers: [{ type:
"all" }]`, `actions: [{ type: "drop" }]`, `enabled: false`, `priority: 2147483647`, the same object
`GET …/rules/catch_all` returns. A listing that offered every row for take-over would offer the catch-all,
so the listing names it as one and the take-over refuses a rule whose matcher is not `literal` on `to`.

## Through the Node's own grant

Same day, after the routes were built: the dev Node (`mailda.swmengappdev.workers.dev`, its grant consented
with `email-routing-rule.write`) listed `mailda.site`'s rules, took over a `drill@mailda.site → drop` rule
(`was drop, now worker -> mailda`), and put it back (`was worker -> mailda, now drop`), each step confirmed
by listing again. The first take-over was refused with `E_RECEIVING_MAILBOX_AMBIGUOUS` because the
organization has two mailboxes and none was named, which is the refusal `onboardReceiving` makes for the
same reason. The drill rule was then deleted and the address row removed.

## What this settles

- Take-over is `PUT` with the full rule and one `worker` action naming this Node's script.
- Put-back is the same call with the recorded previous actions.
- The catch-all is listed, marked, and never taken over.

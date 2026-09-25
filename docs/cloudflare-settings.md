# What Mailda needs from your Cloudflare account

Every setting a Node depends on, in one place, with the two ways each can be put there.

**The intended experience is that an operator never opens the Cloudflare dashboard.** Mailda runs in the
customer's own account (ADR 7), and for a non-technical operator the dashboard is the hardest part of that
premise. So `mailda install` does the account work at install with wrangler's login, the one consent the
operator already gave ([`wrangler-login-reach.md`](./receipts/wrangler-login-reach.md)), and for changes
made later from a browser the Node can carry its own grant (ADR 42,
[`cloudflare-grant.md`](./cloudflare-grant.md)), which is optional. **The dashboard path is kept**, on
purpose. A builder who wants to arrange the account by hand, or who already has, is told exactly what
Mailda expects and how `doctor` checks it, rather than being asked to trust a button.

Two rules hold across the table:

- **The Node never assumes a setting is there.** Each row names the `doctor` check that reads the truth from
  the account or from evidence, so a setting made either way is verified the same way.
- **Nothing here is a secret Mailda holds for you.** The credential the install uses is your own wrangler
  login, carried on one request; the optional stored one is an API token you made, wrapped in *your* Node.
  The dashboard path involves no Mailda credential at all.

| What | Why Mailda needs it | From Mailda | By hand in the dashboard | `doctor` check |
|:--|:--|:--|:--|:--|
| **Workers Paid plan** | Free forces 24-hour queue retention; a delivery event stuck a day is deleted silently (ADR 25) | Cannot. A Worker cannot read its own account's plan | Billing → Workers & Pages → Paid | `workers_paid_plan` reports *unverified* and names where to look. This is the one row nothing can verify. |
| **The Worker and its bindings**: D1 `CATALOG`, R2 `EVIDENCE`, Durable Objects, the `SENDING_EVENTS` queue, the `BUTLER_RUNS` Workflow, the every-minute cron | The Node's own storage and machinery | `mailda deploy`, or the Deploy button. Wrangler provisions every binding from `wrangler.jsonc` with no account-specific id (ADR 24) | Not recommended. The names derive from the Worker's, and a hand-made resource is one wrangler will not adopt ([`deploy-plan`](../packages/cli/src/deploy-plan.mjs)) | `catalog_reachable`, `evidence_bucket_reachable`, `migrations_applied`, `key_vault`, `butler_execution` |
| **Schema applied** | An empty catalog answers 500 | Automatic on claim, or `POST /api/prepare` | `wrangler d1 migrations apply CATALOG --remote` | `migrations_applied` |
| **The Node's own credential**, optional | Changing the Cloudflare setup from the browser later: another receiving domain, a sending domain, a routing-rule takeover, buying a domain. The install and the upgrade need none of it, they carry wrangler's login on one request | `PUT /api/provider/token` (`/setup` → *connect this Node*; `mailda provider --token`, read from stdin): an API token, verified against `GET /user/tokens/verify`, bound to the one account it sees, stored wrapped like the sending token; `DELETE` forgets it. Permissions: Account Settings Read, Zone Read, Zone Settings Edit, Email Routing Rules Edit, Queues Edit, the Email Sending group; Registrar Domains Read only to buy domains | My Profile → API Tokens → Create Token → Custom, those permissions, restricted to this account; paste it once. Superseded the OAuth client on 26 September 2026 (ADR 42) | `provider_token` reports `no_token`, `token_held` or `token_refused` |
| **Email Routing on the zone**, MX and SPF records, and a rule routing your address to this Worker | Inbound mail reaches the Node only through a routing rule to its `email` handler | At install, with wrangler's login (`mailda install`; `mailda upgrade` for a Node never set up): the same route with the operator's credential on the request. Later, `POST /api/provider/receiving` through the grant (`/setup` → *receiving*; `mailda provider --onboard-receiving`). Proposes the records and the rule, confirmed by digest, enables routing on the zone if it is off (#209, #210). The records are Email Routing's own: the subdomain-records endpoint names what is missing and, after enabling, lists what is there, and an apex's records come with enabling routing on the zone; raw DNS is not read or written for receiving (measured 25 and 26 September 2026, [`wrangler-login-reach.md`](./receipts/wrangler-login-reach.md)). A rule that already routes the address elsewhere is listed and taken over from the same screen, with a put-back (#258, `GET /api/provider/routing-rules`). On a zone's own name the proposal offers the **catch-all** instead (25 September 2026): one rule, every address managed on People; on a subdomain Cloudflare allows literal rules only, and adding an address on People writes its rule in the same act | Email → Email Routing → enable; DNS → add the MX and SPF records it shows; Routing rules → *Send to a Worker* → this Node's Worker, or on an apex the catch-all → *Send to a Worker*. Taking a subdomain back **out** of routing is dashboard-only unless a grant with `dns.write` exists: wrangler's login may create those records and may not delete them (measured) | `inbound_routing`, from evidence: addresses that have received, and silence since |
| **A sending domain** onboarded for Email Sending, with DKIM, SPF and DMARC records | Arbitrary recipients require a verified sending domain; paying for Workers is not enough | At install, with wrangler's login (`mailda install`; `mailda upgrade`). Later, `POST /api/provider/sending` through the grant (`/setup` → *sending*; `mailda provider --onboard-sending`). Records proposed, confirmed by digest, verified by reading them back | Email → Email Sending → add domain; DNS → add the records it shows | `transport_adapters` (which adapter can carry mail), and the send ladder itself: `handed_over` → `accepted` / `bounced` |
| **The `send_email` binding**, or REST credentials | The transport | The binding ships in `wrangler.jsonc`; REST credentials are the fallback for a Node that cannot be redeployed: `PUT /api/transport` | Workers → Settings → Bindings, or an Email Sending API token pasted into `PUT /api/transport` | `transport_adapters` |
| **Delivery outcomes**: the `email.sending` event subscription publishing to `SENDING_EVENTS`, and a consumer on that queue | Without both, every send sits *unobserved* forever and nothing looks wrong | At install, with wrangler's login (`mailda install`; `mailda upgrade`). Later, the subscription: `POST /api/provider/subscription` through the grant (`/setup` → *delivery outcomes*; `mailda provider --subscribe <domain>`), proposed and confirmed by digest, for a domain already onboarded for sending ([receipt](./receipts/email-sending-events.md)). `GET /api/provider/delivery-events` names which of the three is missing. The same confirm attaches this Worker as the queue's consumer when nothing consumes it (measured 16 September 2026: `POST /accounts/{id}/queues/{id}/consumers`); `queue:attach-consumer` remains for a Node with no grant | Queues → the `SENDING_EVENTS` queue → Settings → consumer: this Worker. The subscription: Email → Email Sending → the domain → events → this queue | `sending_events_consumer`, `delivery_visibility`, `delivery_attribution` |
| **A domain**, if you do not have one | Optional | `GET /api/provider/domains` to price, `POST /api/provider/domains/purchase` confirmed by digest (`mailda provider --buy`) | Domain Registration | none |
| **A hostname for the Node** | The Node answers on `<worker>.<account>.workers.dev` by default; a name of your own reads better on every link the Node hands out | The install and the upgrade ask for one (a zone from the list, then the label) and write it into the Node's derived config; a first deploy attaches it, the canary path keeps it, and an upgrade adding one runs `wrangler triggers deploy` ([receipt](./receipts/worker-custom-domain.md)). Remembered in `.mailda/nodes.json` | Workers → Settings → Domains & Routes | none: the hostname the Node is reached on is whatever answered; nothing in the Node depends on which |

## Reading the table

- **From Mailda** means the Node does it through its own grant, shows what it is about to do, and acts only
  on a confirmation bound to a digest of that exact proposal (`cloudflare-grant.md`, *Onboarding a domain
  for sending*). It never acts on a stale plan.
- **By hand** is the same end state. The Node does not know or care which path produced it; `doctor` reads
  the account, or the evidence, either way.
- **One row needs a person at the provider**, the optional token, and only when the browser is to change the
  Cloudflare setup later: API tokens are made in the dashboard, one form, restricted to this account. The
  ordinary path needs no row of the dashboard at all (`docs/receipts/wrangler-login-reach.md`). The `email.sending`
  subscription was on this list until 16 September 2026, when the API turned out to create one; the Node
  creates it now (#222).
- **One row cannot be verified at all**: the plan. `doctor` says so rather than reporting `ok`.

## What is still owed

- Attaching the consumer through the *grant* is unmeasured. The API attaches it (measured with the
  operator's token), the live Node's consumer was already attached by the deploy, and no Node without one
  has been available to try. `queues.write` is the candidate.
- A grant consented before 16 September 2026 is short of `zone-settings.write`, `dns.write`,
  `queues.write` and `email-routing-rule.write`. `/setup`, `mailda provider` and `doctor` all say so and
  name the two steps (add them to the OAuth client, authorize again). Measured that day: `queues.write`
  creates the subscription, and the routing rule needs `email-routing-rule.write`. A grant holding only
  `zone-settings.write` and `dns.write` wrote the MX records and was refused the rule, which is how the
  receiving proposal learned to resume its own half-done work rather than refuse it. Since 26 September
  2026 `dns.write` is not asked for at all: receiving reads and writes Email Routing's own records through
  its own endpoints and never touches raw DNS, so a grant is seven scopes plus `offline_access`.
- A custom hostname from Mailda, so the last dashboard-only row goes.

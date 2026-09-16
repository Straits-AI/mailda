# What Mailda needs from your Cloudflare account

Every setting a Node depends on, in one place, with the two ways each can be put there.

**The intended experience is that an operator never opens the Cloudflare dashboard.** Mailda runs in the
customer's own account (ADR 7), and for a non-technical operator the dashboard is the hardest part of that
premise — so the Node carries its own grant (ADR 42, [`cloudflare-grant.md`](./cloudflare-grant.md)) and
does the account work itself, from `/setup` or `mailda provider`. **The dashboard path is kept**, on
purpose: a builder who wants to arrange the account by hand, or who already has, is told exactly what
Mailda expects and how `doctor` checks it, rather than being asked to trust a button.

Two rules hold across the table:

- **The Node never assumes a setting is there.** Each row names the `doctor` check that reads the truth from
  the account or from evidence, so a setting made either way is verified the same way.
- **Nothing here is a secret Mailda holds for you.** The grant is the Node's own OAuth client in *your*
  account; the dashboard path involves no Mailda credential at all.

| What | Why Mailda needs it | From Mailda | By hand in the dashboard | `doctor` check |
|:--|:--|:--|:--|:--|
| **Workers Paid plan** | Free forces 24-hour queue retention; a delivery event stuck a day is deleted silently (ADR 25) | Cannot — a Worker cannot read its own account's plan | Billing → Workers & Pages → Paid | `workers_paid_plan` reports *unverified* and names where to look. This is the one row nothing can verify. |
| **The Worker and its bindings** — D1 `CATALOG`, R2 `EVIDENCE`, Durable Objects, the `SENDING_EVENTS` queue, the `BUTLER_RUNS` Workflow, the every-minute cron | The Node's own storage and machinery | `mailda deploy`, or the Deploy button — wrangler provisions every binding from `wrangler.jsonc` with no account-specific id (ADR 24) | Not recommended: the names derive from the Worker's, and a hand-made resource is one wrangler will not adopt ([`deploy-plan`](../packages/cli/src/deploy-plan.mjs)) | `catalog_reachable`, `evidence_bucket_reachable`, `migrations_applied`, `key_vault`, `butler_execution` |
| **Schema applied** | An empty catalog answers 500 | Automatic on claim, or `POST /api/prepare` | `wrangler d1 migrations apply CATALOG --remote` | `migrations_applied` |
| **The OAuth client** for the Node's grant | Everything below that says *from Mailda* is done through it | Guided: `/setup` and `GET /api/provider` print the five steps with the redirect URI filled in; the client id and secret are pasted once | **Unavoidable by hand** — a private OAuth client is created by a person signed in to the account; there is no API for it. Grant types must include `refresh_token` or the grant dies in an hour | `provider_binding`, `provider_oauth_endpoints` |
| **Consent**, with the scopes the ceremony lists | The grant is only as wide as what was consented to | The consent URL from `/setup`; Cloudflare's own sign-in and prompt | The same — consent is always a person in a browser | `provider_binding` names any scope declined |
| **Email Routing on the zone**, MX and SPF records, and a rule routing your address to this Worker | Inbound mail reaches the Node only through a routing rule to its `email` handler | `POST /api/provider/receiving` (`/setup` → *receiving*; `mailda provider --onboard-receiving`) — proposes the records and the rule, confirmed by digest, enables routing on the zone if it is off (#209, #210) | Email → Email Routing → enable; DNS → add the MX and SPF records it shows; Routing rules → *Send to a Worker* → this Node's Worker | `inbound_routing` — from evidence: addresses that have received, and silence since |
| **A sending domain** onboarded for Email Sending — DKIM, SPF and DMARC records | Arbitrary recipients require a verified sending domain; paying for Workers is not enough | `POST /api/provider/sending` (`/setup` → *sending*; `mailda provider --onboard-sending`) — records proposed, confirmed by digest, verified by reading them back | Email → Email Sending → add domain; DNS → add the records it shows | `transport_adapters` (which adapter can carry mail), and the send ladder itself: `handed_over` → `accepted` / `bounced` |
| **The `send_email` binding**, or REST credentials | The transport | The binding ships in `wrangler.jsonc`; REST credentials are the fallback for a Node that cannot be redeployed: `PUT /api/transport` | Workers → Settings → Bindings, or an Email Sending API token pasted into `PUT /api/transport` | `transport_adapters` |
| **Delivery outcomes**: the `email.sending` event subscription publishing to `SENDING_EVENTS`, and a consumer on that queue | Without both, every send sits *unobserved* forever and nothing looks wrong | The subscription: `POST /api/provider/subscription` (`/setup` → *delivery outcomes*; `mailda provider --subscribe <domain>`) — proposed and confirmed by digest, for a domain already onboarded for sending ([receipt](./receipts/email-sending-events.md)). `GET /api/provider/delivery-events` names which of the three is missing. The consumer is still attached out of band: `pnpm --filter @mailda/worker run queue:attach-consumer` | Queues → the `SENDING_EVENTS` queue → Settings → consumer: this Worker. The subscription: Email → Email Sending → the domain → events → this queue | `sending_events_consumer`, `delivery_visibility`, `delivery_attribution` |
| **A domain**, if you do not have one | Optional | `GET /api/provider/domains` to price, `POST /api/provider/domains/purchase` confirmed by digest (`mailda provider --buy`) | Domain Registration | — |
| **A hostname for the Node** | The Node answers on `<worker>.<account>.workers.dev` by default | Not built: a custom domain is a dashboard setting today | Workers → Settings → Domains & Routes | The redirect URI check in `provider_binding`: the grant's callback must be the hostname the Node is reached on |

## Reading the table

- **From Mailda** means the Node does it through its own grant, shows what it is about to do, and acts only
  on a confirmation bound to a digest of that exact proposal (`cloudflare-grant.md`, *Onboarding a domain
  for sending*). It never acts on a stale plan.
- **By hand** is the same end state. The Node does not know or care which path produced it; `doctor` reads
  the account, or the evidence, either way.
- **One row cannot be done from Mailda**, and the reason is measured rather than assumed: the OAuth client
  — no API exists for a private client. It is named in the handover manifest `mailda provider --handover`
  prints as *what a person must still do at the provider*, with the receipt that established it. The
  `email.sending` subscription was on this list until 16 September 2026, when the API turned out to create
  one; the Node creates it now (#222).
- **One row cannot be verified at all**: the plan. `doctor` says so rather than reporting `ok`.

## What is still owed

- The queue consumer is the one delivery-outcomes object still attached out of band, by a wrangler call
  rather than through the grant. Whether the API attaches it through the grant is unmeasured.
- A grant consented before 16 September 2026 is short of `zone-settings.write`, `dns.write` and
  `queues.write`; `/setup`, `mailda provider` and `doctor` all say so and name the two steps (add them to the
  OAuth client, authorize again). Measured that day: `queues.write` creates the subscription.
- A custom hostname from Mailda, so the last dashboard-only row goes.

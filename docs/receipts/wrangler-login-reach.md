---
id: wrangler-login-reach
kind: platform-limit
measured_on: 2026-09-25
stale_when: >
  wrangler's login scope list changes (24 scopes on 4.90.1; `wrangler login --scopes-list` is the record);
  Cloudflare changes which permission group governs POST or DELETE /zones/{zone_id}/email/routing/dns, or
  the routing rules endpoints, or /accounts/{account_id}/event_subscriptions/subscriptions; or the registrar
  or raw DNS endpoints start answering an `email_routing:write`-shaped token
values:
  wrangler.login_creates_subdomain_routing_records: 1
  wrangler.login_deletes_subdomain_routing_records: 0
  wrangler.login_reaches_raw_dns_records: 0
  wrangler.login_reaches_registrar: 0
  wrangler.login_writes_zone_catch_all: 1
  wrangler.login_creates_event_subscription: 1
---

# What wrangler's login can do in the account, measured for the install

**The question.** Whether `mailda install` can set a Node up to receive, send and observe delivery outcomes
with the consent the operator already gave to wrangler, so the Node's own grant (ADR 42) stops being on the
critical path. The grant asks for eight scopes; wrangler's login carries `zone:read`, `email_routing:write`,
`email_sending:write` and `queues:write` among its 24, and the Node's provisioning code reaches Cloudflare
through exactly those permission groups for everything but two endpoints.

**Measured** on 25 September 2026 with wrangler 4.90.1's login token (refreshed by `wrangler whoami`), in
account `1e0170…`, on the zone `mailda.site`. Reads first, then writes on the throwaway subdomain
`probe.mailda.site`, then cleanup.

| endpoint | method | answer |
|:--|:--|:--|
| `/zones?account.id=…` | GET | 200 |
| `/zones/{zone}/email/routing` | GET | 200, `enabled: true, status: ready` |
| `/zones/{zone}/email/routing/rules` | GET | 200 |
| `/zones/{zone}/email/routing/dns?subdomain=probe.mailda.site` | GET | 200 |
| `/accounts/{account}/event_subscriptions/subscriptions` | GET | 200 |
| `/accounts/{account}/queues` | GET | 200 |
| `/zones/{zone}/email/sending/subdomains` | GET | 200 |
| `/accounts/{account}` | GET | 200 |
| `/zones/{zone}/dns_records` | GET | **403** |
| `/accounts/{account}/registrar/domains` | GET | **403** |
| `/zones/{zone}/email/routing/dns` `{name: probe.mailda.site}` | POST | **200**; three MX records appeared in public DNS (`route1/2/3.mx.cloudflare.net`, priorities 96/75/44) |
| `/zones/{zone}/email/routing/rules` (a disabled `drop` rule) | POST | **200**, with an id |
| `/zones/{zone}/email/routing/rules/{id}` | DELETE | 200 |
| `/zones/{zone}/email/routing/dns` (body `{name}` and `?name=`) | DELETE | **403** `10000 Authentication error` |
| `/zones/{zone}/email/routing/rules/catch_all` (mailda.site's own content: disabled, `drop`) | PUT | **200**; read back unchanged. A no-op write, chosen so the permission is measured without moving any mail |

The apex `mailda.site` was untouched throughout; its MX records were the same before and after.

**What this establishes.** With wrangler's login the CLI can enable routing for a subdomain (the endpoint
writes the MX records itself, so `dns.write` is not needed for that), write and delete a routing rule, and
read every state the Node's Setup screen reads. Delivery-events subscriptions and the queue are read under
the same permission group (`queues:write`) that the 16 September measurement in
[`queue-provisioning.md`](./queue-provisioning.md) found creates the subscription. So the install can leave
a Node receiving, sending and observing outcomes without the Node holding any grant. The two things it
cannot do are raw DNS records and the registrar, which is domain purchase.

**What it does not establish.** The sending-domain onboarding *write* was not run with wrangler's token:
the first real run below met a domain already onboarded, so it stays a same-permission-group inference. The
subscription write is measured, below. And nothing here is about the grant: a Node that holds one still
reaches exactly what `cloudflare-oauth-scopes.md` says.

**The boundary it draws.** Wrangler's token may create a subdomain's routing records and may not remove
them, and it may write a zone's catch-all (measured later the same day, when the apex catch-all became the
receiving step's offer for a zone's own name). Taking a subdomain back out of Email Routing is therefore a dashboard act, or an act of a grant
holding `dns.write`, and the settings table says so rather than offering an undo the install cannot make.
And since receiving reads and writes only Email Routing's own records (26 September 2026), `dns.write` is
not in the grant either. The cost of that: a subdomain whose MX already points at a foreign mail host is
not detectable through the routing endpoints, which report only Cloudflare's records, so the records are
written beside a foreign MX rather than refused. The proposal used to refuse that case by reading raw DNS.

**Residue.** The cleanup's last step was refused, so `probe.mailda.site` kept its three MX records; they
are removed by hand in the dashboard (the zone's DNS, three MX records named `probe`). Harmless meanwhile:
mail to that subdomain bounces, and nothing routes it.

## The first real run (25 September 2026)

The founder's Node `mailda-whymelabs`, the apex `whymelabs.com`, wrangler's login token carried on the
operator headers. Four outcomes:

- **The zone picker worked.** `whymelabs.com` was picked from the account's list.
- **Receiving refused, and the refusal was ours.** The proposal read `GET /zones/{zone}/dns_records` to learn
  the MX already on the apex, and the token answered `10000 Authentication error`: the raw-DNS boundary the
  table above records. The CLI then printed a `fix` that blamed the domain ("must be a subdomain of a zone"),
  which was wrong. The catch-all question was never reached.
- **Sending: `onboarded already`.** The domain had been onboarded for sending earlier, so no write happened
  and none was measured.
- **Delivery outcomes: the subscription was created.** `mailda-whymelabs-sending-events-whymelabs.com`,
  publishing message.delivered, deferred, bounced, failed, rejected and complained into
  `mailda-whymelabs-sending-events`. That is the subscription write with wrangler's token, `queues.write`'s
  permission group, and the value `wrangler.login_creates_event_subscription` records it.

**Measured afterwards** (26 September 2026 UTC, same token): Email Routing's own records endpoint is both the
plan and the read-back, so raw DNS is not needed for receiving at all.

| state | `GET /zones/{zone}/email/routing/dns` |
|:--|:--|
| a subdomain never enabled, `?subdomain=probe2.mailda.site` | `errors: [{code: "mx.missing", missing: {…the MX record…}} ×3, {code: "spf.missing", …}]`, no `records` |
| a subdomain enabled, `?subdomain=probe.mailda.site` | `errors: null, records: [MX ×3, TXT spf]` |
| an apex with routing `ready`, no query | the zone's own records: MX ×3, the DKIM TXT, … |

So a subdomain's plan is the `missing` list, its read-back is `errors: null` with `records`, and an apex's
records come with enabling routing on the zone. The receiving code is being rewritten onto these
endpoints; the raw-DNS boundary above then bounds nothing the install does.

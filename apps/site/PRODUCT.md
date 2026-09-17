# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: Astro with Starlight for the docs, static output, deployed as a Cloudflare Worker with static assets from the same account as the Node (`swmengappdev`), at `mailda.site`. Chosen because the docs are Markdown already in `docs/` and Starlight renders Markdown with navigation and search for no runtime; a Worker rather than Pages because every other Mailda artefact deploys with `wrangler` and one toolchain is one thing to learn. Lives at `apps/site` in the monorepo so a PR moves code and its docs together (AGENTS.md).

## Users

Builders first — technical founders and engineers who will run `mailda deploy` into their own Cloudflare account, read the receipts, and hold the Node to what it says. Second, the small-business owner who signs off on it: they read one plain-language strip and want to know what it costs, what it will not do, and that they own the data. (User's answer, 18 September 2026.)

## Product Purpose

Mailda is an open-source, customer-owned mail-operations system deployed into the customer's own Cloudflare account: shared inboxes with a queue, cases and response clocks; sending with a policy plane, approvals and breakers; deterministic Butlers that act on mail; a governance ledger (audit, matters, holds, exports). It exists so a small team can run operational mail without handing it to a vendor. Success is a Node a builder installs in an afternoon and can explain to their owner in a sentence.

## Positioning

"I don't want AI in your app, I want your app in my AI." The product is a Node in *your* account with a contract-generated SDK, Skill and MCP surface; nothing runs on Mailda's servers, and there is no Mailda control plane (ADR 43). Every number in the product has a receipt (`docs/receipts/`), every limit is stated, and the README lists what is thin before what is good. A neighbouring product cannot truthfully copy "you own the Worker, the database and the bill".

## Capabilities

Receiving through Cloudflare Email Routing; reading with SPF/DKIM/DMARC verdicts, attachment and link judgement, quarantine; threads, labels, read state; composing with Cc/Bcc, reply-all, forwarding, attachments, drafts; queue with claim/hand-over/close and response clocks; policies, approvals, domain pauses, breakers, suppression; Butlers (deterministic, refused `llm.*` nodes); people, teams, passkeys, delegated agents with pinned capability ceilings; matters, holds, supervised reads, e-discovery exports; backup and a drilled restore; doctor; a CLI; a generated SDK, Skill and MCP server.

## Constraints

- Cloudflare only; Workers Paid required (ADR 25). No IMAP/JMAP/SMTP mailbox service. No Gmail/M365 import. 5 MiB outbound, 50 recipients, transactional only.
- No control plane, no telemetry, nothing fetched from Mailda at runtime — the site must make no claim that implies one.
- Claims on the site come from README.md and docs/; nothing invented (no testimonials, customers, benchmarks, pricing beyond Cloudflare's published prices as the README states them).
- Apache-2.0; repository `github.com/Straits-AI/mailda`.

## Terminology

Node (one deployed Worker + its D1/R2), mailbox, case, queue, Butler, policy, receipt, tripwire, landmine, doctor, matter, hold, export, grant.

## Evidence

README.md (386 lines, the gap table is the honest inventory), docs/*.md, docs/receipts/*.md (every constant's provenance), docs/disaster-recovery.md (three drills with timings).

## Brand commitments

The brand sheet (three PNGs, 28 August 2026): Ink `#0F1720`, Flow Blue `#4C77B8`, Sky `#E6EEF7`, Mist `#F2F4F7`, White; Satoshi for headings (not shipped — Plus Jakarta Sans stands in), Inter for body; the continuous-line M with a blue dot (traced, `apps/node/worker/src/brand.ts`); a subtle continuous-line brand pattern for backgrounds; the four values Intelligent · Reliable · Flowing · Helpful. Tagline on the stationery: "Connected communication. Flowing forward." The product UI in `apps/node/worker/src/ui.ts` is the incumbent expression of this world.

## Accessibility

WCAG AA, as the product holds itself to (axe-clean, contrast tokens receipted). Light and dark.

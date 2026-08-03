# Deploy-button probe (#14)

Throwaway. Answers one question the Cloudflare docs leave open: **when a Deploy to
Cloudflare button installs a two-Worker application, what gets provisioned, by which
credential, and in what order?**

The shape mirrors a real Mailda Node per ADR 18 and ADR 22 — `effects` holds a value and no
data binding; the root Worker holds every data binding — and the deploy command chains them
in the order #4 requires, since the root Worker service-binds to `effects`.

The root Worker's `wrangler.jsonc` sits at the top of this directory deliberately: the button
reads *"the Wrangler configuration file of your source repo"* to determine what to provision,
so a config in a subdirectory would likely be invisible to it.

Every resource in `wrangler.jsonc` is declared **without an id**, which is what asks
Cloudflare to provision it.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Straits-AI/mailda/tree/main/probes/deploy-button)

## What to record

- Which resources appeared, and under what names.
- Whether the chained `deploy` script ran, or only `wrangler deploy` on one Worker.
- Whether `effects` deployed before `node`, so the service binding resolved.
- Whether resource ids were written back into the cloned repo's wrangler configs — this
  bears on ADR 24, which assumes the fork stays byte-identical to upstream.
- Whether the Durable Object namespace and the queue were created.
- What permissions the generated Workers Builds token holds.

Then fetch the deployed `node` Worker: it reports what actually bound.

## Cleanup

Delete both Workers, the D1 database, the R2 bucket and the queue, then delete this
directory and the cloned repo.

# mailda.site

The landing page and the documentation, one static site, one Worker with assets.

- `/` — the README's **Status** table, rendered as a `mailda doctor` report (`src/gaps.ts` reads it; `src/components/Landing.astro` lays it out). The `ok` rows link to the doc that earns them; the `warn` rows are the README's own words.
- `/docs/*` — `README.md`, `AGENTS.md`, `docs/*.md` and `docs/receipts/*.md`, rendered by `scripts/generate-docs.mjs` on every build into `src/content/docs/docs/` (gitignored). A receipt's frontmatter is shown as the record, not swallowed as page metadata.

No page carries a claim that is not in the repository's Markdown, so the site cannot say something the README does not. `test/build.test.mjs` fails the build if a doc has no page, a status row is missing from the landing, or anything loads from another origin.

```sh
pnpm dev                       # astro dev, regenerates docs first
pnpm test                      # build, then the three checks above
CLOUDFLARE_ACCOUNT_ID=… pnpm deploy   # wrangler deploy: custom domains mailda.site and www.mailda.site
```

Fonts and the mark are copies of `apps/node/worker/fonts` and `brand.ts`'s geometry; the palette in `src/styles/site.css` is the Node's, mapped onto Starlight's tokens.

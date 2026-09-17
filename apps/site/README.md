# mailda.site

The landing page and the documentation, one static site, one Worker with assets.

`/` is the README's Status table laid out as a `mailda doctor` report. `src/gaps.ts` reads the table, `src/components/Landing.astro` lays it out. The `ok` rows link to the doc that earns them. The `warn` rows are the README's own words.

`/docs/*` is `README.md`, `AGENTS.md`, `docs/*.md` and `docs/receipts/*.md`. `scripts/generate-docs.mjs` renders them into `src/content/docs/docs/` (gitignored) on every build, and shows a receipt's frontmatter as the record instead of swallowing it as page metadata.

Every claim on the site comes from the repository's Markdown, so the site cannot say something the README does not. `test/build.test.mjs` fails the build if a doc has no page, a status row is missing from the landing, or anything loads from another origin.

```sh
pnpm dev                       # astro dev, regenerates docs first
pnpm test                      # build, then the three checks above
CLOUDFLARE_ACCOUNT_ID=… pnpm deploy   # wrangler deploy: custom domains mailda.site and www.mailda.site
```

The fonts are copied from `apps/node/worker/fonts`, the mark from `brand.ts`. The palette in `src/styles/site.css` is the Node's, mapped onto Starlight's tokens.

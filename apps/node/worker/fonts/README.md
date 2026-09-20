# The typeface this Node serves

One face in four weights, 97 KB, served from this origin at `/app/fonts/*.woff2` and referenced by `@font-face` in
`src/ui.ts`. **Nothing here is fetched from a third party at runtime**, which is the whole reason they are
committed rather than linked: Mailda's premise is custody, and a page that loads a font from someone else's
CDN hands that party every viewer's IP address on every load. There is no version of that consistent with
the promise.

| file | face | weight | bytes |
|:--|:--|--:|--:|
| `inter-400.woff2` | Inter | 400 | 23.1 KB |
| `inter-500.woff2` | Inter | 500 | 23.7 KB |
| `inter-600.woff2` | Inter | 600 | 23.9 KB |
| `inter-700.woff2` | Inter | 700 | 23.8 KB |

All four are the **Latin subset** as published by [Fontsource](https://fontsource.org), copied verbatim from
`@fontsource/inter@5.3.0`. Plus Jakarta Sans 600 and 700 were served as the heading face until 21 September
2026, when a browser audit found the interface set in three families and the product went to one; the two
files and their licence left with it. Not subset further and not modified in
any way — what is here is byte-identical to what those packages ship, which keeps provenance checkable.

That package is **not** a dependency of this repository. They were the source of the copy and nothing
imports them, so keeping them in `package.json` would be two entries in every customer's `node_modules` that
no code reaches. To reproduce or verify the copy:

1. `pnpm add -D @fontsource/inter@5.3.0` anywhere convenient.
2. Copy `files/inter-latin-{400,500,600,700}-normal.woff2` in, under the names in the table above.
3. Copy the package's `LICENSE` beside them.
4. `shasum` against what is already here — the files are unmodified, so they must match exactly.
5. Remove the package again.

Inter is **SIL Open Font License 1.1**, and the licence is beside the files as OFL §2 requires:
`LICENSE-Inter.txt`.

## Satoshi is in the brand and is deliberately not in this directory

The brand specifies **Satoshi** for headings. It is not here and must not be added.

Satoshi is licensed under the **ITF Free Font License**, which permits self-hosting and forbids modifying and
redistributing the font. Read against this repository, the second clause is the operative one: **this
repository is the distribution channel.** ADR 24 requires it byte-identical across installs because customers
*clone and merge from it* to get updates — so a font committed here is not self-hosted by one operator, it is
redistributed from a public URL to every customer of the product, and subsetting it for size is precisely the
modification the licence names.

So Satoshi is named **first in the heading stack and never shipped**:

```css
--display: Satoshi, "Plus Jakarta Sans", ...
```

A designer with Satoshi installed sees the brand exactly. Everybody else sees Plus Jakarta Sans, which is the
closest OFL face to Satoshi's geometric-humanist character and is the substitution the type community
generally reaches for. The degradation is visible rather than silent, and no licence is bent to get it.

**If Mailda later licenses Satoshi for redistribution**, adding it is a two-line change — the files here and
the first entry of `--display`, which already names it.

## Adding or changing a face

1. It must be OFL or otherwise explicitly redistributable. This repository is a distribution channel; treat
   every font here as being handed to every customer, because it is.
2. Copy the licence in beside it.
3. Update the table above, `FONT_FILES` in `src/ui.ts`, and the `@font-face` block.
4. Re-measure `docs/receipts/react-shell-bundle.md` — these bytes are served per Node and the receipt's
   `stale_when` names them.

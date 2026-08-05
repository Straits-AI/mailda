# Prototype — wayfinder #32

Throwaway. Nothing here is imported by the Worker, and this directory does not exist on `main`.

- `32-shell-variants.html` — three shells, `?variant=a|b|c`, switch with ← → or the bottom bar.
  Open it directly in a browser; there is no build step and no network access.
- `32-axe.mjs` — the accessibility harness seed. Runs axe-core against every variant in both themes:

  ```sh
  npm install axe-core playwright && npx playwright install chromium
  node apps/node/worker/prototype/32-axe.mjs
  ```

  Exits non-zero on any WCAG 2.2 AA violation. Currently clean: 3 variants x 2 themes.

It found two real defects while being written, which is the argument for building it with the first
screen rather than after — see the resolution notes on issue #32.

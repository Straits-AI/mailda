import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

/**
 * mailda.site: the landing page at `/` and the repository's docs at `/docs`.
 *
 * The docs are not written here. `scripts/generate-docs.mjs` copies `../../docs/*.md`, `README.md`,
 * `AGENTS.md` and the receipts into `src/content/docs` at build time, so the site is a rendering of the
 * repository and cannot say something the repository does not. Starlight brings navigation and search
 * with no runtime; nothing on this site is fetched from anywhere but its own origin (custody, as the Node).
 */
export default defineConfig({
  site: "https://mailda.site",
  integrations: [
    starlight({
      title: "Mailda",
      description: "Open-source, customer-owned mail operations, deployed into your own Cloudflare account.",
      logo: { src: "./src/assets/mark.svg", alt: "" },
      customCss: ["./src/styles/site.css"],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/Straits-AI/mailda" }],
      sidebar: [
        { label: "Start here", items: [{ label: "README", slug: "docs/readme" }, { label: "How decisions get made", slug: "docs/agents" }] },
        { label: "The product", autogenerate: { directory: "docs/product" } },
        { label: "Operating a Node", autogenerate: { directory: "docs/operating" } },
        { label: "Receipts", collapsed: true, autogenerate: { directory: "docs/receipts" } },
      ],
      head: [{ tag: "meta", attrs: { name: "color-scheme", content: "light dark" } }],
      lastUpdated: false,
      pagination: false,
      credits: false,
    }),
  ],
});

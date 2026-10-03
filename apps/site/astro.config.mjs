import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

/**
 * mailda.site: the landing page at `/` and the repository's docs at `/docs`.
 *
 * The docs are not written here. `scripts/generate-docs.mjs` copies `../../docs/*.md`, `README.md`,
 * `AGENTS.md` and the receipts into `src/content/docs` at build time, so the site is a rendering of the
 * repository and cannot say something the repository does not. Starlight brings navigation and search
 * with no runtime; nothing on this site is fetched from anywhere but its own origin (custody, as the Node).
 *
 * Two locales, as the Node has (docs/i18n.md): English at the root and Simplified Chinese under /zh-cn/, whose
 * menus, search and navigation are Starlight's own zh translations (it finds them from `lang`, zh-Hans to zh).
 * Most doc bodies exist only in English, so most of /zh-cn/docs/* is Starlight's fallback: the English page, marked
 * `lang="en"`, under its notice that this content is not available in your language yet. That notice is the
 * honest label, and nothing is copied on disk to make it. A doc translated in `docs/zh-cn/` is rendered at its slug
 * instead, and held to its English by a recorded hash (docs/i18n.md, *Doc translations*). The landing pages are `src/pages/index.astro` and
 * `src/pages/zh-cn/index.astro`.
 */
export default defineConfig({
  site: "https://mailda.site",
  integrations: [
    starlight({
      title: { en: "Mailda", "zh-Hans": "淼达" },
      defaultLocale: "root",
      locales: { root: { label: "English", lang: "en" }, "zh-cn": { label: "简体中文", lang: "zh-Hans" } },
      description: "Open-source, customer-owned mail operations, deployed into your own Cloudflare account.",
      logo: { src: "./src/assets/mark.svg", alt: "" },
      customCss: ["./src/styles/site.css"],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/Straits-AI/mailda" }],
      sidebar: [
        // The group labels in zh-Hans use the glossary's words: 节点 for Node, 测量记录 for a receipt (`receipt.measured`).
        {
          label: "Start here", translations: { "zh-Hans": "从这里开始" },
          items: [
            { label: "README", slug: "docs/readme" },
            { label: "How decisions get made", translations: { "zh-Hans": "决策方式" }, slug: "docs/agents" },
          ],
        },
        { label: "The product", translations: { "zh-Hans": "产品" }, autogenerate: { directory: "docs/product" } },
        { label: "Operating a Node", translations: { "zh-Hans": "运维节点" }, autogenerate: { directory: "docs/operating" } },
        { label: "Receipts", translations: { "zh-Hans": "测量记录" }, collapsed: true, autogenerate: { directory: "docs/receipts" } },
      ],
      head: [{ tag: "meta", attrs: { name: "color-scheme", content: "light dark" } }],
      lastUpdated: false,
      pagination: false,
      credits: false,
    }),
  ],
});

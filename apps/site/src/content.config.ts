import { defineCollection } from "astro:content";
import { docsLoader, i18nLoader } from "@astrojs/starlight/loaders";
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  // Starlight's zh words under the zh-Hans tag, written by scripts/generate-docs.mjs (it says why).
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};

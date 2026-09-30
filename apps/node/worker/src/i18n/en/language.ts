import type { Area } from "../areas.ts";

/** Settings > Language (`src/client/app/screens/language.tsx`). */
export const language = {
  "language.heading": "Language",
  "language.legend": "Language of this interface",
  "language.scope":
    "This browser's choice, never the Node's. Mail, names, and what this Node reports in its own words stay in the language they were written in.",
  "language.only": "English is the only language offered so far.",
  "language.flag": "This page is in {language} because its address asks for it. Nothing is saved: a page opened without that address uses your own choice.",
  "language.unreadable": "This browser would not let Mailda read a saved language, so each page starts in your browser's language, or English.",
  "language.draft": "Your draft was not saved on your Node, so the page was not reloaded to change language: {problem}",
} as const satisfies Area<"language">;

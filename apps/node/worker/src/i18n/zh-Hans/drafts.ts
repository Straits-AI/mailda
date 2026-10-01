import type { drafts as source } from "../en/drafts.ts";
import type { Twin } from "../catalog.ts";

export const drafts: Twin<typeof source> = {
  "drafts.empty": "没有草稿。",
  "drafts.noun": "份草稿",
  "drafts.noSubject": "（无主题）",
  "drafts.noRecipient": "还没有收件人",
};

import type { setup as source } from "../en/setup.ts";
import type { Twin } from "../catalog.ts";

export const setup: Twin<typeof source> = {
  "setup.rules.newMailbox": "新建邮箱，名为 {address}",
  "setup.rules.mailboxStays": "已为它新建邮箱 {name}，该邮箱会保留。",
  "setup.rules.filesInto": "将归入 {name}。",
  "setup.rules.nameNotRecorded": "它的名称没有记录原来的去向，因此只有本节点能把它恢复：请在删除本节点之前完成。",
};

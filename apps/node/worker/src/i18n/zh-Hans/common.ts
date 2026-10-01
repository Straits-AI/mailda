import type { common as source } from "../en/common.ts";
import type { Twin } from "../catalog.ts";

/** Each route's name is a glossary row (`glossary.ts`, `route.*`), still proposed. */
export const common: Twin<typeof source> = {
  "route./": "收件箱",
  "route./queue": "队列",
  "route./approvals": "审批",
  "route./rules": "规则",
  "route./people": "成员",
  "route./matters": "事项",
  "route./butlers": "管家",
  "route./agents": "代理",
  "route./limits": "限额",
  "route./outbox": "发件箱",
  "route./audit": "审计",
  "route./log": "日志",
  "route./doctor": "诊断",
  "route./setup": "配置",
  "route./drafts": "草稿",
  "route./archive": "归档",
  "route./trash": "回收站",

  "route./settings": "设置",
  "title.route": "{screen} · {brand}",
  "join.sentence": "",
};

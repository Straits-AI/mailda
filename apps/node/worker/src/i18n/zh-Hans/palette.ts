import type { palette as source } from "../en/palette.ts";
import type { Twin } from "../catalog.ts";

/** Aliases: the English word, the pinyin initials, then the full pinyin, lower case and space-separated. */
export const palette: Twin<typeof source> = {
  "palette.label": "命令面板",
  "palette.input": "前往或执行",
  "palette.placeholder": "前往或执行…",
  "palette.list": "命令",
  "palette.go": "前往{route}",
  "palette.search": "在邮件中搜索“{term}”",
  "palette.group.message": "当前邮件",
  "palette.group.mail": "邮件",
  "palette.group.go": "前往",
  "palette.alias.compose": "compose xyj xieyoujian",
  "palette.alias./": "inbox sjx shoujianxiang",
  "palette.alias./queue": "queue dl duilie",
  "palette.alias./approvals": "approvals sp shenpi",
  "palette.alias./rules": "rules gz guize",
  "palette.alias./people": "people cy chengyuan",
  "palette.alias./matters": "matters sx shixiang",
  "palette.alias./butlers": "butlers",
  "palette.alias./agents": "agents dl daili",
  "palette.alias./limits": "limits xe xiane",
  "palette.alias./outbox": "outbox fjx fajianxiang",
  "palette.alias./audit": "audit sj shenji",
  "palette.alias./log": "log rz rizhi",
  "palette.alias./doctor": "doctor zd zhenduan",
  "palette.alias./setup": "setup pz peizhi",
  "palette.alias./drafts": "drafts cg caogao",
  "palette.alias./archive": "archive gd guidang",
  "palette.alias./trash": "trash fzl feizhilou",
  "palette.alias./settings": "settings sz shezhi",
};

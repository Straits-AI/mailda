import type { approvals as source } from "../en/approvals.ts";
import type { Twin } from "../catalog.ts";

export const approvals: Twin<typeof source> = {
  "approvals.waiting": "{n} 项等你决定",
  "approvals.empty": "没有等你决定的事。",

  "approvals.kind.send_manifest.title": "一封等待发出的邮件",
  "approvals.kind.send_manifest.what": "一条规则要求这封邮件发出前再经一个人过目。",
  "approvals.kind.hold_lift.title": "解除法律保全",
  "approvals.kind.hold_lift.what": "批准后保全即告结束，它所保全的邮件将可以再次被删除。",
  "approvals.kind.supervised_read.title": "查阅他人的邮件",
  "approvals.kind.supervised_read.what": "批准后，申请人可以查阅一个他们没有常设关系的邮箱。事项结束时，邮箱的主人会收到通知（§7）。",
  "approvals.kind.ediscovery_export.title": "把邮件导出本节点",
  "approvals.kind.ediscovery_export.what": "批准后会生成一份匹配邮件的副本，它将离开本系统自身的管控。",
  "approvals.kind.domain_pause.title": "暂停一个域名的邮件",
  "approvals.kind.domain_pause.what": "批准后，发往该域名的每一封邮件都会暂停，直到有人解除暂停。",

  "approvals.subject": "对象",
  "approvals.askedBy": "申请人",
  "approvals.asked": "申请时间",
  "approvals.lapses": "失效时间",
  "approvals.noLapse": "不会失效",
  "approvals.needs": "需要",
  "approvals.needs.one": "需要一项审批",
  "approvals.needs.single": "需要 {n} 项审批",
  "approvals.needs.staged": "第 {stage} 阶段，共 {stages} 个阶段 · 总计 {n} 项审批",
  "approvals.supervised.matter": "范围 {scope} · 对象 {subject} · 事项 {matter}",
  "approvals.supervised.noMatter": "范围 {scope} · 对象 {subject} · 未引用事项",
  "approvals.domain": "域名 {domain}",

  "approvals.decided": "你已作出决定。",
  "approvals.takeBack": "收回我的决定",
  "approvals.approve": "批准",
  "approvals.deny": "否决",
};

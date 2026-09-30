import type { api as source } from "../en/api.ts";
import type { Twin } from "../catalog.ts";

export const api: Twin<typeof source> = {
  "api.no_reason": "本节点返回了 {status}，但没有说明原因。",
  "api.answered": "本节点返回了 {status}。",
  "api.answered.short": "返回了 {status}。",
  "api.revoked": "已吊销。",
  "api.refusal": "{code}  {what}\n  why      {why}\n  fix      {fix}",
  "api.refusal.code": "refused",
  "api.held.somebody": "他人",
  "api.held.message": "他人正在处理此工单。",
  "api.withdrawal.malformed": "access.revoked 记录 {id} 没有指明人员或对象：{detail}",
  "api.passkey.unsupported": "此浏览器不支持通行密钥。",
  "api.passkey.none": "未创建通行密钥。",

  "api.grant.mailbox.metadata.read": "查看有哪些邮件——发件人、主题、时间。不含邮件本身。",
  "api.grant.mailbox.content.read": "阅读邮件。",
  "api.grant.send.propose": "从此邮箱撰写和发送邮件，并认领其中的工单。",
  "api.grant.approval.decide": "对此邮箱的邮件作出审批决定，但不能审批自己的。",
  "api.grant.message.export": "将一封邮件的副本带出节点。",
  "api.grant.ediscovery.export": "针对一个事项执行批量导出。",
  "api.grant.org.admin": "管理组织：规则、管家、访问权限、法律保全和隔离。",

  "api.agent.mailbox.metadata.read": "查看有哪些邮件——发件人、主题、时间。不含邮件本身。",
  "api.agent.mailbox.content.read": "阅读邮件本身，包括原始字节。",
  "api.agent.send.propose": "从此邮箱起草并提交待发送的邮件。定稿发送不授予任何机器。",
  "api.agent.message.export": "将单封邮件的副本带出此邮箱。",

  "api.matter.legal_hold": "为履行法律义务而保全邮件。",
  "api.matter.security_incident": "调查账户被入侵或被滥用的情况。",
  "api.matter.departure_handover": "交接已离职人员的工作。",
  "api.matter.regulatory_request": "答复监管机构。",
};

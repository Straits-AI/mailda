import type { policies as source } from "../en/policies.ts";
import type { Twin } from "../catalog.ts";

/**
 * Rules are 规则 (confirmed), never 策略, which is DMARC's own policy. A rule's sentence is its clauses joined by
 * 、 before 的邮件, then the outcome: 来自 support、发给组织外部的人的邮件需要先经审批才能发出。A rule's deny is 否决
 * (the `send.denied` row), not 拒绝. The daily count is what this Node handed over (`send_counters.handed_over`),
 * so it says 移交, the word the Outbox's daily line uses, where the English still says "sent".
 */
export const policies: Twin<typeof source> = {
  "policies.new": "新建规则",
  "policies.notAdmin": "这里没有规则，或者你没有 org.admin。编写规则是管理员的操作。",
  "policies.empty": "还没有规则。每封邮件按邮箱及其关系所允许的方式发出。",
  "policies.caption": "每条规则做什么，按阅读顺序列出。一封邮件由与它匹配的最严格的规则决定，而不是第一条。",
  "policies.col.rule": "规则",
  "policies.col.does": "作用",
  "policies.col.version": "版本",
  "policies.col.since": "起始时间",
  "policies.col.edit": "编辑",
  "policies.version": "v{version}",
  "policies.draft": "草稿",
  "policies.unpublished": "（未发布：它还不决定任何事）",
  "policies.publish": "发布",
  "policies.open": "打开",

  "policies.outcome.allow": "照常发出",
  "policies.outcome.hold": "会被暂扣，等人放行",
  "policies.outcome.require_approval": "需要先经审批才能发出",
  "policies.outcome.deny": "会被此规则否决",

  "policies.rule.every": "每封邮件都{outcome}。",
  "policies.rule.when": "{conditions}的邮件{outcome}。",
  "policies.when.join": "、",
  "policies.when.mailbox": "来自{mailbox}",
  "policies.when.actor": "由{user}撰写",
  "policies.when.external": "发给组织外部的人",
  "policies.when.internal": "只发给同事",
  "policies.when.reply": "作为回复",
  "policies.when.newMessage": "作为新邮件",
  "policies.when.dmarcFail": "回复发件人域名不予认可的来信",
  "policies.when.notDmarcFail": "不是回复不予认可的来信",
  "policies.when.volume": "在本节点今天已移交 {count} 封之后",

  "policies.editor.label": "规则{name}",
  "policies.editor.name": "这条规则叫什么？",
  "policies.editor.mailbox": "哪个邮箱？",
  "policies.editor.mailbox.any": "任何邮箱",
  "policies.editor.to": "发给谁？",
  "policies.editor.to.any": "任何人：不作为本规则的条件",
  "policies.editor.to.external": "本组织以外的任何人",
  "policies.editor.to.internal": "只发给同事",
  "policies.editor.either": "两者皆可：不作为本规则的条件",
  "policies.editor.reply": "是回复吗？",
  "policies.editor.reply.only": "只限回复",
  "policies.editor.reply.new": "只限新邮件",
  "policies.editor.dmarc": "是否回复发件人域名不予认可的来信？",
  "policies.editor.dmarc.only": "只限回复 DMARC 未通过的来信",
  "policies.editor.dmarc.else": "其他所有邮件",
  "policies.editor.then": "然后这封邮件……",
  "policies.editor.approvals": "需要多少人批准？",
  "policies.editor.save": "保存草稿",
};

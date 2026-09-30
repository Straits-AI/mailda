import type { queue as source } from "../en/queue.ts";
import type { Twin } from "../catalog.ts";

/**
 * 队列。English "Release" and "held" each name two concepts here, and Chinese keeps them apart: a case is
 * 放回队列 (the `case.release` row) or held by a colleague, 他人处理中 (`case.held`); a delivery is 隔离
 * (`quarantine`) and let in with 放行.
 */
export const queue: Twin<typeof source> = {
  "queue.handTo.open": "转交给…",
  "queue.handTo.placeholder": "同事@…",
  "queue.handTo.label": "同事的登录邮件地址",
  "queue.handTo.submit": "转交",

  "queue.duration.underMinute": "不到 1 分钟",
  "queue.duration.minutes": "{n} 分钟",
  "queue.duration.hours": "{n} 小时 {m} 分钟",
  "queue.duration.days": "{n} 天 {h} 小时",
  "queue.age.justNow": "刚刚",

  "queue.clock.answered": "已回复",
  "queue.clock.targetPassed": "已于 {at} 超过目标时间",
  "queue.clock.overdue": "已逾期 {age}",
  "queue.clock.overdueJustNow": "刚刚逾期",
  "queue.clock.dueNow": "现在到期",
  "queue.clock.dueIn": "{until}后到期",

  "queue.restricted": "受限",
  "queue.restricted.subject":
    "你在此邮箱持有 send.propose，但两种读取关系都没有，所以主题不予显示。管理员可以授予 mailbox.metadata.read。",
  "queue.restricted.sender":
    "你在此邮箱持有 send.propose，但两种读取关系都没有，所以发件人不予显示。管理员可以授予 mailbox.metadata.read。",

  "queue.state.unclaimed": "未认领",
  "queue.state.mine": "由你处理",
  "queue.state.held": "他人处理中",
  "queue.pick": "选中「{subject}」以合并",
  "queue.pick.noSubject": "选中此工单以合并",
  "queue.noSubject": "（无主题）",
  "queue.case.messages": "{n} 封邮件",
  "queue.holder.you": "你",

  "queue.act.claim": "认领",
  "queue.act.release": "放回队列",
  "queue.act.close": "关闭",
  "queue.act.take": "接手",

  "queue.merged": "已合并。移动了 {n} 封邮件。",
  "queue.target.cleared": "此邮箱现在不承诺响应时间，所以它的工单不再计时。",
  "queue.target.set": "承诺在 {n} 分钟内首次回复。计时从下一封邮件开始。",
  "queue.target.none": "此邮箱不承诺响应时间，所以这里的工单都不计时。",
  "queue.target.promised": "承诺在 {n} 分钟内首次回复。",
  "queue.target.minutes": "分钟",
  "queue.target.label": "首次回复目标（分钟）；留空表示不作承诺",
  "queue.overdue": "{n} 个已逾期",

  "queue.quarantine.dmarc.on":
    "从现在起，发件人域名声明不属于它的来信（DMARC 未通过，p=reject 或 p=quarantine）会在这里隔离，交由管理员处理。",
  "queue.quarantine.attachments.on":
    "从现在起，带有可执行文件、脚本或伪装成文档的程序的来信会在这里隔离，交由管理员处理。",
  "queue.quarantine.off": "已关闭。已经隔离的来信会保持隔离，直到被放行。",
  "queue.quarantine.dmarc.label": "隔离发件人域名声明不属于它的来信",
  "queue.quarantine.dmarc.text": "隔离发件人域名声明不属于它的来信（DMARC 未通过，p=reject 或 p=quarantine）。",
  "queue.quarantine.attachments.label": "隔离带有危险附件的来信",
  "queue.quarantine.attachments.text": "隔离带有可执行文件、脚本或伪装成文档的程序的来信。",
  "queue.limits.saved": "附件限制已保存。它们从下一封收到的邮件和下一次发送起生效。",
  "queue.limits.maxSize": "单个附件上限（KB）",
  "queue.limits.noLimit": "不限",
  "queue.limits.typesPlaceholder": "任意类型；或填写 pdf, docx, png",
  "queue.limits.types": "允许的附件类型",

  "queue.released": "已放行。它现在在队列中，归入它本来会有的工单。",
  "queue.handedTo": "已转交给 {email}。它现在在对方的队列中，记录会写明你们两人。",

  "queue.mailbox": "邮箱",
  "queue.mailbox.option": "{name}（{n} 个未认领）",
  "queue.noMailbox": "你还不能处理本节点上的任何邮箱。管理员可以在某个邮箱上授予 send.propose。",

  "queue.held.count": "{n} 封已隔离",
  "queue.held.noun": "本节点上的隔离来信",
  "queue.held.table": "已隔离",
  "queue.held.col.at": "隔离时间",
  "queue.held.col.why": "原因",
  "queue.held.release": "放行",
  "queue.held.reason.held": "应要求隔离：{note}",
  "queue.held.noReason": "应要求隔离：未说明原因",
  "queue.held.reason.attachment_too_large": "带有超过此邮箱大小上限的附件。",
  "queue.held.reason.attachment_type_refused": "带有此邮箱不接受的类型的附件。",
  "queue.held.reason.attachment_dangerous": "带有可执行文件、脚本、伪装成文档的程序，或列出其中之一的压缩包。",
  "queue.held.reason.dmarc_fail_reject": "{domain}声明这封邮件不属于它，并要求收件方拒收。",
  "queue.held.reason.dmarc_fail_quarantine": "{domain}声明这封邮件不属于它，并要求收件方隔离。",
  "queue.held.fromDomain": "发件人域名",

  "queue.merge.picked": "已选中两个工单。",
  "queue.merge.do": "合并",
  "queue.merge.hint": "——多数合并会被拒绝，拒绝信息会指出需要先处理的那一对工单。",
  "queue.merge.clear": "清除",

  "queue.empty": "此队列中没有待处理的工单。",
  "queue.cases": "工单",
  "queue.col.state": "状态",
  "queue.col.subject": "主题",
  "queue.col.from": "发件人",
  "queue.col.holder": "处理人",
  "queue.col.response": "响应",
  "queue.col.action": "操作",
};

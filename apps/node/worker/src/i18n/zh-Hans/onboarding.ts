import type { onboarding as source } from "../en/onboarding.ts";
import type { Twin } from "../catalog.ts";

/**
 * 配置进度。A step's `phrase` is its label unchanged: Chinese has no capital to lower. "doctor" the check is 诊断,
 * the Doctor screen's word; the delivery-events queue is Cloudflare's, Cloudflare 队列, so 队列 alone is always the shared
 * Queue (the owner's round three, G11).
 */
export const onboarding: Twin<typeof source> = {
  "onboarding.step.address": "可接收邮件的邮件地址",
  "onboarding.step.address.phrase": "可接收邮件的邮件地址",
  "onboarding.step.routed": "邮件已路由到本节点",
  "onboarding.step.routed.phrase": "邮件已路由到本节点",
  "onboarding.step.sending": "已为发信接入的域名",
  "onboarding.step.sending.phrase": "已为发信接入的域名",
  "onboarding.step.outcomes": "能观测到投递结果",
  "onboarding.step.outcomes.phrase": "能观测到投递结果",
  "onboarding.step.connected": "已连接 Cloudflare",
  "onboarding.step.connected.phrase": "已连接 Cloudflare",

  "onboarding.state.done": "已完成",
  "onboarding.state.todo": "待完成",
  "onboarding.state.unknown": "未知",
  "onboarding.state.optional": "可选",

  "onboarding.record.install": "{domain}，于 {date}在安装时配置（这是一条记录，不是实时读取）",
  "onboarding.record.token": "{domain}，于 {date}通过持有的令牌配置（这是一条记录，不是实时读取）",
  "onboarding.record.observed": "{domain}，在本节点之前就已在 Cloudflare 上就绪，于 {date}观测到（这是一条记录，不是实时读取）",
  "onboarding.record.none": "尚未配置；安装程序或配置页面会完成它",

  "onboarding.domain": "{domain}：{said}",
  "onboarding.join": "；",
  "onboarding.required": "仍需 {n} 条记录",

  "onboarding.connected.unread": "无法读取连接状态",
  "onboarding.connected.account": "账户 {account}",
  "onboarding.connected.optional": "仅用于在此页面更改 Cloudflare 上的配置",
  "onboarding.notRead": "未读取",
  "onboarding.needsConnection": "需要先连接",
  "onboarding.address.unread": "无法读取诊断",
  "onboarding.address.unreported": "诊断没有报告入站路由",
  "onboarding.address.done": "已配置邮件地址",
  "onboarding.address.todo": "尚未配置邮件地址；请在成员页面添加",
  "onboarding.routed.unread": "无法用持有的令牌读取路由",
  "onboarding.routed.none": "还没有要路由的域名",
  "onboarding.routed.off": "未启用路由",
  "onboarding.delivery.unread": "无法用持有的令牌读取投递事件",
  "onboarding.sending.none": "还没有为发信接入的域名",
  "onboarding.sending.notOnboarded": "未为发信接入",
  "onboarding.sending.off": "未启用发信",
  "onboarding.outcomes.none": "还没有可订阅的内容",
  "onboarding.outcomes.noSubscription": "没有订阅",
  "onboarding.outcomes.off": "订阅未启用",
  "onboarding.outcomes.noQueue": "没有 Cloudflare 队列",
  "onboarding.outcomes.noConsumer": "Cloudflare 队列没有消费者",

  "onboarding.progress.label": "配置进度",
  "onboarding.progress.done": "已完成 {done}/{total} 步。",
  "onboarding.progress.next": "已完成 {done}/{total} 步；下一步：{next}。",
  "onboarding.progress.optional": "第五步是可选的。",

  "onboarding.unfinished.address": "配置尚未完成：{step}（{detail}）。",
  "onboarding.unfinished.routed": "配置尚未完成：邮件尚未路由到本节点。",
  "onboarding.unfinished.go": "前往配置",
};

import type { limits as source } from "../en/limits.ts";
import type { Twin } from "../catalog.ts";

export const limits: Twin<typeof source> = {
  "limits.title": "发信限额",

  "limits.breakers": "熔断器",
  "limits.breakers.caption": "本节点对自身施加的速率限制。每项限制都是经过测量的预算，而不是设置项——要修改，就得修改它的测量记录。",
  "limits.col.breaker": "熔断器",
  "limits.col.now": "当前",
  "limits.col.over": "统计窗口",
  "limits.col.seen": "样本数",
  "limits.col.state": "状态",
  "limits.reading.unarmed": "流量不足，无法判断",
  "limits.reading.count": "{observed}（上限 {limit}）",
  "limits.reading.percent": "{percent}%（上限 {limit}%）",
  "limits.window.days": { other: "{n} 天" },
  "limits.window.hours": { other: "{n} 小时" },
  "limits.window.minutes": { other: "{n} 分钟" },
  "limits.state.tripped": "正在阻止发信",
  "limits.state.armed": "已启用",
  "limits.state.unarmed": "未启用",
  "limits.state.unarmed.no_observations": "未启用——尚无观测数据",

  "limits.pauses": "已暂停的域名",
  "limits.pauses.lead": "暂停一个域名需要另外两名管理员批准，提出申请的人永远不算在内。解除暂停只需一名管理员独自操作，因为往谨慎方向犯的错应该容易撤销。",
  "limits.pauses.asked": "已提出申请。需要另外两名管理员批准，这个域名才会暂停。",
  "limits.pauses.domain": "域名",
  "limits.why": "原因",
  "limits.since": "开始时间",
  "limits.pauses.act": "申请暂停此域名",
  "limits.pauses.lift": "解除",
  "limits.pauses.liftAct": "恢复发信",
  "limits.pauses.empty": "没有已暂停的域名。",

  "limits.suppressed": "已抑制的收件人",
  "limits.suppressed.heading": "本节点不会向其发信的收件人",
  "limits.suppressed.lead":
    "服务商报告硬退信的邮件地址，或将邮件标记为垃圾邮件的邮件地址。发往其中任何一个的邮件都会在定稿时被拒，并指明是哪个地址。这里的条目不能手动添加；管理员可以附上原因为某个邮件地址作保，之后再次退信会让它重新回到列表。",
  "limits.suppressed.noun": "个邮件地址",
  "limits.suppressed.address": "邮件地址",
  "limits.cause.complaint": "被标记为垃圾邮件",
  "limits.cause.hard_bounce": "硬退信",
  "limits.vouch": "作保",
  "limits.vouch.why": "{address} 为何已恢复正常",
  "limits.suppressed.empty": "本节点上没有被抑制的邮件地址。",
};

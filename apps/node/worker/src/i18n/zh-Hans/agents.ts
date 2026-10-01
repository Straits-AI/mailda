import type { agents as source } from "../en/agents.ts";
import type { Twin } from "../catalog.ts";

export const agents: Twin<typeof source> = {
  "agents.lede": "以某个具名成员的权限行事的机器身份。它持有的永远不会超过那个人持有的，它的每一个操作都以两者的名义记入审计记录。",
  "agents.none": "本节点还没有签发过代理。",

  "agents.col.name": "名称",
  "agents.col.sponsor": "委托人",
  "agents.col.may": "可以做",
  "agents.col.where": "在哪里",
  "agents.col.standing": "状态",
  "agents.col.expires": "过期时间",
  "agents.col.withdraw": "收回",

  "agents.standing.revoked": "已吊销",
  "agents.standing.expired": "已过期",
  "agents.standing.live": "有效",
  "agents.held.partial": "{held}/{total}",
  "agents.unnamed": "本节点已不再命名的 {n} 条固定路由：",
  "agents.noMailbox": "没有邮箱",
  "agents.notEffective": "未生效——委托人已不再持有此权限",
  "agents.withdraw": "收回",

  "agents.mint.heading": "签发代理",
  "agents.mint.actingFor": "代表",
  "agents.mint.actingFor.note": "代理永远不会超过此人的权限，并在此人的访问权限终止时随之停止。",
  "agents.mint.name": "名称",
  "agents.mint.name.placeholder": "这个代理的用途",
  "agents.mint.may": "它可以做什么",
  "agents.mint.reachesContent": "可读取邮件内容",
  "agents.mint.which": "哪些邮箱，以及怎样使用",
  "agents.mint.which.note": "默认不授予任何权限，代理也永远不会超过它的委托人：委托人不持有的关系会在签发时被拒绝，而不是被写入后悄无声息地永远不匹配。",
  "agents.mint.noMailbox": "本节点上还没有邮箱。",
  "agents.mint.holdsNothing": "此人在这里没有任何权限",
  "agents.mint.days": "有效天数",
  "agents.review": "这个代理将持有 {capabilities}，涉及 {relations}，直到过期或被收回。",
  "agents.review.capabilities": "{n} 项能力",
  "agents.review.relations": "{n} 项邮箱关系",
  "agents.review.bounded": "只要委托人失去相应的访问权限，其中每一项都会随之停止——代理受其所代表的人约束，在每次请求时检查，而不是只在此刻检查。",
  "agents.review.unmet": "{capability} 需要在其其他关系所在的同一个邮箱上拥有 {missing}——这里没有一个邮箱同时具备全部关系，所以代理能通过认证，但会被拒绝。",
  "agents.mint.renewal": "没有刷新，以后也无法放宽上限——重新签发就是续期，它会发出一个新令牌。",
  "agents.mint.submit": "签发代理",
};

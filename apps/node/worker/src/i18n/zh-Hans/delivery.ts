import type { delivery as source } from "../en/delivery.ts";
import type { Twin } from "../catalog.ts";

/**
 * The labels are the glossary's confirmed words (`glossary.ts`, the `send.*`, `delivery.*` and `policy-hold`
 * rows, bound to these keys). The notes are proposed. "policy" is 规则 here although the English notes still say
 * policy (D1, fixed in English with the Rules screen in layer 2b). "The mail service" is 邮件服务商, the provider,
 * as in 服务商拒收. At the delivery scale a refusal by the receiving server is 退信, never 拒收.
 */
export const delivery: Twin<typeof source> = {
  "send.state.held": "暂留",
  "send.state.held.note": "尚未发送。你仍可以停止它。",
  "send.state.awaiting": "待放行",
  "send.state.awaiting.note":
    "未发送。一条规则拦下了这封邮件，它正在等人放行。是哪一道关卡，见旁边的原因：规则暂扣，任何可以用此邮箱发送的人都能放行；" +
    "或者审批，只有审批人能给出。",
  "send.state.cancelled": "已取消",
  "send.state.cancelled.note": "在发出前已停止。",
  "send.state.withheld": "扣发",
  "send.state.withheld.note":
    "未发送。本节点没有移交它，旁边的原因说明了为什么：规则否决了它，审批人否决了它，或者它获批时依据的条件在该发出时已经改变。" +
    "没有人取消它，也从未向邮件服务商提交。",
  "send.state.throttled": "限流中",
  "send.state.throttled.note": "被邮件服务商限流。它尚未发出，稍后会重试。",
  "send.state.refused": "服务商拒收",
  "send.state.refused.note": "邮件服务商不肯接收它。它从未发出。",
  "send.state.suppressed": "已抑制",
  "send.state.suppressed.note": "邮件服务商永远不会向这个收件人投递。",
  "send.state.handed_over": "已移交",
  "send.state.handed_over.note": "邮件服务商已接手。是否到达收件方，从这里无从得知。",
  "send.state.outcome_unknown": "结果未知",
  "send.state.outcome_unknown.note": "本节点不知道它是否已发出。它不会被自动重试。",
  "send.state.never_submitted": "结果未知",
  "send.state.never_submitted.note":
    "它从未发出。本节点在请求邮件服务商之前会先存下提交的字节，而这里没有，所以这次尝试在联系邮件服务商之前就失败了。" +
    "什么都没有发出，再次发送也不会产生重复的邮件。",

  "send.reason.policy_hold": "规则暂扣",
  "send.reason.policy_hold.note":
    "一条规则暂扣了这封邮件。它尚未发出。任何可以用此邮箱发送的人都能放行它，不需要审批人，所以暂扣是两道关卡中较轻的一道。",
  "send.reason.policy_approval_required": "需要审批",
  "send.reason.policy_approval_required.note":
    "一条规则要求这封邮件先经审批。它尚未发出。只有在此邮箱上拥有 approval.decide 的人才能批准它，所以这是较严的一道关卡。",
  "send.reason.policy_denied": "规则否决",
  "send.reason.policy_denied.note":
    "一条规则否决了这封邮件。本节点没有移交它；没有人取消它，也从未向邮件服务商提交。否决无法解除：请重新撰写，或修改规则。",
  "send.reason.authority_lost": "发送权限已失效",
  "send.reason.authority_lost.note":
    "作者用此邮箱发送的权限在移交前被收回，所以本节点没有移交它。吊销权限的人可以再次授予 send.propose，" +
    "之后需要重新撰写这封邮件：已定稿的邮件永远不会被修改。",
  "send.reason.approval_revoked": "审批已吊销",
  "send.reason.approval_revoked.note":
    "放行这封邮件所依据的审批已不再成立：它不再被记录为已批准，或者某人的批准被收回了。本节点中没有任何途径会在审批完成后造成这种情况，" +
    "所以管理员应检查这条记录是如何改变的。重新撰写即可获得新的审批。",
  "send.reason.approver_ineligible": "审批人已无资格",
  "send.reason.approver_ineligible.note":
    "批准放行这封邮件的某个人已不再拥有此邮箱上的 approval.decide，所以本节点不会依据其批准行事。职责分离是实时评估的，" +
    "而不是沿用做出决定时的结果。请重新授予该关系，或重新撰写，让有资格的审批人来决定。",
  "send.reason.policy_stricter": "规则已收紧",
  "send.reason.policy_stricter.note":
    "在审批与移交之间规则发生了变化，而且比这封邮件获批时更严格，所以它按从严处理不予发出，而不是依据一条已不再适用的规则发出。" +
    "重新撰写后，它会按现行规则评估，如有需要再经审批。",
  "send.reason.approval_expired": "审批已过期",
  "send.reason.approval_expired.note":
    "这封邮件的审批在移交前已过期。这是最终结果：审批绑定于这些确切的字节，一个可以无限期恢复的审批就成了长期有效的放行，" +
    "而不是一次决定。重新撰写后，新邮件会有自己的审批。",
  "send.reason.evidence_changed": "证据已变更",
  "send.reason.evidence_changed.note":
    "这封邮件存储的正文与其记录中的哈希不再一致，所以本节点拒绝发送它无法担保的字节。这不是任何人做出的决定：" +
    "它意味着存档与自身的记录不符，也就是损坏或被篡改。它已写入运行日志，mailda doctor 也会报告；在有人检查之前，请不要重新撰写。",
  "send.reason.approval_denied": "审批被否决",
  "send.reason.approval_denied.note":
    "一位审批人否决了这封邮件。本节点没有移交它；没有人取消它，也从未向邮件服务商提交。否决是最终的：" +
    "没有任何操作能推翻它，因为审批绑定于这些确切的字节。重新撰写后，新邮件会有自己的审批。",
  "send.reason.breaker_volume": "发送过多过快",
  "send.reason.breaker_volume.note":
    "本节点在过去一小时内移交的邮件超过了它自己的发送量熔断器所允许的数量，所以这封邮件正在等待。它尚未发出，也没有丢失：" +
    "不需要任何人放行，最早的那些发送移出这一小时后，它会自行发出。确切的限额、本节点当前的数量以及还需多久，都写在这封邮件自己的消息里。",
  "send.reason.breaker_bounce_rate": "退信地址过多",
  "send.reason.breaker_bounce_rate.note":
    "本节点最近发往的地址中，有太多被对方的邮件服务器退信，所以它停止了发送，以免声誉进一步变差。这封邮件尚未发出，也没有丢失：" +
    "等足够多的退信移出时间窗口后，它就会发出。不需要任何人放行，但应该有人检查收件人列表：发件箱会显示哪些地址退信，以及对方服务器的答复。",
  "send.reason.breaker_complaint_rate": "垃圾邮件举报过多",
  "send.reason.breaker_complaint_rate.note":
    "有太多收件人把本节点最近的邮件标记为垃圾邮件，所以它停止了发送。这封邮件尚未发出，也没有丢失：等足够多的举报移出时间窗口后，" +
    "它就会发出。不需要任何人放行，也不应该有人在弄清发出了什么之前提高限额：一次举报就是一个人在说他不想要这封邮件。",
  "send.reason.domain_paused": "域名已暂停",
  "send.reason.domain_paused.note":
    "两位管理员暂停了从此域名发出的所有邮件，他们给出的理由写在这封邮件上。本节点没有移交它；没有人取消它，也从未向邮件服务商提交。" +
    "任何一位管理员都可以独自恢复这个域名（被错误暂停的域名，危害每分钟都在增加），之后需要重新撰写这封邮件，因为已定稿的邮件永远不会被修改。",
  "send.reason.approval_unsatisfiable": "无法审批",
  "send.reason.approval_unsatisfiable.note":
    "一条规则要求的审批没有人能给出：在此邮箱上拥有 approval.decide 的人数不足以满足规则要求的各个阶段，而邮件的作者永远没有资格批准自己的邮件。" +
    "这不是在等某个人：没有人能放行它。管理员需要把 approval.decide 授予足够多的不同的人，然后需要重新撰写这封邮件。",
  "send.reason.butler_release_required": "等待人工放行",
  "send.reason.butler_release_required.note":
    "这封邮件由管家撰写，还没有人看过，所以本节点不会移交它。它尚未发出，也没有丢失。任何可以用此邮箱发送的人都能放行它" +
    "（撰写它本来就需要同样的权限），放行后它会回到普通的暂留窗口，在那里仍可以取消。它不会自行放行：管家是一个程序，" +
    "这道关卡的意义就在于程序无权断定某个人已经同意。",

  "delivery.state.accepted": "已受理",
  "delivery.state.accepted.note": "接收方邮件服务器受理了这封邮件并返回了 250。这不等于有人读过它：这里的一切都无法知道这一点。",
  "delivery.state.bounced": "退信",
  "delivery.state.bounced.note": "接收方服务器退回了它。硬退信表示地址有误；软退信表示临时故障的重试次数已经用完。",
  "delivery.state.deferred": "延迟",
  "delivery.state.deferred.note": "临时故障，邮件服务商仍在重试。结果确实还不知道。",
  "delivery.state.failed": "服务出错",
  "delivery.state.failed.note": "邮件服务商遇到了内部错误，而不是收件方服务器的拒绝。这不是退信，也不说明地址有任何问题。",
  "delivery.state.rejected": "投递前被拒",
  "delivery.state.rejected.note": "在尝试投递之前就被拒绝。",
  "delivery.state.unobserved": "未观测到",
  "delivery.state.unobserved.note": "关于这个收件人，目前还没有任何回报。本节点不会猜测：没有消息不是好消息，也不是坏消息。",

  "delivery.reason.verified_destination": "已验证的目标地址",
  "delivery.reason.verified_destination.note":
    "已验证的目标地址不会报告投递结果。对本节点 Cloudflare 账户的一次读取显示，这个地址是已验证的 Email Routing 目标地址，" +
    "且在这封邮件移交之前就已验证；在测量过的唯一一例中，Cloudflare 没有为发往已验证目标地址的邮件发布任何投递事件。" +
    "所以这里不会有回报。这种沉默不是本节点的故障，也不说明这封邮件是否已到达。如果某个地址在最近一次读取之后才从账户的列表中移除，" +
    "在再次读取列表之前，这里仍会显示此项。",
};

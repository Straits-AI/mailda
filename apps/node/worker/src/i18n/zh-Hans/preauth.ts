import type { preauth as source } from "../en/preauth.ts";
import type { Twin } from "../catalog.ts";

export const preauth: Twin<typeof source> = {
  "brand.name": "淼达",

  "preauth.status.listening": "接收中",
  "preauth.status.unclaimed": "未认领",
  "preauth.session.renewsIn": "登录会话 · 将于 {time} 后续期",
  "preauth.session.renewing": "登录会话 · 正在续期",
  "preauth.session.renewed": "登录会话 · 已续期",
  "preauth.session.notRenewed": "你的登录会话无法续期。请重新登录。",
  "preauth.language": "语言",

  "preauth.claim.title": "本节点等待你认领。",
  "preauth.claim.lede":
    "它运行在你的 Cloudflare 账户中，用你的密钥保管你的数据。它还没有被认领，所以会拒收来信，而不是把邮件存放到无法确定归属的地方。",
  "preauth.claim.heading": "首次运行",
  "preauth.claim.org": "组织",
  "preauth.claim.orgExample": "示例物流",
  "preauth.claim.email": "所有者的邮件地址",
  "preauth.claim.emailHint": "你用这个邮件地址登录。外发邮件使用某个邮箱的地址，由配置时选定。",
  "preauth.claim.secret": "认领码",
  "preauth.claim.secretHint": "由 `mailda claim-secret` 显示，只显示一次。",
  "preauth.claim.submit": "认领本节点",
  "preauth.claim.busy": "正在认领…",
  "preauth.claim.failed": "认领失败。",
  "preauth.password": "密码",
  "preauth.password.rule": "至少 12 个字符。没有字符类别的要求——抵御猜测靠的是长度。",

  "preauth.codes.title": "现在就把它们记下来。",
  "preauth.codes.lede":
    "这十个恢复码是恢复本节点密钥的唯一途径。它们能打开保存内容密钥和凭据密钥（也就是解密你邮件的那些密钥）的密钥恢复副本，并且只在这里显示一次。本节点只保存每个恢复码的哈希值，所以谁都无法再次生成它们，本节点也不能。",
  "preauth.codes.keep":
    "把它们存放在即使丢失这台电脑和这个 Cloudflare 账户也不会丢失的地方：密码管理器，或者另一栋楼里的纸上。每个恢复码只能使用一次。",
  "preauth.codes.heading": "恢复码",
  "preauth.codes.once": "只显示一次，无法找回。",
  "preauth.codes.next":
    "下一步：运行 `mailda recovery-codes confirm`，输入其中一个恢复码。这证明有人保管着它们。在此之前，本节点会报告降级，因为没有人读过的十个恢复码等于没有。",
  "preauth.codes.saved": "我已保存这十个恢复码",

  "preauth.signin.title": "知道是谁回复的共享收件箱。",
  "preauth.signin.lede":
    "到达这里的每封邮件都逐字节保存、静态加密，只有你授权的人才能阅读。每次请求都会重新检查访问权限，而不是由令牌携带。",
  "preauth.signin.heading": "登录",
  "preauth.signin.email": "邮件地址",
  "preauth.signin.submit": "登录",
  "preauth.signin.busy": "正在登录…",
  "preauth.signin.failed": "登录失败。",
  "preauth.signin.passkey": "用通行密钥登录",
  "preauth.signin.or": "或者用密码登录",
  "preauth.signin.invited": "我收到了邀请",
  "preauth.passkey.waiting": "正在等待你的通行密钥…",
  "preauth.passkey.unsupported": "此浏览器不支持通行密钥。请用密码登录。",
  "preauth.passkey.notStarted": "本节点无法开始通行密钥登录。",
  "preauth.passkey.silent": "本节点没有应答。",
  "preauth.passkey.failed": "该通行密钥未被接受。",

  "preauth.join.title": "你收到了邀请。",
  "preauth.join.lede":
    "粘贴你收到的邀请码，并设置密码。除你之外没有人会看到这个密码，邀请你的管理员也不会。在对方授予你某个邮箱的访问权限之前，你加入后不持有任何权限。",
  "preauth.join.heading": "加入",
  "preauth.join.secret": "邀请码",
  "preauth.join.password": "设置密码",
  "preauth.join.submit": "加入",
  "preauth.join.busy": "正在加入…",
  "preauth.join.failed": "该邀请无法使用。",
  "preauth.join.member": "我已有账户",

  "preauth.unreachable": "无法连接本节点：{reason}",
  "preauth.shell.failed": "应用无法加载（{reason}）。本节点仍在运行：/api/doctor 和每封邮件的原件仍可访问。",

  "preauth.noscript.title": "此页面需要 JavaScript。",
  "preauth.noscript.body":
    "认领节点、登录和查看诊断都在浏览器中运行。这里没有任何内容在服务器上渲染，所以禁用脚本后，此页面只能显示这条提示。",
  "preauth.noscript.doctor": "诊断报告有纯文本版本，无需脚本：{link}。",

  "preauth.refusal.already_claimed": "本节点已被认领。请直接登录，或者从备份恢复以重新开始。",
  "preauth.refusal.bad_secret": "认领码不匹配。它只由 `mailda claim-secret` 显示过一次，本节点只保存它的哈希值；如果丢失了，请重新生成。",
  "preauth.refusal.not_installed": "本节点没有记录认领码。运行 `mailda deploy` 完成安装。",
  "preauth.refusal.weak_password": "密码太短。",
  "preauth.refusal.not_claimed": "本节点还没有被认领。",
  "preauth.refusal.locked_out": "登录失败次数过多。",
  "preauth.refusal.invalid_credentials": "邮件地址和密码不匹配。",
  "preauth.refusal.no_refresh_token": "你的登录会话已结束。请重新登录。",
  "preauth.refusal.expired": "你的登录会话已结束。请重新登录。",
  "preauth.refusal.unknown": "你的登录会话已结束。请重新登录。",
  "preauth.refusal.reuse_detected": "此登录会话已被登出，因为它的令牌被使用了两次。请重新登录。",
  "preauth.refusal.E_PASSKEY_REJECTED": "该通行密钥未被接受。",
  "preauth.refusal.E_CHALLENGE_UNUSABLE": "这次通行密钥登录已无法完成。请重新开始。",
  "preauth.refusal.E_CHALLENGE_ALREADY_SPENT": "这次通行密钥登录已被使用过。请重新开始。",
  "preauth.refusal.E_INVITATION_UNUSABLE": "该邀请无法使用。",
  "preauth.refusal.E_WEAK_PASSWORD": "密码太短。",
  "preauth.refusal.E_CROSS_SITE_REQUEST": "本节点拒绝了一个不是来自它自己页面的请求。",
  "preauth.refusal.internal": "本节点未能处理该请求。它的运维人员可以在日志中找到这条记录。",
};

import type { composer as source } from "../en/composer.ts";
import type { Twin } from "../catalog.ts";

/**
 * Proposed words, reviewed under `?locale=zh-Hans`. Seal is 定稿 (the glossary's), never 封存; "sealed under a
 * key" is the cryptographic sense and is 加密. A recall is 撤回, the word the other rows keep clear of, and the
 * vault is 密钥库 (both proposed rows). The limit line's clauses carry no leading space: Chinese sentences meet
 * without one.
 */
export const composer: Twin<typeof source> = {
  "composer.title.reply": "回复",
  "composer.title.forward": "转发",
  "composer.title.new": "新邮件",
  "composer.discard": "丢弃",
  "composer.close": "关闭",
  "composer.closing": "正在保存…",
  "composer.context.reply": "正在回复：{subject}",
  "composer.context.forward": "正在转发：{subject}",

  "composer.phase.empty": "空草稿",
  "composer.phase.browser": "仅在此浏览器中 · 重新加载会丢失",
  "composer.phase.saving": "正在保存到你的节点…",
  "composer.phase.saved": "已保存到你的节点 · {time}",
  "composer.phase.failed": "未保存——{why}",
  "composer.save.answered": "本节点返回了 {status}",
  "composer.save.noDraft": "本节点的答复中没有草稿",
  "composer.save.failed": "这份草稿无法保存",
  "composer.close.kept": "这份草稿还没有保存到你的节点，所以编辑窗口会保持打开。请重试，或者确定要丢弃它。",

  "composer.field.from": "发件人",
  "composer.field.to": "收件人",
  "composer.field.copies": "抄送 / 密送",
  "composer.field.cc": "抄送",
  "composer.field.bcc": "密送",
  "composer.field.subject": "主题",
  "composer.field.body": "正文",
  "composer.field.attach": "附件",
  "composer.from.unreadable": "本节点无法读取此邮箱的邮件地址（{why}），所以无法显示这封邮件将从哪个地址发出。",
  "composer.from.unlisted": "此邮箱不在本节点列出的邮箱中，所以无法显示这封邮件将从哪个地址发出。",
  "composer.from.choose": "选择一个邮件地址…",
  "composer.from.mailbox": "· {name} 邮箱",
  "composer.from.none": "还没有邮件地址：在管理员于“成员”中添加一个之前，从 {name} 发出的邮件会被拒绝。",
  "composer.from.more": "此邮箱的更多邮件地址由管理员在“成员”中添加。",

  "composer.size.kb": "{size} KB",
  "composer.size.mb": "{size} MB",
  "composer.limit.none": { other: "总计最多 {size}，{n} 个文件。" },
  "composer.limit.used": { other: "已用 {used}，共 {size}；{count} 个文件，最多 {n} 个。" },
  "composer.limit.over": "超出限额：请移除一个文件，或改为发送链接。",
  "composer.limit.tooMany": "文件太多。",
  "composer.limit.checking": "正在检查文件…",
  "composer.limit.unreadable": { other: "{n} 个文件无法读取：请移除后重新附加。" },
  "composer.limit.flagged": { other: "{n} 个文件被判定为危险：见下方的警告。" },

  "composer.files.label": "已附加的文件",
  "composer.file.remove": "移除",
  "composer.file.checking": "正在检查…",
  "composer.file.dangerous":
    "{name} 是{what}。因为是你附加的，它会被发出，定稿会记录这一点。有些收件服务器会拒绝程序和脚本（Gmail 会拒绝 .exe、.js、.jar 等文件，即使放在 zip 压缩包里），所以链接可能是对方唯一能收到它的方式。",
  "composer.file.unread": "此浏览器无法读取它（{why}），所以无法发出：请移除后重新附加。",
  "composer.files.kept": "文件随这次发送一起发出，不随草稿保存：关闭后不会保留。",

  "composer.bodyUnavailable.unreadable":
    "这份草稿的正文存储在本节点上，但无法打开——它是用密钥库中没有的某一代密钥加密的。正文没有丢失，覆盖保存会被拒绝。请用十个恢复码中的一个恢复密钥库，然后重新打开这份草稿。",
  "composer.bodyUnavailable.missing":
    "这份草稿的正文已经不在了：记录它的行还在，存储的对象却不在了。上面的收件人和主题完好无损。没有任何办法能找回这些文字。",

  "composer.takeAnyway": "仍然接手",
  "composer.seal": "定稿并发送",
  "composer.sealing": "正在定稿…",
  "composer.seal.refused": "这封邮件无法定稿。",
  "composer.unreachable": "无法连接本节点（{why}）。",
  "composer.unreachable.unsealed": "无法连接本节点（{why}）。没有任何内容定稿，所以什么都不会发出。",
  "composer.discard.silent": "本节点返回了 {status}，没有给出原因，所以这份草稿可能仍然存在。",
  "composer.discard.unreachable": "无法连接本节点（{why}），所以这份草稿可能仍然存在。",
  "composer.sendNote": "以邮箱的名义发出；本节点记录是谁写的。暂留 {n} 秒，期间你可以停止它；不可撤回。",
  "composer.how": "发送是怎样进行的",
  "composer.how.body": {
    other: "这封邮件将以邮箱的名义发出，而不是以你个人的名义。是谁写的记录在本节点上，不会随邮件一起发出。定稿会在任何内容发出之前准确记录将要发出的内容，然后等待 {n} 秒，让你仍然可以停止它——邮件不会被撤回，因为声称能撤回是不诚实的。",
  },

  "composer.quote": "{date}，{from} 写道：",
};

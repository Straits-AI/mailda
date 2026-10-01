import type { ui as source } from "../en/ui.ts";
import type { Twin } from "../catalog.ts";

export const ui: Twin<typeof source> = {
  "ui.firstRun": "需要配置",
  "ui.firstRun.heading": "本节点尚不能使用",
  "ui.firstRun.lead": "本节点已部署并认领。要当作收件箱使用，它还需要一个邮件地址，并把邮件路由到这个地址；下面是目前的进度。",
  "ui.firstRun.next": "下一步",
  "ui.firstRun.next.heading": "下一步：{step}",
  "ui.firstRun.terminal": "在终端中操作（推荐，无需令牌）",
  "ui.firstRun.terminal.what": "命令",
  "ui.firstRun.terminal.body":
    "在安装时创建的目录中运行。部署完成后，它会询问本节点在哪个域名接收邮件，并使用 wrangler 已获得的授权配置接收、发信和投递结果。",
  "ui.firstRun.browser": "在此页面操作",
  "ui.firstRun.browser.body":
    "浏览器中没有 wrangler，所以这种方式需要本节点自己的凭据：{link}。在根域名上，Catch-all 地址只需一步，之后邮件地址都在本节点上管理。",
  "ui.firstRun.browser.link": "用一个 API 令牌连接本节点，然后在那里配置接收",
  "ui.firstRun.anyway": "仍然打开应用",
  "ui.firstRun.anyway.note": "（仅限此标签页；在邮件地址完成路由之前，发信会被拒绝）",

  "ui.nextSteps": "下一步",
  "ui.nextSteps.fromSender": "此发件人的更多邮件",
  "ui.nextSteps.ai": "AI",
  "ui.nextSteps.provenance": "{profile} · {model} · 运行 {runId} · {at}",
};

import type { butlers as source } from "../en/butlers.ts";
import type { Twin } from "../catalog.ts";

/**
 * Butler is 管家 (confirmed); a node of the program's graph is 步骤, never 节点, which is this Node; an effect is
 * 外部动作. The program's identifiers and the Node's tokens stay Latin: `org.admin`, `yaml`/`json`, a node id, and
 * the outcome "would", which the caption names because the table shows it as the Node sent it.
 */
export const butlers: Twin<typeof source> = {
  "butlers.version.draft": "草稿",
  "butlers.version.published": "已发布",
  "butlers.version.superseded": "已被取代",
  "butlers.pauseReason.loop_detected": "检测到循环",
  "butlers.run.running": "运行中",
  "butlers.run.awaiting_release": "等待放行",
  "butlers.run.finished": "已完成",
  "butlers.run.stopped": "已终止",
  "butlers.run.refused": "被拒绝",
  "butlers.run.failed": "失败",
  "butlers.new": "新建管家",
  "butlers.notAdmin": "这里没有管家，或者你没有 org.admin。编写管家是管理员的操作。",
  "butlers.empty": "本节点上还没有任何自动化。",
  "butlers.col.name": "名称",
  "butlers.col.standing": "状态",
  "butlers.col.published": "发布时间",
  "butlers.col.draft": "草稿",
  "butlers.col.editor": "编辑器",
  "butlers.col.state": "状态",
  "butlers.unpublishedChanges": "有未发布的修改",
  "butlers.open": "打开",
  "butlers.startedAgain": "已重新运行，新运行为 {run}。",

  "butlers.standing.paused": "已暂停：{reason}",
  "butlers.standing.live": "生效中 · v{version}",
  "butlers.standing.draftOnly": "只有草稿，从未发布",

  "butlers.detail.label": "管家{name}",
  "butlers.close": "关闭",
  "butlers.format": "格式",
  "butlers.format.hint": "决定用哪种解析器读取下面的源代码。切换它不会改写你的文本",
  "butlers.source": "源代码",
  "butlers.saveDraft": "保存草稿",
  "butlers.publish": "发布",
  "butlers.draft.none": "尚未保存任何内容",
  "butlers.draft.showingLive": "显示的是生效中的 v{version}：保存一份草稿才能修改它",
  "butlers.draft.unpublished": "未发布的草稿",

  "butlers.dry": "试运行",
  "butlers.dry.notRun":
    "试运行会让这个程序走一遍一次真实运行从真实来信中得到的输入，而这个管家还没有运行过。先发布它，给它发一封邮件，然后再回来：" +
    "下面的演练不会造成任何影响，所以之后想做几次都可以。",
  "butlers.dry.explain":
    "让草稿（没有草稿时用生效中的版本）走一遍过去某次运行的输入。会读取真实的数据，也会询问真实的权限问题；不写入任何内容。",
  "butlers.dry.over": "试运行：{at} 的那次运行",
  "butlers.dry.noFacts": "那次运行没有记录触发时的事实，无从演练。请选一次更晚的运行。",
  "butlers.dry.draft": "草稿",
  "butlers.dry.version": "v{version}",
  "butlers.dry.nodes": { other: "{n} 个步骤" },
  "butlers.dry.summary": "{program} · {nodes} · 将消耗 {spend}",
  "butlers.dry.noEffect": "没有执行到任何外部动作步骤。",
  "butlers.dry.caption":
    "“would” 表示本节点没有执行的一次写入。其他每个结果都是一次真实读取给出的真实答案，与正式运行会记录的结果相同。",
  "butlers.dry.col.node": "步骤",
  "butlers.dry.col.type": "类型",
  "butlers.dry.col.outcome": "结果",
  "butlers.dry.col.detail": "详情",

  "butlers.versions.caption": "版本：发布即产生新版本，已发布的版本不可更改",
  "butlers.versions.col.version": "版本",
  "butlers.versions.col.by": "发布者",
  "butlers.versions.col.ast": "AST sha256",

  "butlers.pause.placed": "由 {by} 暂停 · {at}",
  "butlers.pause.why": "为什么现在恢复是安全的？",
  "butlers.pause.resume": "恢复",

  "butlers.runs": "运行记录",
  "butlers.runs.none": "还没有任何管家运行过。运行由来信触发。",
  "butlers.runs.explain":
    "{again}会用这次运行得到的输入，重新运行同一个已发布版本，并按今天的规则判断。它的外部动作是真实的；它提出的任何发送都会在发件箱中等待，" +
    "直到有人放行，所以没有任何邮件会自行离开本节点。",
  "butlers.runs.again": "再次运行",
  "butlers.runs.col.started": "开始时间",
  "butlers.runs.col.why": "结束原因",
  "butlers.runs.col.nodes": "步骤",
  "butlers.runs.col.effects": "外部动作",
  "butlers.runs.col.refusals": "被拒绝",
  "butlers.runs.col.spent": "已消耗",
  "butlers.runs.col.again": "再次运行",
};

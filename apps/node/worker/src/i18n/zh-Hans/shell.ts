import type { shell as source } from "../en/shell.ts";
import type { Twin } from "../catalog.ts";

export const shell: Twin<typeof source> = {
  "shell.chooser.label": "选择邮箱",
  "shell.chooser.from": "发件邮箱",
  "shell.chooser.none": "选择邮箱…",
  "shell.chooser.option": "{name} · {address}",
  "shell.chooser.option.no_address": "{name}（无邮件地址）",
  "shell.chooser.start": "开始写邮件",
  "shell.cancel": "取消",
  "shell.toast.dismiss": "关闭",
  "shell.sealing": "仍在为已打开的邮件定稿。请等本节点答复后再打开此项。",
  "shell.no_mailbox": "发送需要邮箱上的 send.propose 权限，而你在任何邮箱上都没有。",
  "shortcuts.undo": "撤销",
};

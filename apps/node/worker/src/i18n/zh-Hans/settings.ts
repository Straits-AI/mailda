import type { settings as source } from "../en/settings.ts";
import type { Twin } from "../catalog.ts";

export const settings: Twin<typeof source> = {
  "settings.account.heading": "账户",
  "settings.account.person": "你已登录为 {who}。",
  "settings.account.agent": "你以代理身份登录：{who}。",
  "settings.account.draft": "你要求退出登录时，草稿未能保存到你的节点，因此你仍处于登录状态：{problem}",
  "settings.sign_out": "退出登录",
  "settings.sign_out.anyway": "仍然退出登录",
  "settings.sign_out_everywhere": "在所有设备上退出登录",
  "settings.sign_out_everywhere.anyway": "仍然在所有设备上退出登录",
  "settings.sign_out_everywhere.title": "结束你持有的每一个登录会话，覆盖所有设备，包括此设备。",

  "settings.session.heading": "登录会话",
  "settings.session.renews": "将于 {time} 后续期",
  "settings.session.node": "本节点：{host}",

  "settings.appearance.heading": "外观",
  "settings.theme.legend": "主题",
  "settings.theme.dark": "深色",
  "settings.theme.light": "浅色",
  "settings.theme.system": "跟随系统",
  "settings.theme.system_note": "跟随设备的浅色或深色设置。",
  "settings.theme.unreadable": "此浏览器不允许淼达读取已保存的主题，因此每个页面都以深色打开。",
  "settings.not_saved": "未保存在此浏览器中；在重新加载之前有效。",

  "settings.keyboard.heading": "键盘",
  "settings.keyboard.switch": "单键快捷键",
  "settings.keyboard.unreadable": "此浏览器不允许淼达读取已保存的快捷键设置，因此单键快捷键默认开启。",
  "settings.keyboard.caption": "键盘快捷键",
  "settings.shortcut.compose": "写邮件",
  "settings.shortcut.palette": "命令面板（在 Mac 上为 ⌘K；关闭单键快捷键后仍可使用）",
  "settings.shortcut.reply": "回复，并先认领工单",
  "settings.shortcut.reply_all": "全部回复，并先认领工单",
  "settings.shortcut.forward": "转发",
  "settings.shortcut.archive": "归档",
  "settings.shortcut.next": "下一封邮件",
  "settings.shortcut.previous": "上一封邮件",
  "settings.shortcut.unread": "标为未读",
  "settings.shortcut.undo": "撤销（当提示中提供撤销时）",
  "settings.shortcut.close": "关闭菜单、弹出框或对话框",
};

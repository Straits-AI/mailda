import type { language as source } from "../en/language.ts";
import type { Twin } from "../catalog.ts";

export const language: Twin<typeof source> = {
  "language.heading": "语言",
  "language.legend": "界面语言",
  "language.scope": "这是此浏览器的选择，与节点无关。邮件、名称以及本节点用自己的话报告的内容，保持其原本的语言。",
  "language.only": "目前只提供英文。",
  "language.flag": "此页面显示为{language}，因为页面地址要求如此。这不会被保存：不带该地址打开的页面使用你自己的选择。",
  "language.unreadable": "此浏览器不允许淼达读取已保存的语言，因此每个页面都以浏览器的语言或英文打开。",
  "language.draft": "你的草稿未能保存到节点，因此页面没有重新加载以切换语言：{problem}",
};

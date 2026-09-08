// FR-M12.5：markdown 报告渲染（JSON 在 audit.ts 直接序列化对象）
import type { AuditReport } from "./audit.js";

export function renderMarkdown(r: AuditReport): string {
  const lines: string[] = [];
  lines.push(`# MCP 体检报告：${r.server}`);
  lines.push("");
  lines.push(`- 目标：\`${r.target}\`（${r.transport}）`);
  lines.push(`- 引擎：${r.engine}`);
  lines.push(`- 工具数 ${r.summary.tool_count} ｜ 投毒 ${r.summary.poisoned} ｜ 高危(L2) ${r.summary.high_risk}`);
  lines.push("");
  lines.push("## 工具清单");
  lines.push("");
  lines.push("| 工具 | 建议分级 | 需审批 | 风险 | 投毒扫描 |");
  lines.push("|---|---|---|---|---|");
  for (const t of r.tools) {
    const poison = t.poison_scan.is_injection
      ? `⚠️ 注入(score ${t.poison_scan.score}：${t.poison_scan.families.join(", ")})`
      : "干净";
    lines.push(`| ${t.name} | ${t.suggested_tier} | ${t.requires_approval ? "是" : "否"} | ${t.risks.join(", ") || "—"} | ${poison} |`);
  }
  lines.push("");
  lines.push("## 凭证暴露面");
  lines.push("");
  if (r.credential_exposure.length === 0) {
    lines.push("未发现明文凭证模式。");
  } else {
    for (const c of r.credential_exposure) {
      lines.push(`- \`${c.source}\`：\`${c.match}\``);
    }
  }
  lines.push("");
  lines.push("## rug-pull 提示");
  lines.push("");
  if (r.rug_pull.status === "baseline_created") {
    lines.push("首採已建立工具描述基线（mcp-audit-baseline.json）；下次体检对比，描述漂移即提示。");
  } else if (r.rug_pull.status === "match") {
    lines.push("与基线一致，未发现工具描述漂移。");
  } else {
    lines.push(`⚠️ **工具描述与基线漂移**——正是 rug-pull 的典型前兆：`);
    for (const n of r.rug_pull.changed ?? []) lines.push(`- 变更：${n}`);
    for (const n of r.rug_pull.added ?? []) lines.push(`- 新增：${n}`);
    for (const n of r.rug_pull.removed ?? []) lines.push(`- 移除：${n}`);
  }
  lines.push("");
  return lines.join("\n");
}

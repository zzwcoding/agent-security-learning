// 体检核心（FR-M12.2~M12.5）：清单 → 逐工具投毒扫描/分级建议/凭证面 → rug-pull 基线 → 报告。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanCredentialText, scanDescription, type PoisonScan } from "./rules.js";
import { schemaHasCredentialSurface, suggestTier } from "./tier.js";
import { isHttpTarget, listTools, type McpTool } from "./transports.js";
import { renderMarkdown } from "./report.js";

export interface ToolAudit {
  name: string;
  suggested_tier: "L0" | "L1" | "L2";
  requires_approval: boolean;
  risks: string[];
  poison_scan: PoisonScan;
}

export interface AuditReport {
  server: string;
  target: string;
  engine: string;
  transport: "stdio" | "http" | "—";
  tools: ToolAudit[];
  credential_exposure: { source: string; match: string }[];
  rug_pull: {
    status: "baseline_created" | "match" | "drift";
    changed?: string[];
    added?: string[];
    removed?: string[];
  };
  summary: { tool_count: number; high_risk: number; poisoned: number };
}

export interface AuditResult {
  exitCode: 0 | 1 | 2;
  report: AuditReport;
}

export async function auditTarget(
  target: string,
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<AuditResult> {
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let manifest;
  try {
    manifest = await listTools(target, timeoutMs);
  } catch {
    // PRD 异常与边界：连接失败 → 报告标记 unreachable，退出码 2
    const report: AuditReport = {
      server: "unreachable",
      target,
      engine: ENGINE,
      transport: isHttpTarget(target) ? "http" : "stdio",
      tools: [],
      credential_exposure: [],
      rug_pull: { status: "match" },
      summary: { tool_count: 0, high_risk: 0, poisoned: 0 },
    };
    return { exitCode: 2, report };
  }

  const tools: ToolAudit[] = manifest.tools.map((t) => auditTool(t));
  // FR-M12.4：命令行 + 工具 schema 两个来源查明文凭证（server env 本身拿不到，静态边界）
  const credential_exposure = [
    ...scanCredentialText(target, "cmd"),
    ...manifest.tools.flatMap((t) =>
      scanCredentialText(schemaText(t), `schema:${t.name}`)),
  ];

  const hashes = manifest.tools.map(toolHash);
  const baselinePath = join(cwd, "mcp-audit-baseline.json");
  let oldBaseline: { name: string; hash: string }[] | undefined;
  try {
    oldBaseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
  } catch {
    /* 首採：无基线 */
  }
  const rug_pull = compareBaseline(hashes, oldBaseline);
  writeFileSync(baselinePath, JSON.stringify(hashes, null, 2));

  const report: AuditReport = {
    server: manifest.server,
    target,
    engine: ENGINE,
    transport: manifest.transport,
    tools,
    credential_exposure,
    rug_pull,
    summary: {
      tool_count: tools.length,
      high_risk: tools.filter((t) => t.suggested_tier === "L2").length,
      poisoned: tools.filter((t) => t.poison_scan.is_injection).length,
    },
  };
  return { exitCode: report.summary.poisoned > 0 ? 1 : 0, report };
}

const ENGINE = "embedded-rules (decision 11)";

function auditTool(t: McpTool): ToolAudit {
  const tier = suggestTier(t);
  const risks = [...tier.risks];
  if (schemaHasCredentialSurface(schemaText(t))) {
    risks.push("credential_surface");
  }
  return {
    name: t.name,
    suggested_tier: tier.tier,
    requires_approval: tier.requires_approval,
    risks,
    poison_scan: scanDescription(t.description ?? ""),
  };
}

function schemaText(t: McpTool): string {
  return JSON.stringify(t.inputSchema ?? {});
}

export function toolHash(t: McpTool): { name: string; hash: string } {
  return {
    name: t.name,
    hash: createHash("sha256").update(`${t.name}\n${t.description ?? ""}\n${schemaText(t)}`).digest("hex").slice(0, 16),
  };
}

export function compareBaseline(
  current: { name: string; hash: string }[],
  old: { name: string; hash: string }[] | undefined,
): AuditReport["rug_pull"] {
  if (!old) return { status: "baseline_created" };
  const oldMap = new Map(old.map((h) => [h.name, h.hash]));
  const curMap = new Map(current.map((h) => [h.name, h.hash]));
  const changed = current.filter((h) => oldMap.has(h.name) && oldMap.get(h.name) !== h.hash).map((h) => h.name);
  const added = current.filter((h) => !oldMap.has(h.name)).map((h) => h.name);
  const removed = old.filter((h) => !curMap.has(h.name)).map((h) => h.name);
  if (changed.length || added.length || removed.length) {
    return { status: "drift", changed, added, removed };
  }
  return { status: "match" };
}

export async function writeReports(report: AuditReport, cwd: string): Promise<{ json: string; md: string }> {
  const json = join(cwd, "mcp-audit-report.json");
  const md = join(cwd, "mcp-audit-report.md");
  writeFileSync(json, JSON.stringify(report, null, 2));
  writeFileSync(md, renderMarkdown(report));
  return { json, md };
}

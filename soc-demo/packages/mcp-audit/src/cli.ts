// soc-mcp-audit CLI 入口：退出码 0=干净 / 1=检出投毒 / 2=server 不可达（PRD 异常与边界）。
import { auditTarget, writeReports } from "./audit.js";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const timeoutFlag = argv.indexOf("--timeout-ms");
  const timeoutMs = timeoutFlag >= 0 ? Number(argv[timeoutFlag + 1]) : undefined;
  const target = argv.find((a) => !a.startsWith("--") && a !== String(timeoutMs));
  if (!target) {
    console.error("用法: soc-mcp-audit <\"server 命令\" | http(s) URL> [--timeout-ms N]");
    console.error('示例: soc-mcp-audit "npx -y @modelcontextprotocol/server-filesystem /tmp"');
    return 2;
  }
  const { exitCode, report } = await auditTarget(target, { cwd: process.cwd(), timeoutMs });
  const files = await writeReports(report, process.cwd());
  if (report.server === "unreachable") {
    console.error(`soc-mcp-audit: server 不可达（${target}），报告已写出 ${files.json}`);
    return 2;
  }
  console.log(
    `soc-mcp-audit: ${report.server} 工具 ${report.summary.tool_count}，投毒 ${report.summary.poisoned}，高危 ${report.summary.high_risk} → ${files.md}`,
  );
  return exitCode;
}

main().then((code) => process.exit(code));

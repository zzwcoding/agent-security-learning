// 库出口：测试与后续工具复用同一批函数（CLI 只是薄壳）。
export { auditTarget, compareBaseline, toolHash, writeReports, type AuditReport, type ToolAudit } from "./audit.js";
export { scanCredentialText, scanDescription, type PoisonScan } from "./rules.js";
export { schemaHasCredentialSurface, suggestTier, type McpTool, type TierSuggestion } from "./tier.js";
export { isHttpTarget, listTools, type McpManifest } from "./transports.js";
export { renderMarkdown } from "./report.js";

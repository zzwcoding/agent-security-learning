# 05: m12 MCP 体检 CLI

**What to build:** 独立 npm bin：soc-mcp-audit <cmd-or-url> 静态体检 MCP server（投毒描述/权限面/凭证暴露/rug-pull），产出 mcp-audit-report.{md,json}。扫描规则本地内嵌，可独立跑。

**Blocked by:** None (can start immediately)

**Touches modules:** `m12`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] soc-mcp-audit <cmd-or-url> 产出 mcp-audit-report.{md,json}（源：m12 卡公开接口）
- [x] ≥3 公开 server + 1 内置恶意 fixture server 投毒 100% 检出（源：m12 卡测试计划）
- [x] 扫描规则本地内嵌、不依赖运行时 guards（源：决策记录 #11）

---

## 实现记录（2026-09-08）

**产物**：`packages/mcp-audit/`——npm bin `soc-mcp-audit`（bin 壳借 tsx loader 直跑 TS，
demo 级无构建方案）；transport adapter ×2（stdio 逐行 JSON-RPC 手写握手 initialize→
initialized→tools/list 带翻页；http 兼容 streamable HTTP 与 SSE 响应，透传
mcp-session-id）；内嵌规则 7 攻击族（与 guards 注入扫描同源的 6 族 + mcp_camouflage：
伪装 SYSTEM 标记/长 base64 载荷）；权限面按 PRD §5.7 口径建议 L0/L1/L2 +
requires_approval；凭证暴露面查 cmd 行与工具 schema 两来源（密钥字面量/明文键值/PEM/
敏感属性名）；rug-pull 基线 `mcp-audit-baseline.json` 对比（漂移/新增/移除逐项提示）；
md+json 双报告；退出码 0 干净 / 1 检出投毒 / 2 不可达（PRD 异常与边界）。

**验收证据**：恶意 fixture server（test/fixtures/evil-server.mjs，4 工具 2 带毒）→
投毒 100% 检出、干净工具不误报、run_diagnostic L2、api_key schema 进凭证面
（examples/evil-server.{md,json}）；公开 server ×3 存证——
`server-filesystem`（14 工具/0 毒/1 高危）、`server-memory`（9/0/3）、
`server-sequential-thinking`（1/0/0），报告在 examples/。

**决策记录**：
1. 手写最小 JSON-RPC 不引官方 SDK——体检只需「拉清单」，直连可测且零依赖（m12 卡
   Seam 本就要求 transport adapter 自持）。
2. 决策 11「llm-guard 内嵌」落地为：与 guards 同源的规则族本地化进 rules.ts（票 04
   同契约思路），CLI 不发起任何网络扫描调用；server 不可达降级路径天然覆盖。
3. 分级出入：PRD 契约示例 write_file=L2，与 §5.7 分级定义（L1=写需任务票、L2=高危
   需审批）不符——以 §5.7 为准，普通写= L1，仅 isolate/删除/执行/外发类= L2。
4. env 来源边界：server 进程 env 静态不可得，凭证面实际查 cmd 行内引用与 schema；
   报告如实标注来源。

**基建随票**：根 lint 范围 `eslint services packages`（新包进 CI 门禁）；
onlyBuiltDependencies 统一回 pnpm-workspace.yaml（票 03 放 package.json 的配置分裂
有 CI 差异风险，本次消除）；eslint 补纯 JS 文件（bin 壳/fixture server）node globals。

**验证**：mcp-audit vitest 10/10（先红后绿，含 stdio 端到端与连接失败退出码 2）、
全仓 TS 三连绿（5 包 typecheck/test 全过）、ruff 过、spec gate PASS（警告 6→5：
m12 目录落地）。

# 78-hunt-siem-tools: 狩猎查询工具 ×4——SIEM 维度扩展（P1）

**What to build:** 能力菜单的查询维度扩展，五业务共用。FixtureSiem（`workers/investigation/siem.ts`）在现有 ip/user/host 索引之外加四个维度 + 对应工具封装（登记进 tools.manifest，tier/owner 按现有表口径）：① `file_change_query`（按路径/哈希查文件新增篡改——FIM 维度，webshell 落盘取证）；② `outbound_conn_query`（按目的 IP/域名/频率查外联——C2 心跳维度）；③ `web_access_query`（按 URL 模式查访问异常——web 攻击痕迹维度）；④ `proc_lineage_query`（按进程名查父子关系——持久化/提权维度）。fixture 语料按维度补条目（沿用现有 Wazuh 语料风格，注入变体惯例照旧：攻击者可控字段埋点）。每工具：L0 只读、票面登记、fake 数据源 seam、契约测试（时间窗强制口径与 siem_query 一致——缺窗报错不替 LLM 补）。

**铁律:** 边界红线——只许扩展 investigation 的 SIEM adapter 面与工具登记，m2/guards 禁碰；注入变体 fixture 全量过现有防线测试（INV-1）；新工具默认 L0，升级 L1 需 L0 裁决记票。

**Touches modules:** `m5`（adapter 扩展）、`m9`（manifest 登记）

**Belongs to spec:** specs/orchestration-loop.md（行号回填同上）；票 70 菜单工具位清单对账


**Spec 绑定:** specs/orchestration-loop.md 验收测试表 T13 前置（菜单登记）（spec 已定稿 2026-09-12）

**Blocked by:** 72

**Status:** done

**验收：**
- [x] 四工具各维度查询契约测试绿（命中/空集/时间窗缺失报错三态）
- [x] tools.manifest 登记齐全（未登记一律 L1 的 fail-closed 策略对新工具生效验证）
- [x] 每维度至少 1 条注入变体 fixture，防线测试全绿
- [x] 现有 siem_query/related_alerts 行为零回归
- [x] 菜单工具位清单逐条对账关闭

**实现记录：**（2026-09-13，TDD 红→绿，全量 pnpm test exit 0 + 双闸全绿）

**产物清单：**
- `services/agent/workers/investigation/siem.ts` —— m5 adapter 扩展：FixtureSiem 在既有 `query()`（ip/user/host，逐字节未动）之外新增四维度索引 `queryFileChanges` / `queryOutboundConns` / `queryWebAccess` / `queryProcLineage` + 数据源 seam `HuntQueryBackend`（生产=FixtureSiem 同一 adapter 同一语料，禁起第二套查询面的红线由结构兑现）。口径：与 siem_query 同一强制时间窗/排序/max_results 骨架；维度圈定=结构化字段存在性（文件=syscheck、外联=dstip/dns、web=data.url、进程=process/parent_process_name）；字段匹配沿用 matchesEntity 的「结构化字段+full_log 全文」双口径（进程名除外，只走结构化等值防 sh 误中 bash）。freq 维度 = rule.firedtimes ≥ N。
- `services/agent/workers/investigation/hunt.ts`（新增）—— 工具封装：`HUNT_QUERY_TOOLS`（四名，与 INVESTIGATION_TOOLS 零交集）、`HUNT_TOOL_SCHEMAS`（required 显式含 time_window）、`validateHuntToolCall`（复用 prompt.ts checkTimeWindow——只加 export 未改逻辑；缺窗报 time_window_required 不替 LLM 补）、`executeHuntTool`（契约校验后唯一分发点，面外炸响 unreachable_tool）。**未加进 INVESTIGATION_TOOLS / 旧链票面**——PRD §13.4b 里四工具独立于调查六件套，hunt 菜单/票面接线归票 79（内容层），本票只落 m5 能力面 + m9 登记，不越界动 m3/m14。
- `services/agent/workers/investigation/prompt.ts` —— 仅 `checkTimeWindow` 加 export（供 hunt.ts 共用同一份时间窗规则），其余逐字节未动。
- `services/agent/workers/investigation/hunt.test.ts`（新增，17 测试）—— 契约三态（每工具缺窗/残窗/坏参数/合法放行）、FixtureSiem 四维度命中/空集/窗外空集、max_results 截断、executeHuntTool spy 分发、登记闸双向（登记后 L0 免验 allow；temp 表摘掉四行 → tierOf 落 L1 → 无票 403 no_ticket）。
- `fixtures/tools.manifest.json` —— 四工具登记行：L0 / readonly_query / owner_card m5（tier/owner 按现有表口径）。
- `services/agent/src/tools-manifest.test.ts` —— m9 契约面：KNOWN_NOT_IN_A1 点名四工具（「登记先行、A.1/矩阵收编归 L0 记票」= list_approvals/get_case 既有口径）；FACES 增补 HUNT_QUERY_TOOLS 来源（先登记后持票断言）。
- `services/gateway/test_fga_matrix.py` —— 互锁例外集点名四工具（同上口径）；pytest 9/9 绿。
- `evals/src/rigs/hunting.test.ts` —— 矩阵规模快照 3×24→3×28（在册 25→29），INV-11 遍历逻辑本身零改动。

**验收逐条证据：**
1. 三态契约：hunt.test.ts 17/17 绿（四工具×缺窗报错 `time_window_required`、命中 total 精确断言、空集 `{total:0,hits:[]}`、窗外空集）；contract.test.ts（siem_query 三态）原样绿。
2. manifest 登记：四行 L0/readonly_query/m5；fail-closed 双向验证绿（登记后 tierOf=0+无票 allow；摘行副本 tierOf=1+403 no_ticket）；tools-manifest.test 10/10；gateway pytest 43/43。
3. 注入变体：语料四维度本就各含 ≥1 注入变体（file=inject-webshell、conn=inject-beacon、web=inject-url/inject-ua、proc=inject-lineage，攻击者可控字段埋点惯例照旧）——hunt.test 逐维度可查断言（probe.php/evil-baseline.example/ignore all previous instructions/python3）+ 全量防线/eval 测试绿（evals 33/33、alert_injection 8/8）。
4. 零回归：siem_query/related_alerts 的 FixtureSiem.query 与 prompt.ts 契约面逐字节未动；contract.test/flow.test/chat/autorun 等全绿；全量 pnpm test exit 0（641 agent + 111 web + 101 evals + 76 ingest + 111 case-backend + 14 mcp-audit = 988 测试 0 失败，只增不减）。
5. 菜单工具位对账：PRD §13.4b「新增维度工具（票 78 落）」四行全部落地+登记销账；共享底座六件套与 weknora 三工具（票 79/83）各行不在本票范围。hunt 菜单子集接线（HUNT_MENU_TOOLS/DEFAULT_TEMPLATE/票 79 模板）按边界规则未动——四工具已具备被菜单引用的登记前提。

**出入/观察：** ① gateways py 例外集与 tools-manifest.test KNOWN_NOT_IN_A1 从空转四名（登记先行的点名机制，非偏差——A.1/FGA 矩阵收编与 specs 行号回填是 L0 专属，未动 docs/prd.md、specs/、run-kinds.ts、template.ts、task-flow.ts）；② task-flow.ts execute 节点仍为 stub（票 73 注释预告「票 78 换真执行体」，但换真需动 m14 执行链+m3 菜单票面，超出本票 m5+m9 边界，票 79 接线时一并落——executeHuntTool 即为其预留的正门执行件）；③ pnpm lint 存在 3 处**先于本票**的 no-unused-vars 报错（judge.test.ts/prompt-guard.test.ts/case-backend app.ts，非本票文件，未代改）；④ lessons 7-2-manifest-probe.mts 头部打印的「25 行」文案在票 63 后即已过时（教具 print，非断言，未动）。

- **L0 验收（主窗口，2026-09-13）**：亲跑双闸 PASS + agent 638|3skip + evals 101（hunting rig INV-11 矩阵 3×28=84 次 403 全对——新工具自动进遍历矩阵，正是"登记即被 INV-11 罩住"的机器证明）；PRD §13.4b 四行逐条销账：file_change_query/outbound_conn_query/web_access_query/proc_lineage_query 已全部 manifest 登记（票 78 落），对账在本记录关闭、PRD 计划行不回改（其原文即"票 78 落"）。三项观察处置：①hunt_task execute stub 换真执行体=m14 领地活，executeHuntTool 为 79 预留正门——**移交 79 简报钉死**；②A.1/FGA 矩阵/specs 行号回填 L0 专属——FGA 矩阵子 agent 已按既有口径收四名（gateway 测试文件，m9 领地内），A.1 不动（PRD 附录是计划表非验收面）；③3 处先于本票的 lint 报错与 76 记录的同源，挂账阶段 E。收尾五样齐。
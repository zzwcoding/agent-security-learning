# 48-m9-tool-manifest: ToolManifest 登记机制 + 工具脚手架生成器（ADR 0004-2）

**What to build:** 工具清单落 tools.manifest.json 单一来源（name/tier/family/owner_card/description），verify-ticket 分级改读 manifest（未登记一律 L1 fail-closed 口径保持并写进机制）；契约测试锁 manifest ≡ 各 worker TOOLS 常量 ≡ PRD A.1 清单；`pnpm gen:tool <name>` 脚手架生成「输出一句话」空壳工具 + manifest 行 + 测试骨架，演示新增工具→登记→闸生效 / 未登记被拒全流程。

**Blocked by:** （ADR 0004 已落）

**Touches modules:** `m9`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] manifest 单一来源：分级读它；未登记工具默认 L1 被闸（负例测试）（源：FR-S2.1·遗留 G2-4·ADR 0004-2）
- [x] manifest ≡ TOOLS 常量 ≡ A.1 三方一致性契约测试（漂移必红）（源：体检对账口径）
- [x] 脚手架生成空壳工具端到端演示：生成→登记→过闸可用；不登记→闸拒（源：用户拍板「新增工具→工具登记，外围用简单空壳」）
- [x] 既有分级/闸测试零删除（L0 读免验的更严口径如有变化记票）（源：体检口径）

## 实现落点（票内记档）

- **登记表** `fixtures/tools.manifest.json`（fixtures 共读通道，票 29/31/32 先例）：24 工具 × {name/tier/family/owner_card/description} = A.1 全部 23 工具 + get_case（出入①）；`policy.unregistered_tier: "L1"` ——「未登记一律 L1」从注释升格为登记表自己声明的机制，契约测试钉死该值只许 L1。
- **读口** `services/agent/src/tools-manifest.ts`：loadToolsManifest（env `TOOLS_MANIFEST_FILE` 覆盖 + 模块缓存，visible-tools.ts 读 FGA_MATRIX_FILE 同款三件套）+ tierOf（未登记 → policy 默认级）+ resetToolsManifestCache（测试接缝）。读失败抛错 → 在闸体 INV-1 的 try 里兜成 403 signature_invalid（册子病了门关得更死）。
- **分级消费改造** `verify-ticket.ts`：票 07 手写静态表（L0_TOOLS/L2_TOOLS 四个名字）退役，`tierOf()` 接位（载体变更，断言语义不变：L0 免验 / L1 需任务票 / L2 需审批铸票照旧）。任务票/审批票两路径不查分级，行为零变化。
- **三方契约闸** `services/agent/src/tools-manifest.test.ts`：① manifest ≡ PRD A.1（现场解析 docs/prd.md 的 A.1 表格，名字+分级逐字，不建第二份清单；manifest 比 A.1 多出的登记必须逐个具名）；② manifest ≡ worker 工具面（TRIAGE/INVESTIGATION/ENRICHMENT/KNOWLEDGE/CHAT_READONLY 五常量 + 五张 run kind 票面 allowedTools + close_flow 最小票，全部已登记；持票工具面无 L2 = INV-3 户口册版）；③ 全表扫描分级行为（24 工具无票过闸：L0→allow / L1→no_ticket / L2→require_approval，改任何 tier 即红）+ 未登记负例（kb_search 幽灵工具锚，出入②）+ env 覆盖接缝自证。
- **矩阵互锁** `services/gateway/test_fga_matrix.py` 增 test_tool_manifest_matches_matrix_families：FGA 矩阵（族→角色授权面）里每个工具在登记表同名同族同级；登记表比矩阵多出的登记必须具名（当前唯一 get_case）。与该文件既有 A.1/A.2 断言同住。
- **脚手架** `tools/gen-tool.mjs`（零依赖 node，中立层不 import 工程内部——边界 R3）：`pnpm gen:tool <name> [--tier L1]`（默认 L1=fail-closed 同口径；另有 --family/--owner/--desc/--out/--manifest 可选）。生成空壳 handler（输出一句话）+ 测试骨架 + 登记行追加；重名拒绝（退出码 2，登记面绝不静默覆盖）、非法名拒绝、清单缺失给明确报错。默认输出目录 `generated-tools/` 已进 .gitignore——入库的是生成器，不是生成物。
- **端到端演示** `services/agent/src/gen-tool.test.ts`（临时目录跑，TOOLS_MANIFEST_FILE 把闸指向演示清单）：生成 L0 → 无票 allow；生成 L2 → require_approval；删登记行 → 同一工具名 403 no_ticket；重名/非法名拒绝。

## 记票定夺（票面留白处 / 出入）

1. **A.1 缺 get_case（三方一致性暴露的真实漂移）**：get_case 是票 17 引入的沉淀读案工具（KNOWLEDGE_TOOLS 两件之一，knowledge_flow 票面持票），PRD 附录 A.1 全表未列。本票不追加改 PRD（交付文档，避并行冲突）：登记表按代码现状收编（tier=L1 更严口径——读案也过任务票，与 knowledge/flow.ts「L1 get_case 过任务票闸」注释一致；family=readonly_query 表其本质是只读族，FGA 授权面不认识它故不入矩阵），契约测试以「具名偏差」方式点名（manifest 比 A.1 恰许多 get_case、比矩阵恰许多 get_case），多一个没记票的即红。A.1 补列留待下次 PRD 修订。
2. **kb_search 幽灵工具除籍**：票 07 静态表里的 `kb_search` 全仓无第二处引用、A.1 无此工具——载体换成登记表后自然成为未登记工具（默认 L1 被闸），并留作未登记负例测试的锚。旧表四个名字里另一个 L0（siem_query）A.1 有据，照迁。
3. **L2 覆盖补齐（更严口径，零行为回归）**：旧静态表 L2 只有 isolate_host/kb_write 两件；A.1 的 L2 五件中 block_ip/deisolate_host/unblock_ip 此前落「未登记默认 L1」口径。入册后全部 L2——无票路径从 no_ticket 变 require_approval（都拒，语义更准）；持票路径不受影响（无任何 worker 票面含 L2，INV-3）。既有分级/闸测试零删除全绿。
4. **A.1 提取方式选型（票面给的二选一）**：选「从 PRD 提取清单做静态断言」（测试现场解析 docs/prd.md 表格），不建样品 fixture——fixture 会成为第四份手抄，自身还需要一条「fixture ≡ PRD」测试，不如直接咬文档。
5. **chat 意图闸的 tier 来源未动**：workers/chat/visible-tools.ts 仍读 matrix.json（m8 可见性/意图分流转审批的语义面），与登记表的 tier 一致性由 gateway 矩阵互锁测试担保（契约测试锁双源 = 本仓已驯服模式，py-TS 双验票同款）。票面只要求验票闸分级读 manifest，此处不扩大战果。

## 门禁

- `python3 tools/check_specs.py` → PASS（0 警告）
- `pnpm check:boundary` → self-test 18/18 + PASS（0 越界，9/9 条禁令全有人查）
- `pnpm lint` / `pnpm -C services/agent typecheck` → 过
- 测试（新增 13 + 矩阵互锁 1，零删除）：agent 474 passed + 4 skipped（基线 461+4sk + 本票 13）/ case-backend 60 / evals 99（+ eval 套件 33 用例）/ ingest 41+1sk（wazuh 真容器冒烟为能力探测 skip，容器不在即 skip——票 46 commit 记录同口径 41+1sk，本票零 ingest 改动）/ web 100 / mcp-audit 14 / gateway pytest 43（基线 42 + 本票 1）

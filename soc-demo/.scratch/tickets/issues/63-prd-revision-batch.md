# 63-prd-revision-batch: soc-demo PRD 账面修订批（体检 #7/#8 + 票 48/49 挂账并批）

**What to build:** docs/prd.md 落后于现实的三处账面修订（阶段 7 体检 2026-09-12），零决策纯对账：①§8 服务清单 C1-C7 列 7 服务、把 ContextForge/OpenFGA 写成 gateway 单容器——改为实际默认九服务拓扑（补 openfga/contextforge，与 specs/modules.md §2"三个容器并排"对齐）；②删/改 `pnpm fixtures:load` 幽灵引用（全仓无此脚本定义，替换为实际灌入命令）；③§8 部署形态补 jiaotu profile 一行（全外接双模式，指向 README 狗粮段与 docker-compose.jiaotu.yml）——PRD 目前 grep "jiaotu|椒图" 0 命中；④票 48"A.1 补列留待下次 PRD 修订"与票 49"PRD 文字修订留待下次"两笔挂账若同面一并清（不同面则注明留批）。

**Touches modules:** 无（纯 docs/prd.md）

**Belongs to spec:** docs/prd.md（§8 部署形态）

**Blocked by:** 无

**Status:** done（2026-09-12 当票施工+主窗口验收：PRD 六处 + 收敛测试两处同步）

**验收：**
- [x] §8 服务清单与 docker-compose.yml 默认九服务逐名一致
- [x] 全文无 fixtures:load 幽灵引用；灌入命令与 package.json/scripts 实际一致
- [x] §8 有 jiaotu profile 双模式一行；票 48/49 两笔 PRD 挂账销账或注明留批理由

**实现记录：**（2026-09-12 主窗口直改）①§8(:1068) 服务清单 C1-C7 九服务逐名对齐 compose（补 openfga/contextforge）+ 三 profile（real-wazuh/observability/jiaotu）+ 布景命令改 `setup-openfga.sh`+`pnpm replay`；②§8(:997) 幕布景同改，注明原文 fixtures:load 系幽灵引用；③A.1 补 `get_case` 行（L1 沉淀读案，票 48 挂账销账）——同步 `tools-manifest.test.ts`：快照 24→25、KNOWN_NOT_IN_A1 具名偏差收回（清零保留登记位）；④FR-S4.2(:780) 验收标准改判后表述（ADR 0004 裁决 3+票 49，票 49 挂账销账）。

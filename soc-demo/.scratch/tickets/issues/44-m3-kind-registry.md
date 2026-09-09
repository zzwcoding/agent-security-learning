# 44-m3-kind-registry: run kind 描述符注册表 + evals scenarios 拆分（F2+F6）

**What to build:** ① kind→（票面 spec+图工厂+节点清单）单一注册表，RUN_KINDS/CASE_KINDS/TICKET_SPECS 三张平行表与 index.ts 分支收敛（新 kind 触点从 9+ 文件降到 1 处注册）；web pipeline FLOW_NODES 改由注册表派生或契约锁；② evals scenarios.ts（1040 行）按 facet 拆 rig 模块，布景声明与检查分层。

**Blocked by:** 36, 42

**Touches modules:** `m3`, `m10`, `m11`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] 新增 kind 只需注册一处（源：结构-1/2）
- [ ] scenarios.ts 拆分后 eval 全绿（源：结构-5）
- [ ] 全仓测试零删除零放松（源：体检口径）

# 15: m6 富化 worker：TLP/PAP 闸门 + analyzer 管线

**What to build:** observables 跑 analyzer（Cortex 契约子集，fixture 表 mock）+ TLP/PAP 确定性闸门 + artifacts 回写。

**Blocked by:** 13

**Touches modules:** `m2`, `m6`, `m9`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] enrich/01_vt_malicious_hash taxonomy 正确（源：m6 卡测试计划）
- [ ] TLP/PAP 闸门在工具包装层确定性执行（不靠 prompt）（源：m6 卡 Seam）
- [ ] enrich/02_tlp_red_blocked 超限必拒 + DENIED 审计（源：m6 卡测试计划）
- [ ] artifacts 回写 m2（源：m6 卡职责）

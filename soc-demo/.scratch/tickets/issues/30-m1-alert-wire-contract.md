# 30-m1-alert-wire-contract: alert wire 全链契约 + m1 hostname/TLP 映射补齐（A3+G1）

**What to build:** ① m1 映射补两行：agent.name→hostname observable（FR-M2.4 归并空转修复）+ TLP 溯源（wazuh.ts 硬编码 tlp:2 改为按规则/管道抽取，缺口=ticket15-2）；② fixtures/alerts 具名 fixture 做 ingest→M2→agent 全链 wire 断言（告警进案→observables→triage 读到的形状逐字段锁）。

**Blocked by:** （无）

**Touches modules:** `m1`, `m2`, `m4`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] hostname observable 从回放流水线真实进案，FR-M2.4 归并对回放数据生效（源：遗留标记 13-1·FR-M2.4）
- [ ] TLP 溯源：非默认 tlp 的告警能进案（enrich/02 类布景不再需 DB 直种）（源：遗留标记 15-2·§5.3）
- [ ] 全链 fixture 契约测试：ingest 映射/REST/agent 消费三段同锚（源：对账三-15）

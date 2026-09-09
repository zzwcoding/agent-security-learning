# 38-m1-real-wazuh-profile: Wazuh real-wazuh profile + logtest 喂数（B2）

**What to build:** compose 增 `profiles: [real-wazuh]`：Wazuh manager 容器 + logtest 喂数脚本（fixtures/alerts 灌真实规则引擎取回真 full_log 回推 webhook 正门）；与 replay.ts 推模式共存（回放布景两种来源）。

**Blocked by:** 28

**Touches modules:** `m1`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] real-wazuh profile 一键起，logtest 真回包灌 webhook（源：FR-M1.6·遗留标记 09-1）
- [ ] 默认链路零改动（源：compose 拍板口径）
- [ ] 灌回数据走 webhook 正门不直塞库（源：m1 卡三铁律）

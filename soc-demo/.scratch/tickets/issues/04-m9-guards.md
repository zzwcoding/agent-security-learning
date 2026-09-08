# 04: m9 guards 防护件：注入扫描 + PII 脱敏

**What to build:** 独立 FastAPI :8001：/scan/injection 四通道扫描（alert_field/user_input/kb/tool_output，按通道配 block/剔除/仅标记）+ /pii/anonymize（Presidio zh/en 实体集 + RFC1918 内网豁免自定义识别器）。无状态。

**Blocked by:** None (can start immediately)

**Touches modules:** `m9`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] 四通道扫描契约照 PRD §6-M9-S3（请求 text+channel，响应 is_injection/score/action）（源：m9 卡公开接口·PRD S3 接口契约）
- [ ] PII 替换类型占位符，出域文本 100% 无原文（源：PRD S4 验收标准·FR-S4.1）
- [ ] RFC1918 内网 IP 豁免（源：决策记录 #8）
- [ ] 服务不可达/扫描超时 2s → 调用方 fail-closed（不可信段不进 prompt + 转人工）（源：PRD S3 异常与边界·INV-1）
- [ ] 攻击 fixture 四注入位（srcuser/full_log/url/previous_output）拦截率 100%（源：m9 卡测试计划·PRD S3 验收）

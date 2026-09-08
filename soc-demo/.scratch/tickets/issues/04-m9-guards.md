# 04: m9 guards 防护件：注入扫描 + PII 脱敏

**What to build:** 独立 FastAPI :8001：/scan/injection 四通道扫描（alert_field/user_input/kb/tool_output，按通道配 block/剔除/仅标记）+ /pii/anonymize（Presidio zh/en 实体集 + RFC1918 内网豁免自定义识别器）。无状态。

**Blocked by:** None (can start immediately)

**Touches modules:** `m9`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] 四通道扫描契约照 PRD §6-M9-S3（请求 text+channel，响应 is_injection/score/action）（源：m9 卡公开接口·PRD S3 接口契约）
- [x] PII 替换类型占位符，出域文本 100% 无原文（源：PRD S4 验收标准·FR-S4.1）
- [x] RFC1918 内网 IP 豁免（源：决策记录 #8）
- [x] 服务不可达/扫描超时 2s → 调用方 fail-closed（不可信段不进 prompt + 转人工）（源：PRD S3 异常与边界·INV-1）
- [x] 攻击 fixture 四注入位（srcuser/full_log/url/previous_output）拦截率 100%（源：m9 卡测试计划·PRD S3 验收）

---

## 实现记录（2026-09-08）

**产物**：`services/guards/`——`injection_scan.py`（6 攻击族确定性规则引擎：指令覆盖/
权限伪造/工具调用注入/数据外传/提示词外泄/不可见字符，score≥0.5 判定；通道处置
alert_field/user_input=block、kb=strip 剔命中行、tool_output=flag）、`pii.py`（EMAIL_
ADDRESS/PHONE_NUMBER/CN_ID/CREDIT_CARD/IP_ADDRESS 五识别器 + RFC1918 豁免 + 重叠去重）、
`app.py`（契约装配）；攻击 fixture `fixtures/attack/injection/` 四注入位各一（语料家族
取自路线 1-3 红队实测：promptinject Hijack/DAN/指令覆盖，中英混合）；调用方 fail-closed
客户端 `services/agent/src/guards-client.ts`（2s 默认超时、不可达/超时→blocked=true
fail_closed，GUARDS_FAIL_MODE=flag 可切仅标记降级）。

**引擎替换决策（对票面「llm-guard/Presidio」的出入，记票不猜）**：路线 1-3 的注入扫描
用 llm-guard PromptInjection（deberta onnx，HuggingFace 运行时下载 500MB+），Presidio
需 spacy 模型——均进不了本仓 CI 且破坏确定性口径。实现取**同契约确定性引擎**：响应
字段照 PRD（scanner:"PromptInjection"），管线形状照搬（scan→score→按通道处置），
实体集照 memory_guard.py 的中文落地课（内建偏英文、中文正则识别器补、名单收窄防误报
——故 PERSON 类 NER 实体不设，对话里的人名不脱敏）。llm-guard/Presidio 真件可作
同契约替换件后续换入，接口不变。

**契约补充**：/scan/injection 响应在 PRD 三字段外加 `hits`（命中族明细，供「扫描结果
与处置进审计」）与 `text`（strip 通道的清洗文本）；invalid channel → FastAPI 校验。
语言参数收下但引擎双语（正则对 zh/en 同时生效）。

**验收 4 的归属**：fail-closed 是调用方行为，本票以 guards-client.ts 交付该 seam
（2s 超时/不可达→blocked+fail_closed；「转人工待办」由后续 m4/m3 消费方接手），6 个
vitest 含真 TCP 不可达与慢服务超时两个故障注入测试。

**验证**：guards pytest 9/9、agent vitest 7/7（新 6 + 骨架 1）、全仓 TS 三连绿、
ruff 过、spec gate PASS；真服务冒烟 :8001：中文注入 block（score 1.0）、干净日志
allow、anonymize 输出 `张三 <PHONE_NUMBER> <EMAIL_ADDRESS> 从 <IP_ADDRESS> 攻击
10.0.0.5`（公网打码、内网豁免、人名按名单收窄保留）。

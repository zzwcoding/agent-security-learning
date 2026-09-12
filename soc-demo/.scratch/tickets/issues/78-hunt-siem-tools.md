# 78-hunt-siem-tools: 狩猎查询工具 ×4——SIEM 维度扩展（P1）

**What to build:** 能力菜单的查询维度扩展，五业务共用。FixtureSiem（`workers/investigation/siem.ts`）在现有 ip/user/host 索引之外加四个维度 + 对应工具封装（登记进 tools.manifest，tier/owner 按现有表口径）：① `file_change_query`（按路径/哈希查文件新增篡改——FIM 维度，webshell 落盘取证）；② `outbound_conn_query`（按目的 IP/域名/频率查外联——C2 心跳维度）；③ `web_access_query`（按 URL 模式查访问异常——web 攻击痕迹维度）；④ `proc_lineage_query`（按进程名查父子关系——持久化/提权维度）。fixture 语料按维度补条目（沿用现有 Wazuh 语料风格，注入变体惯例照旧：攻击者可控字段埋点）。每工具：L0 只读、票面登记、fake 数据源 seam、契约测试（时间窗强制口径与 siem_query 一致——缺窗报错不替 LLM 补）。

**铁律:** 边界红线——只许扩展 investigation 的 SIEM adapter 面与工具登记，m2/guards 禁碰；注入变体 fixture 全量过现有防线测试（INV-1）；新工具默认 L0，升级 L1 需 L0 裁决记票。

**Touches modules:** `m5`（adapter 扩展）、`m9`（manifest 登记）

**Belongs to spec:** specs/orchestration-loop.md（行号回填同上）；票 70 菜单工具位清单对账


**Spec 绑定:** specs/orchestration-loop.md 验收测试表 T13 前置（菜单登记）（spec 已定稿 2026-09-12）

**Blocked by:** 72

**Status:** blocked

**验收：**
- [ ] 四工具各维度查询契约测试绿（命中/空集/时间窗缺失报错三态）
- [ ] tools.manifest 登记齐全（未登记一律 L1 的 fail-closed 策略对新工具生效验证）
- [ ] 每维度至少 1 条注入变体 fixture，防线测试全绿
- [ ] 现有 siem_query/related_alerts 行为零回归
- [ ] 菜单工具位清单逐条对账关闭

**实现记录：**（待填）

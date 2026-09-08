# 08: m9 凭证代理 + gateway 自写件容器化

**What to build:** /proxy/llm/* 转发：验票通过后出站前在白名单字段替换凭证占位符为真值（SECRETS_* env）。与铸票件合成一个 compose 服务（gateway 自写件）。金丝雀断言测试。

**Blocked by:** 03, 06

**Touches modules:** `m9`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] 占位符 ${{ SECRETS.x.KEY }} 在出站白名单字段替换真值（源：PRD FR-S1.2·m9 卡公开接口）
- [x] 金丝雀凭证全链路（prompt 装配/工具调用/审计/timeline）grep 不到真值（源：m9 卡测试计划·INV-4）
- [x] 占位符无对应凭证 → 执行失败 fail-closed + 审计（源：PRD S1 异常与边界）
- [x] 与铸币件合成 compose 服务 gateway（自写件不动镜像内部）（源：modules.md §2 三容器并排拍板）

---

## 实现记录（2026-09-08）

**产物**：`services/gateway/proxy.py`（凭证代理，参数化搬自 ADR 0001 盘点的路线 3 实测件
starter-agent/proxy.py 74 行：UPSTREAM 与密钥 env 名参数化）+ `app.py` 挂
`/proxy/llm/{path}`（与 /internal/mint 同一 FastAPI app，合成一个自写件容器）+
Dockerfile 三件齐拷 + compose gateway 挂 SECRETS_* 真值仓 env。测试 `test_proxy.py`
7 个（全仓 gateway 24 绿）；出站 seam 打在 `proxy._client`（httpx.MockTransport）。

**契约裁决（票面未细化处，按 PRD 机制落）**：
- 占位符→env 映射：`${{ SECRETS.vt.KEY }}` → env `SECRETS_VT_KEY`（点换下划线全大写）；
  provider 真 key 走 `SECRETS_LLM_API_KEY` 注入 Authorization（参考件★唯一注入点）。
- 白名单字段 = `("metadata",)`（`CREDENTIAL_BODY_FIELDS`）。白名单存在的理由：替换是
  发秘钥的特权操作，只发给「声明的收件人」；messages 等 LLM 可见字段永不在列
  （FR-S1.1 模型只见占位符原文），白名单外的占位符按原文透传。
- 泄露检测（PRD S1 接口契约「SECRETS_ 值出现即告警」）落成运行时闸 `scan_leak`：
  模型可见（白名单外）字段检出任何 SECRETS_* env 真值 → 503 拒绝 + 审计（≥8 字符
  参与扫描防平凡值误报）。
- 审计缝 `audit()`：stdout JSON 行（五要素 action/actor/object/result/detail + ts +
  request_id，x-actor-id/x-request-id 头关联，与 M2 头约定一致）。生产落 M2
  AuditEntry 的接线在票 10+（调用方持有 run 上下文）；本票消费者 = compose logs 与测试。
- INV-1 裁决顺序（与验票闸同精神，最致命先问）：env 缺失 → 占位符无凭证 → 泄露
  命中 → 上游不可达，任一步不过立即 503/502，上游一个字节不发。
- compose env 教学假值：`SECRETS_VT_KEY`/`SECRETS_SIEM_TOKEN` 默认金丝雀假值
  （真部署以环境变量覆盖）；`SECRETS_LLM_API_KEY`/`SOC_HMAC_KEY` 只留 pass-through
  不设默认——缺了就 fail-closed，不写死任何半真值进仓库。

**金丝雀断言口径（验收 2）**：本票锁住此刻已存在的可观测面——成功响应体、两种错误
消息、审计行、转发日志（stdout）——除「出站请求体那一瞬」外 grep 全干净，且测试先
断言金丝雀真的活在上游收到的请求里（防假绿）。prompt 装配/工具调用/M2 审计表等面
随票 10-19 落地，m9 卡「全链路 grep 不到」由 evals（票 19/22）在同一断言上复跑全链路。

**顺手修正**：gateway Dockerfile 原只 `COPY app.py`，而 app.py import mint——镜像一
启动就 ImportError（票 06 遗留的隐形断线）；本票验收 4「合成 compose 服务」要求镜像
可跑，三件齐拷并加测试锁住。guards 的 Dockerfile 同病（只拷 app.py，缺
injection_scan/pii）——不在本票范围，留给守该文件的范围修。

**验证**：gateway 24/24 绿（17 基线 + 7 新）、guards 9 绿、ruff 全过、
`python3 tools/check_specs.py` PASS（5 条规划警告合法）、`docker compose config -q`
过、全仓 TS 74 测试绿；真服务冒烟 :8002（healthz / 经代理转发到本机 /internal/mint
占位符注入后 mint 200 回执 / ghost 占位符 503 报占位符名不报值 / GET 透传 / 日志
grep 无密钥值）。docker build 冒烟未做（本机 daemon 未启动；镜像 COPY 正确性由
「uvicorn 启动即 import 三件」+ test_gateway_selfbuilt_image_carries_mint_and_proxy 锁）。

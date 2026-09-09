# run-01 · 分诊：从跑通项目到看懂一次告警判定

> 本文是 2026-09-09 演示会话的复习整理：把项目跑起来、切真 LLM、看懂分诊结果、搞清过程日志存哪。
> 体裁说明：这是「run 系列」演示复习（非票-步教学文档）；票-步教学文档见 36-01-case_flow上线-调查富化链接进生产.md。

---

## 1. 项目是什么

**SOC 数字员工**：Wazuh 告警太多人看不过来，让 agent 自动分诊/调查/沉淀知识，危险动作永远等人审批。

数据流一句话：

```
Wazuh 告警 → ingest(3001) webhook 正门 → case-backend(3002) 去重入库
→ web(5173) 点跑流水线 → agent(3003) 分工 worker（kb_check 查知识库 → LLM 判 verdict
→ 自我审计 checkpoint → 建案/审批卡）→ SSE 实时推流水线视图 + 审计落 M2
```

9 个容器职责速记：ingest 接入 / case-backend 存储（SQLite）/ agent 大脑 / guards 注入扫描
/ gateway 铸票+凭证代理 / openfga 授权裁决 / contextforge RBAC 渠道面 / chroma 知识库 / web 演示窗。

## 2. 启动手册（实测口径）

```bash
cp .env.example .env          # 教学假值可跑；真值由环境注入（票 06 fail-closed 口径）
docker compose up -d --build  # 首次或代码更新后带 --build
bash scripts/setup-openfga.sh # 幂等重建 FGA 授权世界；openfga 是内存存储，容器重启后必须重跑
pnpm replay                   # 12 条告警 fixture 走 ingest webhook 正门（同页面回放按钮）
```

打开 http://localhost:5173 选脸登录（无密码，四预置身份：soc1 / duty_lead / admin / redteam）。

三个曾经踩过的坑（已修，属于收尾工作）：

| 坑 | 现象 | 修法 |
|---|---|---|
| agent/case-backend 的 Dockerfile 缺编译工具链 | 重建镜像时 better-sqlite3 源码编译失败 | `apk add python3 make g++`（alpine/musl 无预编译包） |
| compose 的 ingest 没配 CASE_BACKEND_URL | 回放全 500（回退 127.0.0.1 指向容器自己） | 补 `http://case-backend:3002` |
| compose 没穿透 SOC_HMAC_KEY | 登录报 hmac_key_missing | gateway/agent 加 `${SOC_HMAC_KEY:-}`，值放 .env（gitignore） |

## 3. 分诊的四种结论（verdict 词表）

| 缩写 | 全称 | 含义 | 后续动作 |
|---|---|---|---|
| TP | True Positive | 真实攻击 | 升级建案，自动调查 |
| BTP | Benign True Positive | 检测没错但行为良性（演练/授权操作） | 建议关单，等人确认 |
| FP | False Positive | 误报 | 建议关单 |
| Uncertain | 不确定 | 证据不足 | **fail-closed 转人工** |

易混点：TP 与 BTP 的区别不在"检测对不对"，而在"行为坏不坏"。
Uncertain 单列是项目红线（INV-1）：机器拿不准一律交人工，绝不硬编结论。
词表唯一法律在 `fixtures/verdicts.json`（票 31：三端共读，防漂移）。

## 4. 判定逻辑：伪 LLM 的四档决策阶梯

代码：`services/agent/workers/triage/llm.ts` 的 `FakeTriageLlm.decide()`，按序短路：

1. **R1 KB 已知变更**（命中 known_change / env_fact）→ BTP 关单
2. **R2 攻击证据**：severity≥3 ∨ 标题(brute force/malicious file/rootkit) ∨
   日志(failed password/rootkit) ∨ URL(UNION SELECT / <script / whoami.cgi / /etc/passwd)
   → TP 建案
3. **R3 弱信号**（non-existent user 孤立试探）→ uncertain
4. **R4 运维噪声**（标题含 error code / file added，且无 R2 信号）→ FP
5. 兜底 → uncertain（"无匹配决策点，默认升级人工"）

设计要点：规则是"与 fixture 无关的内容信号"，不偷看文件名；标注集
`workers/triage/accuracy.test.ts` 是独立第三方裁判，规则写错测试就红。

## 5. 两个案例对比：看载荷，不看状态码

两条告警标题几乎一样（"Web server 4xx/5xx error code"），判定却相反：

| | CGI 500 → **FP** | SQLi 400 → **TP** |
|---|---|---|
| URL | `/cgi-bin/legacy_status.cgi` | `/products.php?id=1 UNION SELECT username,password FROM users--` |
| 载荷本质 | 普通状态页 | 教科书级 SQL 注入探测（拖库意图） |
| 状态码含义 | 脚本自己坏了，运维噪声 | 服务器拦下了恶意请求——**攻击未遂 ≠ 不是攻击** |

判定路径：SQLi 的 URL 命中 R2 的 `union select`（攻击证据优先于"error code"噪声词）；
CGI 500 四条 R2 全不中（`whoami.cgi` 是探测，`legacy_status.cgi` 不是），落 R4。
核心原则：**分诊看的是攻击者可控的 untrusted 字段内容，不是告警标题/状态码本身**。

## 6. 切换真 LLM

链路（票 27）：agent → gateway `/proxy/llm/*` 凭证代理（占位符换真 key，key 只活在网关进程）
→ MiniMax 上游，OpenAI 兼容 `/v1/chat/completions`，`<think>` 推理段有剥壳。

`.env` 配置（key 从 Keychain `agent-key minimax` 取，不落仓库不回显）：

```
AGENT_LLM=real
LLM_MODEL=MiniMax-M2          # 国际站规范大小写
SOC_LLM_UPSTREAM=https://api.minimax.chat   # 注意不是 compose 默认的 api.minimaxi.com
SECRETS_LLM_API_KEY=<真 key>
```

改完 `docker compose up -d` 重建生效。三个行为差异：

1. 真调用真花钱（对标 M507 约 $0.18/告警）；
2. 上游病了 worker 降级 uncertain+人工（fail-closed，`workers/triage/llm-real.ts`）；
3. 测试不受影响（vitest rig 显式注入 fake，不走这个开关）。

**验证真出站的方法**：看网关审计日志 `proxy.forward upstream=200 bytes=… took=…`；
看 rationale 是否为自然语言（伪 LLM 是模板句"攻击证据成立（title=… severity=…）"）。
真 LLM 判 SSH 暴破的 rationale 还带 MITRE T1110 映射。
诚实观察：真 LLM 偶有"结论对、叙述瑕疵"（把 SQL 注入说成 XSS）——结论稳、措辞不可靠，
这正是 eval 里"确定性断言 + LLM judge 混合"设计的理由。

## 7. verdict 锁：已判过的告警不会重判

重跑已分诊的告警，审计里出现 `triage_skip, reason: verdict_locked`，run 直接 completed。
这是防重设计：旧 verdict 保留，不会被覆盖。想全部重判 = 清库重播（停机清 `data/case-backend/`，再 `pnpm replay`）。

## 8. 点完分诊，过程日志存哪

| 存储位置 | 内容 | 持久性 |
|---|---|---|
| agent SQLite `run_events` | 节点进出/工具调用/状态迁移事件（SSE 回放与断线补发的底账，INV-7） | ⚠️ **当前易失**：compose 没给 agent 挂数据卷（票 41①未做），重建容器即丢 |
| M2 `audit_entries` | 五要素审计（谁/何时/对什么/干了什么/结果+diff，INV-8），agent 动作经 HttpAuditSink 汇入（票 35） | 持久（`./data/case-backend` 卷），审计流页读它 |
| 告警 `verdictAi` 字段 | verdict/confidence/rationale/self_audit | 持久 |
| LLM 原始 prompt/回包全文 | **不存**（只存结构化结论） | 全文级 trace 是票 37 Langfuse profile（未开工） |

另：tool_call 只存参数哈希 `params_hash`，不存原文。

## 9. 启动

cd soc-demo
open -a Docker                      # Docker Desktop 没开的话
docker compose up -d --build        # 首次或代码更新后加 --build
bash scripts/setup-openfga.sh       # 幂等重建 FGA 授权世界（openfga 是内存存储，容器重启后要重跑，~30 秒）
pnpm replay                         # 12 条告警 fixture 从 webhook 正门推入（或直接用页面上的回放按钮）
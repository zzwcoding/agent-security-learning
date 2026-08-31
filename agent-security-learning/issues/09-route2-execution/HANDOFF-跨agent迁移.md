# HANDOFF:路线 2 跨 Agent 迁移交接(2026-08-30;2026-08-31 接手 agent 复核后刷新进度)

> 给换一个 agent 继续执行路线 2 用。原始交接(决策、四阶段任务单、验收标准)在 `HANDOFF.md`,本文件只补"当前进度 + 新 agent 开工所需的增量"。

## 0. 需要移植的 skill

| skill | 位置 | 要不要带 |
|---|---|---|
| **learn-by-rebuild** | `/Users/divh/.agents/skills/learn-by-rebuild/SKILL.md`(单文件) | **必带**——整套教学纪律(小步增量/数据流闭环/注释轮换/讲解落盘/用户控节奏)都在里面 |
| wayfinder | `/Users/divh/.agents/skills/wayfinder/` | 建议带——收官时写票 Answer、维护 map.md 的格式约定 |
| knowledge-cards | 项目级,已在仓库 `.agents/skills/knowledge-cards/` | 不用带,随仓库走 |
| 其他(grilling/research/interview-prep 等) | 用户级 | 路线 2 用不到 |

移植方法:把 `SKILL.md` 内容贴给新 agent 让它照此工作,或复制到对应工具的 skill 目录。

## 1. 当前进度(2026-08-31 接手 agent 复核更新)

- **阶段 21 已提交**:commit `1b8e078`(MISSION/RESOURCES/lesson 0018/record 0022 已入库)
- **阶段 22 已完成、未提交**(2026-08-30 施工;接手 agent 2026-08-31 复跑验证通过:Linux 内核/宿主不可见/一次性实证,两次调用 1.2s):
  - 改动:`starter-agent/mcp_servers/shell_server.py`(`run_command` → 一次性 microVM)、`starter-agent/agent.py`(BANNER/注释轮换)、`issues/09-route2-execution/MISSION.md`(阶段 22 行勾 ✅)
  - 新文件:`lessons/0019-shell工具进microVM.md`、`learning-records/0023-stage22.md`、本 HANDOFF
  - 等用户说"提交",以 `阶段 22:` 前缀入库
- 验证脚本 `/tmp/test_shell_mcp.py`(依赖级测试),复跑:`cd starter-agent && .venv/bin/python /tmp/test_shell_mcp.py`

## 2. 下一步:阶段 23(fetch 工具进 microVM + egress 白名单,缺口 1 核销点)

已核实的 API 事实(不要重复调研,来源 `.venv/.../microsandbox/types.py` 与 `_microsandbox.pyi`):

- 改造对象:`starter-agent/mcp_servers/fetch_server.py`(现 27 行,httpx GET/POST 裸奔);SDK 全异步,两个工具照 shell 模式改 `async def`
- 白名单走新 API:`Sandbox.create(..., network=Network(policy=...))`;策略形如 `NetworkPolicy(default_egress=Action.DENY, rules=(Rule.allow(destination=Destination.domain("httpbin.org")),))`——**不是**旧文档的 `allowed_hosts` 列表(MISSION 路线表里这词是旧措辞,施工时顺手改掉)
- ⚠️ deny-by-default 下 DNS 也要显式放行:`rules` 里要 `*Rule.allow_dns()`(UDP/53+TCP/53 一对),否则域名解析都过不去
- 拦截生效位置:DNS 解析(NXDOMAIN)/ TLS 首包(SNI)/ TCP 出网,三层兜底
- 白名单初值:只放 `httpbin.org`(验收用)+ Agent 真实需要的域名
- 编号:lesson 0020、record 0024;验证照 `/tmp/test_shell_mcp.py` 模式 stdio 直连(`agent.py` 的 /call 只连 filesystem_server,验不了 fetch)

## 3. 纪律提醒(沿用)

- 用户说"下一步"才进新阶段,说"提交"才 commit(消息前缀 `阶段 N:`)
- 真 key 只走 Keychain(`starter-agent/scripts/run-with-keychain.sh`);`.env` 永远假密钥
- agent 代跑服务:后台任务 + `disable_timeout`;用户自己跑的服务不抢端口
- microsandbox 是 beta:踩坑记 record,不硬撑

## 4. 复制即用开场白

```
读 /Users/divh/Downloads/安全评估agent/.scratch/agent-security-learning/issues/09-route2-execution/HANDOFF.md
和 HANDOFF-跨agent迁移.md,按 learn-by-rebuild 的纪律继续路线 2。
(若阶段 22 尚未提交,先等用户说"提交";然后从阶段 23 开始。)
```

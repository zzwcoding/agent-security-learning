# HANDOFF:路线 2 跨 Agent 迁移交接(2026-08-30;2026-08-31 二次刷新:阶段 21–29 完成,主线下一步 31)

> 给换一个 agent 继续执行路线 2 用。原始交接(决策、四阶段任务单、验收标准)在 `HANDOFF.md`,本文件只补"当前进度 + 新 agent 开工所需的增量"。

## 0. 需要移植的 skill

| skill | 位置 | 要不要带 |
|---|---|---|
| **learn-by-rebuild** | `/Users/divh/.agents/skills/learn-by-rebuild/SKILL.md`(单文件) | **必带**——整套教学纪律(小步增量/数据流闭环/注释轮换/讲解落盘/用户控节奏)都在里面 |
| wayfinder | `/Users/divh/.agents/skills/wayfinder/` | 建议带——收官时写票 Answer、维护 map.md 的格式约定 |
| knowledge-cards | 项目级,已在仓库 `.agents/skills/knowledge-cards/` | 不用带,随仓库走 |
| 其他(grilling/research/interview-prep 等) | 用户级 | 路线 2 用不到 |

移植方法:把 `SKILL.md` 内容贴给新 agent 让它照此工作,或复制到对应工具的 skill 目录。

## 1. 当前进度(2026-08-31 二次刷新)

- **阶段 21–29 全部提交完成**(最近三笔:阶段 29 `edb5d8d` OTel 审计字段、选型文档 `36054bd`、阶段 30 开工包 `d9e1d47`);逐阶段结论见 `MISSION.md` 阶段表(唯一实时真源)
- **阶段 25 复刻(平行窗口)已收官**:commit `922348d`(12/12 阶段,16/16 gate)+ `02974d9`(lesson 0013 全流程总账);产物在仓库根目录 `自修改agent复刻/`;收官对照 `自修改agent复刻/对照复盘-验证沙箱选型.md` 落定:**候选验证沙箱选一次性 microVM,加固 Docker 降备选**(三候选双后端灯表 100% 一致,probe.sh 双跑数据在案)
- **阶段 30 复刻(另一平行窗口)施工中**:仓库根目录 `日志脱敏复刻/`,交接 `HANDOFF-阶段30-日志脱敏复刻.md`,复刻 1–2 已提交;⚠ 该窗口工作区可能有未提交改动,主线提交时只 add 主线自己的文件

## 2. 下一步:阶段 31 四次主动攻击验收(逃逸 / egress / 密钥不可见 / 审计复盘,全程留证据)

四条验收的地基已全部就位,验收是"组装 + 留证",不是新建设:

| 攻击 | 武器/地基(已有) | 验收动作 |
|---|---|---|
| ① 逃逸 | `escape-probe/probe.sh` + `run_in_microvm.py`(阶段 24 产物,evidence/ 已有 Docker vs microVM 对照;复刻窗口又双跑一遍,数据在 `对照复盘-验证沙箱选型.md` §二) | 注入得手后 shell 只见一次性 microVM 内部,重跑留新证据 |
| ② egress | fetch_server 工具层白名单 fail closed(lesson 0020)+ VM 层 PUBLIC profile 兜底 | fetch 向白名单外域名外泄"密钥"被拒(缺口 1 核销证据) |
| ③ 密钥不可见 | LLM 路走 proxy.py(lesson 0022)、fetch 路走 `{{SECRET:}}` 占位符(lesson 0023) | dump Agent 进程环境/可见面,找不到真 key |
| ④ 审计复盘 | 阶段 29 五要素字段(OTLP 出网捕获字节级验证过,lesson 0025) | 四次攻击全程在 Langfuse 按 audit.* 字段可复盘 |

- 产出归 `deliverables/route2/` 三件(清单见 `HANDOFF.md` §5);缺口 1 核销还要回写 `deliverables/route1/03-已知缺口清单.md`
- 之后:阶段 32(chapter5/async-agent 对照讨论 + Firecracker/gVisor 精读)→ 阶段 33 收官(`deliverables/route2/` 三件 + 票 09 写 Answer 关闭)

## 3. 纪律提醒(沿用)

- 用户说"下一步"才进新阶段,说"提交"才 commit(消息前缀 `阶段 N:`)
- 真 key 只走 Keychain(代理进程经 `scripts/run-proxy.sh` 取;Agent 经 `scripts/run-agent.sh` 零密钥裸启动);`.env` 永远假密钥
- agent 代跑服务:后台任务 + `disable_timeout`;用户自己跑的服务不抢端口
- microsandbox 是 beta:踩坑记 record,不硬撑

## 4. 复制即用开场白

```
读 /Users/divh/Downloads/安全评估agent/.scratch/agent-security-learning/issues/09-route2-execution/HANDOFF-跨agent迁移.md,
按 learn-by-rebuild 的纪律继续路线 2,从阶段 31(四次主动攻击验收)开始。
```

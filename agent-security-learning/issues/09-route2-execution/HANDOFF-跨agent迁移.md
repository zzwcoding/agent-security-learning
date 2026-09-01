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
- **阶段 30 复刻(另一平行窗口)已收官(2026-09-01)**:11/11 阶段,commit `555a1c7`→`c90302e`;产物 仓库根目录 `日志脱敏复刻/`;收官拍板 `对照复盘-三引擎分工拍板.md`——三出口分工:memory.json=Presidio 保留,Langfuse trace 与本地日志=regex 在线全量 + hybrid 离线补扫(阶段 33 可引用)

## 2. 下一步:阶段 33 收官(`deliverables/route2/` 三件交付物 + 票 09 写 Answer 关闭)

~~阶段 31 四次主动攻击验收~~ ✅ 已完成(2026-08-31,`19098fe`;证据 `attack-validation/` 四目录,README 有总判表与复跑指南);~~阶段 32 对照讨论与精读~~ ✅ 已完成(2026-09-01,`d204e19`;lesson 0027/0028)。素材全部就位,收官是"组装 + 写报告":

- **三件交付物**(写进 `deliverables/route2/`,格式照抄 `deliverables/route1/`):
  1. 边界对比报告:素材 = 阶段 24 escape-probe 证据 + 阶段 25 复刻双后端对照 + lesson 0028 光谱理论
  2. 劫持无效化验证记录:素材 = 阶段 31 attack-validation/ 四攻击全文 + 防线命中统计
  3. 缺口 1 核销记录:素材 = 阶段 23 两层出网设计 + 攻击②六格证据;核销说明回写 `deliverables/route1/03-已知缺口清单.md`
  - 引用件:复刻收官拍板两份(`自修改agent复刻/对照复盘-验证沙箱选型.md`、`日志脱敏复刻/对照复盘-三引擎分工拍板.md`)
- **票 09 Answer**:交付物位置、与方案 08 的偏差(egress 白名单 API 换形/凭证注入点移到 fetch_server/chapter 编号误记/一次 gzip bug 修复/架构新增 middleware 审计)、验收证据指针;Status 置 closed

之后回主窗口按滚动排期开**路线 3 方案票**(输入已备好:缺口 2/3/7 备料方案、ContextForge 研究结论票 05、根目录两份调研《Agent开发分层与语言选型》《沙箱机制与传统安全业务选型》)。

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

# 38-m1-real-wazuh-profile: Wazuh real-wazuh profile + logtest 喂数（B2）

**What to build:** compose 增 `profiles: [real-wazuh]`：Wazuh manager 容器 + logtest 喂数脚本（fixtures/alerts 灌真实规则引擎取回真 full_log 回推 webhook 正门）；与 replay.ts 推模式共存（回放布景两种来源）。

**Blocked by:** 28

**Touches modules:** `m1`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] real-wazuh profile 一键起，logtest 真回包灌 webhook（源：FR-M1.6·遗留标记 09-1）
- [x] 默认链路零改动（源：compose 拍板口径）
- [x] 灌回数据走 webhook 正门不直塞库（源：m1 卡三铁律）

## 实现记录（2026-09-09，编码窗口）

**① compose profile real-wazuh（验收①）**：`docker-compose.yml` 增 `wazuh-manager`
单容器，挂 `profiles: ["real-wazuh"]`。只要 manager 当「真规则引擎」backdrop（logtest
用），不要 indexer/dashboard 全家桶——PRD FR-M1.6 只要 `PUT /logtest`，水位线纪律同
票 37。镜像按 **index digest** 钉 `wazuh/wazuh-manager@sha256:80cada6a…`（= 4.14.7，
2026-09-09 本机 arm64 实测可 pull 可跑；票 26/37 口径）。宿主口只露 API 15500
（55000 落在 macOS/Linux 临时端口段，同 langfuse 13000 口径）；agent 接入口
1514/1515/514 不开——本地不收 agent。`API_USERNAME/API_PASSWORD` 用 Docker Hub 官方
镜像文档的教学假值当金丝雀（contextforge JWT_SECRET_KEY 同口径，真部署由环境注入）；
`ulimits.nofile 65536` 照官方 compose（ossec-analysisd 开规则文件多）；只读挂载定制
`ossec.conf`（`deploy/wazuh-manager/ossec.conf`，源=官方镜像原版仅关两段：
**vulnerability-detection enabled=no**——否则每次启动自动下全量 CVE 库 5-8GB，正是
前一窗口磁盘满事故的根因；indexer 连接器 enabled=no。实测 4.14.7：VD 彻底不下载，
连接器受 s6 已知行为影响仍起（wazuh/wazuh#35264）但有界，LMDB 约 110MB 见顶）。
不挂数据卷（logtest 无状态，容器一停即没，重跑 up 幂等）。机器断言：compose-topology.test.ts
票 38 组 6 例——静态 4（服务存在+profiles 含 real-wazuh+digest 钉+不 build；只露
55000 不露 1514/1515/514；默认 11 服务全都不许 depends_on wazuh-manager（依赖会隐式
激活 profile，票 37 同坑）；喂数脚本不进 compose）+ 语义 2（daemon 探测 skip 先例：
默认 config 恰好九服务且不含 wazuh-manager；开 profile 后 wazuh-manager 进 config）。

**② logtest 喂数脚本（验收①/③）**：`scripts/wazuh-logtest-feed.ts` + 根
`pnpm wazuh:feed`。与 replay.ts 的关系 = 回放布景两种来源：replay 推手造 fixture；
本脚本把 fixture 的 `full_log` 喂进真引擎 `PUT /logtest`（先 `POST
/security/user/authenticate` Basic 换 Bearer JWT），取回**真回包**（真实
rule/decoder/full_log 输出）原样回推 ingest webhook 正门。引擎判不出告警的
（`alert=false` 或无 rule.id）跳过不推。自签证书走 `node:https`
`rejectUnauthorized:false`（本地教学容器；脚本里唯一不用 fetch 的出站）。
`--wazuh/--ingest/--dir/--only/--dry-run` 旗标，dry-run 零出网可断言。
**回放载体三条铁律有机器断言**（ingest/logtest-feed.test.ts，replay.test.ts 同源）：
①源码不 import 库件、真回包只 POST `/api/v1/webhooks/alerts`；②推模式（跑一次推
一遍，无定时轮询）；③不进 compose。R4 口径：scripts 不在 ingest 模块图内，测试静态
读源码 + 子进程跑脚本（replay.test.ts 同款）。

**③ 真容器冒烟（验收①，2026-09-09 复验实测）**：`--profile real-wazuh` 点名起
manager（九服务栈零接触，验完 stop+rm 该容器）；真引擎对 `ssh-5710-bad-user` 实测回
**rule 5710 / level 5 / MITRE T1110.001（Password Guessing）**；ingest 侧冒烟测试
起临时 app（MemoryM2Client）全目录喂 12 fixture：零错误、ssh 家族命中回推 webhook
**201** 带 alert_id、`m2.calls` 条数与 pushed 严格相等、severity 与
`severityFromLevel` 映射一致。5712 升档要同会话 8+ 次，单条喂入真引擎给
5710/5711——冒烟断言钉 ssh 家族不钉死 id。

**④ 文档**：README「可选：Wazuh 真实规则引擎 profile」段（接票 37 段后，口径：默认
链路零改动）；教学文档 `lessons/38-01-Wazuh真实规则引擎-profile-logtest喂数与回放布景两种来源.md`。

**阻塞与处置（磁盘满中断 → 接手收尾）**：前一编码窗口完成 compose/脚本/测试主体并在
真容器上验证过冒烟后，被**磁盘满非自愿打断**，工作树遗留未提交。本窗口磁盘恢复
（18Gi 空闲、daemon 29.4.1、4.14.7 镜像 2.57GB 在本机）后接手：读 diff 与新文件核对
遗留 → 复跑拓扑测试（12/12 绿）与喂数脚本单测（容器关时 4P+1skip，与自报一致）属实
→ 真容器冒烟复验通过。接手中**修出三处前窗遗留问题**：① ingest 冒烟例漏了显式超时
闸（vitest 默认 5s/例，真 HTTP ×12 往返实测 3.2s+ 必假红/抖红）——补 120s 闸与
execFile 同口径；②③ case-backend 两处 + evals 一处**票 36 遗留 typecheck error**
（`createTask` 整对象传参窄化不过 / `mapTask` null 分支 / evals 场景缺票 36 新增的
必填 `scan` seam）——卫生修掉（9bd085d 先例），基线测试零删除。

**门禁与基线（2026-09-09 实测）**：`python3 tools/check_specs.py` PASS（0 警告）；
`pnpm check:boundary` PASS（self-test 17/17，0 越界）；`pnpm test` 全绿——agent 384
passed | 4 skipped（基线 381+1sk + 本票 6 新例；多出的 3 skip = 真容器探测例随栈未
起显式 skip）、case-backend 60、evals 97、ingest 42（基线 37 + 本票 5 新例，容器关
时冒烟例显式 skip）、web 82、mcp-audit 14（既有基线全部持平零删除）；
`pnpm lint` 干净；`pnpm typecheck` 全绿（含上述 3 处卫生修复）。

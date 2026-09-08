# 12-01 · 票 12：gateway 三容器并排——contextforge + openfga 与 FGA 授权闸

## 三问

**位置感**：数据地基（m2）、安全基座的 py 侧五件套（m9：guards/mint/验票/凭证代理）、
正门（m1）、编排骨架（m3 薄径）+ 审批回路都齐了。这票给安全控制面装上最后两块官方
积木，之后 m8 对话 Copilot 才有地方问「这个角色能不能用这个工具」：

```
票03 m2 ✅ → 票04-08 m9 五件套 ✅ → 票09 m1 ✅ → 票10 编排 ✅ → 票11 审批 ✅
→ 票12 三容器并排 ✅你在这里 → 票13+ worker 子图 → m8 对话/前端/评测
```

- **这一步是干嘛的？** 把「谁有权用什么工具」的裁判从纸面搬进真容器：compose 里
  三个兄弟并排——`contextforge`（工具渠道面，工具调用先过它）、`openfga`（授权
  裁判，专门回答"能不能"）、自写小 FastAPI `gateway`（铸票/凭证代理，票 06/08 的
  东西，原样不动）。再写一个幂等脚本把 PRD 附录 A.2 的权限矩阵灌进 openfga。
- **什么需求逼我们这么设计？** m8 对话 Copilot 的验收是「soc1 发起 isolate_host
  意图 100% deny」——需要一个按**角色**裁决的工具闸。ADR 0001 拍板不自己造：
  starter-agent 里这套 fga_check 插件 + setup 脚本被路线 1-3 的攻击实测过，
  **直接搬件、搬思路重建模型**（4 角色 × 4 工具族按 soc-demo 的 A.2 重写）。
- **解决什么麻烦？** 三个麻烦：① 官方软件升级会不不会冲掉我们的定制？——答：
  自写件一律**挂载/env/旁路**接入，镜像内部一个字节不碰，升级镜像零漂移；
  ② 授权数据在 openfga 内存里，容器一停全没？——幂等重建脚本，重跑 30 秒恢复
  整个授权世界；③ 陌生身份混进来怎么办？——认不出的脸一律按零权限匿名位，
  裁判联系不上也一律拒绝（fail-closed，INV-1）。

## 全链路一览

```
用户(带角色登录, m8 接入)                                  ← 本票先造好闸, 人流是后面票的事
   │ 身份是 JWT 里的 user_email，比如 soc1@soc.local
   ▼
contextforge 容器(:4444) —— 工具调用的门厅
   │ tool_pre_invoke 钩子：工具真正执行前先停下来
   ▼
fga_check 插件(services/gateway/plugins/fga_check.py，挂载进容器)
   │ ① user_map 查表：soc1@soc.local → user:soc1（认不出 → user:anonymous 零权限位）
   │ ② 读 fga_ids.json：store/model id（setup 脚本每次重建都刷，bind mount 实时可见）
   ▼
openfga 容器(:18080→8080) —— 授权裁判
   │ check(user:soc1, can_execute, tool:isolate_host)
   │ 工具先经 member_of 归族，角色授权挂在「族」上——角色×工具族就级联在这一跳
   ▼
False → 403 FGA_DENIED（mcp_error_code -32603）       True → 放行 + 留痕(日志+metadata)
        裁判不可达/ids 不可读 → 也 403（fail-closed，宁拒勿放）
```

setup 侧（`scripts/setup-openfga.sh` → `services/gateway/fga/setup_openfga.py`）：
等 openfga 健康 → store 按名找（有就复用）→ 模型骨架比对（一样就复用旧 id）→
元组差量同步（缺的补、多的删）→ 13 条 A.2 裁决当场对表 → 刷 fga_ids.json。

## 跟着数据走：soc1 想隔离主机（真跑出来的）

1. **身份进门**：`soc1@soc.local` 想调 `isolate_host`。插件查 user_map：
   `soc1@soc.local → user:soc1`，拼出问题「user:soc1 能 can_execute tool:isolate_host 吗？」
2. **工具先归族**：openfga 里没有"给角色直接授权工具"的元组——只有
   `tool:isolate_host --member_of--> family:incident_response`（高危族，还有
   block_ip/deisolate_host/unblock_ip）。查 can_execute 时 tupleToUserset 自动
   级联：问工具 → 顺着 member_of 找到族 → 查族上有没有你的授权。
3. **查无此人**：matrix.json 里 L2 两族（kb_write/incident_response）**任何角色
   都没有直接授权**（A.2 该列写的是「需审批」——走审批铸 ApprovalToken，INV-3，
   不经过这个布尔闸）。裁决 False → 插件回 403，代码 FGA_DENIED。真容器输出：
   `DENY(403)  soc1@soc.local -> isolate_host`。
4. **对照一组放行的**：`soc1@soc.local -> kb_lookup`——kb_lookup 属
   family:readonly_query（L0 族），soc1 有 `user:soc1 can_execute family:readonly_query`
   元组 → ALLOW，且 metadata 里留下 `fga_user=user:soc1` 供审计对"闸门开过、谁过的"。
5. **捣乱实验·陌生脸**：`stranger@evil.example` 来了——user_map 查不到 →
   落到 `default_user: user:anonymous`。匿名位一个元组都没有，连 kb_lookup 都
   `DENY(403)`。这就是「认不出的脸按零权限对待」；把 openfga 停掉再试，得到的是
   `FGA_UNREACHABLE` 403 而不是放行——裁判联系不上 ≠ 无罪推定。

## 新技术点四要素：OpenFGA（Zanzibar 风格的细粒度授权）

- **名字**：OpenFGA（Google Zanzibar 论文的开源实现），关系型授权（ReBAC）引擎；
  compose 里就是 `openfga/openfga:v1.19.0` 镜像 `run` 子命令（内存存储，教学口径）。
- **作用**：把"谁能对什么做什么"变成**可查询的元组 + 可推演的模型**。和传统 RBAC
  （角色表存数据库、代码里 if-else）的区别：授权是**数据**不是代码——改权限矩阵
  = 重跑 setup 脚本写元组，不改一行代码；且支持级联（工具→族→角色），if-else
  写级联会越写越乱。
- **参数（四个核心对象）**：
  - `store`：一个授权世界（id 每次重建都变 → 写进 fga_ids.json，不写死）；
  - `authorization model`：类型与关系声明，如 `tool.can_execute = member_of 上的
    tupleToUserset`（模型不可变，改模型=加新版本，所以脚本先比对再决定建不建）；
  - `tuple`：具体授权事实，`{user, relation, object}` 三元组，如
    `user:soc1 can_execute family:readonly_query`；
  - `check`：运行时问一句 allowed true/false——就是插件每刀工具调用问的那句。
- **用法（本项目）**：模型 `services/gateway/fga/openfga_model.json`，矩阵
  `services/gateway/fga/matrix.json`，灌入与自检 `services/gateway/fga/setup_openfga.py`，
  查询 `services/gateway/plugins/fga_check.py::query_openfga`（POST
  `/stores/{id}/check`）。顺带认识的 cpex 插件框架：`Plugin.tool_pre_invoke` 钩子
  + `PluginViolation(http_status_code=403)` 就是 contextforge 的"执行前闸位"。

## 关键顿悟

- **幂等 = 先查后建，且比对要挑"骨架"**。API 回读的模型/元组会带一堆修饰字段
  （metadata、`"object": ""`），逐字节比对**永不相等**、每次重跑都多出一个模型
  版本——把可比的部分（类型+关系表达式）归一化后再比，才能真正做到"重复跑结果一致"。
- **FGA 是布尔闸，审批是另一条路**。A.2 的「需审批」在 FGA 里落成"零直接授权"：
  duty_lead 也查不到 isolate_host 的 can_execute——高危动作唯一通道是审批回路铸
  一次性票（INV-3），票面由 TS 验票闸验。两道闸各管各的，谁也不能替谁放行。
- **自写件不动镜像内部，升级才敢随便点**。插件/配置/ids 全是 bind mount 进
  contextforge 的——镜像从 0.5.0 换到 1.0.8、或 ghcr 换回官方源，挂载件零漂移；
  代价只有一个：ids 这类运行时产物也得走挂载实时刷（内存存储的 id 每次重建都变）。

## 亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo

# 0) 单测基线（compose 拓扑断言/矩阵覆盖/插件 fail-closed 共 18 项在 gateway 套里）
(cd services/gateway && ../../.venv/bin/python -m pytest -q)   # 应看到 42 passed
python3 tools/check_specs.py                                   # 应看到 spec gate: PASS（5 警告）

# 1) 三容器并排 + 幂等两连跑 + A.2 裁决 + 插件容器内真跑 + 换镜像验证（一条命令全做）
bash scripts/gateway-smoke-12.sh
# 应看到：三容器 Up；(reused) 两连跑、tuples written=0 deleted=0；
#         13 条 ✓；ALLOW/DENY(403)×2；末尾 SMOKE PASS

# 2) 只跑授权世界重建（openfga 已起时）
bash scripts/setup-openfga.sh
# 第一遍 created + written=29；立刻再跑一遍应 (reused)/(reused)/written=0——这就是幂等

# 3) 捣乱实验：把 admin 也封掉（模拟"收权"），看差量同步 + 自检当场抓包
#    编辑 services/gateway/fga/matrix.json，把 admin 的 families 改成 []
bash scripts/setup-openfga.sh
# 应看到：tuples written=0 deleted=2（收权也是差量）；
#         接着 2 条 ✗（admin 的 kb_lookup/close_alert 预期 True 实际 False）→ 脚本非零退出
#         ——13 条 A.2 对表就是授权世界的守门员，世界和 PRD 不一致当场喊停
# 把 matrix.json 改回来再跑一遍，13 条 ✓ 复原
```
玩完 `docker compose stop openfga contextforge gateway` 收摊（内存存储，停了授权
世界即散，下次 `setup-openfga.sh` 30 秒重建）。
```

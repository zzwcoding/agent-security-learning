# 41-01 · 票 41：compose 装配数据卷——挂载落点必须对上代码的写盘路径

## 三问

**位置感**：M3 编排主线的收尾小票，compose 一键起的最后一块拼图：

```
票 10 编排骨架 ✅ → 票 11 审批回路 ✅ → 票 23 LangGraph ✅ → … → 票 40 事件驱动 ✅
→ 票 41 compose 装配（数据卷 + 密钥口径）✅你在这里 → m3 卡「杀进程重启恢复」演示闭环
```

- **这一步是干嘛的？** 给 compose 里的 agent 服务挂一块**数据盘**。agent 的全部编排
  状态——runs、SSE 事件流、checkpoint 信封链、审批卡——都记在自己的 SQLite 里，而
  没挂卷之前，这个库写在**容器层**里。容器层你可以理解成「集装箱外壳内侧的记事本」：
  `docker restart` 还好（箱子没换），但凡镜像升级、`up --force-recreate`、机器重启后
  容器重建，箱子一换记事本就没了——审批挂起的 run 直接蒸发，值班长批了个寂寞。
- **什么需求逼我们这么设计？** m3 卡测试计划白纸黑字：「审批 interrupt 杀进程重启后
  状态可恢复且绑定原 (run, tool_call)」。这条在测试里早就绿了（票 11 用「文件库 +
  两个全新 buildApp 实例」模拟杀进程），但它要在 compose 一键起的**真实部署形态**下
  成立，前提就是那个库文件得活在容器外面——挂载就是把宿主机的一个目录「探进」容器，
  让数据写在宿主硬盘上，容器随便换。
- **解决什么麻烦？** 票 10 的实现记录早就承诺了「compose 卷 ./data/agent:/data」，但
  一直没人接。本票照承诺去接的时候撞出一个安静得可怕的坑：**承诺里的 `/data` 是错的**。
  代码找库文件的路径是从源文件位置往上爬三级算出来的（`index.ts` 的
  `../../../data/`），在容器里爬到的终点是 `/app/data` 不是 `/data`。要是无脑照票面
  挂 `/data`，冒烟一跑就会看到「重启后卡没了」——挂了个寂寞，验收①照样不成立。
  这票的真战果与其说是「挂了个卷」，不如说是「把挂载落点对准了代码真实写盘的地方」。

## 全链路一览

```
【写盘路径是怎么算出来的】容器里 WORKDIR=/app/services/agent
  src/index.ts 的 new URL("../../../data/", import.meta.url)
    = /app/services/agent/src/ 往上三级 = /app/data/          ← 库真实落点
  铁律：compose 挂载的 target 必须等于这个终点
    ./data/agent:/app/data   ✅ 卷里见
    ./data/agent:/data       ❌ 库照旧写容器层，卷是空的（票 10 注释之误）

【杀进程重启恢复的全链路（scripts/agent-smoke-41.sh 跑的就是这条）】
  POST /internal/runs {kind:"alert_flow"}        ← agent（AGENT_FLOW=approval_demo）
      │ 图跑到 execute_action 的 L2 闸口：开审批卡 + interrupt，run 挂起
      ▼
  卡落 SQLite（/app/data/agent.sqlite）──bind mount──► 宿主 ./data/agent/
      ▼
  docker restart agent                            ← 容器层整个换掉
      │ 新进程、新容器层，唯一带过来的行李 = 挂载卷
      ▼
  GET /api/v1/approvals?status=pending            ← 同一张卡还在（id 一字不差）
  GET /api/v1/events/stream?run_id=…              ← 重启前的事件从盘上补发（INV-7）
      ▼
  POST /api/v1/approvals/:id/approve              ← 向 gateway 铸 ApprovalToken
      │ resumeRun：从 checkpoint 链末态重跑中断节点（Tracecat 语义）
      ▼
  run completed，卡 executed=true                 ← 决定绑定原 (run, tool_call)
```

## 跟着数据走：一张审批卡的重启之旅

冒烟脚本 `scripts/agent-smoke-41.sh` 的六步，每步一句人话：

1. **起最小栈**：`docker compose up -d agent gateway case-backend`——批准动作要向
   gateway 铸票、执行要查 case-backend 的焚毁表，所以这俩必须在场；guards/chroma/
   openfga 是 agent 的 `depends_on`，compose 自动带起。演示图不在默认配置里（那九个
   服务的生产装配是 alert_flow 全链），冒烟用一个 `/tmp` override 文件给 agent 补一个
   `AGENT_FLOW: approval_demo`——**docker-compose.yml 一字不动**，本票主角（数据卷）
   必须从真 compose 文件里来，测的才是交付形态。
2. **拉起 run 挂在闸口**：POST 一条 `alert_flow`，图跑到 `execute_action`（L2 动作
   isolate_host），`executeApproved` 开卡 + 同步抛 interrupt，run 停在
   awaiting_approval。此刻卡已经写进 SQLite，而 SQLite 在挂载卷上。
3. **杀进程**：`docker compose restart agent`。注意这比生产更狠也更快——容器层全部
   作废重来，进程内存清零，能带走的只有挂载卷里的那个库文件。
4. **点收行李**：再查 pending 列表，同一张卡（`apr_…` id 一模一样）还在，tool 还是
   isolate_host、还没执行没裁决。这一步就是验收①的心脏。
5. **SSE 也活着**：`GET /events/stream?run_id=…` 把重启前落盘的 `approval_required`
   事件原样补发出来——事件总线的游标也在卷里，INV-7 的「不丢不重」跨重启成立。
6. **批准收尾**：approve → 铸 ApprovalToken → resumeRun 验信封链（也在卷里）→ 重跑
   中断节点 → 动作执行 → run completed、卡 executed=true。决定绑定原 (run, tool_call)。

## 新技术点四要素：`import.meta.url` 相对解析——挂载落点的唯一依据

- **名字**：ESM 的 `new URL(relative, import.meta.url)`（Node `url` 模块），TS 项目里
  求「本文件在磁盘上的位置」的标准姿势。
- **作用**：agent 要把库文件放在「仓库根的 data/ 目录」，但代码不知道仓库根在哪——
  它只知道自己这个文件在哪。`../../../data/` 的意思是「从本文件往上爬三级再进 data」。
  本机源码树里爬到 `soc-demo/data/`；容器里同样的爬法爬到 `/app/data`，因为 Dockerfile
  把代码放在 `/app/services/agent/`。**同一段代码，两个部署形态，落点由目录布局决定**。
- **参数/规则**：`new URL("a/b", base)` 的 base 是**文件路径**（不是目录），每级 `..`
  先消掉文件名再消目录；写错级数不报错，只是安静地落到别的目录——这是它最阴的地方。
- **用法**（本项目：`services/agent/src/index.ts`）：

  ```ts
  const dataDir = new URL("../../../data/", import.meta.url);   // 容器内 = /app/data/
  mkdirSync(dataDir, { recursive: true });
  const dbPath = process.env.AGENT_DB_PATH ?? fileURLToPath(new URL("agent.sqlite", dataDir));
  ```

  case-backend 同款写法同款落点，所以它的卷是 `./data/case-backend:/app/data`——
  agent 照抄这个先例（拓扑测试里专门有一条锁「两边对称」）。`AGENT_DB_PATH` env 是
  逃生口：谁要是真想把库挪进 `/data`，改 env 就行，不用改代码。

## 关键顿悟

- **挂载落点≠起个好听的名字，它必须等于代码算出来的写盘路径**。卷挂 `/data` 而代码
  写 `/app/data`，两边互不打扰也互不认识：卷空着，库照旧落容器层，重启照丢——而且
  服务一切正常，没有任何报错。这类错只有「杀进程重启再点收一次」的真容器冒烟能咬住，
  单测里 tmpdir 文件库（票 11 先例）是测不出来的，因为测试自己指定路径，不存在解析。
- **「承诺的配置」和「代码的现实」冲突时，验收说了算**。票 10 白纸黑字写着
  `./data/agent:/data`，但验收①的判据是「重启可恢复」，它只认 `/app/data`。处置：
  按现实挂，票内记档出入，顺手修掉 index.ts/db.ts 里两处以讹传讹的注释。注释会撒谎，
  测试不会——拓扑断言把正确落点锁死，下个人想改回 `/data` 会当场红。
- **冒烟脚本别为测试改交付物**。演示开关用 `/tmp` override 文件注入（compose 的
  `-f` 可以叠多张配置，同名键覆盖、volumes 追加），docker-compose.yml 保持一字不动；
  daemon 不可用就显式 SKIP（先例票 37），CI 不装绿。真机验证的公信力来自「测的就是
  交付的那份文件」。

## 亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo
pnpm -C services/agent exec vitest run src/compose-topology.test.ts   # 应 16 passed（含票 41 四条）
bash scripts/agent-smoke-41.sh   # 需要 Docker daemon；末行应见 SMOKE PASS
# 顺手看卷：宿主机 data/agent/ 下应出现 agent.sqlite（.gitignore 的 data/ 盖住，不入库）
```

捣乱实验（验证你真懂了「落点必须对上解析」）：把 docker-compose.yml 里 agent 的
`./data/agent:/app/data` 改成票 10 注释里的 `./data/agent:/data`，重跑冒烟——第 4 步
「同一张卡还在」必红，卡随着旧容器层一起蒸发了。改回来重跑即绿。这就是为什么这条
验收必须用真容器跑一遍才算数。

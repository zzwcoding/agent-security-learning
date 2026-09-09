# 37-01 · 票 37：Langfuse 可选观测 profile——compose 双服务挂 profile 与 agent 镜像旁路

## 三问

- **终极目标**：soc-demo 是能拿去汇报的 SOC 数字员工。可观测性有两层：「谁做了什么」的审计（M2 AuditEntry，早已上线）和「LLM/流程跑得到底什么样」的 trace（Langfuse 这类观测台，可视化时间线）。本票把第二层**以可选件的身份**接上。
- **为什么现在做**：PRD v1.1 变更 1 和 ADR 0001 早就拍了板——「Langfuse 砍出默认路径，降为可选 compose profile `observability`」。拍板归拍板，compose 里一直没这个东西（收官体检 B1 对账：承诺悬空）。本票兑现承诺。
- **解决什么麻烦**：Langfuse 官方 v3 自托管要背 postgres + clickhouse + valkey + minio 四件套——为了看个时间线背四个容器，违反本项目「一键可起」水位线。所以默认九服务里永远没有它；想看 trace 的人显式开 profile 才起，而且 agent 侧**不配 key 就一个字节都不发**（零开销）。

路线图位置：这是收官体检转来的补齐票（28-44 批次）之一，m3 编排面的「可选观测」一角；主链路（审计→SSE→审计流）已经闭环，本票加的是**旁路镜子**，不是主干。

## 全链路一览

```
（默认：什么都没有——九服务照旧跑，下面整套不存在）

开 profile 后：
POST /internal/runs ──> agent 跑图 ──> emitEvent 落 run_events（主链路，SSE 照旧）
                        │                     │
                        │（事件插行成功后）    │
                        │                     ▼
                        │             eventTap（可选旁路，默认 null）
                        │                     │ key 三件套齐了才挂上
                        ▼                     ▼
              audit.record ──────────> LangfuseMirror（fire-and-forget）
                                                │ POST /api/public/ingestion
                                                │ （Basic 认证：public key 当用户名）
                                                ▼
                                langfuse 容器（:13000，profile observability）
                                                │ 落库
                                                ▼
                                postgres（langfuse-db，也在 profile 里）
                                                ▲
              UI http://localhost:13000 或 GET /api/public/traces/{id} 查回
```

每个环节一句话：`emitEvent` 是事件流的**总闸口**（全 agent 的事件都从这一根管子过）；`eventTap` 是闸口旁边开的**读数口**；`LangfuseMirror` 是抄表员，抄完随手寄出去（不等回执）；langfuse 容器是**档案馆**。

## 跟着数据走：一条 node_enter 事件的镜面之旅

1. 跑一个 run，图节点 `classify` 开始。graph.ts 调 `emitEvent(db, runId, "node_enter", {node:"classify"})`——先插一行进 SQLite（主链路到此完成，SSE 订阅者已经能收到）。
2. events.ts 末尾有一句 `if (eventTap) { try { eventTap(event) } catch {} }`。默认 `eventTap` 是 null——这两行等于不存在，这就是「默认链路零改动」的字面意思。
3. 你在 .env 配了 `LANGFUSE_PUBLIC_KEY=pk-lf-local-demo` 和 `LANGFUSE_SECRET_KEY=sk-lf-local-demo`，index.ts 启动时 `makeLangfuseMirror()` 返回了镜像实例并把 tap 挂上。于是这条事件被递给 `LangfuseMirror.onEvent`。
4. 镜像给这个 run 算一个**确定性 trace id**：`sha256("run:" + runId)` 截 32 位 hex。好处：冒烟脚本不用登记 run→trace 的映射，现场算就能查。第一次见到这个 run 还会捎一条 `trace-create`（「档案馆，开个新卷宗，名字叫 agent.run」）。
5. 打包成 v2 ingestion 的 wire 形——`{batch:[{id, type:"event-create", timestamp, body:{traceId, name:"node_enter.classify", startTime, metadata:{node:"classify"}}}]}`，Basic 认证，POST 到 `http://langfuse:3000/api/public/ingestion`。2 秒超时闸挂着，失败只打一行 `warn=langfuse_mirror_failed`，**绝不回头打扰主链路**。
6. 打开 http://localhost:13000 ，run trace 时间线上就多了两条观察：`node_enter.classify` 和（节点跑完后）`node_exit.classify`。审计五要素走 `record()`，落在以 requestId 命名的独立 trace 上（名字 agent.audit，DENIED 抬 WARNING 档）。

**捣乱输入**：把 SECRET_KEY 改成错的再跑一个 run——agent 照常完成业务，compose logs 里多几行 `langfuse_mirror_failed ... 401`，Langfuse 里没有新 trace。这就是旁路纪律：镜子碎了，人没事。

## 新技术点四要素：docker compose profiles

- **名字**：`profiles`，docker compose 的服务分组开关（compose spec 内建，不用装东西）。
- **作用**：给服务打标签。带标签的服务**默认完全不参与**——`docker compose up -d`、`config`、`ps` 都当它不存在；`docker compose --profile observability up` 才把它连同同标签的伙伴一起拉起来。这正好是「可选件不进默认一键启动」的原生机制，一行配置顶一百行脚本。
- **参数**：值是字符串数组，如 `profiles: ["observability"]`；命令行 `--profile <名>` 或 `.env` 里 `COMPOSE_PROFILES=<名>` 激活。
- **用法**：本项目 docker-compose.yml 的 `langfuse` 与 `langfuse-db` 两个服务都挂了 `profiles: ["observability"]`（注意：**成对挂**，只给 langfuse 挂不给 db 挂，`depends_on` 的健康检查会踢到铁板）。机器断言在 `services/agent/src/compose-topology.test.ts`：默认 config 九服务不含 langfuse、开 profile 后两个都在。另一个隐藏坑写成了测试：**agent 不许 `depends_on` langfuse**——依赖会隐式激活 profile，可选件就变必选件了。

## 关键顿悟

- **profile 是「编译期开关」，key 是「运行期开关」**：`--profile observability` 决定容器起不起；agent 的 `LANGFUSE_PUBLIC_KEY/SECRET_KEY` 决定进程发不发数据。两层缺一不可——容器起着但 key 空，agent 依旧零出站；这就是为什么 key 空时旁路"不存在"（连 tap 都不挂）而不是"发失败"。
- **默认链路零改动的实现可以很小**：没有 if-else 包裹业务，只在 emitEvent 末尾加了一个默认为 null 的 tap 判空。基线 357 个 agent 测试一个没改一个没删，全部原样绿——这是「零改动」的可执行证明，比口头承诺值钱。
- **镜像语义 = 只读不裁**：Langfuse 里看到的 metadata 就是 SSE payload 原样（`metadata: payload`），不做字段重排。抄表员抄的就是原表，将来 Langfuse 版本升级、换别的观测台， wire 闸（langfuse.test.ts 的 wire 形断言）都在一个文件里好换。
- **v2 还是 v3 看依赖栈不看版本号**：v2 已停止功能更新，但 v3 要背四个容器。教学 demo 选 v2 单镜像 + postgres，钉 index digest（= 2.95.11）；这是一次典型的「水位线压过新版本偏好」的选型，理由写在 compose 注释里。

## 亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo
docker compose config --services | sort        # 应见 9 个服务，无 langfuse
docker compose --profile observability config --services | grep langfuse
                                               # 应见 langfuse 和 langfuse-db 两行
bash scripts/langfuse-smoke-37.sh              # 一键冒烟：起栈 + 探活 + trace 查回全过
```

起栈后给 agent 配 key（.env 解开 LANGFUSE_PUBLIC_KEY/SECRET_KEY 两行注释）再 `docker compose up -d agent && pnpm replay`，然后：

```bash
curl -s -u pk-lf-local-demo:sk-lf-local-demo "http://127.0.0.1:13000/api/public/traces?limit=5" | grep -o '"run_id":"run_[a-f0-9-]*"'
```

应看到刚 replay 出来的 run id；打开 http://localhost:13000 用 `demo@soc-demo.local` / `teaching-demo-pass-not-for-prod` 登录，点进 trace 看时间线——node_enter/node_exit/audit 一条条排开。

**捣乱实验**：把 .env 里的 SECRET_KEY 改错一位，重启 agent 再 replay——业务页面照常出 verdict，但 `docker compose logs agent | grep langfuse_mirror_failed` 会现形，Langfuse UI 里没有新 trace。停观测栈：`docker compose --profile observability down`。

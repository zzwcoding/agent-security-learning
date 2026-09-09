# 48-01 · 工具登记单一来源：ToolManifest 与脚手架生成器

> 票 48（ADR 0004 裁决 2）的教学文档。读前需要知道：LLM 说「我要调 isolate_host」
> 不算数，得手里有我们盖过钢印的票才算数——而「什么工具算 L0/L1/L2、归谁管」
> 这件事本身，在本票之前只是验票闸里一行手写的小名单。

## 一、三问（这一票是干嘛的）

**位置感先行**——阶段 7 收官三项裁决的第二项（ADR 0004 拆成票 47/48/49）：

```
票 47：run 异步化（POST 秒回 + 分发循环 + 审批卡保质期）
   ✅
票 48：ToolManifest 登记机制 + 工具脚手架生成器
   ↑ 你在这里
票 49：PII mapstore + 反查口
   ⬜
```

- **这一票是干嘛的？** 给全仓 24 个工具建一本**户口册**：`fixtures/tools.manifest.json`，
  每个工具一行（名字/分级 L0-L1-L2/属 A.2 哪个族/归哪张模块卡/一句话说明）。
  验票闸的分级判定从「代码里手写的小名单」改成「读这本册子」。再配一个
  `pnpm gen:tool <名字>` 命令，把「新增一个工具」的最小闭环变成一条命令。
- **什么需求逼我们这么设计？** 体检（G2-4）翻出来的旧账：票 07 在闸里手写了
  一张四个名字的最小分级表——比 PRD 附录 A.1 的 23 个工具少了 19 个。比如
  `block_ip`（防火墙封禁，高危）在旧表里查无此人，闸只能把它当普通 L1 对待；
  而 `kb_search` 这个名字除了旧表自己，全仓没有任何地方认识它（幽灵工具）。
  「分级」是安全语义，它的**真相**却散在手抄小表、PRD 文档表格、各 worker 的
  工具面常量、FGA 矩阵四处——漂移了没人知道。
- **解决了什么麻烦？** 三个：①分级有了唯一事实来源，闸、文档、代码面三方被
  契约测试互相咬死，谁单方面改谁变红；②「没登记的工具怎么办」从注释里的一句话
  变成册子自己声明的机制（`policy.unregistered_tier: "L1"`——fail-closed 写进数据）；
  ③演示动线补齐：新增工具→登记→过闸，一条命令走完。

## 二、全链路一览

```
fixtures/tools.manifest.json（户口册，唯一事实来源）
   │                        ▲
   │ ①闸的粮草               │ ④gen:tool 追加登记行
   ▼                        │
src/tools-manifest.ts（读口：env 覆盖 + 缓存 + tierOf）
   │
   ▼
verify-ticket.ts  tierOf(工具名) → 0/1/2
   │                 L0 免验放行 / L1 无票 403 / L2 无审批票 403
   ▼
各 worker 的 gated() 调用（票 43 共享闸拼装处）
   │
   ▼
tools-manifest.test.ts（契约闸，谁漂移谁红）
      ⑤ manifest ≡ PRD A.1（现场解析 docs/prd.md）
      ⑥ manifest ≡ 各 worker TOOLS 常量 ∪ 五张票面
      ⑦ 未登记 → 默认 L1（负例：kb_search 幽灵工具现身说法）

tools/gen-tool.mjs（pnpm gen:tool，零依赖 node 脚本）
      ⑧ <名字>.ts 空壳 + <名字>.test.ts 骨架 + 户口册追加一行
      ⑨ 端到端演示测试在临时目录跑：生成→登记→过闸 allow；
         删掉登记行→同一个工具名→403 no_ticket
```

另外一角：gateway 的 `test_fga_matrix.py` 新增一条互锁——FGA 矩阵
（matrix.json，管「角色×族」授权）里的每个工具必须在户口册里同名同族同级。
册子管「每个工具是什么」，矩阵管「哪个角色能碰哪个族」，两边不许各说各话。

## 三、跟着数据走 4 步（一个新工具从出生到过闸）

1. **出生**：`pnpm gen:tool demo_echo --tier L0`。生成器干三件事：写一个空壳
   `demo_echo.ts`（handler 只返回一句话 `[demo_echo] 空壳工具被调用…`）、写一个
   测试骨架、往户口册追加一行 `{name:"demo_echo", tier:"L0", family:"readonly_query", …}`。
   生成物落在 `generated-tools/`（已进 .gitignore）——**入库的是生成器，不是生成物**。
2. **过闸**：某天有个调用者无票调 `demo_echo`。闸调 `tierOf("demo_echo")`，读册子
   查到 L0 → 直接放行（L0 只读免验）。如果登记的是 L2，同一时刻同一调用会得到
   `403 require_approval`——**同一个名字，册子上改一个字母，闸的行为就翻过来**，
   因为分级从代码变成了数据。
3. **捣乱实验——撕户口页**：把 `demo_echo` 那一行从册子里删掉。同一个工具、同一个
   调用方式，这次闸查册查无此人 → 按 `policy.unregistered_tier`（L1）对待 →
   手里没任务票 → `403 no_ticket`。这就是「未登记一律 L1」的 fail-closed：
   **登记是工具获得身份的唯一途径，撕了户口页它就自动失权**，不需要谁去改代码。
4. **看门的所有权**：谁在盯着册子不被改坏？`tools-manifest.test.ts`。它现场解析
   `docs/prd.md` 的 A.1 表格（23 个工具名+分级），逐个跟册子对；现场 import 五个
   worker 的 TOOLS 常量和五张 run kind 票面，确认每个持票工具都登记过、且没有一个
   是 L2（INV-3 的户口册版）；最后做一次全表扫描——册子里 24 个工具逐个无票过闸，
   L0 的必须放行、L1 的必须 403 no_ticket、L2 的必须 403 require_approval。
   你把 `isolate_host` 的 tier 从 L2 改成 L0？「A.1 逐字一致」那条立刻红给你看
   （PRD 说它是 L2，册子说 L0——文档面先翻脸；gateway 的矩阵互锁也会跟着红）。

## 四、新技术点：没有新库，只有两个值钱的模式

本票零新依赖。值钱的是两个以后到处能用的模式：

- **模式一：契约测试锁双源（单一来源做不到时的标准替代）**。
  最理想是全世界只有一份数据；但 FGA 矩阵（gateway 的 matrix.json，要灌给真
  openfga）和户口册（fixtures，管分级登记）各有各的消费者，硬合成一份会制造
  跨服务耦合。这个仓的标准答案是：**允许两份，但必须有测试互相咬**——
  `test_fga_matrix.py` 逐字比对两边的 name/family/tier，多出来的登记必须逐个点名
  （现在唯一被点名的：`get_case`，票 17 引入的读案工具，A.1 表漏列——这就是
  「漂移必红」的例外管理：例外必须显式写进测试，不许默默放行）。
- **模式二：env 覆盖 + 缓存重置（测试把闸指向假数据的接缝）**。
  - **名字**：`process.env.TOOLS_MANIFEST_FILE ?? 默认路径` + `resetToolsManifestCache()`，
    本仓先例是 chat 意图闸读 FGA 矩阵的 `FGA_MATRIX_FILE`（visible-tools.ts）。
  - **作用**：端到端测试要在**临时目录**里验货（生成物不入库！），就得让生产代码
    愿意去读临时那份册子。env 覆盖是唯一的正式入口——测试不戳生产代码的内部变量。
  - **用法**：测试里 `process.env.TOOLS_MANIFEST_FILE = 临时清单; resetToolsManifestCache();`
    用完在 finally 里删 env、再 reset。生成器的整套端到端演示（gen-tool.test.ts）
    就架在这个接缝上。
  - **参数**：缓存必须能重置——env 是进程级的，改了 env 不清缓存，闸还在吃旧数据。

## 五、关键顿悟 3 条

- **分级不是代码，是数据（载体变更，语义不变）**。旧表写死在 verify-ticket.ts 里，
  改分级=改代码=重新发版；新形态里分级是 fixtures 里的一行 JSON，闸只是读它的
  嘴。判断「重构是否安全」就看断言语义动没动：L0 免验/L1 需票/L2 需审批一条没变，
  变的只是查表的地方。
- **fail-closed 的最高形态是默认值写进数据自己**。「没登记怎么办」这件事，旧形态
  靠一行注释担保；新形态是册子里的 `policy.unregistered_tier: "L1"` 字段，闸读它、
  测试钉死它只许是 L1。规则住在数据里，数据坏成读不出来时闸还会把一切兜成 403
  （INV-1 的 try 罩着 tierOf）——**册子烧了，门只会关得更死，不会敞开**。
- **漂移的解药不是自觉，是「必红」**。A.1 文档表、TOOLS 常量、户口册、FGA 矩阵
  四处各说各话的日子，靠的是四组契约测试互相咬；而唯一没能对齐的那一处
  （get_case 不在 A.1）也不藏着掖着——在测试里**具名豁免**并记进票面出入。
  契约测试文化里，例外不可耻，沉默的例外才可耻。

## 六、亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo

# ① 生成一个空壳工具（生成物进 generated-tools/，已被 .gitignore，不会污染 git）
pnpm gen:tool demo_echo --tier L0
#    应看到：三行输出——工具空壳/测试骨架/登记行追加 的落点路径

# ② 看三件产物
cat generated-tools/demo_echo.ts
#    应看到：export async function demo_echo…返回一句话
grep demo_echo fixtures/tools.manifest.json
#    应看到：户口册末尾多了一行 tier=L0 的登记
git status --short
#    应看到：fixtures/tools.manifest.json 显示 M（登记行是真改动），generated-tools/ 不出现

# ③ 跑端到端演示测试：生成→登记→过闸 allow；删登记行→403 no_ticket；重名拒绝
pnpm -C services/agent exec vitest run src/gen-tool.test.ts
#    应看到：3 passed（测试在临时目录跑，不动你 ② 里生成的真文件）

# ④ 捣乱实验：把册子里 isolate_host 的 tier 改成 "L0"，跑分级契约测试
pnpm -C services/agent exec vitest run src/tools-manifest.test.ts
#    应看到：红 1 条——「A.1 全量 23 工具已登记且分级逐字一致」（PRD 说 L2、册子说
#    L0，文档面先翻脸）。改回去再跑即绿。

# ⑤ 收尾：把 ② 里 demo_echo 的登记行删掉（保持仓库干净）
git checkout -- fixtures/tools.manifest.json && rm -rf generated-tools
```

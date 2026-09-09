# 31-01 · 票 31：SSE 事件类型 + verdict 词表——共享样品契约锁

## 三问

**位置感**：阶段 7 收官体检的 D 组「数据形状契约补机器锁」，一根一根钉钉子：

```
票28 边界闸 ✅ → 票29 latest.json 契约 ✅ → 票30 alert wire 全链 ✅
→ 票31 SSE 事件 + verdict 词表锁 ✅你在这里（体检 D1）
→ 票32 guards 形状锁（D2）→ …
```

- **这一步是干嘛的？** 给两份「口头对齐」的名单上锁。第一份是 SSE 事件名：agent 往
  事件总线里写什么名字，web 就得按同样的名字挂监听——这份名单在代码里手抄了三份
  （agent 的全集、agent 的对话子集、web 的全集），注释里写着「新增类型两端同步」，
  但没人查。第二份是 verdict 词表：分诊 LLM 只许说 fp/btp/tp/uncertain 四个缩写，
  落库时翻译成 M2 的全名——这条翻译链在四个文件里各抄一份。本票把两份名单各做成
  一份「共享样品」放进 `fixtures/`，三端测试各读样品对暗号，谁改名单没打招呼就红灯。
- **什么需求逼我们这么设计？** 体检对账三-14：SSE 名单**已经漂移过一次**（票 18 加
  chat 三型时靠人肉记着三处同步）。人肉记事总会漏——漏一次就是「web 收不到某类
  事件、页面静默缺一块」这种最难查的哑巴亏。
- **解决什么麻烦？** 把「两端同步」从注释里的君子协定变成 CI 里的机器闸：以后谁改
  名单，要么同时改样品并对端（全绿），要么当场红给你看。跟票 29 的 latest.json、
  票 30 的 alert wire 是同一个思路，只是这回锁的是「词表」不是「数据形状」。

## 全链路一览

```
fixtures/sse-events.json                fixtures/verdicts.json
（事件名单的"唯一法律"）                 （verdict 词表的"唯一法律"）
        │                                       │
  ┌─────┼────────────┐                    ┌─────┼──────────────┐
  ▼     ▼            ▼                    ▼     ▼              ▼
agent  agent       web                  agent  case-backend  web
全集   对话子集     全集                 翻译表  M2 值域        颜色覆盖
(events.ts) (app.ts) (sse.ts)          (prompt.ts) (store.ts) (AlertsPage.tsx)
  │     │            │                    │     │              │
  ▼     ▼            ▼                    ▼     ▼              ▼
sse-contract.test.ts               verdict-contract.test.ts（agent）
（agent 侧两闸）                    verdict-contract.test.ts（M2 侧）
                                   sse-verdict-contract.test.ts（web）
```

三道闸都只干一件事：**「我自己的本地名单 ≡ 样品」**。三个包互不许 import 对方源码
（边界规则 R1），所以样品文件是它们对暗号的唯一通道——跟三家分店对账只认总部下发的
那张表，谁也不许抄隔壁店的账本。

## 跟着数据走：往名单里塞一个"thinking"试试

假如哪天有人给 agent 加了个新事件类型 `thinking`（LLM 思考中……），看看锁是怎么
一层层咬住的：

1. **只改 agent 的全集**（`services/agent/src/events.ts` 的 `SSE_EVENT_TYPES` 数组
   加 `"thinking"`，样品没动）→ `src/sse-contract.test.ts` 第一测当场红：
   `agent 全集 ≡ 样品` 不成立。漂移还没出门就被自家闸拦下。
2. **他学乖了，把样品也改了**（`fixtures/sse-events.json` 的 `event_types` 加上
   `"thinking"`）→ agent 转绿。但如果 web 忘了跟，`services/web/src/sse-verdict-
   contract.test.ts` 红：`web SSE_EVENT_TYPES ≡ 样品` 差一项——实测就是这样，
   报错很直白：`expected […9 项] to deeply equal […10 项]`。web 那边补上同名事件，
   全绿。这就是「改一处枚举，对端测试必红」。
3. **verdict 侧同款玩法**：分诊说 `fp`，`TO_M2_VERDICT` 翻译成 `"false_positive"`
   写进 M2 库，web 按全名查颜色表上红色。谁动哪一环都有对应闸：
   - 翻译表改了个值（`fp: "false_pos"`）→ agent 的 verdict-contract 两测红
     （逐键值比对 + 值域包含都炸）；
   - M2 的 `VERDICTS` 改名（`uncertain`→`unknown`）→ case-backend 两测红——
     变异实测过，`值域包含：TO_M2_VERDICT 值域 ⊆ M2 VERDICTS` 这条票面点名的断言
     就是防「翻译出来的词库不认，写回被拒收」；
   - web 颜色表混进一个错别字键（比如手滑写个 `_DEAD`）→ web 闸红：
     `expected ['_DEAD','btp','fp','tp'] to deeply equal ['btp','fp','tp']`——
     错别字键在页面上是**静默无色**的，不锁就是隐形坑。

## 新技术点四要素：`as const` 数组 → `typeof` 推导类型

- **名字**：const 断言 + 索引访问类型（`as const` / `typeof X[number]`），TypeScript
  内置，不属于任何包。
- **作用**：TS 的 `type A = "x" | "y"` 只是编译期注记，编译成 JS 后**消失了**——测试
  在运行时根本摸不到这份名单（这正是旧代码测试不了的原因：类型只活在编译器脑子里）。
  把写法倒过来——先写运行时数组，再从数组**推导**类型——名单就从「编译器的记忆」
  变成了「盘面上谁都能查的值」，测试能读、样品能比。写法变了，类型本身一字不变。
- **参数**：`as const` 把数组冻成只读元组（每项还是字面量类型而不是 string）；
  `(typeof ARR)[number]` 意思是「取 ARR 数组元素的类型」= 那串字面量的联合。
- **用法**：

  ```ts
  export const SSE_EVENT_TYPES = [
    "node_enter", "node_exit", /* …共 11 个… */
  ] as const;

  export type SseEventType = (typeof SSE_EVENT_TYPES)[number];
  // 用起来跟原来的裸 union 一模一样：const t: SseEventType = "done"; ✅
  ```

  本项目用在哪：`services/agent/src/events.ts`（票 31 改造处）；web 的
  `services/web/src/sse.ts` 早就是这么写的，所以 web 侧本来就摸得到运行时名单——
  这次是让 agent 侧也摸得到，三份手抄才能互相咬合。

## 关键顿悟

- **类型不是运行时事实，名单才是**。`type SseEventType = "a" | "b"` 在 JS 里不存在，
  靠它「双端对齐」只是编译器的一厢情愿（跨包更管不着）。要锁就锁运行时值：数组、
  样品文件、测试比对，三样都是真实存在的东西。
- **样品是法律，代码是被告**。三端测试没有谁「信」谁的代码，全都只信
  `fixtures/*.json`。所以改动顺序永远是「先改样品（提案）→ 两端代码跟上（执行）→
  全绿（通过）」；跳过样品直接改代码，自家闸先红。
- **词表的锁是双向的**：值域包含（`TO_M2_VERDICT 值域 ⊆ M2 VERDICTS`）在 agent 和
  case-backend **各断言一遍**——agent 对着自己的映射说「我的翻译都样品里有」，
  M2 对着样品说「样品里的翻译我都收」。两边都对着同一张表各自表态，才叫契约；
  单边表态叫愿望。

## 亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo
pnpm -C services/agent exec vitest run src/sse-contract.test.ts workers/triage/verdict-contract.test.ts
pnpm -C services/case-backend exec vitest run src/verdict-contract.test.ts
pnpm -C services/web exec vitest run src/sse-verdict-contract.test.ts
# 应看到：2 + 3 / 2 / 3 个测试全绿（共 10 道闸）
```

捣乱实验（做完记得还原）：把 `fixtures/verdicts.json` 里 `"tp": "true_positive"`
改成 `"tp": "true_pos"`，再跑上面第 1、2 条——agent 侧映射比对 + 值域包含红、
case-backend 侧值域包含红，web 不动；改回来全绿。再想想：如果**只**想红 web 该动
哪个文件？（答：动 `VERDICT_COLORS` 的键集，颜色表是 web 独有的第四份手抄。）

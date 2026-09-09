# 29-01 · 票 29：latest.json 契约对齐——两端共读一份样品，Eval 页拦截率真渲染

## 三问

**位置感**：阶段 7 收官体检回补波的第二票，把"数据形状契约"从口头对齐变成机器锁：

```
票19 eval骨架 ✅ → 票22 三维报告 ✅ → 票27 真LLM ✅ → 票28 边界闸 ✅
→ 票29 形状收口：latest.json 双端契约 + Eval 页真渲染 ✅你在这里
```

- **这一步是干嘛的？** 三方"对暗号"：票 22 的 evals 已经产出 `defense_interception`
  （by_face 拦截率 / by_facet 方式计数 / skipped 留痕），但 web 还在读旧键
  `attack_block_rate`（那个键在产物里根本不存在，所以永远是 undefined），PRD §6-M11
  的样例又是第三种形状。同一个文件，三份说法。本票：① PRD 样例按实现改；② 建一份
  两端共读的"标准样品"+ 两道契约测试，谁漂移谁红灯；③ Eval 页从"渲染不出"改成真渲染。
- **什么需求逼我们这么设计？** 体检 A1 实锤：这不是"将来可能漂"，是**已经漂了三年
  没人发现**的集成缺口——web 的 `attackFaces()` 恒得空集，页面恒标"未产出"。
  人眼对暗号总会漏，机器不会。
- **解决什么麻烦？** 以后谁再改 latest.json 的形状：evals 改了没更新样品 → 生产端
  契约测试红；evals 改了样品但 web 没跟 → 消费端契约测试红。漂移从"下次体检才知道"
  变成"这次 CI 就知道"。

## 全链路一览

```
evals/src/report.ts buildReport()         ← 生产者（票 22 代码，本票没动生产逻辑）
        │  pnpm test:eval 跑完落盘
        ▼
eval-results/latest.json                   ← 真产物（Eval 页 fetch 它，gitignore）
        ≈ 形状必须一致（≈ 就是本票钉死的）
fixtures/eval-report/latest.json          ← 共享"标准样品"（本票新建，git 内）
        │                                       │
        ▼ 生产端闸                              ▼ 消费端闸
evals/src/report.contract.test.ts          services/web/src/eval.test.ts「双端契约」节
  同一份输入再喂 buildReport，                import 样品原文（?raw）喂给
  逐字段比对 ≡ 样品                          evalView/attackFaces，断言真值
        │                                       │
        └───────────────┬───────────────────────┘
                        ▼
        services/web/src/eval.ts（attackFaces / interceptFacets / attackSkipped）
                        ▼
        services/web/src/pages/EvalPage.tsx（分面率+分母、方式计数 Tag、skip 留痕）
```

## 跟着数据走：一条"没拦住"的攻击走完全程

用样品里两条最有戏的用例——`chat_injection`（真没拦住，rate 0）和 `sandbox`（环境
坏了没跑成）：

1. **生产者**（`evals/src/report.ts`）：`attack/04_chat_injection_missed` 真跑且没拦住
   → `by_face.chat_injection = {total:1, intercepted:0, rate:0}`，不粉饰；
   `attack/05_sandbox_msb_down` 因 msb 不可用没跑（`ran:false`）→ **不进 by_face**，
   只在 `skipped` 留痕一行 `"attack/05_sandbox_msb_down: msb 不可用"`——不冒充拦截
   成功，也不算拦截失败。这就是"skipped 不进分母"的出处。
2. **样品**（`fixtures/eval-report/latest.json`）：上面这些数字原样进去。注意样品
   **不是手抄的第三份真相**——它是用 `buildReport` 本人跑一份合成输入生成的，
   手抄反而是下一轮漂移的种子。
3. **生产端闸**（`report.contract.test.ts`）：把同一份合成输入再喂一遍 buildReport，
   和样品逐字段比。谁动了形状（比如把 `by_facet` 改名 `by_facets`），这里先红——
   实测红过一次（变异验证），改回来才绿。
4. **消费端闸**（`eval.test.ts` 双端契约节）：把样品原文喂给 `evalView`，断言：
   faces 键序、`chat_injection` 如实显示 `0%`、`sandbox` **不在** faces 里（skip 了）、
   skipped 一条。evals 改了形状+更新了样品但 web 忘了跟 → 这里红——也实测红过。
5. **页面**（`EvalPage.tsx`）：攻击面卡渲染"对话注入拦截率 0%（0/1）"这样的分面率
   （括号里是 拦住/分母），下面四个方式 Tag（扫描拦 D2、行为兜底 403/无票、人审
   驳回 D8、沙箱边界）各计几次，底部一行小字"分母=ran 攻击用例，skip N 例不计入 ·
   （生产端 note 原话）"。

## 新技术点四要素：Vite 的 `?raw` 导入

- **名字**：`?raw` 后缀导入（Vite 静态资源约定；vitest 也认，因为它就是 vite 跑的）。
- **作用**：把任意文件当**字符串**原样打进模块。它救了我们的场：web 的测试跑在
  jsdom 里，`import.meta.url` 是 `http:` 开头不是 `file:`，用 `readFileSync(new
  URL(...))` 读共享样品直接炸（`The URL must be of scheme file`）；`?raw` 在构建期
  就把文件内容内联进来，运行期不碰文件系统。
- **参数**：没有参数，就是路径后缀：`import x from "./y.json?raw"`。TS 类型声明来自
  `vite/client`（web 的 tsconfig `types` 里已含，不用额外装）。
- **用法**：
  ```ts
  import fixtureRaw from "../../../fixtures/eval-report/latest.json?raw";
  const FIXTURE = JSON.parse(fixtureRaw) as EvalReport;
  ```
  本项目用在哪：`services/web/src/eval.test.ts` 双端契约节。对照：evals 包的测试跑在
  node 环境，`readFileSync(new URL("../../fixtures/...", import.meta.url))` 就行
  （`report.contract.test.ts`）——同一个"读样品"，两端按各自环境选拿法。

## 关键顿悟

- **样品要由生产者本人出**：契约样品如果手写，它自己就是第三份真相，漂移问题原样
  复发。让 `buildReport` 生成样品、测试里再算一遍比对，样品和生产者就永远咬合。
- **两端各一道闸才夹得住**：只有消费端测试时，它红了你分不清是"该改 web"还是"测试
  写死了"；加了生产端"再算一遍 ≡ 样品"的闸，改动被迫先过样品关，web 那边的红就
  明确指向"web 没跟"。
- **口径也是契约的一部分**："skipped 不进分母"是生产端统计规则（`note` 字段写明的），
  页面只负责把口径原话亮出来，不重新发明分母——网页端自己算一遍率，就是下一个漂移源。

## 亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo
pnpm test:eval                # 真跑一遍刷新产物：应看到 32 passed + 三维报告数字
pnpm -C evals test            # 93 passed（含 report.contract.test.ts 生产端闸）
pnpm -C services/web test     # 77 passed（含「双端契约」消费端闸）
```

页面验证（服务放你自己终端跑）：

```bash
pnpm -C services/web dev      # :5173
```

浏览器开 `http://localhost:5173/#/eval`：应看到五个攻击面分面（告警注入 100%（8/8）、
RAG 投毒、越权、沙箱、对话注入）+ 四个方式计数 Tag + "分母=ran 攻击用例"一行；
`curl -s localhost:5173/eval-results/latest.json | head -40` 与页面数字一致。

捣乱实验（做完记得还原）：把 `fixtures/eval-report/latest.json` 里的
`defense_interception` 全局替换成 `defense_intercept`，再跑 `pnpm -C services/web test`
——双端契约两红、其余绿；替换回来又全绿。这就是"evals 形状变更而 web 未跟时必红"
的手感。

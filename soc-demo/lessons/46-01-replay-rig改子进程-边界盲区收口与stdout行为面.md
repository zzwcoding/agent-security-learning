# 46-01 · replay rig 改子进程：边界盲区收口与 stdout 行为面

> 票 46（盲区收口票）的教学文档。读前需要知道：边界闸（票 28 建）的规则表里，R2 管
> 「evals→services」、R4 管「services→scripts」——而 evals→scripts 这条斜线，两张网都没捞到。

## 一、三问（这一票是干嘛的）

**位置感先行**——功能票早已收官，这一票是收官体检对账二-7 点名的「边界盲区」收尾：

```
票 44：evals scenarios 拆 rig（replay.ts 逐字搬进 rigs/）
   ✅
票 45：rigs 七文件进 R2 豁免清单（L0 追认）
   ✅
票 46：replay rig 改子进程执行（R4 扩到 evals，盲区收口）
   ↑ 你在这里（行为零变化：断言语义逐条保持，测试零删除）
```

- **这一票是干嘛的？** 把 `evals/src/rigs/replay.ts` 里那行 `import { replay, replayOne } from "../../../scripts/replay.js"` 拆掉，换成**子进程执行**——像调用外部命令一样跑 `tsx scripts/replay.ts`，然后去解析它打印的 stdout。
- **什么需求逼我们这么设计？** 这行 import 是票 44 拆文件时**逐字搬**过来的——搬家不改变它的性质，但边界规则表变了：R2 的例外清单圈的是「evals 引用 **services** 内部」，R4 的禁令圈的是「**services** 反引 scripts」。这行 `evals → scripts` 的斜线正好从两张网的眼缝里漏下去。闸不报红不是因为它对了，是因为没人查它。
- **解决了什么麻烦？** scripts/ 是**中立层**——它的立身之本是「可独立执行、不在任何模块图内」。evals 直接 import 它，等于把邻居家的工具箱整箱搬进自己家：脚本从此成了 evals 编译单元的一部分，独立性名存实亡，而且边界闸对「evals→scripts」这个方向装瞎。收口后：脚本退回「外部 CLI」身份，evals 只依赖它**承诺打印的 stdout 文本**——耦合面从「整个 TS 模块」缩到「一行汇总格式」。

## 二、全链路一览

改造后 replay 布景的一次完整流转（以 replay/01_same_fixture_dedup 为例）：

```
loader 扫 fixtures/eval/replay/01_same_fixture_dedup/ → EvalCase（带 alertFixturePath）
   │
   ▼
scenarioReplayDedup（evals/src/rigs/replay.ts:73）
   │ ① 起布景：真 case-backend SQLite + ingest app 挂 127.0.0.1 随机端口
   │ ② 把 fixture 内容写进临时目录（文件名补 .json，见第三节的坑）
   ▼
execFile tsx scripts/replay.ts --url … --dir … --rate 1000     ◀── 子进程，边界外
   │  CLI 逐条读目录里的 *.json，POST /api/v1/webhooks/alerts（正门，铁律①）
   ▼
ingest → 真 case-backend（去重逻辑在这层生效）
   │
   ▼  stdout（行为面，我们要断言的全部证据）
   │    replay: /tmp/replay-dedup-xxx/*.json -> http://127.0.0.1:PORT @ 1000/s
   │      01_same_fixture_dedup.json -> 201 alert_id=al_xxx
   │    replay done: 1 pushed, 1 created, 0 dedup
   ▼
parseReplayStdout（evals/src/rigs/replay.ts:35）逐行解析 → r1/r2
   │
   ▼
三条专项检查（replay_dedup_same_id / replay_occurrences_incremented / replay_no_second_case）
   → 进门槛，与通用断言同权（布景跑第二遍时：-> 200 … dedup，三条全咬合）
```

## 三、跟着数据走 5 步（看闸是怎么先红后绿的）

这票本身就是一道 TDD：红样本先行，每一步都有可观察的输出。

1. **补红样本（此刻闸还没扩）**：给 `tools/check_boundary.py` 的 self-test 假仓库里种一棵 `evals/src/rigs/replay.ts`，内容就是那行斜线 import。跑 self-test：
   `FAIL 红样本必抓 R4 evals/src/rigs/replay.ts`——**盲区被实证了**：检查器 `check_r4` 只写了一半（`src.startswith("services/")`），evals 从这个方向路过它视而不见。
2. **扩检查器**：`check_r4` 加一个 `or src == "evals"`（tools/check_boundary.py:226-234）。self-test 转 18/18 全绿；但紧接着跑**实盘**闸：
   `VIOL [R4] evals/src/rigs/replay.ts:6 反引 scripts/（../../../scripts/replay.js）`——
   真凶现形。假仓库绿、真仓库红，说明闸的口径扩对了，剩下的就是把真实违例清偿。
3. **rig 改子进程**：删掉 import，换成 `execFile` 跑 CLI。断言对象跟着换载体：
   - 原来 `replayOne()` 返回 `{status, alertId, dedup}` 对象 → 现在从 stdout 逐条行 `  {file} -> {status}[ alert_id=…][ dedup]` 里解析出同样的字段；
   - 原来的三连断言 `r1.status === 201 && r1.dedup === false && r2.status === 200 && r2.dedup === true && …` **一字不动**，只是 r1/r2 的来源变了。
4. **数据集用例同理**：`scenarioReplayDataset` 原来调两次 `replay()` 拿记录数组数数 → 现在跑两遍 CLI，从汇总行 `replay done: N pushed, C created, D dedup` 里拿 created/dedup 两个数，「第一遍全新建 / 第二遍全 dedup / 账面不涨」三条检查的语义原样保持。
5. **全绿收口**：evals 99/99、实盘闸 PASS、specs 闸 PASS——红灯流程走完，测试一条没删。

**顺手踩掉的两个坑**（都值得记住）：
- CLI 目录扫描只认 `*.json`（scripts/replay.ts:59），临时目录里用用例目录名 `01_same_fixture_dedup` 裸名落盘会被过滤掉 → 0 条、`records[0]` 是 undefined。补上 `.json` 后缀即愈（payload 还是同一份 fixture 内容，语义无损）。
- 解析正则里写两个连续空格，eslint 的 `no-regex-spaces` 直接红（"Spaces are hard to count"）→ 用 `^ {2}` 量词写法。

## 四、新技术点四要素：promisify(execFile) 子进程执行

- **名字**：`child_process.execFile` + `node:util` 的 `promisify`（Node 内置模块，零依赖）。
- **作用**：起一个**子进程**去跑外部命令，等它退出，把 stdout/stderr 拿回来。比喻：直接 import 是「把邻居的工具箱搬来自己用」——从此邻居家的东西坏了算你的事；execFile 是「打电话请邻居干一件事，等他把结果念给你听」——你只依赖他**嘴上承诺的结果格式**，他家内部怎么干活与你无关。`promisify` 负责把老式回调风格 `(err, result) =>` 包成 Promise，让 `await` 能接。
- **参数**：`execFile(file, args, options)`。`file` 是可执行文件路径（这里用 `fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url))` 钉死本地 bin，不赌 PATH 里有没有全局 tsx）；`args` 是参数数组；`options.timeout` **必须显式给**（本项目口径 30_000，先例 services/ingest/src/replay.test.ts:124、票 38 沙箱同理）——不设超时的子进程一旦挂住，测试就跟着永远挂着，CI 一直转到天荒地老。
- **用法**：最小样子就是本票的实现（evals/src/rigs/replay.ts:26-56）：

  ```ts
  const run = promisify(execFile);
  const { stdout } = await run(TSX, [REPLAY_TS, "--url", url, "--dir", dir, "--rate", "1000"],
    { timeout: 30_000 });
  ```

  同款先例：services/ingest/src/replay.test.ts:11-13（票 28 E3，服务测试侧的清偿）、evals/src/rigs/attack.ts:134-136（rig 内调外部 msb CLI）。本项目里「调仓库级脚本/外部二进制」已经统一收敛到这一种形态。

## 五、关键顿悟 3 条

1. **盲区是两张网的缝隙，不是哪张网破了**。R2 管 evals→services，R4 管 services→scripts，`evals→scripts` 斜着走就漏了。收口动作永远是三件套**同步**改：规则表措辞（唯一事实来源）→ 闸检查器（执行者）→ self-test 红样本（闸自己的测试）。只改检查器不改表，两向锁立刻红给你看——这是这套设计自带的防漂移。
2. **import 拽人进模块图，子进程只认文本契约**。`import` 一个仓库级脚本，它就进了你的编译单元，中立层的独立性就破了；execFile 把它留在外边界，双方契约缩到「stdout 这几行长什么样」。代价是断言从「拿对象」变成「解析文本」——所以解析函数要小（本票 20 行）、字段要跟原对象一一对应。
3. **行为零变化 = 断言表达式逐条抄写，而不是"感觉一样"**。`r1.status === 201 && r2.dedup === true && …` 一字不动，只换 r1/r2 的来源；证据骨架里 `verdictAi` 的键名（push1/push2/files/pass1_created/…）也不动。报告的消费者（latest.json、门槛）零感知——这才是"重构票"和"重写票"的分界线。

## 六、亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo

# 1. 边界闸自测：应 18/18 通过，其中一条就是"红样本必抓 R4 evals/src/rigs/replay.ts"
python3 tools/check_boundary.py --self-test

# 2. 实盘闸：应 PASS（0 越界，9/9 条禁令全有人查）
python3 tools/check_boundary.py .

# 3. evals 全量：应 99 passed（8 个文件），replay 维两条在 scenarios.test.ts 与 suite.test.ts 各跑一遍
cd evals && pnpm test && cd ..
```

**捣乱实验**（验证你真理解了闸在查什么）：把 `import { replay } from "../../../scripts/replay.js";` 临时加回 `evals/src/rigs/replay.ts` 顶部（跑完记得还原），再跑第 2 条命令——应看到 `VIOL [R4] evals/src/rigs/replay.ts:N 反引 scripts/…`、退出码 1。这就是改造前闸对该文件"视而不见"、改造后一秒咬住的差别。

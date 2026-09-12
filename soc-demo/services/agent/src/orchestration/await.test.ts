// 票 73 · spec T19：await_children 事件唤醒、全仓无轮询实现。
// 两半断言：
//   动态半 —— waiter 的 promise 只由落盘事件总线（LoopEventBus）的子 run 终态事件
//            resolve；先到事件进缓冲（wait 晚调也能拿到）；重复终局幂等；error 事件
//            折成失败终局；未终局的子 run 持续挂起（不靠查表猜状态）。
//   静态半 —— 机制目录全部非测试源码 grep 不到任何定时器 API（setInterval/setTimeout）：
//            轮询实现的宿主就是定时器，静态断言把这条路焊死（防将来退化）。
import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeLoopEventBus } from "./bus.js";
import { makeChildWaiter } from "./await-children.js";

const ORCH_DIR = fileURLToPath(new URL("./", import.meta.url));

function finishedEvent(runId: string, id: number, summary = `obs-${runId}`) {
  return {
    id,
    runId,
    type: "audit" as const,
    payload: { action: "hunt_task_finished", run_id: runId, ok: true, result_summary: summary, params_hash: `h-${runId}` },
    createdAt: id,
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("T19 event_wakeup_no_polling：await_children 只经事件唤醒", () => {
  test("子 run 终态事件到齐才 resolve；未终局持续挂起（无事件 = 无进展）", async () => {
    const bus = makeLoopEventBus();
    const waiter = makeChildWaiter(bus);
    let resolved = false;
    const p = waiter.wait(["c1", "c2"]).then((out) => {
      resolved = true;
      return out;
    });

    bus.publish(finishedEvent("c1", 1));
    await tick();
    expect(resolved).toBe(false); // c2 未终局：promise 挂着（事件没来就不动，也不查表）

    bus.publish(finishedEvent("c2", 2));
    const outcomes = await p;
    expect(resolved).toBe(true);
    expect(outcomes.map((o) => o.runId)).toEqual(["c1", "c2"]); // 与传入顺序对齐
    expect(outcomes[0]).toMatchObject({ ok: true, resultSummary: "obs-c1", paramsHash: "h-c1" });
  });

  test("先到事件进缓冲：wait() 晚于终局事件也只认事件（不补查 runs 表）", async () => {
    const bus = makeLoopEventBus();
    const waiter = makeChildWaiter(bus);
    // 事件先落、wait 后调——订阅在工厂构造即挂上，缓冲语义保证不丢
    bus.publish(finishedEvent("c9", 1));
    const outcomes = await waiter.wait(["c9"]);
    expect(outcomes[0]?.runId).toBe("c9");
  });

  test("重复终局事件幂等（重放不重复折算，INV-6 同族口径）", async () => {
    const bus = makeLoopEventBus();
    const waiter = makeChildWaiter(bus);
    bus.publish(finishedEvent("c1", 1));
    bus.publish(finishedEvent("c1", 2, "dup-replay"));
    const outcomes = await waiter.wait(["c1"]);
    expect(outcomes[0]?.resultSummary).toBe("obs-c1"); // 首见终局生效
  });

  test("error 事件 = 失败终局（失败强杀口径与现有 run 一致，INV-1）", async () => {
    const bus = makeLoopEventBus();
    const waiter = makeChildWaiter(bus);
    const p = waiter.wait(["c-kill"]);
    bus.publish({ id: 3, runId: "c-kill", type: "error", payload: { code: "node_error", node: "execute" }, createdAt: 3 });
    const outcomes = await p;
    expect(outcomes[0]).toMatchObject({ runId: "c-kill", ok: false });
    expect(outcomes[0]?.resultSummary).toContain("node_error");
  });
});

describe("T19 静态半：机制目录全源码无定时器（轮询实现的宿主）", () => {
  test("orchestration/ 非 test 源码 grep 不到 setInterval/setTimeout", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(ORCH_DIR)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const text = readFileSync(ORCH_DIR + f, "utf8");
      if (/\bsetInterval\b|\bsetTimeout\b/.test(text)) offenders.push(f);
    }
    expect(offenders, `轮询宿主出现在：${offenders.join(",")}`).toEqual([]);
  });
});

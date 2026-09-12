// 票 76 · spec T11/T12/T15：两票制铸票时序与 fail-closed（fake gateway 腿 + 解析器缝闸）。
//
// T11/T12 two_tier_mint_timing：父票铸于 run 起（planner 只读面），子票铸于 dispatch
//      （每任务单工具）——fake gateway 腿咬铸票调用级时序；真 gateway 腿（真
//      /internal/mint 铸票 + 真验票闸）与椒图外接腿在同一张布景上跑，见
//      src/ticketing-gateway.test.ts（m3 装配层测试位：R11 禁机制目录 import 铸票
//      客户端，布景由此拆两处，铸票客户端只在装配层测试里出场）。
// T15 mint_failure_fail_closed：子票铸票失败 → 该任务不执行、无悬置（无活子 run）、
//      DENIED 审计可查（INV-1/INV-8 全链路成立）。
// 附：ticketSpecFor 窄面解析器的 INV-11 缝闸单测（父菜单外拒铸）。
import { afterAll, describe, expect, test } from "vitest";
import { setEventTap } from "../events.js";
import { requireRunKind, ticketSpecFor } from "../run-kinds.js";
import {
  MENU,
  childMints,
  fakeGatewayMint,
  plannedRounds,
  rig,
} from "../ticketing-rig.js";

afterAll(() => setEventTap(null));

// ---------- T11/T12（fake gateway 腿）：父票铸于 run 起、子票铸于 dispatch ----------

describe("T11/T12 two_tier_mint_timing（fake gateway 腿：铸票调用级时序）", () => {
  test("父票铸于 run 起（先于 planner、菜单面）；子票铸于 dispatch（每任务单工具、⊆ 父菜单）", async () => {
    const rig1 = rig(fakeGatewayMint);
    const { order, tickets, port } = rig1;
    await rig1.launchRound();
    await rig1.waitUntil(() => port.status === "concluded", "两轮收敛（假设 concluded）");
    await rig1.waitAllSettled();
    await rig1.close();

    // 两轮跑通（fake LLM：轮 1 不充分 → gap → 轮 2 收敛），子任务覆盖全菜单
    const planned = plannedRounds(order);
    expect(planned.length).toBeGreaterThanOrEqual(2);
    const children = childMints(order);
    expect(children.map((c) => c.slice("mint:agent:hunt_task:".length)))
      .toEqual(planned.flat()); // 每个计划任务恰好一枚子票（逐任务单工具）

    // T11 父票：每轮 run 起铸一枚（两轮两枚），面 = planner 只读菜单，先于本轮 planner
    const parentMints = order.filter((o) => o.startsWith("mint:agent:hunt_flow:"));
    expect(parentMints).toHaveLength(2);
    for (const p of parentMints) {
      expect(p.slice("mint:agent:hunt_flow:".length).split("+")).toEqual(MENU);
    }
    const firstPlanner = order.findIndex((o) => o.startsWith("planner:"));
    expect(order.indexOf(parentMints[0]!)).toBeLessThan(firstPlanner); // 父票铸于 run 起
    expect(order.indexOf("graph:hunt_flow")).toBeGreaterThan(order.indexOf(parentMints[0]!)); // 票先于组图

    // T12 子票：铸于 dispatch——出组合（planner）之后、经门（door）拉起时在门内铸
    for (const c of children) {
      const tool = c.slice("mint:agent:hunt_task:".length);
      expect(MENU, `子票 ${tool} ⊆ 父菜单（INV-11）`).toContain(tool);
      const ci = order.indexOf(c);
      expect(ci).toBeGreaterThan(firstPlanner); // 晚于 planner（不是 run 起一次铸）
      const di = order.indexOf(`door:hunt_task:${tool}`);
      expect(di).toBeGreaterThanOrEqual(0); // 该任务确实经门拉起
      expect(ci).toBeGreaterThan(di - 1); // 铸票发生在门内（door 推进后立刻可见）
      expect(order.slice(ci + 1).some((o) => o === "graph:hunt_task")).toBe(true); // 票先于子图组（无票不组图）
    }
    // 门记录与子票一一对应：dispatch 只经门（R11 铸票唯一通道的结构面）
    expect(order.filter((o) => o.startsWith("door:hunt_task"))).toHaveLength(children.length);
    // 每 run 恰拿一枚票（组图捕获面）：父 run 拿父票、子 run 拿单工具票
    expect(tickets.filter((t) => t.kind === "hunt_flow")).toHaveLength(2);
    expect(tickets.filter((t) => t.kind === "hunt_task")).toHaveLength(children.length);
    for (const t of tickets.filter((t) => t.kind === "hunt_task")) {
      const claims = JSON.parse(Buffer.from(t.ticket.split(".")[1]!, "base64url").toString("utf8")) as {
        allowed_tools: string[]; sub: string; exp: number; iat: number;
      };
      expect(claims.allowed_tools).toHaveLength(1);
      expect(claims.sub).toBe("agent:hunt_task");
      expect(claims.exp - claims.iat).toBe(900); // TTL 沿用 900s 口径
    }
  });

  test("旧 kind 时序零变化：alert_flow 仍按注册表票面一次铸于 run 起（无逐任务铸票）", async () => {
    const rig1 = rig(fakeGatewayMint);
    const { db, order } = rig1;
    const res = await rig1.post({ kind: "alert_flow", alert_id: "al-t76" });
    expect(res.statusCode).toBe(202);
    await rig1.waitAllSettled();
    await rig1.close();

    const mintCalls = order.filter((o) => o.startsWith("mint:"));
    expect(mintCalls).toHaveLength(1); // 按 kind 一次铸
    const spec = requireRunKind("alert_flow").ticket;
    expect(mintCalls[0]).toBe(`mint:${spec.sub}:${spec.allowedTools.join("+")}`);
    expect(order.filter((o) => o.startsWith("door:"))).toEqual([]); // 无人经门拉子 run
    const row = db.prepare("SELECT status FROM runs WHERE kind = 'alert_flow'").get() as { status: string };
    expect(row.status).toBe("completed"); // 空图即刻终态（时序布景，不看分诊行为）
  });
});

// ---------- 附：ticketSpecFor 窄面解析器（m3 票务装配面的 INV-11 缝闸） ----------

describe("ticketSpecFor（hunt_task 窄票面解析：单工具 + 父菜单外拒铸）", () => {
  test("带任务上下文 → allowed_tools = {该任务唯一工具}；无上下文 → 票 73 菜单级兜底；菜单外抛错", () => {
    const narrow = ticketSpecFor("hunt_task", { tool: "siem_query" });
    expect(narrow.sub).toBe("agent:hunt_task");
    expect(narrow.allowedTools).toEqual(["siem_query"]);
    expect(ticketSpecFor("hunt_task").allowedTools).toEqual(MENU); // 直拉无任务 = 旧口径兜底
    expect(ticketSpecFor("alert_flow")).toEqual(requireRunKind("alert_flow").ticket); // 旧 kind 原样
    // INV-11 缝闸：父菜单外的工具在铸票缝上拒铸（fail-closed，不产越界票）
    expect(() => ticketSpecFor("hunt_task", { tool: "isolate_host" })).toThrow(/父票菜单/);
    expect(() => ticketSpecFor("hunt_task", { tool: "" })).toThrow();
  });
});

// ---------- T15：铸票失败 fail-closed ----------

describe("T15 mint_failure_fail_closed（INV-1/INV-8）", () => {
  test("子票铸票失败 → 该任务不执行、无活子 run、DENIED 审计可查、父 run 强杀", async () => {
    const rig1 = rig(fakeGatewayMint, { failSub: "agent:hunt_task" });
    const { db, audit, order, ledger } = rig1;
    const parent = await rig1.launchRound();
    await rig1.waitAllSettled();
    await rig1.close();

    // 无悬置：不存在任何活子 run（铸票失败 = 子 run 拉不起来）
    const live = db
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE kind = 'hunt_task' AND status IN ('queued','running','awaiting_approval')")
      .get() as { n: number };
    expect(live.n).toBe(0);
    expect(ledger.childrenOf(parent)).toEqual([]); // 簿记零子链接
    expect(order.filter((o) => o.startsWith("graph:hunt_task"))).toEqual([]); // 无票不组图

    // DENIED 审计可查（T15 审计半边）：dispatch 逐任务铸票失败落五要素 DENIED
    const planned = plannedRounds(order);
    const denied = audit.entries.filter((e) => e.result === "DENIED" && e.action.startsWith("hunt_dispatch"));
    expect(denied.length).toBeGreaterThanOrEqual(1);
    expect(denied[0]!.details).toMatchObject({ tool: planned[0]![0] });
    expect(denied[0]!.requestId).toContain(parent);

    // fail-closed：父 run 强杀（与既有 run 强杀口径一致），铸票失败的子 run 行落 failed(mint_failed)
    const row = db.prepare("SELECT status, fail_reason FROM runs WHERE id = ?").get(parent) as {
      status: string; fail_reason: string | null;
    };
    expect(row.status).toBe("failed");
    expect(audit.entries.some((e) => e.action === "kill" && e.objectId === parent && e.result === "FAILURE")).toBe(true);
    const childRows = db.prepare("SELECT status, fail_reason FROM runs WHERE kind = 'hunt_task'").all() as {
      status: string; fail_reason: string | null;
    }[];
    for (const c of childRows) {
      expect(c.status).toBe("failed");
      expect(c.fail_reason).toBe("mint_failed");
    }
  });
});

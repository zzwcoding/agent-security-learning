// 审计流「实时滚动」的合并逻辑测试：轮询拉回的条目按 id 去重合并（audit_entries.id
// 是 UUID 无自增游标，去重只能按 id 集合），新条目在上，老条目保留。
import { describe, expect, it } from "vitest";
import { mergeAudit, type AuditRow } from "./audit";

function row(id: string, createdAt: number): AuditRow {
  return {
    id,
    action: "update",
    actor: { type: "system", id: "m1:ingest" },
    objectId: "al_1",
    objectType: "alert",
    details: {},
    requestId: "rq_1",
    result: "SUCCESS",
    createdAt,
  };
}

describe("mergeAudit", () => {
  it("新条目插最上，旧条目原位保留", () => {
    const old = [row("b", 2)];
    const out = mergeAudit(old, [row("c", 3), row("a", 1), row("b", 2)]);
    expect(out.map((r) => r.id)).toEqual(["c", "b", "a"]); // 先按已有时序，再拼新到的（按 createdAt 降序插队首）
  });

  it("同一轮询窗口内按 createdAt 降序排（最新在上）", () => {
    const out = mergeAudit([], [row("a", 1), row("c", 3), row("b", 2)]);
    expect(out.map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("按 id 去重：重复轮询不产生重复条目", () => {
    const existing = [row("b", 2), row("a", 1)];
    const out = mergeAudit(existing, [row("b", 2), row("c", 3)]);
    expect(out.map((r) => r.id)).toEqual(["c", "b", "a"]);
  });
});

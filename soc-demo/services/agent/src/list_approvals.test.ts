// 场景 7 步 7.2 · list_approvals 的契约测试（gen:tool 测试骨架收编后的真身）。
//
// 骨架的指路注释兑现于此：handler 冒烟 + 闸的正/负例（仿 verify-ticket.test.ts 与
// tools-manifest.test.ts）。数据源一律临时库——生产布景的 data/agent/agent.sqlite
// 不进测试（CI 里 data/ 根本不存在），台账读口只认显式传入的 dbPath。
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { list_approvals } from "./list_approvals.js";
import { resetToolsManifestCache, tierOf } from "./tools-manifest.js";
import { verifyTicket } from "./verify-ticket.js";
import { makeTaskTicket } from "../workers/triage/testkit.js";

// 冻结时钟（票 07 契约口径：禁 wall clock，一律注入固定 verify_now）
const NOW = 1757000100;
const KEY = "soc-demo-test-hmac-key-do-not-use-in-prod";
const OPTS = { hmacKey: KEY };
const REAL_MANIFEST = fileURLToPath(new URL("../../../fixtures/tools.manifest.json", import.meta.url));

/** 造一个带最小 approvals 表的临时库：2 approved + 1 pending + 1 rejected。 */
function seedDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "list-approvals-"));
  const dbPath = path.join(dir, "agent.sqlite");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node TEXT NOT NULL, tool TEXT NOT NULL,
    params TEXT NOT NULL, params_hash TEXT NOT NULL, case_id TEXT, reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending', approver TEXT, reject_reason TEXT,
    token TEXT, token_jti TEXT, executed_at INTEGER, created_at INTEGER NOT NULL, decided_at INTEGER)`);
  const ins = db.prepare(
    `INSERT INTO approvals (id, run_id, node, tool, params, params_hash, case_id, reason, status, created_at)
     VALUES (?, 'run_x', 'execute', 'isolate_host', '{}', 'sha256:x', ?, ?, ?, ?)`,
  );
  ins.run("apr_a2", "case_000001", null, "approved", 1000);
  ins.run("apr_b1", "case_000002", null, "pending", 2000);
  ins.run("apr_c3", "case_000003", "拒绝理由演示", "rejected", 3000);
  ins.run("apr_d4", "case_000003", null, "approved", 4000);
  db.close();
  return { dir, dbPath };
}

const made: string[] = [];
afterEach(() => {
  while (made.length > 0) rmSync(made.pop() as string, { recursive: true, force: true });
  delete process.env.TOOLS_MANIFEST_FILE;
  resetToolsManifestCache();
});

describe("list_approvals handler（审批台账读口）", () => {
  test("台账四字段读口：total 是过滤后总数，approvals 按 created_at 倒序截断", async () => {
    const { dir, dbPath } = seedDb();
    made.push(dir);
    const r = await list_approvals({ dbPath, status: "approved" });
    expect(r.total).toBe(2); // 过滤后的总数，不是返回行数
    expect(r.approvals.map((a) => a.id)).toEqual(["apr_d4", "apr_a2"]); // 倒序
    expect(Object.keys(r.approvals[0]).sort()).toEqual([
      "case_id", "created_at", "id", "reason", "status", "tool",
    ]); // 数据最小化：params/params_hash/token_jti 不出读口
  });

  test("limit 夹在 1..100；status 白名单外的过滤值当场拒（prepared statement，不拼串）", async () => {
    const { dir, dbPath } = seedDb();
    made.push(dir);
    expect((await list_approvals({ dbPath, limit: 2 })).approvals).toHaveLength(2);
    expect((await list_approvals({ dbPath, limit: 999 })).approvals).toHaveLength(4);
    expect((await list_approvals({ dbPath, limit: 0 })).approvals).toHaveLength(1); // 夹到 1
    await expect(list_approvals({ dbPath, status: "'; DROP TABLE approvals;--" })).rejects.toThrow(
      /bad_status/,
    );
    // 拒绝发生在查询前：表还在，台账照常可读
    expect((await list_approvals({ dbPath })).total).toBe(4);
  });

  test("fail-closed：库打不开直接抛 db_not_found，不伪装成空台账", async () => {
    await expect(list_approvals({ dbPath: "/nonexistent/agent.sqlite" })).rejects.toThrow(/db_not_found/);
  });
});

describe("list_approvals 过闸（登记行 tier=L1 的闸行为）", () => {
  test("正例：L1 + 任务票面含 list_approvals → allow（verdict 携带票面 claims）", () => {
    const ticket = makeTaskTicket("run_72", ["get_alert", "list_approvals"], {
      iat: NOW - 10,
      exp: NOW + 890,
    });
    const r = verifyTicket(
      { name: "list_approvals", params: { status: "pending" } },
      { ticket, runId: "run_72" },
      NOW,
      OPTS,
    );
    expect(r).toMatchObject({ allow: true, reason: "allow" }); // 持票放行时 verdict 附带 payload（票面九 claims 里的任务票八件）
    if (r.allow && r.payload && "allowed_tools" in r.payload) {
      expect(r.payload.allowed_tools).toContain("list_approvals");
    }
  });

  test("负例三连：无票 no_ticket / 案件不绑 scope_insufficient / 大小写戏法 scope_insufficient", () => {
    // ① 无票：L1 没票别想上岗（登记了也不免验——免验是 L0 的待遇）
    expect(verifyTicket({ name: "list_approvals", params: {} }, {}, NOW, OPTS)).toEqual({
      allow: false,
      code: 403,
      reason: "no_ticket",
    });
    // ② 票对、案件不对：票不是万能通行证（FR-S2.2 case-run 绑定）
    const ticket = makeTaskTicket("run_72", ["list_approvals"], {
      caseId: "case_000001", iat: NOW - 10, exp: NOW + 890,
    });
    expect(
      verifyTicket({ name: "list_approvals", params: {} }, { ticket, runId: "run_72", caseId: "case_000002" }, NOW, OPTS),
    ).toEqual({ allow: false, code: 403, reason: "scope_insufficient" });
    // ③ 大小写戏法：票里是小写的 list_approvals，闸收到大写开头的 List_Approvals——
    //    allowed_tools 字符串精确匹配，大写名字不在票面 → scope_insufficient
    const capTicket = makeTaskTicket("run_72", ["list_approvals"], { iat: NOW - 10, exp: NOW + 890 });
    expect(
      verifyTicket({ name: "List_Approvals", params: {} }, { ticket: capTicket, runId: "run_72" }, NOW, OPTS),
    ).toEqual({ allow: false, code: 403, reason: "scope_insufficient" });
  });

  test("未登记对照：TOOLS_MANIFEST_FILE 指向摘了行的临时清单 → 默认级 L1，tierOf=1、无票 no_ticket", () => {
    // 从真表拷一份再摘行，env 把闸的粮草换过去，验完复位——真登记表一个字节不碰
    // （gen-tool.test.ts 的 makeTmp 同款思路）
    const dir = mkdtempSync(path.join(tmpdir(), "list-approvals-manifest-"));
    made.push(dir);
    const manifestPath = path.join(dir, "tools.manifest.json");
    copyFileSync(REAL_MANIFEST, manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      tools: { name: string }[];
    };
    manifest.tools = manifest.tools.filter((t) => t.name !== "list_approvals");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    process.env.TOOLS_MANIFEST_FILE = manifestPath;
    resetToolsManifestCache();
    expect(tierOf("list_approvals")).toBe(1); // policy.unregistered_tier = L1
    expect(verifyTicket({ name: "list_approvals", params: {} }, {}, NOW, OPTS)).toEqual({
      allow: false,
      code: 403,
      reason: "no_ticket",
    });
    // 复位后真表生效：登记回来了，tier 还是 L1 的位
    delete process.env.TOOLS_MANIFEST_FILE;
    resetToolsManifestCache();
    expect(tierOf("list_approvals")).toBe(1);
  });
});

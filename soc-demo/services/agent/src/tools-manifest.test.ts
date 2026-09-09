// 票 48：ToolManifest 单一来源的契约闸（ADR 0004-2）。
//
// 收敛前的局面：分级散在两处手抄——verify-ticket.ts 的最小静态表（票 07，只有
// siem_query/kb_search/isolate_host/kb_write 四个名字）与 gateway FGA 矩阵（票 12）；
// 而各 worker 的 TOOLS 常量与 PRD 附录 A.1 的对齐只靠注释里的一句「一字不差」。
// 收敛后：fixtures/tools.manifest.json 是工具登记的唯一事实来源
// （name/tier/family/owner_card/description + 未登记默认级 policy），本文件咬死三方法律：
//   manifest ≡ PRD A.1 清单（文档面） ≡ 各 worker 工具面（代码面）——谁单方面漂移谁红。
// family 与 gateway FGA 矩阵（matrix.json）的互锁在 services/gateway/test_fga_matrix.py
// （矩阵的家在 gateway，与票 12 的 A.1/A.2 断言同住一个文件）。
//
// 数据只有一份：本文件不复制任何工具名——PRD 从 docs/prd.md 现场解析，工具面从
// worker 常量现场 import，分级从 manifest 现场读。测试密钥从 fixtures/tickets/contract.json
// 机读（票 07 约定）；时钟禁 wall clock，一律注入固定 verify_now。
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { loadToolsManifest, resetToolsManifestCache, tierOf } from "./tools-manifest.js";
import { verifyTicket } from "./verify-ticket.js";
import { RUN_KIND_IDS, requireRunKind } from "./run-kinds.js";
import { TRIAGE_TOOLS } from "../workers/triage/prompt.js";
import { INVESTIGATION_TOOLS } from "../workers/investigation/prompt.js";
import { ENRICHMENT_TOOLS } from "../workers/enrichment/tools.js";
import { KNOWLEDGE_TOOLS } from "../workers/knowledge/prompt.js";
import { CHAT_READONLY_TOOLS } from "../workers/chat/flow.js";

const ROOT = new URL("../../../", import.meta.url); // src → soc-demo/
const NOW = 1757000100; // 冻结时钟（票 07 同款 fixture 时刻）
const KEY = (JSON.parse(readFileSync(new URL("fixtures/tickets/contract.json", ROOT), "utf8")) as {
  hmac_key: { value: string };
}).hmac_key.value;
const OPTS = { hmacKey: KEY };

interface A1Row {
  name: string;
  tier: string;
}

/** 现场解析 PRD 附录 A.1 工具分级表（文档即契约：测试直接咬 docs/prd.md，不建第二份清单）。
 *  规则：`### A.1` 节内的表格数据行，第 1 列的反引号工具名（一格可含两个名字，如
 *  `deisolate_host` / `unblock_ip`），第 3 列是分级。 */
function parsePrdA1(): A1Row[] {
  const prd = readFileSync(new URL("docs/prd.md", ROOT), "utf8");
  const section = prd.split("### A.1")[1];
  if (!section) throw new Error("PRD 缺附录 A.1（文档即契约，节不能丢）");
  const rows: A1Row[] = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) {
      if (rows.length > 0) break; // 表格结束后遇到正文 → 收工
      continue; // 表头前的引语行
    }
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells.length < 3) continue;
    const names = [...cells[0].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (names.length === 0) continue; // 表头/分隔行
    const tier = cells[2];
    if (!["L0", "L1", "L2"].includes(tier)) {
      throw new Error(`PRD A.1 出现非法分级「${tier}」（行：${cells[0]}）`);
    }
    for (const name of names) rows.push({ name, tier });
  }
  return rows;
}

// ADR 0004-2 已知偏差（记票 48 出入①）：get_case 是票 17 引入的沉淀读案工具，
// PRD A.1 漏列——manifest 按更严口径登记为 L1（读案也过任务票），不标 L0 免验。
const KNOWN_NOT_IN_A1 = ["get_case"];

describe("ToolManifest ≡ PRD A.1（文档面：漂移必红）", () => {
  const manifest = loadToolsManifest().tools.map((t) => ({ name: t.name, tier: t.tier }));
  const a1 = parsePrdA1();

  test("A.1 全量 23 工具已登记且分级逐字一致（PRD 改表不改 manifest → 红）", () => {
    expect(a1.length).toBe(23); // 快照：A.1 若增删行，这里先红，逼人走「先 manifest 后文档」
    const byName = new Map(manifest.map((t) => [t.name, t.tier]));
    for (const row of a1) {
      expect(byName.get(row.name), `A.1 工具 ${row.name} 未登记`).toBeTypeOf("string");
      expect(byName.get(row.name), `A.1 工具 ${row.name} 分级漂移`).toBe(row.tier);
    }
  });

  test("manifest 只比 A.1 多已点名的偏差工具（多一个没记票的 → 红）", () => {
    const a1Names = new Set(a1.map((r) => r.name));
    const extra = manifest.filter((t) => !a1Names.has(t.name)).map((t) => t.name);
    expect(extra).toEqual(KNOWN_NOT_IN_A1);
  });

  test("manifest 无重名、分级枚举合法、family ∈ A.2 四族（登记表自身形状闸）", () => {
    const raw = loadToolsManifest().tools;
    expect(new Set(raw.map((t) => t.name)).size).toBe(raw.length);
    const FAMILIES = ["readonly_query", "case_write", "kb_write", "incident_response"];
    for (const t of raw) {
      expect(["L0", "L1", "L2"], `${t.name} tier`).toContain(t.tier);
      expect(FAMILIES, `${t.name} family`).toContain(t.family);
      expect(t.owner_card, `${t.name} owner_card`).toMatch(/^m\d+$/);
      expect(t.description.length, `${t.name} description`).toBeGreaterThan(0);
    }
  });
});

describe("ToolManifest ≡ worker 工具面（代码面：先登记后持票）", () => {
  const names = new Set(loadToolsManifest().tools.map((t) => t.name));

  const FACES: [string, readonly string[]][] = [
    ["TRIAGE_TOOLS（票 13）", TRIAGE_TOOLS],
    ["INVESTIGATION_TOOLS（票 14）", INVESTIGATION_TOOLS],
    ["ENRICHMENT_TOOLS（票 15）", ENRICHMENT_TOOLS],
    ["KNOWLEDGE_TOOLS（票 17）", KNOWLEDGE_TOOLS],
    ["CHAT_READONLY_TOOLS（票 18）", CHAT_READONLY_TOOLS],
  ];

  test("六个来源的工具面全部已登记（worker 加工具不登记 → 红）", () => {
    for (const [label, face] of FACES) {
      for (const tool of face) {
        expect(names.has(tool), `${label} 的 ${tool} 未在 manifest 登记`).toBe(true);
      }
    }
    // close_flow 的最小票（票 39）不经过任何 TOOLS 常量，单独咬
    for (const tool of requireRunKind("close_flow").ticket.allowedTools) {
      expect(names.has(tool), `close_flow 票面的 ${tool} 未登记`).toBe(true);
    }
  });

  test("五个 run kind 票面 allowedTools 全部已登记（票面是工具面的唯一出票口）", () => {
    for (const id of RUN_KIND_IDS) {
      for (const tool of requireRunKind(id).ticket.allowedTools) {
        expect(names.has(tool), `${id} 票面的 ${tool} 未登记`).toBe(true);
      }
    }
  });

  test("INV-3（manifest 版）：所有 worker 持票工具面无任何 L2（L2 走审批铸票）", () => {
    const tierByName = new Map(loadToolsManifest().tools.map((t) => [t.name, t.tier]));
    for (const [, face] of FACES) {
      for (const tool of face) {
        expect(tierByName.get(tool), `worker 工具面 ${tool} 不得是 L2`).not.toBe("L2");
      }
    }
  });
});

describe("分级读 manifest（verify-ticket 的分级来源载体变更，断言语义不变）", () => {
  test("全表扫描：无票调用时 L0 allow / L1 no_ticket / L2 require_approval（改任何 tier 这条就翻脸）", () => {
    for (const t of loadToolsManifest().tools) {
      const r = verifyTicket({ name: t.name, params: {} }, {}, NOW, OPTS);
      if (t.tier === "L0") {
        expect(r, `${t.name}（L0）应免验放行`).toEqual({ allow: true, reason: "allow" });
      } else if (t.tier === "L1") {
        expect(r, `${t.name}（L1）无票应 403 no_ticket`).toEqual({ allow: false, code: 403, reason: "no_ticket" });
      } else {
        expect(r, `${t.name}（L2）无票应 403 require_approval`).toEqual({
          allow: false,
          code: 403,
          reason: "require_approval",
        });
      }
    }
  });

  test("未登记一律 L1（fail-closed 更严口径写进机制：policy.unregistered_tier）", () => {
    expect(tierOf("no_such_tool")).toBe(1);
    expect(verifyTicket({ name: "no_such_tool", params: {} }, {}, NOW, OPTS)).toEqual({
      allow: false,
      code: 403,
      reason: "no_ticket",
    });
    // 负例锚：kb_search 曾活在票 07 的旧静态表里（A.1 无此工具的幽灵名字）——
    // 载体换成 manifest 后它成了未登记工具，与任何新写的工具一样默认 L1 被闸。
    expect(verifyTicket({ name: "kb_search", params: {} }, {}, NOW, OPTS)).toEqual({
      allow: false,
      code: 403,
      reason: "no_ticket",
    });
  });

  test("未登记默认级由 manifest policy 声明（改 policy.unregistered_tier → tierOf 跟着走）", () => {
    const policy = (JSON.parse(
      readFileSync(new URL("fixtures/tools.manifest.json", ROOT), "utf8"),
    ) as { policy: { unregistered_tier: string } }).policy;
    expect(policy.unregistered_tier).toBe("L1"); // 口径钉死：默认级只许是更严的 L1
    expect(tierOf("no_such_tool")).toBe(1);
  });

  test("env 覆盖 + 缓存重置可用（脚手架端到端演示的接缝，gen-tool.test.ts 同款）", () => {
    const saved = process.env.TOOLS_MANIFEST_FILE;
    try {
      process.env.TOOLS_MANIFEST_FILE = "/nonexistent/tools.manifest.json";
      resetToolsManifestCache();
      // 读不到 manifest → tierOf 抛 → 在闸里被 INV-1 兜成 403（fail-closed 双保险）
      expect(() => tierOf("siem_query")).toThrow();
      expect(verifyTicket({ name: "siem_query", params: {} }, {}, NOW, OPTS)).toEqual({
        allow: false,
        code: 403,
        reason: "signature_invalid",
      });
    } finally {
      if (saved === undefined) delete process.env.TOOLS_MANIFEST_FILE;
      else process.env.TOOLS_MANIFEST_FILE = saved;
      resetToolsManifestCache();
    }
    expect(tierOf("siem_query")).toBe(0); // 复位后恢复
  });
});

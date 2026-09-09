// 票 48：工具脚手架生成器（tools/gen-tool.mjs）的端到端演示测试。
//
// 验收③的原话：生成→登记→过闸可用；不登记→闸拒。整条链在临时目录跑——
// 入库的只有生成器本身，生成物（空壳工具/测试骨架/登记行）是演示产物不入库
// （生成器默认输出目录 generated-tools/ 已进 .gitignore）。
//
// 闸怎么「指着」临时清单？tools-manifest.ts 的 env 覆盖接缝（TOOLS_MANIFEST_FILE，
// visible-tools.ts 读 FGA_MATRIX_FILE 的同款先例）：把闸的粮草换成演示清单，
// 验完在 finally 里复位——测试之间互不串味。
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { resetToolsManifestCache } from "./tools-manifest.js";
import { verifyTicket } from "./verify-ticket.js";

const GEN = fileURLToPath(new URL("../../../tools/gen-tool.mjs", import.meta.url));
const REAL_MANIFEST = fileURLToPath(new URL("../../../fixtures/tools.manifest.json", import.meta.url));
const NOW = 1757000100;
const KEY = (JSON.parse(
  readFileSync(new URL("../../../fixtures/tickets/contract.json", import.meta.url), "utf8"),
) as { hmac_key: { value: string } }).hmac_key.value;
const OPTS = { hmacKey: KEY };

interface TmpCase {
  dir: string;
  manifest: string;
}

function makeTmp(): TmpCase {
  const dir = mkdtempSync(path.join(tmpdir(), "gen-tool-"));
  const manifest = path.join(dir, "tools.manifest.json");
  copyFileSync(REAL_MANIFEST, manifest); // 从真登记表拷贝一份当演示底稿
  process.env.TOOLS_MANIFEST_FILE = manifest;
  resetToolsManifestCache();
  return { dir, manifest };
}

function cleanup(c: TmpCase): void {
  delete process.env.TOOLS_MANIFEST_FILE;
  resetToolsManifestCache();
  rmSync(c.dir, { recursive: true, force: true });
}

const manifestNames = (p: string): string[] =>
  (JSON.parse(readFileSync(p, "utf8")) as { tools: { name: string }[] }).tools.map((t) => t.name);

afterEach(() => {
  // 兜底复位（每个用例自己也会清）：env 与缓存绝不能泄进别的测试文件/用例
  delete process.env.TOOLS_MANIFEST_FILE;
  resetToolsManifestCache();
});

describe("gen:tool 端到端演示（票 48 验收③：生成→登记→过闸可用；不登记→闸拒）", () => {
  test("生成 L0 空壳 → manifest 多一行 → 无票过闸（分级从登记表流进闸）", () => {
    const c = makeTmp();
    try {
      expect(manifestNames(c.manifest)).not.toContain("demo_echo");

      execFileSync("node", [GEN, "demo_echo", "--tier", "L0", "--out", c.dir, "--manifest", c.manifest]);

      // 生成物三件：空壳工具 + 测试骨架 + 登记行
      const shell = readFileSync(path.join(c.dir, "demo_echo.ts"), "utf8");
      expect(shell).toContain("export async function demo_echo");
      expect(readFileSync(path.join(c.dir, "demo_echo.test.ts"), "utf8")).toContain("demo_echo");
      expect(manifestNames(c.manifest)).toContain("demo_echo");
      const row = (JSON.parse(readFileSync(c.manifest, "utf8")) as {
        tools: { name: string; tier: string }[];
      }).tools.find((t) => t.name === "demo_echo");
      expect(row?.tier).toBe("L0");

      // 登记后过闸：L0 只读免验——无票直接 allow（分级依据是 manifest，不是代码）
      resetToolsManifestCache();
      expect(verifyTicket({ name: "demo_echo", params: {} }, {}, NOW, OPTS)).toEqual({
        allow: true,
        reason: "allow",
      });
    } finally {
      cleanup(c);
    }
  });

  test("同一生成器给 L2 → 无票 require_approval；删登记行 → 未登记默认 L1 → no_ticket", () => {
    const c = makeTmp();
    try {
      execFileSync("node", [GEN, "demo_strict", "--tier", "L2", "--out", c.dir, "--manifest", c.manifest]);
      resetToolsManifestCache();
      expect(verifyTicket({ name: "demo_strict", params: {} }, {}, NOW, OPTS)).toEqual({
        allow: false,
        code: 403,
        reason: "require_approval",
      });

      // 捣乱实验：把登记行删掉——同一个工具名，闸立刻翻脸（fail-closed 的「登记才有效」）
      const m = JSON.parse(readFileSync(c.manifest, "utf8")) as { tools: { name: string }[] };
      m.tools = m.tools.filter((t) => t.name !== "demo_strict");
      writeFileSync(c.manifest, JSON.stringify(m, null, 2) + "\n");
      resetToolsManifestCache();
      expect(verifyTicket({ name: "demo_strict", params: {} }, {}, NOW, OPTS)).toEqual({
        allow: false,
        code: 403,
        reason: "no_ticket",
      });
    } finally {
      cleanup(c);
    }
  });

  test("重名拒绝（不静默覆盖登记行）+ 非法工具名拒绝 + 生成物落在 --out", () => {
    const c = makeTmp();
    try {
      execFileSync("node", [GEN, "demo_dup", "--out", c.dir, "--manifest", c.manifest]);
      const before = readFileSync(c.manifest, "utf8");
      expect(() => execFileSync("node", [GEN, "demo_dup", "--out", c.dir, "--manifest", c.manifest]))
        .toThrow(/已登记/); // 重名 → 非零退出
      expect(readFileSync(c.manifest, "utf8")).toBe(before); // 登记行一字未动

      expect(() => execFileSync("node", [GEN, "BadName", "--out", c.dir, "--manifest", c.manifest]))
        .toThrow(); // 工具名口径：^[a-z][a-z0-9_]*$
      expect(existsSync(path.join(c.dir, "BadName.ts"))).toBe(false);
    } finally {
      cleanup(c);
    }
  });
});

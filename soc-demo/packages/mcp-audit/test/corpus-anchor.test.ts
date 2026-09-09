// 票 32 验收 2：注入语料共享锚（mcp-audit 侧对称闸）。
// 语料唯一事实：fixtures/attack/injection-corpus.json——guards（llm-guard 主路径）
// 与本 CLI（rules.ts 内嵌规则）两套引擎同读同判，锁「同族判定一致」而非合并实现。
// 决策 #11：CLI 不依赖运行时 guards——共享只走这份 fixtures 文件，零 import
// （边界规则 R5 闸管着）。族集合允许不同：mcp_camouflage 是本 CLI 特有族，
// 不在共享锚内（由 audit.test.ts 自己覆盖）。
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { scanDescription } from "../src/index.js";

interface CorpusSample {
  id: string;
  text: string;
  expect: "hit" | "miss";
}
interface Corpus {
  families: Record<string, { samples: CorpusSample[] }>;
}

const corpus = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/attack/injection-corpus.json", import.meta.url),
    "utf8",
  ),
) as Corpus;

test("同族判定一致：每族每样本的族级 hit/miss ≡ 语料期望（TS 引擎侧）", () => {
  const checked: string[] = [];
  for (const [family, spec] of Object.entries(corpus.families)) {
    for (const s of spec.samples) {
      const hit = scanDescription(s.text).families.includes(family);
      expect(
        hit,
        `${family}/${s.id}: 语料期望 ${s.expect}，TS 引擎实判 ${hit ? "hit" : "miss"}（同族判定漂移）`,
      ).toBe(s.expect === "hit");
      checked.push(`${family}/${s.id}`);
    }
  }
  // 共享锚至少覆盖 6 共有族 × 3 样本——语料被掏空时这里先红
  expect(checked.length).toBeGreaterThanOrEqual(18);
});

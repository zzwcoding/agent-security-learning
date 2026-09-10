// 票 55：vite dev 代理转发表与 api 层的静态对账（防再犯闸）。
// 背景：页面全走同源相对路径（api.ts 头注），跨源由 vite dev 代理转发；proxy 表
// 漏一行 = 浏览器请求落在 vite 自身 404，而 jsdom 单测的 fetchMock 直接拦路径、
// 整段绕过代理层——票 55 的 /api/v1/pii 就这么断的线（单元全绿、走线断裂）。
// 所以这里不 mock 任何东西，直接读两份源码文本对账（不走 import：配置文件不在
// tsconfig include 内，对账只关心文本里的表，别把 vite 模块图拖进测试）：
//   ① vite.config.ts proxy 表里 "/…": { target: … } 形的前缀行；
//   ② src 运行时代码（剔除 *.test.* 与 test/ 测试替身）里带引号（' " `）发起的
//     /api/v1/<seg>——引号锚定调用点，注释里的路径不入集。
// 断言 ① ⊇ ②：新增 api 前缀而忘配 proxy 行时本测试当场红。
// 口径：只对账 /api/v1/*——/internal/runs（proxy 有独立 /internal 行）与
// /eval-results/latest.json（evalResultsStatic 静态面，非代理）不在本闸范围。
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// HERE = import.meta.url 过一道中间变量：`new URL(x, import.meta.url)` 内联写法
// 会被 vite 当成静态资产 URL 特征模式改写，jsdom 环境下产物不是 file: 协议，
// fileURLToPath 直接炸（票 55 实测）——中间变量绕开该模式匹配，别"简化"回内联。
const HERE = import.meta.url;

const srcDir = fileURLToPath(new URL("./", HERE));
const configFile = fileURLToPath(new URL("../vite.config.ts", HERE));

/** proxy 表里 /api/v1/* 行的第三段（如 "/api/v1/auth" → "auth"）。 */
function v1Segment(prefix: string): string {
  return prefix.split("/")[3] as string;
}

async function proxyV1Prefixes(): Promise<Set<string>> {
  const text = await readFile(configFile, "utf8");
  const rows = [...text.matchAll(/"(\/[^"]+?)":\s*\{\s*target:/g)].map((m) => m[1] as string);
  expect(rows.length).toBeGreaterThan(0); // 一行都抓不到 = 解析方式与配置写法失配，先红在这里
  return new Set(rows.filter((p) => p.startsWith("/api/v1/")).map(v1Segment));
}

async function apiV1Prefixes(): Promise<Set<string>> {
  const files = (await readdir(srcDir, { recursive: true })).filter(
    (f) => /\.(ts|tsx)$/.test(f) && !f.includes(".test.") && !f.split("/").includes("test"),
  );
  const found = new Set<string>();
  for (const f of files) {
    const text = await readFile(join(srcDir, f), "utf8");
    for (const m of text.matchAll(/['"`]\/api\/v1\/([A-Za-z0-9_-]+)/g)) found.add(m[1] as string);
  }
  return found;
}

describe("票 55 · vite dev 代理转发表与 api 层静态对账", () => {
  it("解析自检：两份源码各扫得出非空的 /api/v1/* 前缀集（扫描失配先红在这里，不许空对空放行）", async () => {
    expect((await proxyV1Prefixes()).size).toBeGreaterThan(0);
    expect((await apiV1Prefixes()).size).toBeGreaterThan(0);
  });

  it("对账：api 层发起的每个 /api/v1/* 前缀，proxy 表都有转发行（缺行 = 走线断在 vite 自身）", async () => {
    const proxy = await proxyV1Prefixes();
    const api = await apiV1Prefixes();
    const missing = [...api].filter((p) => !proxy.has(p)).sort();
    expect(missing).toEqual([]); // 红时点名缺行前缀，照 vite.config.ts 相邻行补一行即绿
  });
});

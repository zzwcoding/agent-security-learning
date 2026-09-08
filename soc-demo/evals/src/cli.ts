// m11 eval 体系 · 公开接口入口（m11 卡：`pnpm test:eval [-- --tags regression]`）。
//
// 为什么要有这个薄 CLI：vitest 自己不认识 --tags（那是我们的业务字段），于是入口先解析
// --tags 落成 EVAL_TAGS env（loader.selectedTags 读它过滤用例），再用 vitest 的编程接口
// 启动同一个套件（suite.test.ts）。直接 `pnpm -C evals test`（CI 快道）与本入口跑的是
// 同一份生成的测试，只是这里多了 tag 过滤的入口。
// 用法（soc-demo 根）：
//   pnpm test:eval                       # 全量
//   pnpm test:eval -- --tags regression  # 回归子集（m11 卡公开接口形态）
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const i = argv.indexOf("--tags");
if (i >= 0 && argv[i + 1]) process.env.EVAL_TAGS = argv[i + 1];

const here = dirname(fileURLToPath(import.meta.url));
const { startVitest } = await import("vitest/node");
const ctx = await startVitest("test", [`${here}/suite.test.ts`], {
  root: dirname(here), // evals/ 包根（读它自己的 node_modules 与 tsconfig 语境）
  watch: false,
});
const failed = ctx.state.getCountOfFailedTests() > 0 || ctx.state.getUnhandledErrors().length > 0;
await ctx.close();
process.exitCode = failed ? 1 : 0;

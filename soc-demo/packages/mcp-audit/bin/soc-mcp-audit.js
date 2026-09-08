#!/usr/bin/env node
// npm bin 薄壳：demo 级无构建方案——借 tsx 的 loader 直接跑 TS 源（依赖已在 dependencies）。
import "tsx";
import("../src/cli.js").catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env node
// npm bin 薄壳：demo 级无构建方案——借 tsx 的 loader 直接跑 TS 源。票 43（F7·对账
// 一-7）起 tsx 归 devDependencies：本包 private 不外发，CLI 只从本仓跑（workspace
// 安装含 devDeps），壳保持 import "tsx" 形态不动，别弄坏 CLI。
import "tsx";
import("../src/cli.js").catch((e) => {
  console.error(e);
  process.exit(1);
});

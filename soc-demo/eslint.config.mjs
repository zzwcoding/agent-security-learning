import js from "@eslint/js";
import tseslint from "typescript-eslint";

// 阶段 0.3：最小 lint——eslint 推荐规则 + typescript-eslint 推荐规则，全仓库共用一份。
// 规则严不严以后可以调，"CI 里有一道 lint"这个事实先成立。
export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 纯 JS 文件（npm bin 壳、MCP fixture server）走 node 全局
    files: ["**/bin/**/*.js", "**/fixtures/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
);

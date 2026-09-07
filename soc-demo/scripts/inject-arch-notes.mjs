#!/usr/bin/env node
// 架构图节点注解 → 独立页面 + 点击跳转（本地增强层）。
// 用法: node scripts/inject-arch-notes.mjs
// 做两件事：
//   1. 从 docs/arch-notes.json 生成 docs/nodes/<id>.html 详情页（每节点一页，含返回主图链接）
//   2. 往 docs/architecture-v4.html 注入点击跳转逻辑（幂等，靠标记注释识别旧块）
// 注意：archify 重新 deliver 主图后需重跑本脚本。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = join(root, "docs/architecture-v4.html");
const notesPath = join(root, "docs/arch-notes.json");
const nodesDir = join(root, "docs/nodes");

const BEGIN = "<!-- arch-notes:begin -->";
const END = "arch-notes:end -->"; // 注释内容含 -->，结束标记单独匹配防重复

const notes = JSON.parse(readFileSync(notesPath, "utf8"));

// 节点的延伸阅读（内部结构图等），没有就不显示
const LINKS = {
  ingest: [{ href: "../architecture-m1-internal.html", text: "M1 内部结构图（五步流水线 + 技术栈 + 部署）" }],
  "case-backend": [{ href: "../architecture-m2-internal.html", text: "M2 内部结构图（写路径过闸 + 只读直查 + 事件出口）" }],
  "agent-core": [
    { href: "../architecture-m3-internal.html", text: "M3 内部结构图（调度主图 + 检查点恢复 + 审批挂起）" },
    { href: "../architecture-m4-internal.html", text: "M4 内部结构图（分诊子图六节点 + 不可信包装 + 结构化输出契约）" },
  ],
};

// ── 1. 生成详情页 ──────────────────────────────────────────────
mkdirSync(nodesDir, { recursive: true });
const page = (id, n) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${n.title}</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:0 auto;padding:32px 20px;line-height:1.8;color:#1a1a1a;background:#fafafa}
  h1{font-size:22px;margin:0 0 4px}
  a{color:#0b6bcb;text-decoration:none} a:hover{text-decoration:underline}
  .back{display:inline-block;margin-bottom:20px;font-size:14px}
  .card{background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:20px 24px}
  .links{margin-top:16px;padding-top:12px;border-top:1px dashed #ddd;font-size:14px}
  @media (prefers-color-scheme: dark){
    body{background:#14171f;color:#e6e6e6}
    .card{background:#1f2430;border-color:#333}
    .links{border-color:#444}
    a{color:#6db3f2}
  }
</style>
</head>
<body>
<a class="back" href="../architecture-v4.html">← 返回架构图 v4</a>
<div class="card">
<h1>${n.title}</h1>
${n.body}
${(LINKS[id] ?? []).map((l) => `<div class="links">📎 <a href="${l.href}">${l.text}</a></div>`).join("")}
</div>
</body>
</html>
`;

for (const [id, n] of Object.entries(notes)) {
  writeFileSync(join(nodesDir, `${id}.html`), page(id, n));
}

// ── 2. 主图注入点击跳转 ────────────────────────────────────────
let html = readFileSync(htmlPath, "utf8");
const b = html.indexOf(BEGIN);
if (b !== -1) {
  const e = html.indexOf(END, b);
  if (e !== -1) html = html.slice(0, b) + html.slice(e + END.length);
}

const block = `${BEGIN}
<style>[data-node-id]{cursor:pointer}</style>
<script>
// 捕获阶段监听（防查看器 stopPropagation）：点节点 → 跳转该节点详情页
document.addEventListener("click", function(ev){
  var el = ev.target.closest && ev.target.closest("[data-node-id]");
  if (el) location.href = "nodes/" + el.getAttribute("data-node-id") + ".html";
}, true);
</scr` + `ipt>
<!-- arch-notes:end -->`;

if (!html.includes("</body>")) throw new Error("HTML 里找不到 </body>，结构变了，别硬注入");
html = html.replace("</body>", block + "\n</body>");
writeFileSync(htmlPath, html);
console.log(`完成：${Object.keys(notes).length} 个节点详情页 → docs/nodes/；主图点击跳转已注入`);

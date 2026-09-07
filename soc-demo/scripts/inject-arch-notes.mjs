#!/usr/bin/env node
// 架构图本地增强层。
// 用法: node scripts/inject-arch-notes.mjs
// 做三件事（全部注入 docs/ 下 architecture-*.html，非 visual-check）：
//   1. 节点自定义内容弹窗：点节点查 docs/arch-notes.json（键支持 ALIAS 别名），
//      有内容 → 拦截查看器内置语义护照，弹自定义内容卡（含内部结构图链接）；
//      无内容 → 完全无反应。取代旧的 nodes/<id>.html 详情页跳转（已废弃并移除）。
//   2. 底部三张要点卡折叠进工具栏「要点」按钮，点击弹「要点速览」弹窗。
//   3. 版面增强：隐藏 SVG 图例、导航条上顶、viewBox 裁死边距 + 内容缩小
//      （DENSITY）、画布最大化（pAR=none 铺满窗口）。
// 注意：archify 重新 deliver 任意一张图后，重跑本脚本即可全部恢复。
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = join(root, "docs");
const notesPath = join(docsDir, "arch-notes.json");

const notes = JSON.parse(readFileSync(notesPath, "utf8"));

// 节点的延伸阅读（内部结构图等），没有就不显示；href 相对 docs/ 目录
const LINKS = {
  ingest: [{ href: "architecture-m1-internal.html", text: "M1 内部结构图（五步流水线 + 技术栈 + 部署）" }],
  "case-backend": [{ href: "architecture-m2-internal.html", text: "M2 内部结构图（写路径过闸 + 只读直查 + 事件出口）" }],
  "m3-supervisor": [{ href: "architecture-m3-internal.html", text: "M3 内部结构图（调度主图 + 检查点恢复 + 审批挂起）" }],
  "m4-triage": [{ href: "architecture-m4-internal.html", text: "M4 内部结构图（分诊子图六节点 + 不可信包装 + 结构化输出契约）" }],
  "m5-investigation": [{ href: "architecture-m5-internal.html", text: "M5 内部结构图（调查工具循环 + 三条缰绳）" }],
  "m6-enrichment": [{ href: "architecture-m6-internal.html", text: "M6 内部结构图（TLP/PAP 闸门 + microVM 沙箱）" }],
  "m7-knowledge": [{ href: "architecture-m7-internal.html", text: "M7 内部结构图（提炼→人审→入库 + 检索面）" }],
};

// 内部图节点 id → arch-notes.json 键的别名（内部图 id 是另一套命名）
const ALIAS = {
  m2: "case-backend",
  webui: "web",
  m1: "ingest",
  m3: "m3-supervisor",
  workers: "m3-supervisor",
  human: "approver",
  m4: "m4-triage",
  kb: "m7-knowledge",
  ticketgate: "gate",
};

const diagramFiles = readdirSync(docsDir)
  .filter((f) => /^architecture-.+\.html$/.test(f) && !f.includes("visual-check"))
  .map((f) => join(docsDir, f));

// ── 旧注入块的标记（迁移清理用）──────────────────────────────
const OLD_BEGIN = "<!-- arch-notes:begin -->";
const OLD_END = "arch-notes:end -->";
const CARD_BEGIN = "<!-- arch-cards:begin -->";
const CARD_END = "arch-cards:end -->"; // 结束标记单独匹配防重复
const VIEW_BEGIN = "<!-- arch-view:begin -->";
const VIEW_END = "arch-view:end -->";
const NP_BEGIN = "<!-- arch-nodepop:begin -->";
const NP_END = "arch-nodepop:end -->";

function stripBlock(doc, begin, end) {
  const b = doc.indexOf(begin);
  if (b === -1) return doc;
  const e = doc.indexOf(end, b);
  if (e === -1) return doc;
  return doc.slice(0, b) + doc.slice(e + end.length);
}

// ── 1. 节点自定义内容弹窗（全部图统一）────────────────────────
const nodepopBlock = `${NP_BEGIN}
<style>
  [data-node-id]{cursor:pointer}
  /* 节点内容卡：左上角无蒙层悬浮，按住标题栏可拖动 */
  .arch-np{
    position: fixed; top: 4.6rem; left: 1rem; z-index: 10000;
    width: min(480px, calc(100vw - 2rem));
    max-height: min(72vh, 760px); overflow: auto;
    background: var(--panel, #101827); color: inherit;
    border: 1px solid var(--panel-border, #334155); border-radius: 0.7rem;
    padding: 0.6rem 0.8rem;
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 0.74rem; line-height: 1.5;
    display: none;
  }
  .arch-np[data-open="true"]{ display: block; }
  .arch-np-head{
    display: flex; align-items: center; justify-content: space-between; gap: 0.6rem;
    margin: -0.1rem -0.2rem 0.35rem; padding: 0.1rem 0.15rem;
    cursor: move; user-select: none;
  }
  .arch-np h2{ font-size: 0.82rem; margin: 0; }
  .arch-np p{ margin: 0.35rem 0; }
  .arch-np ul{ margin: 0.3rem 0; padding-left: 1.15em; }
  .arch-np li{ margin: 0.12rem 0; }
  .arch-np a{ color: var(--frontend-stroke, #6db3f2); text-decoration: none; }
  .arch-np a:hover{ text-decoration: underline; }
  .arch-np-close{
    background: transparent; color: inherit; cursor: pointer;
    border: 1px solid var(--panel-border, #334155); border-radius: 0.4rem;
    padding: 0.1rem 0.4rem; font: inherit; font-size: 0.7rem; flex: none;
  }
</style>
<script id="arch-node-notes" type="application/json">${JSON.stringify(notes).replace(/</g, "\\u003c")}</scr` + `ipt>
<script>
(function(){
  var LINKS = ${JSON.stringify(LINKS)};
  var ALIAS = ${JSON.stringify(ALIAS)};
  var card, body;
  function ensure(){
    if (card) return;
    card = document.createElement("div");
    card.className = "arch-np"; card.dataset.open = "false";
    card.innerHTML = '<div class="arch-np-head">'
      + '<h2 class="arch-np-title"></h2>'
      + '<button type="button" class="arch-np-close">关闭 ✕</button></div>'
      + '<div class="arch-np-body"></div>';
    document.body.appendChild(card);
    body = card.querySelector(".arch-np-body");
    card.querySelector(".arch-np-close").addEventListener("click", function(){ setOpen(false); });
    document.addEventListener("keydown", function(ev){
      if (ev.key === "Escape" && card.dataset.open === "true") setOpen(false);
    });
    // 标题栏拖动
    var head = card.querySelector(".arch-np-head");
    head.addEventListener("pointerdown", function(e){
      if (e.target.closest(".arch-np-close")) return;
      e.preventDefault();
      var sx = e.clientX, sy = e.clientY;
      var r = card.getBoundingClientRect();
      var ol = r.left, ot = r.top;
      function move(ev){
        var nl = Math.max(8, Math.min(window.innerWidth - 60, ol + ev.clientX - sx));
        var nt = Math.max(8, Math.min(window.innerHeight - 40, ot + ev.clientY - sy));
        card.style.left = nl + "px"; card.style.top = nt + "px";
      }
      function up(){
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
      }
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    });
  }
  function setOpen(v){ card.dataset.open = v ? "true" : "false"; }
  function open(id){
    var data;
    try { data = JSON.parse(document.getElementById("arch-node-notes").textContent); }
    catch (e) { return false; }
    var key = ALIAS[id] || id;
    var n = data[key];
    if (!n) return false;
    ensure();
    var links = (LINKS[key] || []).map(function(l){
      return '<div style="margin-top:0.45rem;padding-top:0.4rem;border-top:1px dashed var(--panel-border,#334155);font-size:0.72rem">📎 <a href="' + l.href + '">' + l.text + '</a></div>';
    }).join("");
    body.innerHTML = '<h2>' + n.title + '</h2>' + n.body + links;
    card.scrollTop = 0;
    setOpen(true);
    return true;
  }
  // 捕获最早阶段接管节点点击：拦掉查看器内置语义护照；有内容弹卡，没内容不反应
  window.addEventListener("click", function(ev){
    var el = ev.target && ev.target.closest && ev.target.closest("[data-node-id]");
    if (!el) return;
    ev.stopPropagation(); ev.preventDefault();
    open(el.getAttribute("data-node-id"));
  }, true);
})();
</scr` + `ipt>
<!-- arch-nodepop:end -->`;

// ── 2. 底部三卡 → 「要点」按钮弹窗 ─────────────────────────────
const cardsBlock = `${CARD_BEGIN}
<style>
  .cards { display: none !important; }
  .cards-modal-overlay {
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(2, 6, 16, 0.55);
    backdrop-filter: blur(3px);
    display: none; align-items: center; justify-content: center;
    padding: 1.5rem;
  }
  .cards-modal-overlay[data-open="true"] { display: flex; }
  .cards-modal {
    background: var(--panel, #101827);
    color: inherit;
    border: 1px solid var(--panel-border, #334155);
    border-radius: 1rem;
    max-width: 960px; width: 100%;
    max-height: min(78vh, 720px);
    overflow: auto;
    padding: 1.25rem 1.25rem 1.5rem;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.4);
  }
  .cards-modal-head {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 0.9rem;
  }
  .cards-modal-title { font-size: 0.95rem; font-weight: 600; letter-spacing: 0.02em; }
  .cards-modal-close {
    background: transparent; color: inherit; cursor: pointer;
    border: 1px solid var(--panel-border, #334155);
    border-radius: 0.5rem; padding: 0.25rem 0.55rem;
    font: inherit; font-size: 0.8rem; line-height: 1.4;
  }
  .cards-modal-close:hover {
    border-color: color-mix(in srgb, currentColor 40%, var(--panel-border, #334155));
  }
  .cards-modal .cards { display: grid !important; margin-top: 0; }
</style>
<script>
(function(){
  function setup(){
    var cards = document.querySelector(".cards");
    var toolbar = document.querySelector(".toolbar");
    if (!cards || !toolbar || document.getElementById("btn-cards")) return;
    var btn = document.createElement("button");
    btn.id = "btn-cards"; btn.type = "button"; btn.textContent = "要点";
    btn.title = "要点速览";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "cards-modal");
    var themeBtn = toolbar.querySelector("#btn-theme");
    if (themeBtn) themeBtn.insertAdjacentElement("afterend", btn);
    else toolbar.insertBefore(btn, toolbar.firstChild);
    var overlay = document.createElement("div");
    overlay.className = "cards-modal-overlay"; overlay.id = "cards-modal";
    overlay.dataset.open = "false";
    overlay.innerHTML = '<div class="cards-modal" role="dialog" aria-modal="true" aria-label="要点速览">'
      + '<div class="cards-modal-head"><span class="cards-modal-title">要点速览</span>'
      + '<button type="button" class="cards-modal-close">关闭 ✕</button></div>';
    // 原 .cards 节点整体搬进弹窗，类名不动，样式原样带走
    overlay.querySelector(".cards-modal").appendChild(cards);
    document.body.appendChild(overlay);
    function setOpen(open){
      overlay.dataset.open = open ? "true" : "false";
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    }
    btn.addEventListener("click", function(){ setOpen(overlay.dataset.open !== "true"); });
    overlay.addEventListener("click", function(ev){ if (ev.target === overlay) setOpen(false); });
    overlay.querySelector(".cards-modal-close").addEventListener("click", function(){ setOpen(false); });
    document.addEventListener("keydown", function(ev){
      if (ev.key === "Escape" && overlay.dataset.open === "true") setOpen(false);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup);
  else setup();
})();
</scr` + `ipt>
<!-- arch-cards:end -->`;

// ── 3. 版面增强：去图例 / 导航条上顶 / 裁死边距 + 内容缩小 / 画布最大化 ──
let injected = 0;
for (const file of diagramFiles) {
  let doc = readFileSync(file, "utf8");
  // 清掉全部旧块（含 v4 历史上的跳转块），保证可重复执行
  doc = stripBlock(doc, OLD_BEGIN, OLD_END);
  doc = stripBlock(doc, CARD_BEGIN, CARD_END);
  doc = stripBlock(doc, VIEW_BEGIN, VIEW_END);
  doc = stripBlock(doc, NP_BEGIN, NP_END);
  if (!doc.includes("</body>")) throw new Error(`${file} 里找不到 </body>，结构变了，别硬注入`);

  // viewBox：以 spec meta.viewBox 为原始基准。画布统一到目标宽高比 TARGET（贴近常用
  // 窗口），内容不足的维度留白补齐、内容居中——这样 pAR=none 铺满窗口时拉伸失真≈0，
  // 文字不会变瘦/变胖；再整体乘 DENSITY 缩小内容，四周留白给后续加节点。
  // （教训：各图内容比例天生不同，若画布跟随内容比例，pAR=none 会把字横向压扁。）
  const specPath = file.replace(/\.html$/, ".architecture.json");
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const [vbW, vbH] = spec.meta.viewBox;
  const xs = [];
  const ys = [];
  for (const c of spec.components ?? []) {
    xs.push(c.pos[0], c.pos[0] + (c.size?.[0] ?? 0));
    ys.push(c.pos[1], c.pos[1] + (c.size?.[1] ?? 0));
  }
  if (!ys.length) throw new Error(`${specPath} 里没有组件，没法算包围盒`);
  const boxW = Math.min(vbW, Math.max(...xs) + 34) - Math.max(0, Math.min(...xs) - 30);
  const boxH = Math.min(vbH, Math.max(...ys) + 34) - Math.max(0, Math.min(...ys) - 30);
  if (!/viewBox="/.test(doc)) throw new Error(`${file} 里找不到 svg viewBox`);
  const TARGET = 2.15;
  const DENSITY = 1.3;
  let W2 = Math.max(vbW, boxW);
  let H2 = Math.max(vbH, boxH);
  if (W2 / H2 < TARGET) W2 = H2 * TARGET; else H2 = W2 / TARGET;
  W2 *= DENSITY; H2 *= DENSITY;
  const cx = (Math.max(0, Math.min(...xs) - 30) + Math.min(vbW, Math.max(...xs) + 34)) / 2;
  const cy = (Math.max(0, Math.min(...ys) - 30) + Math.min(vbH, Math.max(...ys) + 34)) / 2;
  doc = doc.replace(/viewBox="[^"]*"/, `viewBox="${cx - W2 / 2} ${cy - H2 / 2} ${W2} ${H2}"`);
  // 画布最大化：svg 取消等比信箱（pAR=none），铺满容器非等比拉伸——画跟着画布边界走
  doc = doc.replace(/<svg([^>]*viewBox=[^>]*)>/, (tag, attrs) =>
    /preserveAspectRatio=/.test(tag) ? `<svg${attrs}>` : `<svg${attrs} preserveAspectRatio="none">`
  );

  const viewBlock = `${VIEW_BEGIN}
<style>
  /* 去掉 SVG 内的图例组 */
  svg [data-legend] { display: none !important; }
  /* 右下导航条 → 顶部工具栏（fixed, top:1rem, right:1rem）左侧 */
  .diagram-nav {
    position: fixed !important;
    top: 1.05rem !important;
    right: 26.5rem !important;
    bottom: auto !important;
  }
  @media (max-width: 1280px) {
    .diagram-nav { top: 4.4rem !important; right: 1rem !important; }
  }
  /* 导航条不再占底部预留高度 */
  .diagram-container { --archify-nav-reserve: 0px !important; }
  /* 画布 = 窗口（去掉顶部工具行后全部给图），svg 铺满画布非等比拉伸 */
  html { --archify-reader-width: 100vw !important; }
  .diagram-container {
    height: calc(100vh - 6.5rem) !important;
    box-sizing: border-box !important;
  }
  .diagram-container svg { width: 100% !important; height: 100% !important; }
  body { padding: 1rem 1.25rem 0.75rem !important; }
  .header { margin-bottom: 0.75rem !important; }
</style>
<!-- arch-view:end -->`;

  doc = doc.replace("</body>", nodepopBlock + "\n" + cardsBlock + "\n" + viewBlock + "\n</body>");
  writeFileSync(file, doc);
  injected++;
}

console.log(`完成：${injected} 张架构图已注入——节点自定义内容弹窗（arch-notes.json，无内容点击无反应）、三卡「要点」弹窗、版面增强`);

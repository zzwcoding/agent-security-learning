# 思维导图工具选型

Type: research
Status: resolved
Blocked by:

## Question

为"路线 1–3 安全知识复习思维导图"选工具。要求：GitHub 高星、开源、适合程序员、macOS 可用。硬约束与偏好：

- **源文件可进 git、可 diff、可持续数周更新**（复习导图是活文档，要跟随路线 4 及收尾继续生长）——文本驱动方案（markdown → 导图）优先
- 层级深（安全知识要层层分级归类，4–5 层），节点多（数百个），渲染不能糊
- 节点需要挂链接（跳回 lessons / deliverables / 知识卡片的具体文件）
- 候选至少覆盖：markmap（markdown→导图）、Mermaid mindmap、drawio/diagrams.net、Freeplane、Obsidian 生态（Canvas/Enhancing Mindmap）、VS Code 导图插件；如有更优选项可补充

对比维度：星标与维护活跃度、文本源格式与 git 友好度、深层大图的渲染与交互（折叠/搜索/缩放）、节点挂链接能力、本地/离线可用性、导出（PNG/SVG/HTML）质量。给出明确推荐（主用一个 + 备选）。

## Answer

**主用：markmap**（[markmap/markmap](https://github.com/markmap/markmap)，markdown → D3 SVG 交互导图）。
**备选：Freeplane**（[freeplane/freeplane](https://github.com/freeplane/freeplane)，桌面应用，仅在需要手动布局/关系线/富导出的局部场景补充）。

### 为什么主用 markmap

- **源文件就是 Markdown**：节点用 markdown 标题/列表层级书写，diff 逐行可读，天然满足"活文档数周持续更新、进 git"这条最硬约束；而且与现有 lessons/知识卡片同为 markdown，写作习惯零切换。
- **节点挂本地文件链接是一等公民**：markmap 渲染的是标准 markdown，`[文本](../lessons/xxx.md)` 这类相对链接直接变成可点击节点，跳回 lessons/deliverables/知识卡片无需任何插件机制。
- **深度与规模不设限**：层级深度无限制（4–5 层毫无压力）；交互上支持逐节点折叠/展开（点圆圈）、缩放、平移，`initialExpandLevel` 可设默认展开层级，`colorFreezeLevel` 可按层固定分支颜色（见 [JSON options](https://markmap.js.org/docs/json-options)）。数百节点用 SVG+D3 渲染流畅。
- **离线 & 导出**：`markmap-cli`（同一 monorepo 的 `packages/markmap-cli`，见 [仓库](https://github.com/markmap/markmap/tree/master/packages/markmap-cli)）一条命令把 markdown 编译成**自包含 HTML**，双击即开、不依赖编辑器，可随时发给别人看；官方 [VSCode 扩展](https://github.com/markmap/markmap-vscode)提供实时预览。
- **维护活跃度够**：13.1k stars（2026-09-03 实时），核心库 2026-06 仍有提交，MIT 协议。
- 生态兜底：若想在 Obsidian 里看，james-tindal/obsidian-mindmap-nextgen 就是 markmap 内核——同一 markdown 源可直接复用，不用迁移。

### 为什么备选 Freeplane 而不是其他

Freeplane 的 `.mm` 是 XML 文本，git 可 diff（噪音比 drawio 的 XML 小）；作为桌面应用完全离线；深层大图的折叠、过滤、搜索、缩放都是桌面级体验；节点可挂本地文件链接；导出 PNG/SVG/PDF 质量好。它不文本驱动（需在 GUI 里编辑），所以只作备选：当某张局部图需要手动摆位、画跨分支关系线或要打印级导出时用它。4.3k stars，2026-08 仍活跃提交。

### 对比表（星标与 push 时间为 2026-09-03 GitHub API 实时值）

| 工具 | Stars / 最近 push | 文本源与 git 友好度 | 深层大图交互 | 节点本地链接 | 离线 | 导出 | 判定 |
|---|---|---|---|---|---|---|---|
| [markmap](https://github.com/markmap/markmap) | 13.1k / 2026-06 | ✅ 纯 markdown，diff 完美 | ✅ 折叠/缩放/平移，`initialExpandLevel` 控层级 | ✅ markdown 相对链接原生 | ✅ CLI 编译，自包含 HTML | HTML（自包含）；PNG/SVG 经浏览器/工具栏 | **主用** |
| [Freeplane](https://github.com/freeplane/freeplane) | 4.3k / 2026-08 | ◯ XML `.mm`，可 diff 有噪音 | ✅ 桌面级折叠/过滤/搜索 | ✅ 本地文件链接 | ✅ 桌面应用 | PNG/SVG/PDF 打印级 | **备选** |
| [Mermaid mindmap](https://mermaid.js.org/syntax/mindmap.html) | 90k（全 mermaid）/ 2026-09 | ◯ 自有缩进语法，非 markdown | ❌ 静态 SVG，无折叠交互；官方标注实验性 | ❌ mindmap 不支持节点链接 | ◯ 需渲染器 | SVG/PNG | 排除：只适合嵌在文档里的小图，撑不起数百节点复习图 |
| [drawio/diagrams.net](https://github.com/jgraph/drawio)（[desktop](https://github.com/jgraph/drawio-desktop) 62.9k） | 7.9k / 2026-09 | ❌ XML 非手写格式，diff 噪音大；手动布局 | ◯ 交互强但维护靠手工摆位，数百节点成本高 | ◯ 支持但配置繁琐 | ✅ desktop 版 | PNG/SVG/PDF 好 | 排除：非文本驱动，违背最硬约束（一次性架构图已有 archify 覆盖） |
| Obsidian Canvas（[JSON Canvas](https://jsoncanvas.org/)） | 格式 MIT 开放；Obsidian 本体闭源免费 | ◯ JSON 可 diff 但结构化噪音 | ❌ 白板不是层级导图，布局全手动 | ✅ 可链 vault 文件 | ✅ | 弱（图片导出） | 排除：空间白板模型与"层级复习导图"需求错配 |
| [obsidian-enhancing-mindmap](https://github.com/MarkMindCkm/obsidian-enhancing-mindmap) | 712 / 2026-01 | ✅ markdown 源 | ◯ 图内直接编辑，但写回 markdown 会丢其不支持的语法 | ✅ | ✅ | 一般 | 不作主方案：插件体量小、维护一般；需要 Obsidian 内看图时优先 mindmap-nextgen |
| [obsidian-mindmap-nextgen](https://github.com/james-tindal/obsidian-mindmap-nextgen) | 403 / 2026-05 | ✅ markdown 源（markmap 内核） | ✅ 继承 markmap 折叠/缩放 | ✅ | ✅ | 截图/SVG | 补充查看器：同一 markdown 源可直接用，零迁移成本 |
| [markmap-vscode](https://github.com/markmap/markmap-vscode)（VS Code 插件类） | 298 / 2025-06 | ✅ 同 markmap 源 | ✅ 实时预览+编辑联动 | ✅ | ✅ | 经 markmap 导出 | 主用方案的编辑器前端：VS Code 导图类插件中没有更强独立选项 |

### 落地建议（一句话流程）

复习导图写成 `mindmap.md`（markdown 列表，节点文字带相对链接）→ 日常用 VS Code 的 markmap 扩展边看边改 → 里程碑时 `npx markmap-cli mindmap.md -o mindmap.html --no-open` 产出自包含 HTML 存档/分享。导图本身不进仓库也可，源是 markdown 已满足 git 追踪。

### 来源

- markmap 仓库与生态（stars/提交/相关项目）：https://github.com/markmap/markmap
- markmap JSON options（折叠动画、`initialExpandLevel`、`colorFreezeLevel`、zoom/pan）：https://markmap.js.org/docs/json-options
- markmap-cli：https://github.com/markmap/markmap/tree/master/packages/markmap-cli
- markmap VSCode 扩展：https://github.com/markmap/markmap-vscode
- Mermaid mindmap 官方文档（实验性声明、语法、无折叠/链接能力）：https://mermaid.js.org/syntax/mindmap.html
- Mermaid 仓库：https://github.com/mermaid-js/mermaid
- drawio / drawio-desktop：https://github.com/jgraph/drawio ，https://github.com/jgraph/drawio-desktop
- Freeplane：https://github.com/freeplane/freeplane
- JSON Canvas 格式（Obsidian Canvas 底层，MIT）：https://jsoncanvas.org/
- obsidian-enhancing-mindmap：https://github.com/MarkMindCkm/obsidian-enhancing-mindmap
- obsidian-mindmap-nextgen（markmap 内核）：https://github.com/james-tindal/obsidian-mindmap-nextgen ，插件页 https://community.obsidian.md/plugins/obsidian-mindmap-nextgen

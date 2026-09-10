# 票 0007: 解析器扩充——pymupdf 接 PDF（补票：PRD §0.2-2 点名框架认领，阶段 1 明确不做项的收口）

Status: open
Belongs to spec: `specs/rag-core.md`
Touches modules: `ingest` `webui`
Depends on: 0001（入库管线与 parse_file  seam 已立）
Blocking: （无后续阻塞；第二幕起 PDF 文档可入图谱/Wiki 管线）

## 验收

- [ ] `test_parse_pdf_via_pymupdf` —— 源自 spec 验收测试表第 27 行（fixture_sample.pdf 经 `parse_file` 返回全文且含已知句；pymupdf 真出现在 requirements.txt 且被真调用）

## 范围

- `ingest`：`parse_file` 按扩展名分派——txt/md 走内置解析（md 本票一并补上，PRD §8.1-4 拍板的两个示范解析器齐备），pdf 走 pymupdf；失败抛 `ParseError`（沿用票 0001 失败态约定）
- `webui`：入库页上传控件接受 .pdf（文件类型白名单扩一项）
- 拆票理由：PRD §3 阶段 1 明示"不做 PDF"，但 pymupdf 是 §0.2-2 点名框架，第一幕若无票认领则留洞——故补本票（sdd-flow 阶段 4 框架分配自查）
- 不做：docreader 其余引擎（OCR/图片管线等，PRD §1.2-7 明确不含）

## 框架红线

- **pymupdf 必须真引入**：进 requirements.txt 且 `parse_file` 的 pdf 分支真调用（本票认领 PRD §0.2-2 点名框架之三）
- 不许引入 PyPDF2/pdfplumber 等其他 PDF 库顶替（点名即验收对象，PRD §0.2-2）

## 边界红线

- 允许触碰：`ingest/`、`webui/`（仅上传控件白名单）、`tests/`、新 fixture（fixture_sample.pdf）、requirements.txt
- import 范围：`ingest` 只许新增 import `fitz`（pymupdf 的 import 名）；不新增任何模块间依赖边

## 页面可观察变化

入库页上传一份 PDF → 文档列表出现该 PDF → chunk 列表展示其分块结果（与 txt 同一管线，可入库后即可被 BM25/向量检索命中）。

## 体量

一个分派分支 + 白名单 + 一条 fixture 测试，远小于一次 L2 会话；建议与票 0001 同窗口顺手实现但单独验收单独提交（learn-by-rebuild：用户说"提交"才 commit）。

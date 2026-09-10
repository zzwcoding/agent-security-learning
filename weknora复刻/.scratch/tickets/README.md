# 票 tracker

本地 markdown 票，一票一文件 `NNNN-标题.md`（从 `0001` 起），模板见 `docs/ticket-template.md`。

学习阶段 1–14 = 票，sdd-flow 阶段 4 拆票时生成。spec gate 校验规则：
- `Status:` 翻转与事件同步，不许事后补账
- `Belongs to spec:` 指向 `specs/<功能>.md`
- `Touches modules:` 的模块名必须在 `specs/modules.md` 声明

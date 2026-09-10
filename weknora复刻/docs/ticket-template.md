# 票模板（sdd-flow 阶段 4；真实票落 `.scratch/tickets/NNNN-标题.md`）

```
# 票 NNNN: 标题
Status: open | doing | done
Belongs to spec: `specs/<功能>.md`
Touches modules: `模块A` `模块B`（取自 specs/modules.md）

## 验收
- [ ] 每条验收条目注明源自 spec 验收测试表的哪一行

## 框架红线
（本票点名必须真引入的框架；无则写"无点名框架"）

## 边界红线
（本票允许触碰的模块与 import 范围）
```

注意：模板不能放 `.scratch/` 下——spec gate 会把它当真票校验（模板里的占位模块名会 FAIL）。

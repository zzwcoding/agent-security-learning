# 0001 — 开工落位(阶段 1)

## 学了什么

- 从 git 历史把 starter-agent 最终形态(f1c47d2)落成新项目骨架:`git archive <commit> <path> | tar -x --strip-components=3 --exclude='*.env'`
- 基线冒烟:`echo "/quit" | bash scripts/run-with-keychain.sh` → 6 个 MCP 工具加载成功
  (read_file / write_file / list_dir / run_command / http_get / http_post)

## 攻击面清单(baseline 现状,后续阶段逐个补)

- `shell_server.run_command`(shell_server.py:13-17):零检查,`shell=True` 裸奔
- `filesystem_server.write_file`(filesystem_server.py:32-36):无语法校验、无覆盖确认;
  `_resolve` 用 `str.startswith` 前缀比较(filesystem_server.py:17-22),弱于参考项目的 `relative_to`
- 防护全靠 agent 外置(本项目连 llm-guard 都没挂),工具层自身无任何闸

## 参考项目精读结论(explore agent 调研,证据齐备)

- "四层架构"是横切功能点,非独立模块;危险匹配是**子串匹配**(execution_tools.py:116-123, 210-215)
- 审批 prompt 要求 JSON 回复,`_parse_json_response` 剥 fence + 截取兜底(llm_helper.py:22-42)
- **fail 方向不对称**:审批异常 fail-closed(llm_helper.py:165-167),非 Python 校验异常 fail-open(:344-346)
- 长输出阈值在 execution_tools.py:18-21(200 行/10000 字符,头尾各 50),`truncate_and_persist` 纯函数(:24-67)
- cli.py demo 不是 mock,是懒加载客户端 + fail-closed 的组合(cli.py:195-307)
- server.py 用 mcp SDK 低层 `Server` API,薄壳,与 cli.py 复用同一批工具类

## 卡在哪

无。uv 安装 lock 一次过;冒烟测试发现 banner 还是旧项目的"阶段 8 Docker",已就地修正。

## 结论

基线成立。下一步(阶段 2):file_write 的 workspace 边界升级为 `resolve()+relative_to`。

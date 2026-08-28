"""执行工具 CLI:每个子命令直接调用一个工具函数,打印结构化结果(JSON)。

当前阶段(9)注释:已有 write / edit / shell / code 四个子命令;
下一阶段加 demo,把所有场景串成离线端到端演示。
工具模块(file_tools / execution_tools)不依赖本文件——同一份工具之后还会被 MCP server 复用。
"""
import argparse
import json

import execution_tools
import file_tools


def main() -> None:
    parser = argparse.ArgumentParser(description="执行工具 CLI(带安全闸)")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("write", help="写文件到 workspace(覆盖已有文件需审批)")
    p.add_argument("path")
    p.add_argument("content")
    p = sub.add_parser("edit", help="搜索-替换编辑 workspace 里的文件")
    p.add_argument("path")
    p.add_argument("old_text")
    p.add_argument("new_text")
    p = sub.add_parser("shell", help="在 workspace 里执行 shell 命令")
    p.add_argument("shell_command")
    p = sub.add_parser("code", help="执行一段 Python 代码")
    p.add_argument("python_code")
    args = parser.parse_args()

    if args.command == "write":
        result = file_tools.write_file(args.path, args.content)
    elif args.command == "edit":
        result = file_tools.edit_file(args.path, args.old_text, args.new_text)
    elif args.command == "shell":
        result = execution_tools.virtual_terminal(args.shell_command)
    elif args.command == "code":
        result = execution_tools.code_interpreter(args.python_code)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

"""执行工具 CLI:每个子命令直接调用一个工具函数,打印结构化结果(JSON)。

当前阶段(4)注释:write 之外新增 shell 子命令;后续每阶段加一个,
最后的 demo 子命令把所有场景串成离线端到端演示。
工具模块(file_tools / execution_tools)不依赖本文件——同一份工具之后还会被 MCP server 复用。
"""
import argparse
import json

import execution_tools
import file_tools


def main() -> None:
    parser = argparse.ArgumentParser(description="执行工具 CLI(带安全闸)")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("write", help="写文件到 workspace")
    p.add_argument("path")
    p.add_argument("content")
    p = sub.add_parser("shell", help="在 workspace 里执行 shell 命令")
    p.add_argument("shell_command")
    args = parser.parse_args()

    if args.command == "write":
        result = file_tools.write_file(args.path, args.content)
    elif args.command == "shell":
        result = execution_tools.virtual_terminal(args.shell_command)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

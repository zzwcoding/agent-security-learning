#!/usr/bin/env bash
# 路线 3 阶段 35:三个 MCP server 的 SSE 形态(挂网关用)
# 一个终端跑三个服务,Ctrl+C 全部退场;日志带前缀直接看本终端。
# 默认(stdio)形态不受影响:agent 直连时仍按老方式子进程拉起,不设 MCP_TRANSPORT 即可。
set -e
cd "$(dirname "$0")/.." || exit 1
export MCP_TRANSPORT=http

.venv/bin/python mcp_servers/filesystem_server.py &  # 127.0.0.1:8001 /sse
.venv/bin/python mcp_servers/shell_server.py &       # 127.0.0.1:8002 /sse
.venv/bin/python mcp_servers/fetch_server.py &       # 127.0.0.1:8003 /sse
wait

#!/usr/bin/env bash
# 路线 3 阶段 34:ContextForge MCP 网关启动脚本
# 网关是独立服务:独立 venv(uv 钉 Python 3.12,系统 3.14 超包的 requires-python 上限)+ 独立 .env(JWT/AUTH 密钥,已被 git-ignore)
# UI 登录用 admin,密码在 gateway/.env 的 BASIC_AUTH_PASSWORD(别贴进任何文档)
cd "$(dirname "$0")/../gateway" || exit 1
exec .venv/bin/mcpgateway --host 127.0.0.1 --port 4444

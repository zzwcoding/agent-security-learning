#!/usr/bin/env bash
# 铸一枚网关短时通行证(60 分钟)打到 stdout。
# 单独成脚本的原因:run-agent.sh 里内嵌多行 python -c 的嵌套引号被 shell 撕碎
# (实测:字典单引号被拆,python 收到 SyntaxError)——heredoc 加引号 <<'EOF'
# 是零插值的,内容原样进 python,这是 shell 传多行代码的唯一稳态。
# 铸币权(JWT_SECRET_KEY)留在 gateway 家目录;调用方只拿短时 token。
cd "$(dirname "$0")/../gateway" || exit 1
exec .venv/bin/python - <<'EOF'
import asyncio
from mcpgateway.utils.create_jwt_token import create_jwt_token

token = asyncio.run(create_jwt_token(
    {"sub": "admin@example.com"}, expires_in_minutes=60,
    user_data={"email": "admin@example.com", "full_name": "starter-agent",
               "is_admin": True, "auth_provider": "local"},
    teams=None))
print(token)
EOF

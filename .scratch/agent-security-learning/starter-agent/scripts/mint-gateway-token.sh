#!/usr/bin/env bash
# 铸一枚网关短时通行证(60 分钟)打到 stdout。
# 单独成脚本的原因:run-agent.sh 里内嵌多行 python -c 的嵌套引号被 shell 撕碎
# (实测:字典单引号被拆,python 收到 SyntaxError)——heredoc 加引号 <<'EOF'
# 是零插值的,内容原样进 python,这是 shell 传多行代码的唯一稳态。
# 铸币权(JWT_SECRET_KEY)留在 gateway 家目录;调用方只拿短时 token。
# 阶段 38:支持两个身份——admin(运维位,默认)/ bob(只读位)。
# 注意:票面 is_admin 只过网关的认证层;工具级能不能用由 OpenFGA 判(两层分离)。
IDENTITY="${1:-admin}"
case "$IDENTITY" in
  admin) EMAIL="admin@example.com"; FGA_NAME="starter-agent" ;;
  bob)   EMAIL="bob@example.com";   FGA_NAME="ts-second-agent" ;;
  *) echo "未知身份: $IDENTITY(admin|bob)" >&2; exit 1 ;;
esac
cd "$(dirname "$0")/../gateway" || exit 1
exec .venv/bin/python - "$EMAIL" "$FGA_NAME" <<'EOF'
import asyncio, sys
from mcpgateway.utils.create_jwt_token import create_jwt_token

email, name = sys.argv[1], sys.argv[2]
token = asyncio.run(create_jwt_token(
    {"sub": email}, expires_in_minutes=60,
    user_data={"email": email, "full_name": name,
               "is_admin": True, "auth_provider": "local"},
    teams=None))
print(token)
EOF

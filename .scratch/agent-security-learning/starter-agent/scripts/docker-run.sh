#!/usr/bin/env bash
# 容器化启动起步 Agent:key 从 Keychain 注入,workspace 挂卷(容器里写的文件宿主可见)。
# 用法: scripts/docker-run.sh
set -euo pipefail
cd "$(dirname "$0")/.."

docker build -t starter-agent .

# memory.json 单独挂卷:不挂的话它写在容器可写层,--rm 退出即焚毁,记忆跨重启失效。
# 文件必须先在宿主存在,否则 docker 会把挂载点建成同名目录;
# 容器里是非 root 用户,挂卷文件/目录要放开写权限,否则记忆和 write_file 都写不动
touch memory.json
chmod 666 memory.json
chmod -R a+rwX workspace

# 加固参数(进程边界):只读根fs + tmpfs /tmp + 资源限额 + 全降 capabilities + 禁提权。
# 已知缺口:网络保留(LLM API 与 fetch 硬依赖),egress 未限——留给路线 2 microsandbox。
exec docker run --rm -it \
  -e LLM_BASE_URL="https://api.minimaxi.com/v1" \
  -e LLM_MODEL="MiniMax-M2" \
  -e LLM_API_KEY="$(agent-key minimax)" \
  -v "$PWD/workspace:/app/workspace" \
  -v "$PWD/memory.json:/app/memory.json" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --memory 3g --cpus 2 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  starter-agent

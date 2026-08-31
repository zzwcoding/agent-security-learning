#!/bin/sh
# 逃逸探针(阶段 24):同一段代码在加固 Docker 与 microVM 各跑一遍,输出做边界对比。
# 三类动作:读宿主路径 / 扫内网 / 提权。只用 sh+coreutils+python3(两个环境都有)。
# 标记约定:✗ = 攻击者得手   ✓ = 被防住   △ = 拒绝/无响应(需结合拦截方解读)

echo "===== 0. 身份与环境"
echo "--- id: $(id 2>&1)"
echo "--- 内核: $(uname -srm)"
echo "--- 主机名: $(hostname 2>&1)"
echo "--- 有效 capabilities: $(grep CapEff /proc/self/status 2>/dev/null | cut -d= -f2 || echo '读不到')"

echo "===== 1. 读宿主路径"
echo "--- 根目录: $(ls / 2>&1 | tr '\n' ' ')"
echo "--- /Users(macOS 宿主家目录):"; ls /Users 2>&1 | head -2
echo "--- /etc/passwd 头两行:"; head -2 /etc/passwd 2>&1
echo "--- PID 1 环境(找密钥):"; tr '\0' '\n' < /proc/1/environ 2>&1 | head -3
echo "--- 挂载表(宿主卷泄漏点):"; grep -Ev 'proc|sysfs|devpts|cgroup|overlay|/shm$' /proc/mounts 2>/dev/null | head -6
echo "--- /app/workspace(宿主挂载卷):"; ls /app/workspace 2>&1 | head -4

echo "===== 2. 扫内网"
python3 - <<'PY'
import socket

def probe(ip, port, timeout=2):
    try:
        s = socket.create_connection((ip, port), timeout=timeout)
        s.close()
        return "✗ 可达"
    except ConnectionRefusedError:
        return "△ 拒绝(路径通但端口没开/被主动拒)"
    except Exception as e:
        return f"△ {type(e).__name__}(超时或无路径)"

targets = [
    ("宿主 LAN IP 192.168.0.23:3000(Langfuse,必区分)", "192.168.0.23", 3000),
    ("宿主 LAN IP 192.168.0.23:7000(AirPlay)", "192.168.0.23", 7000),
    ("LAN 网关 192.168.0.1:80", "192.168.0.1", 80),
    ("云元数据 169.254.169.254:80", "169.254.169.254", 80),
    ("docker 网关 172.17.0.1:80", "172.17.0.1", 80),
    ("本机 loopback 127.0.0.1:3000", "127.0.0.1", 3000),
]
for name, ip, port in targets:
    print(f"  {name}: {probe(ip, port)}")
PY

echo "===== 3. 提权尝试"
if touch /etc/pwned-escape 2>/dev/null; then echo "  写 /etc: ✗ 成功"; rm -f /etc/pwned-escape; else echo "  写 /etc: ✓ 被拒"; fi
if touch /pwned-escape 2>/dev/null; then echo "  写 根目录: ✗ 成功"; rm -f /pwned-escape; else echo "  写 根目录: ✓ 被拒"; fi
command -v sudo >/dev/null 2>&1 && echo "  sudo: ✗ 存在" || echo "  sudo: ✓ 不存在"
touch /tmp/pwned-ok 2>/dev/null && echo "  写 /tmp: 允许(预期内)"
echo "===== 探针完毕"

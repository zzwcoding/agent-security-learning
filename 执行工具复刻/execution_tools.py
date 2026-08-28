"""执行工具:跑 shell 命令、跑代码的地方。

当前阶段(4)注释:先只有 virtual_terminal 的"裸执行"版——能跑命令、拿回输出。
唯一限制是 cwd 钉在 workspace(命令从 workspace 目录里发出)。
注意:这挡不住命令里写绝对路径!真正的门卫(危险命令拦截)是阶段 5-6 的事。
"""
import subprocess

from config import WORKSPACE_DIR


def virtual_terminal(command: str) -> dict:
    """在 workspace 目录里执行 shell 命令,返回退出码和输出。"""
    try:
        r = subprocess.run(command, shell=True, capture_output=True, text=True,
                           timeout=30, cwd=WORKSPACE_DIR)
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "执行超时(30 秒上限)"}
    return {
        "success": r.returncode == 0,
        "returncode": r.returncode,
        "stdout": r.stdout,
        "stderr": r.stderr,
    }

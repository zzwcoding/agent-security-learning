"""执行工具:跑 shell 命令、跑代码的地方。

当前阶段(5)注释:virtual_terminal 装上第一道工序——危险命令硬拦截。
命令先过 DANGEROUS_COMMANDS 子串筛子,命中直接拒。这是"宁可错杀"版:
误伤和下漏都不可避免(见 lesson 0005),阶段 6 的 LLM 审批来收拾残局。
"""
import subprocess

from config import WORKSPACE_DIR

# 危险命令黑名单:子串匹配,命中即拦。列表照抄参考项目 execution_tools.py:210-215
DANGEROUS_COMMANDS = ["rm -rf", "dd", "mkfs", "format", "> /dev/", "chmod -R", "chown -R"]


def virtual_terminal(command: str) -> dict:
    """在 workspace 目录里执行 shell 命令,返回退出码和输出。"""
    hit = [d for d in DANGEROUS_COMMANDS if d in command]
    if hit:
        return {"success": False, "error": f"命中危险命令模式 {hit},已拦截(未执行)"}
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

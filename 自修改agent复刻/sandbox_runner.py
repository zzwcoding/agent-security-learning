"""容器入口(宿主进程禁止 import 本文件):从 stdin 读 JSON 请求,往 stdout 回 JSON。

阶段 6:语义检查上三灯——public_api_compatible(签名兼容)/
failure_replay(失败重放一次都不许再试)/ nonretryable_circuit(永久错误 1 次熔断)。
这里 exec 候选源码,是全流程第一次真正执行不可信代码:它只发生在加固一次性
容器里,且 stdout/stderr 被重定向进黑洞——候选的任何打印都污染不了协议通道。
"""

from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import inspect
import json
import sys
from typing import Any

MAX_REQUEST_BYTES = 1024 * 1024
SANDBOX_CHECKS = (
    "public_api_compatible",
    "failure_replay",
    "nonretryable_circuit",
    "temporary_recovery",
    "old_task_regression",
    "canary_ready",
    "rollback_ready",
)


class _NullWriter:
    """黑洞输出:候选代码往 stdout 打多少字节都进不了协议通道。"""

    def write(self, value: str) -> int:
        return len(value)

    def flush(self) -> None:
        pass


def _namespace(source: str) -> dict[str, Any]:
    """把候选源码 exec 成独立命名空间(容器内,这是候选被执行的唯一地点)。"""
    namespace: dict[str, Any] = {}
    exec(compile(source, "candidate/retry_policy.py", "exec"), namespace)
    return namespace


def _validate(payload: dict[str, Any]) -> dict[str, bool]:
    checks = {name: False for name in SANDBOX_CHECKS}
    try:
        namespace = _namespace(payload["source"])
    except Exception:
        return checks
    if not callable(namespace.get("should_retry")) or not callable(
        namespace.get("should_open_circuit")
    ):
        return checks

    try:
        checks["public_api_compatible"] = (
            str(inspect.signature(namespace["should_retry"])) == "(error_code, retryable, attempt)"
            and str(inspect.signature(namespace["should_open_circuit"]))
            == "(consecutive_failures, *, error_code='', retryable=True)"
        )
    except (TypeError, ValueError):
        return checks
    if not checks["public_api_compatible"]:
        return checks

    failures = [item for item in payload["trajectories"] if item.get("outcome") == "failure"]
    try:
        # 失败重放:每条失败轨迹的每个尝试序号上,新策略都必须说"别试了"
        checks["failure_replay"] = bool(failures) and all(
            not namespace["should_retry"](item["error_code"], item["retryable"], attempt)
            for item in failures for attempt in range(item["attempts"])
        )
        # 永久错误熔断:第 1 次永久失败就要跳闸(老代码要凑满 5 次,必挂)
        checks["nonretryable_circuit"] = bool(failures) and all(
            namespace["should_open_circuit"](
                1, error_code=item["error_code"], retryable=item["retryable"]
            )
            for item in failures
        )
    except Exception:
        return checks
    return checks


def main() -> int:
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        return 2
    try:
        payload = json.loads(raw)
        action = payload["action"]
        with redirect_stdout(_NullWriter()), redirect_stderr(_NullWriter()):
            if action == "validate":
                result = {"checks": _validate(payload)}
            else:
                return 2
    except (Exception, SystemExit):
        return 1
    sys.stdout.write(json.dumps({"ok": True, "result": result}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

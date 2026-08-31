"""容器入口(宿主进程禁止 import 本文件):从 stdin 读 JSON 请求,往 stdout 回 JSON。

阶段 5 只打通协议回环:验证请求合法、把"容器确实看到了什么"回传。
七项语义检查在阶段 6-7 逐项点亮。python -I 隔离模式启动,禁网禁写,
就算候选代码在这里执行也摸不到宿主。
"""

from __future__ import annotations

import json
import sys

MAX_REQUEST_BYTES = 1024 * 1024


def _reject(reason: str) -> None:
    """协议级拒绝:也走 JSON,让宿主拿到结构化的失败而不是一堆报错文本。"""
    json.dump({"ok": False, "error": reason}, sys.stdout)
    sys.stdout.flush()
    raise SystemExit(2)


def main() -> None:
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        _reject("request exceeds 1 MiB")
    try:
        request = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        _reject("request is not valid JSON")
    if not isinstance(request, dict) or not isinstance(request.get("source"), str):
        _reject("request missing source string")

    result = {
        "action": request.get("action"),
        "source_bytes": len(request["source"].encode("utf-8")),
        "trajectories_seen": len(request["trajectories"]) if isinstance(request.get("trajectories"), list) else None,
    }
    json.dump({"ok": True, "result": result}, sys.stdout)
    sys.stdout.flush()


if __name__ == "__main__":
    main()

"""microsandbox 一次性 microVM 后端:与 candidate_sandbox.py 同一 JSON 协议、同一 fail-closed 语义。

阶段 12 对照收官用:同一候选、同一 sandbox_runner、同一组检查,只换执行面。
与 Docker 版的三处结构差异(其余语义刻意对齐):
1. 无镜像构建:SDK 嵌入式拉起微型 VM,runner 经 stdin 写进 VM 的 /tmp(不烧进镜像);
2. ephemeral=True:停止即连状态一起销毁(对应 Docker 的 --rm + 一次性容器);
3. 超时靠 SDK exec 的 timeout 参数(对应 Docker 的 Popen.wait(timeout))。
依赖:microsandbox SDK 在主线 starter-agent 的 .venv 里,用该 venv 的 python 运行本模块。
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Iterable
import uuid

from microsandbox import Sandbox

ROOT = Path(__file__).resolve().parent
RUNNER_SOURCE = (ROOT / "sandbox_runner.py").read_bytes()
SANDBOX_IMAGE = "python:3.12"  # 与主线 shell_server 同款;VM 里自带 python3
DEFAULT_TIMEOUT_SECONDS = 8.0


class SandboxError(RuntimeError):
    """microVM 没能产出可信结果——语义与 Docker 版的 SandboxError 对齐。"""


def _build_request(action: str, source: str, trajectories: Iterable[dict[str, Any]],
                   stable_source: str | None) -> bytes:
    return json.dumps({
        "action": action,
        "source": source,
        "trajectories": list(trajectories),
        "stable_source": stable_source,
    }).encode("utf-8")


def _parse_response(stdout: bytes, exit_code: int) -> dict[str, Any]:
    """与 Docker 版相同的协议验收:退出码 0 + 合规 JSON + ok=true + result 对象。"""
    if exit_code != 0:
        raise SandboxError(f"microVM runner exited with {exit_code}")
    try:
        response = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SandboxError("microVM runner returned an invalid response") from exc
    if not isinstance(response, dict) or response.get("ok") is not True:
        raise SandboxError("microVM runner rejected the evaluation request")
    result = response.get("result")
    if not isinstance(result, dict):
        raise SandboxError("microVM response has no result object")
    return result


async def _run_in_microvm(
    action: str,
    source: str,
    trajectories: Iterable[dict[str, Any]],
    *,
    stable_source: str | None = None,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    request = _build_request(action, source, trajectories, stable_source)
    name = f"self-modify-mvm-{uuid.uuid4().hex[:12]}"
    try:
        async with await Sandbox.create(name=name, image=SANDBOX_IMAGE, ephemeral=True) as sb:
            # 1) runner 经 stdin 落进 VM(对应 Docker 版把 runner 烧进内容寻址镜像)
            writer = await sb.exec("sh", ["-c", "cat > /tmp/sandbox_runner.py"],
                                   stdin=RUNNER_SOURCE, timeout=30)
            if not writer.success:
                raise SandboxError("could not install runner into microVM")
            # 2) 同一 runner、同一协议:请求走 stdin,结果只认 stdout 的合规 JSON
            out = await sb.exec("python3", ["-I", "/tmp/sandbox_runner.py"],
                                stdin=request, timeout=timeout_seconds)
            return _parse_response(out.stdout_bytes, out.exit_code)
    except SandboxError:
        raise
    except Exception as exc:  # 超时/VM 起不来/SDK 异常:一律 fail closed
        raise SandboxError(f"microVM evaluation failed: {type(exc).__name__}: {exc}") from exc


def run_in_microvm(
    action: str,
    source: str,
    trajectories: Iterable[dict[str, Any]],
    *,
    stable_source: str | None = None,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """同步封装:Docker 版调用方零改动即可换后端。"""
    return asyncio.run(_run_in_microvm(action, source, trajectories,
                                       stable_source=stable_source,
                                       timeout_seconds=timeout_seconds))


async def run_probe_in_microvm(probe_script: str, timeout_seconds: float = 60.0) -> str:
    """把逃逸探针(纯 sh+python3)整段丢进一次性 microVM,回传完整输出。"""
    try:
        async with await Sandbox.create(name=f"self-modify-probe-{uuid.uuid4().hex[:12]}",
                                        image=SANDBOX_IMAGE, ephemeral=True) as sb:
            out = await sb.shell(probe_script, timeout=timeout_seconds)
            return out.stdout_text + out.stderr_text
    except Exception as exc:
        return f"(microVM probe failed: {type(exc).__name__}: {exc})"

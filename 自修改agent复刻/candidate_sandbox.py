"""宿主侧 Docker 驱动:把候选代码关进一次性加固容器,任何异常一律 fail closed。

形态照抄参考项目:内容寻址镜像(改一字节就换镜像名强制重建)、stdin/stdout
JSON 协议、请求/输出限幅、墙钟超时;Docker 缺失/超时/协议异常都抛 SandboxError,
调用方按"检查失败"处理——绝不把"没验成"当成"验过了"。
(与参考项目的已知简化:输出读取用 communicate+事后限幅,代替参考版的
有界读线程;输出超限的处置语义一致,但恶意容器可先占内存,复刻收官时复核。)
"""

from __future__ import annotations

from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import subprocess
from typing import Any, Iterable
import uuid

ROOT = Path(__file__).resolve().parent
DOCKERFILE = ROOT / "Dockerfile.sandbox"
RUNNER = ROOT / "sandbox_runner.py"
DEFAULT_TIMEOUT_SECONDS = 8.0
MAX_REQUEST_BYTES = 1024 * 1024
MAX_OUTPUT_BYTES = 1024 * 1024
MAX_SOURCE_BYTES = 256 * 1024


class SandboxError(RuntimeError):
    """沙箱没能产出可信结果。"""


def sandbox_image() -> str:
    """内容寻址:镜像名 = Dockerfile+runner 的哈希,改一字节就强制重建。"""
    digest = hashlib.sha256(DOCKERFILE.read_bytes() + RUNNER.read_bytes()).hexdigest()[:12]
    return f"self-modify-replica/sandbox:{digest}"


@lru_cache(maxsize=None)
def _ensure_image(image: str) -> None:
    """镜像在就用,不在就按锁定的 Dockerfile 现场构建;两条路都失败即拒。"""
    try:
        inspect_result = subprocess.run(
            ["docker", "image", "inspect", image],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        raise SandboxError("Docker is required for candidate evaluation") from exc
    if inspect_result.returncode == 0:
        return
    if os.environ.get("SELF_MODIFY_SANDBOX_IMAGE"):
        raise SandboxError(f"Configured sandbox image is unavailable: {image}")
    try:
        build = subprocess.run(
            ["docker", "build", "--file", str(DOCKERFILE), "--tag", image, str(ROOT)],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=180, check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        raise SandboxError("Docker is required to build the candidate sandbox") from exc
    if build.returncode != 0:
        raise SandboxError(f"Could not build candidate sandbox: {build.stderr[-2000:].strip()}")


def _docker_command(image: str, name: str) -> list[str]:
    """加固全家桶:禁网/禁 IPC/只读根 fs/非 root/全降 cap/禁提权,外加资源限幅。"""
    return [
        "docker", "run", "--rm", "--interactive", "--name", name,
        "--hostname", "candidate-sandbox",
        "--network", "none",
        "--ipc", "none",
        "--read-only",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true",
        "--user", "65534:65534",
        "--pids-limit", "16",
        "--memory", "64m",
        "--memory-swap", "64m",
        "--cpus", "0.5",
        "--ulimit", "cpu=2:2",
        "--ulimit", "nofile=64:64",
        "--ulimit", "core=0:0",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777",
        "--workdir", "/tmp",
        "--log-driver", "none",
        "--env", "PYTHONDONTWRITEBYTECODE=1",
        image,
    ]


def run_in_sandbox(
    action: str,
    source: str,
    trajectories: Iterable[dict[str, Any]],
    *,
    stable_source: str | None = None,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """候选源码经 stdin 送进一次性容器,只认 stdout 回来的合规 JSON。"""
    try:
        if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
            raise SandboxError("Candidate source exceeds 256 KiB")
        if stable_source is not None and len(stable_source.encode("utf-8")) > MAX_SOURCE_BYTES:
            raise SandboxError("Stable source exceeds 256 KiB")
        request = json.dumps({
            "action": action,
            "source": source,
            "trajectories": list(trajectories),
            "stable_source": stable_source,
        }).encode("utf-8")
    except (TypeError, UnicodeError, ValueError) as exc:
        raise SandboxError("Candidate sandbox request is not valid JSON data") from exc
    if len(request) > MAX_REQUEST_BYTES:
        raise SandboxError("Candidate sandbox request exceeds 1 MiB")

    image = sandbox_image()
    _ensure_image(image)
    name = f"self-modify-candidate-{uuid.uuid4().hex}"
    try:
        process = subprocess.Popen(
            _docker_command(image, name),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise SandboxError("Docker is required for candidate evaluation") from exc
    try:
        stdout, stderr = process.communicate(request, timeout=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        _remove_container(name)
        process.kill()
        process.wait()
        raise SandboxError("Candidate evaluation exceeded the wall-clock limit") from exc
    except OSError as exc:
        _remove_container(name)
        raise SandboxError("Candidate sandbox closed its input unexpectedly") from exc

    if len(stdout) > MAX_OUTPUT_BYTES or len(stderr) > MAX_OUTPUT_BYTES:
        raise SandboxError("Candidate sandbox output exceeded 1 MiB")
    if process.returncode != 0:
        detail = stderr.decode("utf-8", errors="replace").strip()[-1000:]
        raise SandboxError(f"Candidate sandbox exited with {process.returncode}: {detail}")
    try:
        response = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SandboxError("Candidate sandbox returned an invalid response") from exc
    if not isinstance(response, dict) or response.get("ok") is not True:
        raise SandboxError("Candidate sandbox rejected the evaluation request")
    result = response.get("result")
    if not isinstance(result, dict):
        raise SandboxError("Candidate sandbox response has no result object")
    return result


def _remove_container(name: str) -> None:
    """超时兜底:容器可能还活着,强删,不留僵尸。"""
    try:
        subprocess.run(
            ["docker", "rm", "--force", name],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

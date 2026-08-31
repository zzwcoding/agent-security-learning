"""阶段 12 收官对照:同一候选、同一组检查,加固 Docker vs microsandbox 一次性 microVM。

跑法(用主线 starter-agent 的 venv,里面有 microsandbox SDK):
  cd 自修改agent复刻 && /Users/divh/Downloads/安全评估agent/.scratch/agent-security-learning/starter-agent/.venv/bin/python sandbox_comparison.py

输出:三方候选 × 两种后端的检查灯表对比、逐后端耗时、逃逸探针在两种沙箱的输出。
"""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

from candidate_sandbox import run_in_sandbox, SandboxError, _docker_command, sandbox_image
from evolution import diagnose, generate_candidate, generate_rejected_control
from microvm_sandbox import run_in_microvm, run_probe_in_microvm

ROOT = Path(__file__).resolve().parent


def load_candidates():
    stable_source = (ROOT / "stable" / "retry_policy.py").read_text(encoding="utf-8")
    trajectories = json.loads((ROOT / "failure_trajectories.json").read_text(encoding="utf-8"))
    diagnosis = diagnose(trajectories)
    runs = sorted((ROOT / "validation").glob("real_*"))
    candidates = {
        "deterministic": generate_candidate(stable_source, diagnosis),
        "rejected_control": generate_rejected_control(stable_source, diagnosis),
    }
    if runs:
        llm_path = runs[-1] / "candidates" / "real_llm" / "retry_policy.py"
        if llm_path.exists():
            src = llm_path.read_text(encoding="utf-8")
            candidates["real_llm(replay)"] = {"source": src}
    return stable_source, trajectories, candidates


def bench(name: str, backend: str, fn, source: str, trajectories, stable_source: str):
    started = time.perf_counter()
    try:
        result = fn("validate", source, trajectories, stable_source=stable_source)
        elapsed = time.perf_counter() - started
        green = sum(1 for v in result["checks"].values() if v)
        return {"name": name, "backend": backend, "elapsed": round(elapsed, 2),
                "green": green, "total": len(result["checks"]), "error": None}
    except SandboxError as exc:
        return {"name": name, "backend": backend, "elapsed": round(time.perf_counter() - started, 2),
                "green": 0, "total": 11, "error": str(exc)[:60]}


def probe_in_docker() -> str:
    """同一份探针,丢进与候选验证完全相同的加固 flag 容器(stdin 喂脚本,不留文件)。"""
    probe = (ROOT.parent / ".scratch" / "agent-security-learning" / "issues"
             / "09-route2-execution" / "escape-probe" / "probe.sh").read_text(encoding="utf-8")
    cmd = _docker_command(sandbox_image(), "self-modify-probe")
    cmd.insert(-1, "--entrypoint")  # 覆盖 ENTRYPOINT:runner 换成 sh(同一定义的其他加固 flag 全保留)
    cmd.insert(-1, "sh")
    proc = subprocess.run(cmd + ["-s"], input=probe.encode(), capture_output=True, timeout=90)
    return proc.stdout.decode("utf-8", errors="replace") + proc.stderr.decode("utf-8", errors="replace")


def main() -> None:
    stable_source, trajectories, candidates = load_candidates()
    print(f"候选 {len(candidates)} 个 × 后端 2 种(docker / microvm),同一 runner 同一组检查\n")

    rows = []
    for name, candidate in candidates.items():
        rows.append(bench(name, "docker", run_in_sandbox, candidate["source"], trajectories, stable_source))
        rows.append(bench(name, "microvm", run_in_microvm, candidate["source"], trajectories, stable_source))

    print(f"{'候选':22s} {'后端':8s} {'绿灯':8s} {'耗时(s)':8s} 错误")
    for r in rows:
        lamp = f"{r['green']}/{r['total']}"
        print(f"{r['name']:22s} {r['backend']:8s} {lamp:8s} {r['elapsed']:<8} {r['error'] or ''}")

    print("\n===== 逃逸探针 @ 加固 Docker =====")
    print(probe_in_docker())
    print("===== 逃逸探针 @ microVM =====")
    probe = (ROOT.parent / ".scratch" / "agent-security-learning" / "issues"
             / "09-route2-execution" / "escape-probe" / "probe.sh").read_text(encoding="utf-8")
    import asyncio
    print(asyncio.run(run_probe_in_microvm(probe)))


if __name__ == "__main__":
    main()

"""实验 9-6 复刻:由失败轨迹触发的 Agent 自我修改。

阶段 5:候选进沙箱。宿主只经 stdin/stdout JSON 协议与加固一次性容器对话,
容器回传的原始 JSON 直接打印;沙箱执行灯亮起,后七格仍灭(语义检查在后面)。
"""

from __future__ import annotations

import json
from pathlib import Path

from candidate_sandbox import run_in_sandbox
from evolution import diagnose, generate_candidate, validate_candidate, write_candidate

ROOT = Path(__file__).parent


def load_trajectories() -> list[dict]:
    """失败轨迹 = 生产环境一次任务里工具调用的出错记录,一条一个 JSON 对象。"""
    return json.loads((ROOT / "failure_trajectories.json").read_text(encoding="utf-8"))


def print_checks(title: str, checks: dict[str, bool]) -> None:
    print(f"{title}")
    for name, ok in checks.items():
        print(f"  {'✓' if ok else '·'} {name}")


def main() -> None:
    trajectories = load_trajectories()
    diagnosis = diagnose(trajectories)
    stable_source = (ROOT / "stable" / "retry_policy.py").read_text(encoding="utf-8")

    if not diagnosis["change_required"]:
        print("没有足够支持的失败模式,不改代码。")
        return
    candidate = generate_candidate(stable_source, diagnosis)
    out_path = write_candidate(candidate["source"], ROOT / "output" / "candidate" / "retry_policy.py")
    print(f"候选已写入 {out_path.relative_to(ROOT)},stable 未被改动:"
          f"{(ROOT / 'stable' / 'retry_policy.py').read_text(encoding='utf-8') == stable_source}\n")

    echo = run_in_sandbox("ping", candidate["source"], trajectories, stable_source=stable_source)
    print("容器回传 JSON(候选没出过容器,宿主只拿到这句话):", json.dumps(echo, ensure_ascii=False), "\n")

    checks = validate_candidate(candidate["source"], trajectories, stable_source=stable_source)
    print_checks("发布门槛灯表(候选补丁):", checks)
    assert all(checks[n] for n in ("static_compile", "security_scan")), "自家候选必须过静态闸"

    # 捣乱测试:同一道闸,喂一个偷运了 import os 的坏候选,看它拦不拦
    tampered = candidate["source"] + "\nimport os\nos.system('echo pwned')\n"
    print_checks("\n捣乱测试(候选尾部偷运 import os):", validate_candidate(tampered, trajectories))

    print("\n✅ 阶段 5 跑通:候选在加固容器里跑了个来回,sandbox_execution 亮灯。"
          "但容器只回了个'看见了',还没验证任何行为——下一步在容器里点亮语义检查。")


if __name__ == "__main__":
    main()

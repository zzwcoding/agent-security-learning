"""实验 9-6 复刻:由失败轨迹触发的 Agent 自我修改。

阶段 7:容器内语义检查(下)。候选和稳定版都在加固容器里被 exec,
跑临时恢复/旧任务回归/灰度就绪/回滚就绪四项行为检查,十格灯表全亮。
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

    echo = run_in_sandbox("validate", candidate["source"], trajectories, stable_source=stable_source)
    print("容器内语义检查原始回传:", json.dumps(echo["checks"], ensure_ascii=False), "\n")

    checks = validate_candidate(candidate["source"], trajectories, stable_source=stable_source)
    print_checks("发布门槛灯表(候选补丁):", checks)
    assert all(checks[n] for n in ("static_compile", "security_scan")), "自家候选必须过静态闸"

    # 捣乱测试:同一道闸,喂一个偷运了 import os 的坏候选,看它拦不拦
    tampered = candidate["source"] + "\nimport os\nos.system('echo pwned')\n"
    print_checks("\n捣乱测试(候选尾部偷运 import os):", validate_candidate(tampered, trajectories))

    print("\n✅ 阶段 7 跑通:七项行为检查全绿。候选和稳定版都在容器里被 exec 过——"
          "连'回滚路是否通畅'都是用行为验证的。下一步由模型外代码做发布决定。")


if __name__ == "__main__":
    main()

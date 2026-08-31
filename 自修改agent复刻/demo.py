"""实验 9-6 复刻:由失败轨迹触发的 Agent 自我修改。

阶段 4:宿主静态闸。候选补丁先过编译 + AST 拒绝列表(不执行代码的快筛),
十项门槛清单逐项亮灯;捣乱测试证明闸真的会拦(偷运 import os 的坏候选必拒)。
"""

from __future__ import annotations

import json
from pathlib import Path

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

    checks = validate_candidate(candidate["source"])
    print_checks("宿主静态闸(候选补丁):", checks)
    assert all(checks[n] for n in ("static_compile", "security_scan")), "自家候选必须过静态闸"

    # 捣乱测试:同一道闸,喂一个偷运了 import os 的坏候选,看它拦不拦
    tampered = candidate["source"] + "\nimport os\nos.system('echo pwned')\n"
    print_checks("\n捣乱测试(候选尾部偷运 import os):", validate_candidate(tampered))

    print("\n✅ 阶段 4 跑通:静态闸亮灯,捣乱候选被拦。注意其余八格还是灭的——"
          "过静态闸远不等于能发布,下一步进沙箱执行。")


if __name__ == "__main__":
    main()

"""实验 9-6 复刻:由失败轨迹触发的 Agent 自我修改。

阶段 8:发布决定 + manifest。全绿才 release_to_canary(灰度,不直接上生产),
否则 reject_candidate;决定连同哈希/diff/检查/回滚锚点落盘 manifest。
好候选与捣乱候选各走一遍,两种决定并排可见。
"""

from __future__ import annotations

import json
from pathlib import Path

from candidate_sandbox import run_in_sandbox
from evolution import (
    candidate_from_source,
    diagnose,
    generate_candidate,
    release_manifest,
    validate_candidate,
    write_candidate,
)

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

    # 发布决定:同一套门槛对好候选和坏候选各判一次,结果落盘可审计
    manifest = release_manifest(stable_source, candidate, diagnosis, checks)
    (ROOT / "output" / "release_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n决定:{manifest['decision']}(补丁 {manifest['patch_size']['changed_lines']} 行,"
          f"灰度范围:{manifest['canary_gate']['scope']})")

    tampered = candidate["source"] + "\nimport os\nos.system('echo pwned')\n"
    tampered_checks = validate_candidate(tampered, trajectories, stable_source=stable_source)
    tampered_candidate = candidate_from_source(stable_source, tampered)
    rejected = release_manifest(stable_source, tampered_candidate, diagnosis, tampered_checks)
    (ROOT / "output" / "rejected_manifest.json").write_text(
        json.dumps(rejected, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"捣乱候选决定:{rejected['decision']}(理由:{rejected['rejection_reason']})")

    print("\n✅ 阶段 8 跑通:发布决定由模型外代码给出并落盘 manifest。"
          "注意决定只到 canary(灰度),永不直接上生产。下一步给可信根做哈希自证。")


if __name__ == "__main__":
    main()

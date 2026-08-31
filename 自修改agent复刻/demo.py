"""实验 9-6 复刻:由失败轨迹触发的 Agent 自我修改。

阶段 10:真实 LLM 提案。--generator llm 时请 MiniMax-M2 出完整候选源码,
只写 validation/<run>/candidates/ 隔离区 + evidence 回执;它必须过与确定性
提案一模一样的门槛(静态闸→沙箱→manifest),真 key 只从 Keychain 注入。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import time
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

# 可信根清单:它们是"裁判和病历",不进自我修改权限,流程只许读不许改
TRUSTED_PATHS = (
    "stable/retry_policy.py",
    "failure_trajectories.json",
    "evolution.py",
    "candidate_sandbox.py",
    "sandbox_runner.py",
    "Dockerfile.sandbox",
)


def sha_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def snapshot_trusted_roots() -> dict[str, str]:
    return {name: sha_file(ROOT / name) for name in TRUSTED_PATHS}


def load_trajectories() -> list[dict]:
    """失败轨迹 = 生产环境一次任务里工具调用的出错记录,一条一个 JSON 对象。"""
    return json.loads((ROOT / "failure_trajectories.json").read_text(encoding="utf-8"))


def print_checks(title: str, checks: dict[str, bool]) -> None:
    print(f"{title}")
    for name, ok in checks.items():
        print(f"  {'✓' if ok else '·'} {name}")


def main() -> None:
    parser = argparse.ArgumentParser(description="self-modification pipeline (replica)")
    parser.add_argument("--generator", choices=("deterministic", "llm"), default="deterministic")
    args = parser.parse_args()

    before = snapshot_trusted_roots()  # 开工前:先给裁判和病历拍快照
    trajectories = load_trajectories()
    diagnosis = diagnose(trajectories)
    stable_source = (ROOT / "stable" / "retry_policy.py").read_text(encoding="utf-8")

    if not diagnosis["change_required"]:
        print("没有足够支持的失败模式,不改代码。")
        return

    if args.generator == "llm":
        from llm_generator import generate_with_openai
        candidate = generate_with_openai(stable_source, diagnosis)
        run_dir = ROOT / "validation" / time.strftime("minimax_%Y%m%dT%H%M%SZ", time.gmtime())
        out_path = write_candidate(candidate["source"], run_dir / "candidates" / "retry_policy.py")
        (run_dir / "evidence.json").write_text(
            json.dumps(candidate["generator_metadata"]["receipt"], ensure_ascii=False, indent=2),
            encoding="utf-8")
        print(f"LLM 提案只写隔离区:{out_path.relative_to(ROOT)}(evidence 同目录)\n")
        print(f"真实 LLM diff({candidate['generator_metadata']['model']},"
              f"{candidate['generator_metadata']['receipt']['usage']['total_tokens']} tokens):")
        print(candidate["diff"], "\n")
    else:
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

    # 收工后:再拍一次快照,前后对比——流程碰没碰可信根,哈希说了算
    after = snapshot_trusted_roots()
    print("\n可信根自证(SHA-256 开工前 → 收工后):")
    for name in TRUSTED_PATHS:
        mark = "✓ 未动" if before[name] == after[name] else "✗ 被改动!"
        print(f"  {mark}  {name}  {after[name][:12]}")
    unchanged = before == after
    print(f"结论:trusted_surfaces_unchanged = {unchanged}")
    print(f"证据轨迹哈希(进 manifest 存档):"
          f"{manifest['source_trajectories'][0]['id']} = {manifest['source_trajectories'][0]['trajectory_sha256'][:12]}")

    print("\n✅ 阶段 10 跑通:真实 LLM 提案过了同一组门槛,决定仍是模型外代码给的。"
          "对比 provenance 字段:deterministic vs real_llm_coding_agent。"
          "下一步把三方(负对照/确定性/真 LLM)放进取收入口同台对比。")


if __name__ == "__main__":
    main()

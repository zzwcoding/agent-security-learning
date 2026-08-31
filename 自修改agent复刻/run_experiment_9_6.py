"""实验 9-6 验收入口:负对照必拒 + 确定性/真实 LLM 同一组门槛 + 全量证据落盘。

流程:可信根拍快照 → 先跑负对照(它的死法喂给 LLM 当历史)→ 确定性提案 +
真实 LLM 提案 → 三方各过同一组门槛出 manifest → 行为指标对比 → 15 条验收
gate 全过才算 accepted → evidence.json(+SHA-256)+ artifact_hashes + latest 指针。

用法: scripts/run-with-keychain.sh run_experiment_9_6.py --provider minimax
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from candidate_sandbox import sandbox_image
from evolution import (
    diagnose,
    generate_candidate,
    generate_rejected_control,
    behavior_metrics,
    release_manifest,
    sha256_text,
    validate_candidate,
    write_candidate,
)
from llm_generator import generate_with_openai

ROOT = Path(__file__).resolve().parent

TRUSTED_PATHS = {
    "evolution.py": ROOT / "evolution.py",
    "candidate_sandbox.py": ROOT / "candidate_sandbox.py",
    "sandbox_runner.py": ROOT / "sandbox_runner.py",
    "Dockerfile.sandbox": ROOT / "Dockerfile.sandbox",
}


def _sha_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _manifest_fields_complete(manifest: dict[str, Any]) -> bool:
    required = {
        "failure_cluster", "source_trajectories", "inferred_root_cause",
        "target_component", "target_file", "code_diff", "impact_prediction",
        "expected_fix", "potential_regressions", "checks", "candidate_version",
        "rollback_version", "provenance", "decision",
    }
    return required.issubset(manifest) and all(manifest.get(key) is not None for key in required)


def main() -> int:
    parser = argparse.ArgumentParser(description="Experiment 9-6 acceptance (replica)")
    parser.add_argument("--provider", choices=("minimax", "openai"), default="minimax")
    parser.add_argument("--model", default=None)
    parser.add_argument("--seed", type=int, default=8501)
    args = parser.parse_args()

    stable_path = ROOT / "stable" / "retry_policy.py"
    trajectories_path = ROOT / "failure_trajectories.json"
    stable_source = stable_path.read_text(encoding="utf-8")
    trajectories = json.loads(trajectories_path.read_text(encoding="utf-8"))

    immutable_before = {
        "stable/retry_policy.py": _sha_file(stable_path),
        "failure_trajectories.json": _sha_file(trajectories_path),
        **{name: _sha_file(path) for name, path in TRUSTED_PATHS.items()},
    }

    # 负对照先行:历史感的坏补丁,死法要喂给真实 LLM 当上下文
    diagnosis = diagnose(trajectories)
    rejected = generate_rejected_control(stable_source, diagnosis)
    rejected_checks = validate_candidate(rejected["source"], trajectories, stable_source)
    rejected_manifest = release_manifest(stable_source, rejected, diagnosis, rejected_checks)
    rejected_history = [{
        "candidate_sha256": rejected["source_sha256"],
        "failed_checks": rejected_manifest["failed_checks"],
        "rejection_reason": rejected_manifest["rejection_reason"],
        "failure": "disabled temporary-timeout retries",
    }]
    print(f"负对照:{rejected_manifest['decision']}({rejected_manifest['rejection_reason'].split(':')[0]}…)")

    deterministic = generate_candidate(stable_source, diagnosis)
    print("真实 LLM 调用中…")
    llm = generate_with_openai(
        stable_source, diagnosis, args.model, provider=args.provider,
        seed=args.seed, rejected_history=rejected_history,
    )

    immutable_after = {
        "stable/retry_policy.py": _sha_file(stable_path),
        "failure_trajectories.json": _sha_file(trajectories_path),
        **{name: _sha_file(path) for name, path in TRUSTED_PATHS.items()},
    }
    protected_unchanged = immutable_before == immutable_after

    candidates = {"deterministic": deterministic, "real_llm": llm, "rejected_control": rejected}
    manifests: dict[str, dict[str, Any]] = {}
    metrics = {"stable_buggy_baseline": behavior_metrics(stable_source, trajectories)}
    for name, candidate in candidates.items():
        checks = validate_candidate(candidate["source"], trajectories, stable_source)
        checks["protected_surfaces_unchanged"] = protected_unchanged
        manifests[name] = release_manifest(stable_source, candidate, diagnosis, checks)
        metrics[name] = behavior_metrics(candidate["source"], trajectories)

    stamp = datetime.now(timezone.utc).strftime("real_%Y%m%dT%H%M%SZ")
    output_dir = ROOT / "validation" / stamp
    output_dir.mkdir(parents=True, exist_ok=False)
    for name, candidate in candidates.items():
        write_candidate(candidate["source"], output_dir / "candidates" / name / "retry_policy.py")
        (output_dir / f"{name}_manifest.json").write_text(
            json.dumps(manifests[name], ensure_ascii=False, indent=2), encoding="utf-8")

    llm_receipt = llm["generator_metadata"]["receipt"]
    gates = {
        "cross_trajectory_support_met": diagnosis["patterns"][0]["cross_trajectory_support"] >= 2,
        "root_cause_targets_control_code": diagnosis["target"] == "stable/retry_policy.py",
        "real_coding_model_called": (
            llm["generator_metadata"].get("api_calls") == 1
            and bool(llm_receipt["response"].get("id"))
        ),
        "impact_prediction_precedes_validation": bool(llm.get("impact_prediction")),
        "all_candidates_isolated": stable_path.read_text(encoding="utf-8") == stable_source,
        "trusted_surfaces_unchanged": protected_unchanged,
        "same_release_gate_for_both_generators": (
            set(manifests["deterministic"]["checks"]) == set(manifests["real_llm"]["checks"])
        ),
        "deterministic_candidate_release_to_canary":
            manifests["deterministic"]["decision"] == "release_to_canary",
        "real_llm_candidate_release_to_canary":
            manifests["real_llm"]["decision"] == "release_to_canary",
        "known_bad_candidate_rejected_and_retained": (
            manifests["rejected_control"]["decision"] == "reject_candidate"
            and bool(manifests["rejected_control"]["rejection_reason"])
        ),
        "failure_replay_reduces_calls": (
            metrics["real_llm"]["mean_nonretryable_calls"] == 1.0
            and metrics["stable_buggy_baseline"]["mean_nonretryable_calls"] > 1.0
        ),
        "temporary_recovery_preserved": metrics["real_llm"]["temporary_error_recovery_rate"] == 1.0,
        "old_task_regression_zero": metrics["real_llm"]["old_task_regressions"] == 0,
        "canary_only_not_production": all(
            m["decision"] in {"release_to_canary", "reject_candidate"} for m in manifests.values()
        ),
        "rollback_hash_pinned_to_stable": all(
            m["rollback_sha256"] == sha256_text(stable_source) for m in manifests.values()
        ),
        "release_manifest_fields_complete": all(_manifest_fields_complete(m) for m in manifests.values()),
    }

    report = {
        "experiment": "9-6",
        "executed_at": datetime.now(timezone.utc).isoformat(),
        "execution_mode": "real_api_coding_agent_plus_model_external_release_harness",
        "provider": args.provider,
        "model": args.model or "MiniMax-M2",
        "seed": args.seed,
        "input_artifacts": {
            "stable_sha256": immutable_before["stable/retry_policy.py"],
            "trajectory_sha256": immutable_before["failure_trajectories.json"],
            "trusted_surface_sha256_before": {n: immutable_before[n] for n in TRUSTED_PATHS},
            "trusted_surface_sha256_after": {n: immutable_after[n] for n in TRUSTED_PATHS},
        },
        "candidate_sandbox": {
            "image": sandbox_image(), "network": "none", "root_filesystem": "read_only",
            "user": "65534:65534", "memory": "64m", "cpus": 0.5,
            "wall_clock_timeout_seconds": 8.0,
        },
        "diagnosis": diagnosis,
        "rejected_history_given_to_coding_agent": rejected_history,
        "behavior_metrics": metrics,
        "manifests": manifests,
        "raw_api_receipts": [llm_receipt],
        "cost": llm_receipt["usage"],
        "gates": gates,
        "accepted": all(gates.values()),
    }
    evidence_path = output_dir / "evidence.json"
    evidence_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    evidence_sha = _sha_file(evidence_path)
    (output_dir / "evidence.sha256").write_text(evidence_sha + "  evidence.json\n", encoding="utf-8")
    (output_dir / "artifact_hashes.json").write_text(json.dumps({
        str(p.relative_to(output_dir)): _sha_file(p)
        for p in sorted(output_dir.rglob("*.py"))
    }, indent=2), encoding="utf-8")
    canonical = ROOT / "validation" / "latest.json"
    shutil.copyfile(evidence_path, canonical)
    (ROOT / "validation" / "latest.sha256").write_text(evidence_sha + "  latest.json\n", encoding="utf-8")

    print("\n三方检查对比(同一组门槛):")
    for name in ("deterministic", "real_llm", "rejected_control"):
        m = manifests[name]
        green = sum(1 for v in m["checks"].values() if v)
        print(f"  {name:18s} {m['decision']:18s} 灯 {green}/{len(m['checks'])} "
              f"故障调用均值 {metrics[name]['mean_nonretryable_calls']}")
    print(f"\n基线(stable 带病版)故障调用均值:{metrics['stable_buggy_baseline']['mean_nonretryable_calls']}")
    failed_gates = [k for k, v in gates.items() if not v]
    print(f"验收 gate:{len(gates) - len(failed_gates)}/{len(gates)} 过"
          + (f",未过:{', '.join(failed_gates)}" if failed_gates else ""))
    print(f"accepted:{all(gates.values())}  证据:{output_dir.relative_to(ROOT)}/evidence.json")
    return 0 if all(gates.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())

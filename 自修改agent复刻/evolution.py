"""确定性编排:轨迹 → 修改请求 → 提案 → 验证 → 发布决定(逐阶段生长)。

阶段 5:validate_candidate() 第三格 sandbox_execution 亮灯——候选代码的执行
只发生在加固一次性容器里(candidate_sandbox.py),宿主机上绝不直接执行;
SandboxError 一律按"检查失败"处理,fail closed。
"""

from __future__ import annotations

import ast
import difflib
import hashlib

from candidate_sandbox import MAX_SOURCE_BYTES, SandboxError, run_in_sandbox
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable

# 修复内容(与参考项目一致):三段协调的最小替换。
# 1) 把 PAYMENT_DECLINED 列入不可重试码(should_retry/熔断都要查这张表);
# 2) should_retry 开始认账 retryable 参数;
# 3) 熔断对永久错误立即跳闸,临时错误仍走满 5 次阈值。
OLD_CODES = 'NON_RETRYABLE_CODES = {"AUTH_DENIED", "INVALID_ARGUMENT"}'
NEW_CODES = 'NON_RETRYABLE_CODES = {"AUTH_DENIED", "INVALID_ARGUMENT", "PAYMENT_DECLINED"}'

OLD_RETRY = '''def should_retry(error_code, retryable, attempt):
    """Return whether another tool call should be attempted."""
    return attempt < MAX_RETRIES
'''
NEW_RETRY = '''def should_retry(error_code, retryable, attempt):
    """Return whether another tool call should be attempted."""
    if not retryable or error_code in NON_RETRYABLE_CODES:
        return False
    return attempt < MAX_RETRIES
'''

OLD_BREAKER = '''def should_open_circuit(consecutive_failures, *, error_code="", retryable=True):
    """Open after repeated failures."""
    return consecutive_failures >= CIRCUIT_BREAKER_THRESHOLD
'''
NEW_BREAKER = '''def should_open_circuit(consecutive_failures, *, error_code="", retryable=True):
    """Open immediately for permanent errors; otherwise use the threshold."""
    if not retryable or error_code in NON_RETRYABLE_CODES:
        return consecutive_failures >= 1
    return consecutive_failures >= CIRCUIT_BREAKER_THRESHOLD
'''

# 十项发布门槛清单:候选必须全绿才能 release_to_canary。
# static_compile/security_scan 是宿主静态闸(本阶段);其余八项由沙箱与发布阶段逐个点亮。
CHECK_NAMES = (
    "static_compile",
    "security_scan",
    "sandbox_execution",
    "public_api_compatible",
    "failure_replay",
    "nonretryable_circuit",
    "temporary_recovery",
    "old_task_regression",
    "canary_ready",
    "rollback_ready",
)


def sha256_text(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def _short_sha(source: str) -> str:
    return sha256_text(source)[:12]


def behavior_metrics(candidate_source: str, trajectories: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """在同一个沙箱里量候选的行为指标;量不出来就 fail closed(evaluation_failed)。"""
    fail = {"mean_nonretryable_calls": None, "temporary_error_recovery_rate": None,
            "old_task_regressions": None, "evaluation_failed": True}
    try:
        result = run_in_sandbox("metrics", candidate_source, trajectories)
    except SandboxError:
        return fail
    metrics = result.get("metrics")
    return metrics if isinstance(metrics, dict) else fail


def generate_rejected_control(stable_source: str, diagnosis: Dict[str, Any]) -> Dict[str, Any]:
    """负对照:一剂"看起来也治了病"的坏药——把所有重试全禁掉。
    它必须被门槛拒绝;它的死法还会作为历史喂给真实 LLM(别学我)。"""
    candidate = _replace_once(stable_source, OLD_RETRY, '''def should_retry(error_code, retryable, attempt):
    """Incorrect over-broad fix retained as a rejected candidate."""
    return False
''')
    candidate = _replace_once(candidate, OLD_BREAKER, NEW_BREAKER)
    candidate = candidate.replace('VERSION = "1.0.0"', 'VERSION = "1.0.1-rejected"', 1)
    return candidate_from_source(
        stable_source,
        candidate,
        impact_prediction={
            "non_retryable_calls": {"after": 1},
            "temporary_timeout_recovery_rate": {"after": 0.0},
        },
        generator_metadata={"generator": "negative_control", "api_calls": 0},
    )


def release_manifest(
    stable_source: str,
    candidate: Dict[str, Any],
    diagnosis: Dict[str, Any],
    checks: Dict[str, bool],
) -> Dict[str, Any]:
    """发布决定在模型外:全绿才 release_to_canary,否则 reject_candidate;
    决定连同证据(哈希/diff/检查结果/回滚锚点)整体落盘 manifest,可审计。"""
    accepted = candidate.get("changed", False) and bool(checks) and all(checks.values())
    failed = [name for name, passed in checks.items() if not passed]
    contract = diagnosis.get("change_contract", {})
    return {
        "artifact_type": "agent_control_code_patch",
        "failure_cluster": diagnosis.get("patterns", []),
        "source_trajectories": diagnosis.get("source_trajectories", []),
        "source_case_ids": diagnosis.get("source_case_ids", []),
        "inferred_root_cause": diagnosis.get("reason"),
        "target_component": diagnosis.get("target_component"),
        "target_file": diagnosis.get("target"),
        "code_diff": candidate.get("diff", ""),
        "impact_prediction": candidate.get("impact_prediction", {}),
        "expected_fix": contract.get("expected_fix", []),
        "potential_regressions": contract.get("potential_regressions", []),
        "stable_sha256": sha256_text(stable_source),
        "candidate_sha256": sha256_text(candidate.get("source", stable_source)),
        "rollback_sha256": sha256_text(stable_source),
        "candidate_version": _short_sha(candidate.get("source", stable_source)),
        "rollback_version": _short_sha(stable_source),
        "patch_size": candidate.get("patch_size", {}),
        "checks": checks,
        "failed_checks": failed,
        "canary_gate": {
            "eligible": accepted,
            "scope": "shadow traffic only; stable remains unchanged",
            "rollback_trigger": "any non-retryable repeat or temporary-recovery regression",
        },
        "rollback_gate": {
            "artifact_hash_matches_stable": checks.get("rollback_ready", False),
            "rollback_sha256": sha256_text(stable_source),
        },
        "provenance": candidate.get("generator_metadata", {}),
        "decision": "release_to_canary" if accepted else "reject_candidate",
        "rejection_reason": None if accepted else (
            "candidate did not change stable source" if not candidate.get("changed")
            else "failed gates: " + ", ".join(failed)
        ),
    }


def diagnose(trajectories: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """只聚合"失败的、不许重试的、却重试了"的轨迹;≥2 条同模式支持才成案。"""
    trajectories = list(trajectories)
    repeated: Dict[tuple[str, str], list[Dict[str, Any]]] = defaultdict(list)
    for item in trajectories:
        if item.get("outcome") == "failure" and not item.get("retryable", True) and item.get("attempts", 0) > 1:
            repeated[(item.get("tool", ""), item.get("error_code", ""))].append(item)

    patterns = []
    for (tool, error_code), items in repeated.items():
        if len(items) >= 2:
            patterns.append({
                "cluster_id": f"{tool}:{error_code}",
                "tool": tool,
                "error_code": error_code,
                "source_case_ids": [i["id"] for i in items],
                "cross_trajectory_support": len(items),
                "total_redundant_calls": sum(i["attempts"] - 1 for i in items),
            })
    if not patterns:
        return {"change_required": False, "target": None, "source_case_ids": [],
                "reason": "没有足够支持的重复失败模式。"}
    source_ids = sorted({cid for p in patterns for cid in p["source_case_ids"]})
    sources = [
        {
            "id": item["id"],
            "trajectory_sha256": sha256_text(repr(sorted(item.items()))),
            "evidence": item.get("evidence"),
        }
        for item in trajectories if item.get("id") in source_ids
    ]
    return {
        "change_required": True,
        "target": "stable/retry_policy.py",
        "target_component": "retry_and_circuit_breaker_control",
        "source_case_ids": source_ids,
        "source_trajectories": sources,
        "patterns": patterns,
        "reason": "重试/熔断控制无视 retryable=false,根因在控制代码,不在 prompt。",
        "change_contract": {
            "expected_fix": [
                "non-retryable tool-call attempts fall to one",
                "the circuit opens on the first permanent failure",
            ],
            "potential_regressions": [
                "temporary timeouts stop retrying",
                "the five-failure circuit threshold changes for retryable errors",
                "public function signatures change",
            ],
        },
    }


def _replace_once(source: str, old: str, new: str) -> str:
    """整块替换,且要求 old 在源码里恰好出现一次——匹配不上或匹配多次都报错。"""
    if source.count(old) != 1:
        raise ValueError("Candidate patch no longer matches exactly one stable-code region")
    return source.replace(old, new, 1)


def candidate_from_source(
    stable_source: str,
    candidate_source: str,
    *,
    impact_prediction: Dict[str, Any] | None = None,
    generator_metadata: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """把候选源码打包成可审查对象:源码 + 统一 diff + 补丁尺寸 + 出处元数据。"""
    diff = "".join(difflib.unified_diff(
        stable_source.splitlines(keepends=True),
        candidate_source.splitlines(keepends=True),
        fromfile="stable/retry_policy.py",
        tofile="candidate/retry_policy.py",
    ))
    added = sum(line.startswith("+") and not line.startswith("+++") for line in diff.splitlines())
    deleted = sum(line.startswith("-") and not line.startswith("---") for line in diff.splitlines())
    return {
        "source": candidate_source,
        "diff": diff,
        "changed": candidate_source != stable_source,
        "impact_prediction": impact_prediction or {},
        "generator_metadata": generator_metadata or {},
        "source_sha256": sha256_text(candidate_source),
        "patch_size": {"added_lines": added, "deleted_lines": deleted, "changed_lines": added + deleted},
    }


def generate_candidate(stable_source: str, diagnosis: Dict[str, Any]) -> Dict[str, Any]:
    """从稳定源码做最小 diff 生成候选;不需要改时原样返回(changed=False)。"""
    if not diagnosis.get("change_required"):
        return candidate_from_source(stable_source, stable_source)
    candidate = _replace_once(stable_source, OLD_CODES, NEW_CODES)
    candidate = _replace_once(candidate, OLD_RETRY, NEW_RETRY)
    candidate = _replace_once(candidate, OLD_BREAKER, NEW_BREAKER)
    candidate = candidate.replace('VERSION = "1.0.0"', 'VERSION = "1.1.0-candidate"', 1)
    return candidate_from_source(
        stable_source,
        candidate,
        impact_prediction={
            "non_retryable_calls": {"before": "up to 4", "after": 1},
            "temporary_timeout_recovery_rate": {"before": 1.0, "after": 1.0},
        },
        generator_metadata={"generator": "deterministic", "model": None, "api_calls": 0},
    )


def write_candidate(candidate_source: str, path: Path) -> Path:
    """候选只写进自己的目录,物理上碰不到 stable/。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(candidate_source, encoding="utf-8")
    return path


def _safe_ast(source: str) -> bool:
    """AST 拒绝列表:拒绝一切 import,以及 eval/exec/compile/open/__import__ 调用。
    只"读"语法树、不执行代码;它是快筛,不是安全边界。"""
    tree = ast.parse(source)
    forbidden_calls = {"eval", "exec", "compile", "open", "__import__"}
    return not any(
        isinstance(node, (ast.Import, ast.ImportFrom))
        or (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in forbidden_calls)
        for node in ast.walk(tree)
    )


def validate_candidate(
    candidate_source: str,
    trajectories: Iterable[Dict[str, Any]],
    stable_source: str | None = None,
) -> Dict[str, bool]:
    """发布门槛灯表:全 False 起步、过一关亮一灯;任何一关没过,后续全灭。"""
    checks = {name: False for name in CHECK_NAMES}
    try:
        if len(candidate_source.encode("utf-8")) > MAX_SOURCE_BYTES:
            return checks
    except UnicodeError:
        return checks
    try:
        # 编译和 AST 扫描都不执行源码;拒绝列表只是快筛,容器才是安全边界
        compile(candidate_source, "candidate/retry_policy.py", "exec")
        checks["static_compile"] = True
        checks["security_scan"] = _safe_ast(candidate_source)
        if not checks["security_scan"]:
            return checks
    except Exception:
        return checks

    try:
        result = run_in_sandbox("validate", candidate_source, trajectories, stable_source=stable_source)
    except SandboxError:
        return checks
    sandbox_checks = result.get("checks")
    if not isinstance(sandbox_checks, dict):
        return checks
    checks["sandbox_execution"] = True
    for name in CHECK_NAMES:
        if name not in {"static_compile", "security_scan", "sandbox_execution"}:
            checks[name] = sandbox_checks.get(name) is True
    return checks

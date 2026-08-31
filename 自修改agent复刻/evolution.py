"""确定性编排:轨迹 → 修改请求 → 提案 → 验证 → 发布决定(逐阶段生长)。

阶段 3:generate_candidate() 生成确定性候选补丁。
纪律:diff 用"整段匹配恰好一次"的整块替换(防改错位置);候选只写 output/candidate/,
绝不覆盖 stable/;补丁生成是纯字符串变换,零模型参与。
"""

from __future__ import annotations

import difflib
import hashlib
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


def sha256_text(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


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
    return {
        "change_required": True,
        "target": "stable/retry_policy.py",
        "target_component": "retry_and_circuit_breaker_control",
        "source_case_ids": source_ids,
        "patterns": patterns,
        "reason": "重试/熔断控制无视 retryable=false,根因在控制代码,不在 prompt。",
    }


def _replace_once(source: str, old: str, new: str) -> str:
    """整块替换,且要求 old 在源码里恰好出现一次——匹配不上或匹配多次都报错。"""
    if source.count(old) != 1:
        raise ValueError("Candidate patch no longer matches exactly one stable-code region")
    return source.replace(old, new, 1)


def candidate_from_source(stable_source: str, candidate_source: str) -> Dict[str, Any]:
    """把候选源码打包成可审查对象:源码 + 相对稳定版的统一 diff。
    (patch_size/impact_prediction 等打包元数据到阶段 8 manifest 再补)"""
    diff = "".join(difflib.unified_diff(
        stable_source.splitlines(keepends=True),
        candidate_source.splitlines(keepends=True),
        fromfile="stable/retry_policy.py",
        tofile="candidate/retry_policy.py",
    ))
    return {
        "source": candidate_source,
        "diff": diff,
        "changed": candidate_source != stable_source,
        "source_sha256": sha256_text(candidate_source),
    }


def generate_candidate(stable_source: str, diagnosis: Dict[str, Any]) -> Dict[str, Any]:
    """从稳定源码做最小 diff 生成候选;不需要改时原样返回(changed=False)。"""
    if not diagnosis.get("change_required"):
        return candidate_from_source(stable_source, stable_source)
    candidate = _replace_once(stable_source, OLD_CODES, NEW_CODES)
    candidate = _replace_once(candidate, OLD_RETRY, NEW_RETRY)
    candidate = _replace_once(candidate, OLD_BREAKER, NEW_BREAKER)
    candidate = candidate.replace('VERSION = "1.0.0"', 'VERSION = "1.1.0-candidate"', 1)
    return candidate_from_source(stable_source, candidate)


def write_candidate(candidate_source: str, path: Path) -> Path:
    """候选只写进自己的目录,物理上碰不到 stable/。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(candidate_source, encoding="utf-8")
    return path

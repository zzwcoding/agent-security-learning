"""确定性编排:轨迹 → 修改请求 → 提案 → 验证 → 发布决定(逐阶段生长)。

阶段 2:diagnose() 把失败轨迹聚合成"修改请求"。
两条纪律:同一失败模式 ≥2 条轨迹支持才立案(防单次意外触发自我修改);
根因定位到哪个文件是确定性代码给的结论,不交给模型猜。
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Dict, Iterable


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

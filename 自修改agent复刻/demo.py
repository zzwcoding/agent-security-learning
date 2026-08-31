"""实验 9-6 复刻:由失败轨迹触发的 Agent 自我修改。

阶段 2:轨迹聚合 → 修改请求。同一失败模式要 ≥2 条轨迹支持才立案,
单条意外不足以触发自我修改;根因(改哪个文件)由确定性代码给出。
"""

from __future__ import annotations

import json
from pathlib import Path

from evolution import diagnose

ROOT = Path(__file__).parent


def load_trajectories() -> list[dict]:
    """失败轨迹 = 生产环境一次任务里工具调用的出错记录,一条一个 JSON 对象。"""
    return json.loads((ROOT / "failure_trajectories.json").read_text(encoding="utf-8"))


def main() -> None:
    trajectories = load_trajectories()
    diagnosis = diagnose(trajectories)

    # 入案门槛是硬性的:retryable=true / 非失败 / 没重试的轨迹连分组都进不去
    entered = {cid for p in diagnosis.get("patterns", []) for cid in p["source_case_ids"]}
    skipped = [t["id"] for t in trajectories if t["id"] not in entered]
    print(f"读到 {len(trajectories)} 条轨迹,进入聚合的分组判决:\n")
    for p in diagnosis.get("patterns", []):
        print(f"  模式 {p['cluster_id']} — {p['cross_trajectory_support']} 条轨迹支持,"
              f"冗余重试 {p['total_redundant_calls']} 次 → ✅ 成案")
    print(f"  被门槛排除:{', '.join(skipped) or '无'}(正常重试,不该立案)\n")

    if not diagnosis["change_required"]:
        print("没有足够支持的失败模式,不改代码。")
        return
    print(f"修改请求:根因={diagnosis['target']}({diagnosis['target_component']})")
    print(f"证据轨迹:{', '.join(diagnosis['source_case_ids'])}")
    print(f"理由:{diagnosis['reason']}")
    print("\n✅ 阶段 2 跑通:散轨迹立成『修改请求』。下一步据此生成候选补丁。")


if __name__ == "__main__":
    main()

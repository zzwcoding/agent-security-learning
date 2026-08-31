"""实验 9-6 复刻:由失败轨迹触发的 Agent 自我修改。

阶段 3:确定性提案。立案后从稳定源码做最小 diff 生成候选补丁,
写入 output/candidate/(与 stable/ 物理隔离),并当场验证 stable 一字未动。
"""

from __future__ import annotations

import json
from pathlib import Path

from evolution import diagnose, generate_candidate, write_candidate

ROOT = Path(__file__).parent


def load_trajectories() -> list[dict]:
    """失败轨迹 = 生产环境一次任务里工具调用的出错记录,一条一个 JSON 对象。"""
    return json.loads((ROOT / "failure_trajectories.json").read_text(encoding="utf-8"))


def main() -> None:
    trajectories = load_trajectories()
    diagnosis = diagnose(trajectories)
    stable_path = ROOT / "stable" / "retry_policy.py"
    stable_source = stable_path.read_text(encoding="utf-8")

    if not diagnosis["change_required"]:
        print("没有足够支持的失败模式,不改代码。")
        return
    print("修改请求:根因=", diagnosis["target"], f"({diagnosis['target_component']})", sep="")
    print(f"证据轨迹:{', '.join(diagnosis['source_case_ids'])}\n")

    candidate = generate_candidate(stable_source, diagnosis)
    out_path = write_candidate(candidate["source"], ROOT / "output" / "candidate" / "retry_policy.py")

    # 物理隔离的现场证据:候选在 output/candidate/,stable 原样读回逐字节比对
    print(f"候选已写入 {out_path.relative_to(ROOT)},stable 未被改动:"
          f"{stable_path.read_text(encoding='utf-8') == stable_source}\n")
    print(f"候选 diff(新增 {candidate['source_sha256'][:12]}):")
    print(candidate["diff"])
    print("✅ 阶段 3 跑通:候选补丁落地,与稳定版物理隔离。下一步给它过静态安检。")


if __name__ == "__main__":
    main()

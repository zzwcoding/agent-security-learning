"""实验 9-6 复刻:由失败轨迹触发的 Agent 自我修改。

阶段 1 骨架:把生产失败轨迹读进来,让"病"能被看见——
看 stable/retry_policy.py 的两个 bug 怎么在真实轨迹里发作。
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).parent


def load_trajectories() -> list[dict]:
    """失败轨迹 = 生产环境一次任务里工具调用的出错记录,一条一个 JSON 对象。"""
    return json.loads((ROOT / "failure_trajectories.json").read_text(encoding="utf-8"))


def main() -> None:
    trajectories = load_trajectories()
    print(f"读到 {len(trajectories)} 条生产失败轨迹:\n")
    for t in trajectories:
        retries = t["attempts"] - 1  # 第一次是正常调用,之后才算重试
        flag = "  ←← 不该重试却在重试!" if not t["retryable"] and retries > 0 else ""
        print(f"  [{t['id']}] {t['tool']} 错误={t['error_code']} retryable={t['retryable']} "
              f"共尝试 {t['attempts']} 次(重试 {retries} 次){flag}")

    bad = [t for t in trajectories if not t["retryable"] and t["attempts"] > 1]
    print(f"\n病灶:retryable=false 的错误仍被重试,{len(bad)} 条轨迹实锤"
          f"(最多的重试了 {max(t['attempts'] for t in bad) - 1} 次)。")
    print("根因不在 prompt,在 stable/retry_policy.py:should_retry 只看次数不看 retryable 标志。")
    print("\n✅ 阶段 1 跑通:失败轨迹读进来了,病看得见了。下一步把它聚合成『修改请求』。")


if __name__ == "__main__":
    main()

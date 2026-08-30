#!/usr/bin/env python3
"""对比脚本自检 vs 子 agent 评审的一致率。

输入:
  --script <dir>            # 跑 check_cards.py 的目录
  --agent <file>            # 子 agent 评审输出 (JSON or 行式)
  --samples <f1,f2,...>     # 要对比的文件列表

输出:
  - 每个文件: 脚本违规数 / agent 违规数 / 重合数 / 一致率
  - 总体一致率
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

CHECK_CARDS = Path(__file__).parent / "check_cards.py"


def run_script_on_file(path: Path) -> list[dict]:
    """跑 check_cards.py 单文件, 返回 [{label, snippet}, ...]"""
    out = subprocess.run(
        ["python3", str(CHECK_CARDS), str(path)],
        capture_output=True, text=True, timeout=30,
    )
    violations = []
    for line in out.stdout.splitlines():
        # 格式: "  - [C? xxx] snippet..."
        m = re.match(r"\s*-\s*\[(C\d+)[^]]*\]\s*(.*)", line)
        if m:
            violations.append({
                "label": m.group(1),
                "snippet": m.group(2).strip()[:80],
                "raw": line.strip(),
            })
    return violations


def parse_agent_review(text: str) -> dict[str, list[dict]]:
    """解析子 agent 评审输出 (markdown 表格 / 行式)。

    期望格式 (每文件一段):
      ## 0009-直接注入.cards.md
      - [C2] 单句 73 字
      - [C5] 顿号聚集
    """
    by_file: dict[str, list[dict]] = {}
    current_file = None
    for line in text.splitlines():
        m = re.match(r"^##\s+(\S+\.cards\.md)", line)
        if m:
            current_file = m.group(1)
            by_file.setdefault(current_file, [])
            continue
        if not current_file:
            continue
        m = re.match(r"\s*-\s*\[(C\d+)[^]]*\]\s*(.*)", line)
        if m:
            by_file[current_file].append({
                "label": m.group(1),
                "snippet": m.group(2).strip()[:80],
            })
    return by_file


def agreement(s_violations: list[dict], a_violations: list[dict]) -> dict:
    """计算一致率: 同 label 且 snippet 前 20 字有重叠。"""
    def key(v):
        return (v["label"], v["snippet"][:20])

    s_keys = {key(v) for v in s_violations}
    a_keys = {key(v) for v in a_violations}
    overlap = s_keys & a_keys
    s_only = s_keys - a_keys
    a_only = a_keys - s_keys
    union = s_keys | a_keys
    rate = len(overlap) / len(union) if union else 1.0
    return {
        "script_only": len(s_only),
        "agent_only": len(a_only),
        "both": len(overlap),
        "union": len(union),
        "agreement_rate": round(rate, 3),
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--script-dir", required=True)
    p.add_argument("--agent-review", required=True, help="子 agent 评审文件 (md)")
    p.add_argument("--samples", required=True, help="逗号分隔的文件名")
    args = p.parse_args()

    samples = [s.strip() for s in args.samples.split(",")]
    agent_data = parse_agent_review(Path(args.agent_review).read_text(encoding="utf-8"))

    report = []
    for fname in samples:
        fpath = Path(args.script_dir) / fname
        if not fpath.exists():
            report.append({"file": fname, "error": "not found"})
            continue
        s_v = run_script_on_file(fpath)
        a_v = agent_data.get(fname, [])
        r = agreement(s_v, a_v)
        r["file"] = fname
        r["script_n"] = len(s_v)
        r["agent_n"] = len(a_v)
        report.append(r)

    print(json.dumps(report, ensure_ascii=False, indent=2))

    # 总体
    total_union = sum(r.get("union", 0) for r in report)
    total_both = sum(r.get("both", 0) for r in report)
    if total_union:
        print(f"\n总体一致率: {round(total_both/total_union, 3)} ({total_both}/{total_union})")


if __name__ == "__main__":
    main()

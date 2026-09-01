#!/usr/bin/env python3
"""证据链验证器(阶段 41):重算整条哈希链,任何篡改/删除/重排都会在这里现形。

用法:
  python3 scripts/verify-evidence-chain.py            # 验证,输出每条状态
  python3 scripts/verify-evidence-chain.py --quiet    # 只输出结论
退出码:0=链完整,1=链被破坏(附第一条断点)。
"""
import hashlib
import json
import sys
from pathlib import Path

CHAIN = Path(__file__).parent.parent / "evidence-chain.jsonl"


def main() -> int:
    if not CHAIN.exists() or not CHAIN.stat().st_size:
        print("证据链不存在或为空:没有可验证的记录")
        return 0
    quiet = "--quiet" in sys.argv
    prev, broken_at, total = "", None, 0
    with open(CHAIN, encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            total += 1
            entry = json.loads(line)
            expected_input = {k: v for k, v in entry.items() if k != "entry_hash"}
            canonical = json.dumps(expected_input, ensure_ascii=False, sort_keys=True)
            recomputed = hashlib.sha256((prev + canonical).encode()).hexdigest()
            # prev_hash 也要对上(防删除/重排:删中间一条,后一条的 prev_hash 就对不上)
            if entry.get("prev_hash") != prev or recomputed != entry.get("entry_hash"):
                broken_at = (i, entry.get("seq_tool", "?"))
                break
            prev = entry["entry_hash"]
            if not quiet:
                print(f"  ✓ 第{i:>3} 条 {entry.get('seq_tool','?'):24} {entry['entry_hash'][:16]}…")
    if broken_at:
        print(f"🛑 证据链已被破坏:第 {broken_at[0]} 条({broken_at[1]})起验证失败(共 {total} 条)")
        return 1
    print(f"✅ 证据链完整:{total} 条全部验证通过(append-only 未被改动)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

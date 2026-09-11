#!/usr/bin/env python3
"""教学文章行号机检：校验每个带 📄 标签的引用块与源文件对应行逐字一致。

用法: python3 .scratch/lesson-lint.py soc-demo/lessons/scenario/4-1.md [more.md ...]
在仓库根 /Users/divh/Downloads/安全评估agent 下运行。

规则:
  - 标签行: 📄 [services/x/y.ts:起-止](soc-demo/services/x/y.ts#L起)
  - 标签与下一个围栏块之间不得插入其他围栏; 空行/正文可隔
  - 块行数必须 == 止-起+1; 内容逐行 strip 行尾空白后与源文件比对
  - 指针越界(止 > 源文件总行数)报错
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LABEL = re.compile(r"📄\s*\[([^\]\s]+):(\d+)-(\d+)\]\(([^)]+)\)")


def check(md_path: Path) -> int:
    text = md_path.read_text(encoding="utf-8")
    lines = text.splitlines()
    problems = []
    pending_label = None  # (rel_path_for_link, start, end, lineno_in_md)

    i = 0
    while i < len(lines):
        line = lines[i]
        m = LABEL.search(line)
        if m:
            src_rel = m.group(4).split("#")[0]  # 链接路径去掉 #L 锚点，仓库根相对
            start, end = int(m.group(2)), int(m.group(3))
            pending_label = (src_rel, start, end, i + 1)
            i += 1
            continue

        if line.startswith("```"):
            lang = line[3:].strip()
            if pending_label is None or lang == "":
                # 无标签的普通围栏(bash 命令/伪代码/预期输出) → 跳过整个块
                i += 1
                while i < len(lines) and not lines[i].startswith("```"):
                    i += 1
                i += 1
                continue

            src_rel, start, end, label_line = pending_label
            pending_label = None
            block = []
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                block.append(lines[i])
                i += 1
            i += 1  # 越过收尾围栏

            src = ROOT / src_rel
            if not src.exists():
                problems.append(f"L{label_line}: 源文件不存在 {src_rel}")
                continue
            src_lines = src.read_text(encoding="utf-8").splitlines()
            if end > len(src_lines):
                problems.append(
                    f"L{label_line}: 指针越界 {src_rel}:{start}-{end} 但文件只有 {len(src_lines)} 行"
                )
                continue
            if len(block) != end - start + 1:
                problems.append(
                    f"L{label_line}: 行数不符 {src_rel}:{start}-{end} 应 {end-start+1} 行, 块 {len(block)} 行"
                )
                continue
            for off, (blk, s) in enumerate(zip(block, src_lines[start - 1 : end])):
                if blk.rstrip() != s.rstrip():
                    problems.append(
                        f"L{label_line}: {src_rel}:{start+off} 不一致\n  文章: {blk!r}\n  源码: {s!r}"
                    )
        else:
            i += 1

    if pending_label is not None:
        problems.append(f"L{pending_label[3]}: 标签悬空(后面没有围栏块) {pending_label[0]}")

    print(f"== {md_path} ==")
    if problems:
        for p in problems:
            print("  ✗", p)
        print(f"  {len(problems)} 处问题")
        return len(problems)
    print("  逐字一致 ✓")
    return 0


def main() -> None:
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(2)
    total = 0
    for a in args:
        total += check(Path(a))
    sys.exit(1 if total else 0)


if __name__ == "__main__":
    main()

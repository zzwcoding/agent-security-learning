#!/usr/bin/env python3
"""weknora复刻 边界闸：把 specs/modules.md「边界规则」节的禁令机器化。

规则唯一事实来源 = specs/modules.md 的模块卡（`目录:` 字段）与 `## 边界规则` 节。
默认规则（深模块纪律）：模块目录外的代码只允许 import 该模块包的公开接口
（包根 `__init__.py` 暴露面），不许直引内部子模块。

当前状态：阶段 0 占位——模块划分（阶段 2）尚未产出，规则表为空表，闸恒绿但入口已在 CI。
阶段 2 落模块卡后本闸自动生效；例外必须写进「边界规则」节并带理由（check_specs.py 校验）。

用法：python3 tools/check_boundaries.py [root]
"""
import re
import sys
from pathlib import Path

H2 = re.compile(r"^##\s+(.+?)\s*$")
DIR_FIELD = re.compile(r"^目录[:：]\s*(\S+)", re.MULTILINE)
IMPORT_RE = re.compile(r"^\s*(?:from|import)\s+([a-zA-Z_][\w.]*)", re.MULTILINE)
SKIP_DIRS = {".venv", "__pycache__", ".git", ".scratch", "tools", "tests"}


def parse_module_dirs(root: Path) -> dict[str, str]:
    """{模块名: 目录}；modules.md 不存在返回空表。"""
    path = root / "specs" / "modules.md"
    if not path.exists():
        return {}
    mods = {}
    text = path.read_text(encoding="utf-8")
    title = None
    body_lines: list[str] = []

    def flush():
        if title:
            m = DIR_FIELD.search("\n".join(body_lines))
            if m:
                mods[title] = m.group(1).strip("` ")

    for line in text.splitlines():
        h = H2.match(line)
        if h:
            flush()
            title = h.group(1).strip()
            body_lines = []
        else:
            body_lines.append(line)
    flush()
    return mods


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    mods = parse_module_dirs(root)
    if not mods:
        print("boundary gate: PASS（无模块卡，空表恒绿——机制先于业务代码存在）")
        return 0

    # 包名 → 模块目录（目录 basename 即 import 包名）
    pkg_to_dir = {Path(d).name: d for d in mods.values()}
    violations = []
    for py in sorted(root.rglob("*.py")):
        rel = py.relative_to(root)
        if any(part in SKIP_DIRS for part in rel.parts):
            continue
        owner = next((d for d in mods.values() if str(rel).startswith(d.rstrip("/") + "/")), None)
        for imp in IMPORT_RE.findall(py.read_text(encoding="utf-8", errors="ignore")):
            top, _, rest = imp.partition(".")
            if not rest or top not in pkg_to_dir:
                continue  # import 包根本身 = 走公开接口，合法
            target_dir = pkg_to_dir[top]
            if owner != target_dir:
                violations.append(f"{rel}: 直引 `{imp}`（{top} 的内部子模块），只能走 {target_dir} 的公开接口")

    for v in violations:
        print(f"FAIL  {v}")
    if violations:
        print(f"\nboundary gate: {len(violations)} 处越界（例外须进 modules.md「边界规则」节并带理由）")
        return 1
    print(f"boundary gate: PASS（{len(mods)} 个模块卡已声明）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

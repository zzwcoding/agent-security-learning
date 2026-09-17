#!/usr/bin/env python3
"""lockfile 完整性哈希体检闸（2026-09-17，「JD→目标场景」脱敏误伤事故的机器闸）。

背景：一次全仓文本替换把 pnpm-lock.yaml 12 条 / package-lock.json 1 条 integrity 哈希里的
"JD" 换成了中文，ssri 解不出 digest，容器内 pnpm install 报出误导性的
ERR_PNPM_TARBALL_EXTRACT（object null is not iterable），且被 Docker 层缓存掩盖多日。
本闸在任何安装层之前几十秒内把这类污染点名：扫描仓内全部 pnpm-lock.yaml / package-lock.json，
对每一条 integrity 断言——
  ① 所在行纯 ASCII（lockfile 机器行混进中文 = 文本替换事故的直接铁证）；
  ② 形态 = <algo>-<base64>，algo ∈ sha1/sha384/sha512；
  ③ base64 严格可解码（[A-Za-z0-9+/]，validate=True）；
  ④ 解码字节数 = 算法摘要长（sha1=20 / sha384=48 / sha512=64）。

用法：python3 tools/check_lockfiles.py [文件...]（无参 = 扫全仓；--self-test = 夹具自证红绿）
CI 接线：spec-gate job 首步 --self-test（闸的侦测能力本身被测试）后全仓体检。
零依赖，stdlib only。
"""
import base64
import re
import sys
import tempfile
from pathlib import Path

ALGO_LEN = {"sha1": 20, "sha384": 48, "sha512": 64}
# pnpm-lock（integrity: sha512-xxx==）与 package-lock（"integrity": "sha512-xxx=="）同式捕获
INTEGRITY_RE = re.compile(r'"?integrity"?\s*[:=]\s*"?([A-Za-z0-9+/]+=-[A-Za-z0-9+/=]*|[A-Za-z0-9+/]+-[A-Za-z0-9+/=]+)"?')
B64_RE = re.compile(r"[A-Za-z0-9+/]+={0,2}")
LOCKFILE_NAMES = ("pnpm-lock.yaml", "package-lock.json")


def check_line(path: Path, lineno: int, line: str):
    """一条 lockfile 行的体检 → 问题清单（空 = 干净）。"""
    problems = []
    for m in INTEGRITY_RE.finditer(line):
        raw = m.group(1)
        algo, _, b64 = raw.partition("-")
        if any(ch > "\x7f" for ch in line):
            problems.append(f"{path}:{lineno} integrity 行含非 ASCII 字符（文本替换事故铁证）\n    {line.strip()[:100]}")
            return problems  # 非 ASCII 已是死刑,不必再验形态
        if algo not in ALGO_LEN:
            problems.append(f"{path}:{lineno} 未知摘要算法 {algo!r}")
            continue
        if not B64_RE.fullmatch(b64):
            problems.append(f"{path}:{lineno} base64 段含非法字符\n    {raw[:80]}")
            continue
        try:
            n = len(base64.b64decode(b64, validate=True))
        except Exception:
            problems.append(f"{path}:{lineno} base64 严格解码失败\n    {raw[:80]}")
            continue
        if n != ALGO_LEN[algo]:
            problems.append(f"{path}:{lineno} 解码长 {n}B ≠ {algo} 应为 {ALGO_LEN[algo]}B（截断/篡改）\n    {raw[:80]}")
    return problems


def check_file(path: Path):
    problems = []
    text = path.read_text(encoding="utf-8")
    hit = False
    for lineno, line in enumerate(text.splitlines(), 1):
        if "integrity" not in line:
            continue
        hit = True
        problems += check_line(path, lineno, line)
    if not hit:
        problems.append(f"{path}: 未找到任何 integrity 行——这真是 lockfile 吗？")
    return problems


def scan_roots(root: Path):
    out = []
    for name in LOCKFILE_NAMES:
        for p in sorted(root.rglob(name)):
            if "node_modules" in p.parts:
                continue
            out.append(p)
    return out


def self_test():
    """闸的侦测能力自证：好夹具必须绿、三种坏夹具（非 ASCII/坏 base64/错长）必须红。"""
    good = '    resolution: {integrity: sha512-6f813C0IsasTZms08kfA8kPAGxbbkYToa8ALaiDIGGECU4i9hj8Plgbx0sNJDrey3EtHO30hmdaxtT0138xZcg==}\n'
    cases = [
        ("好夹具", good, 0),
        ("非 ASCII 污染（本次事故实样）", '    resolution: {integrity: sha512-6f813C0IsasTZms08kfA8kPAGxbbkYToa8ALaiDIGGECU4i9hj8Plgbx0sN目标场景rey3EtHO30hmdaxtT0138xZcg==}\n', 1),
        ("base64 坏字符", '    resolution: {integrity: sha512-6f81!C0IsasTZms08kfA8kPAGxbbkYToa8ALaiDIGGECU4i9hj8Plgbx0sNJDrey3EtHO30hmdaxtT0138xZcg==}\n', 1),
        ("长度不对（截断）", '    resolution: {integrity: sha512-6f813C0IsasTZms08kfA8kPAGxbbkYToa8ALaiDIGGECU4i9hj8Plgbx0sNJDrey3EtHO30hmdaxtT0138xZc=}\n', 1),
    ]
    bad = 0
    with tempfile.TemporaryDirectory() as td:
        for i, (name, line, want) in enumerate(cases):
            f = Path(td) / f"pnpm-lock-{i}.yaml"
            f.write_text(line, encoding="utf-8")
            got = len(check_file(f))
            ok = got == want
            bad += 0 if ok else 1
            print(f"  self-test[{i}] {name}: {'PASS' if ok else 'FAIL'}（问题数 {got}，期望 {want}）")
    return bad


def main(argv):
    if "--self-test" in argv:
        print("lockfile integrity 体检闸 · 自证：")
        return 1 if self_test() else 0
    root = Path(__file__).resolve().parent.parent
    files = [Path(a) for a in argv] if argv else scan_roots(root)
    if not files:
        print("FAIL: 仓内一份 lockfile 都没扫到")
        return 1
    problems = []
    for f in files:
        problems += check_file(f)
    print(f"lockfile integrity 体检: 扫描 {len(files)} 份")
    if problems:
        print(f"FAIL: {len(problems)} 条非法 integrity：")
        print("\n".join(problems))
        return 1
    print("PASS: 全部 integrity 纯 ASCII/形态/长度合法")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

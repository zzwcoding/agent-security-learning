#!/usr/bin/env python3
"""零增量断言闸（票 80 · spec T20）：specs/orchestration-loop.md 验收表 T20 行的机器半边。

断言「指定 git diff 范围内的变更文件集合」与「机制层领地」**交集为空**——这是
「一套循环五块业务」主张的验收实验：第二个业务（应急取证，票 80）落地时若需要改
任何机制代码，即证明循环抽象错了——**不是本票返工，是阶段 B 回炉**（回 L0 裁决）。
脚本可复用：未来的内容层票（第 3..N 个业务）同款检查，一个循环一套闸。

机制层领地（票面钦定，缺省档）：
  - services/agent/src/orchestration/      m14 机制目录（planner/judge/gap/轮次链/
                                           票务测试/预算双闸实现全在此，R10 领地）
  - services/agent/src/budget.ts           预算簿记本体（m14 卡公开件）
  - services/agent/src/token-ports.ts      m9 铸票客户端接口（票务·铸票半边，R11）
  - services/agent/src/jiaotu/token-ports-jiaotu.ts  椒图铸票客户端（票务）
  - services/agent/src/verify-ticket.ts    验票闸（票务·验证半边）

零依赖（python3 标准库 + git CLI 只读命令），本地/CI 同一条命令（对齐 check_boundary.py
的参数/输出/退出码惯例）。变更集合 = 基线到工作树的全部 tracked 变更（含已提交/暂存/
未暂存/删除，--no-renames 展开改名两侧）+ 未跟踪新件（git 看不见的新文件也是增量）。

用法：
    python3 tools/check_zero_increment.py                 # 工作树 diff（HEAD 起）+ 未跟踪件
    python3 tools/check_zero_increment.py --base main     # 指定基线（CI：merge-base 起算）
    python3 tools/check_zero_increment.py --self-test     # 喂违规样本必红 / 干净样本必绿

退出码：0 = 交集为空（绿）；1 = 交集非空，或 git 不可用/基线不可解析（查不了 = 不过，
fail-closed）。CI 挂父仓库 ci.yml 的 ts job（与 check_boundary 同槽位）：
    python3 tools/check_zero_increment.py --base "$(git merge-base origin/main HEAD)"
"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# 机制层领地（以 "/" 结尾 = 目录前缀匹配；否则 = 精确文件路径匹配）。
# 领地扩充走 specs/modules.md m14/m9 卡对账，不在这里悄悄加——这里是闸，不是事实来源。
PROTECTED = [
    "services/agent/src/orchestration/",
    "services/agent/src/budget.ts",
    "services/agent/src/token-ports.ts",
    "services/agent/src/jiaotu/token-ports-jiaotu.ts",
    "services/agent/src/verify-ticket.ts",
]


def violations(changed, protected=PROTECTED):
    """变更文件集 × 领地 → [(文件, 领地条目)]（交集；空 = 绿）。

    目录前缀按路径段匹配：`orchestration/` 不吃 `orchestration-evil/`（前缀比较
    带分隔符，防同前缀兄弟目录的假阳性/假阴性）。"""
    out = []
    for f in sorted(set(changed)):
        hit = None
        for p in protected:
            if (p.endswith("/") and (f.startswith(p) or f + "/" == p)) or f == p:
                hit = p
                break
        if hit:
            out.append((f, hit))
    return out


def _git(root, *args):
    """git 只读子命令封装；失败抛 RuntimeError（fail-closed：查不了 = 不过）。"""
    r = subprocess.run(["git", "-C", str(root), *args], capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(
            (r.stderr.decode("utf-8", "ignore").strip() or f"git {' '.join(args)} 退出码 {r.returncode}")
        )
    return r.stdout


def changed_files(root, base):
    """基线 → 工作树的变更文件集（相对 root 的 posix 路径），含未跟踪新件。

    root 可以是仓内子目录（soc-demo 挂在父仓库下的形态）：git 输出相对仓顶，
    这里剥掉 root 相对仓顶的前缀，调用方拿到的恒是 root 相对路径。"""
    toplevel = _git(root, "rev-parse", "--show-toplevel").decode("utf-8", "ignore").strip()
    prefix = ""
    root_abs = str(Path(root).resolve())
    if root_abs != toplevel:
        prefix = os.path.relpath(root_abs, toplevel).replace(os.sep, "/") + "/"

    def rel(path):
        return path[len(prefix):] if prefix and path.startswith(prefix) else path

    names = _git(root, "diff", "--name-only", "--no-renames", "-z", base).split(b"\0")
    names += _git(root, "ls-files", "--others", "--exclude-standard", "-z").split(b"\0")
    return {rel(n.decode("utf-8", "ignore")) for n in names if n}


def run_gate(root, base="HEAD", protected=None):
    """跑零增量断言 → [(文件, 领地)]；git 侧任何失败原样上抛（fail-closed）。"""
    return violations(changed_files(root, base), protected if protected is not None else PROTECTED)


# ---------- 自测：纯逻辑样本必红必绿 + 临时 git 仓端到端（TDD 先行） ----------

def _samples_violations():
    """① 纯交集逻辑：机制层文件必红，内容层/中立层/数据文件必绿。"""
    results = []

    def check(name, cond, detail=""):
        results.append(cond)
        print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  [{detail}]" if detail and not cond else ""))

    bad = [
        "services/agent/src/orchestration/flow.ts",        # m14 机制目录（planner/judge/gap 同目录）
        "services/agent/src/orchestration/planner.test.ts",  # 机制层测试件也算增量（票面：目录零触碰）
        "services/agent/src/budget.ts",                    # 预算本体
        "services/agent/src/token-ports.ts",               # 票务·铸票
        "services/agent/src/jiaotu/token-ports-jiaotu.ts",  # 票务·椒图铸票
        "services/agent/src/verify-ticket.ts",             # 票务·验票闸
    ]
    got = dict(violations(bad))
    for f in bad:
        check(f"红样本必抓 {f}", f in got)

    clean = [
        "fixtures/hunt-templates/ir_host_compromise.json",  # 模板数据（内容层钦点位）
        "fixtures/weknora/playbooks.json",                  # 剧本库语料补条
        "services/agent/workers/investigation/ir-template.test.ts",  # m5 领地测试（内容层）
        "services/agent/workers/investigation/hunt-pack.ts",  # m5 领地 prompt/fake 件
        "evals/src/rigs/hunting.ts",                        # eval 布景
        "tools/check_zero_increment.py",                    # 中立层脚本自身
        ".scratch/tickets/issues/80-ir-playbook-template.md",  # 票据
    ]
    got = violations(clean)
    check("干净样本 0 报", got == [], f"实得={got}")
    # 领地外的同前缀兄弟目录不吃（前缀比较带分隔符）
    got = violations(["services/agent/src/orchestration-evil/foo.ts",
                      "services/agent/src/budget.ts.bak",
                      "services/agent/src/token-ports.ts.orig"])
    check("同前缀兄弟/备份后缀不吃", got == [], f"实得={got}")
    # 未跟踪件与重复条目去重
    got = violations(["services/agent/src/orchestration/flow.ts", "services/agent/src/orchestration/flow.ts"])
    check("重复条目去重后仍必抓", len(got) == 1, f"实得={got}")
    return results


def _repo_e2e():
    """② 临时 git 仓端到端：真 git 管路（基线 diff / 未跟踪件 / 子目录前缀剥离）。"""
    import shutil

    results = []
    git = shutil.which("git")
    if not git:
        print("SKIP  临时仓端到端（环境无 git CLI）")
        return results

    def check(name, cond, detail=""):
        results.append(cond)
        print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  [{detail}]" if detail and not cond else ""))

    def run(*args, cwd):
        return subprocess.run([git, "-C", cwd, *args], capture_output=True)

    with tempfile.TemporaryDirectory() as td:
        repo = Path(td) / "parent"
        demo = repo / "soc-demo"
        (demo / "services/agent/src/orchestration").mkdir(parents=True)
        (demo / "fixtures").mkdir(parents=True)
        assert run("init", "-q", cwd=repo).returncode == 0
        run("config", "user.email", "t@t", cwd=repo)
        run("config", "user.name", "t", cwd=repo)
        # 基线：干净树（机制层 1 件 + 内容层 1 件全部提交）
        (demo / "services/agent/src/orchestration/flow.ts").write_text("export const a = 1;\n", encoding="utf-8")
        (demo / "fixtures/base.json").write_text("{}\n", encoding="utf-8")
        assert run("add", "-A", cwd=repo).returncode == 0
        assert run("commit", "-qm", "base", cwd=repo).returncode == 0

        # 干净态：内容层新增（含未跟踪件）→ 绿
        (demo / "fixtures/new.json").write_text("{}\n", encoding="utf-8")
        (demo / "services/agent/workers").mkdir(parents=True, exist_ok=True)
        (demo / "services/agent/workers/new.ts").write_text("export const b = 2;\n", encoding="utf-8")
        got = run_gate(demo, "HEAD")
        check("临时仓：内容层增量（含未跟踪）必绿", got == [], f"实得={got}")

        # 违规态 1：未提交的机制层修改 → 红
        p = demo / "services/agent/src/orchestration/flow.ts"
        p.write_text("export const a = 2;\n", encoding="utf-8")
        got = run_gate(demo, "HEAD")
        check("临时仓：机制层未提交修改必红", got == [("services/agent/src/orchestration/flow.ts",
                                                       "services/agent/src/orchestration/")], f"实得={got}")
        p.write_text("export const a = 1;\n", encoding="utf-8")

        # 违规态 2：已提交的机制层新增 + --base 基线起算 → 红（路径前缀按子目录 root 剥离）
        (demo / "services/agent/src/orchestration/extra.ts").write_text("export const c = 3;\n", encoding="utf-8")
        assert run("add", "-A", cwd=repo).returncode == 0
        assert run("commit", "-qm", "touch mechanism", cwd=repo).returncode == 0
        got = run_gate(demo, "HEAD~1")
        check("临时仓：--base 已提交机制层增量必红（子目录前缀剥离）",
              got == [("services/agent/src/orchestration/extra.ts", "services/agent/src/orchestration/")],
              f"实得={got}")

        # 删除也是增量：机制层文件被删 → 红
        (demo / "services/agent/src/orchestration/extra.ts").unlink()
        assert run("add", "-A", cwd=repo).returncode == 0
        assert run("commit", "-qm", "delete mechanism", cwd=repo).returncode == 0
        got = run_gate(demo, "HEAD~1")
        check("临时仓：机制层删除也算增量必红", len(got) == 1 and got[0][0].endswith("extra.ts"), f"实得={got}")

        # fail-closed：基线不可解析 → 上抛（调用方标 FAIL）
        try:
            run_gate(demo, "no-such-ref")
            check("临时仓：坏基线 fail-closed 必炸响", False, "未上抛")
        except RuntimeError:
            check("临时仓：坏基线 fail-closed 必炸响", True)
    return results


def self_test():
    results = _samples_violations() + _repo_e2e()
    n, total = sum(results), len(results)
    print(f"\nself-test: {n}/{total} 通过")
    return 0 if n == total and total > 0 else 1


def main():
    if "--self-test" in sys.argv:
        return self_test()
    root = Path(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith("--") \
        else Path(__file__).resolve().parent.parent
    root = root.resolve()
    base = "HEAD"
    protected = list(PROTECTED)
    args = sys.argv[1:]
    if "--base" in args:
        i = args.index("--base")
        if i + 1 >= len(args):
            print("FAIL  [--base] 缺基线参数")
            return 1
        base = args[i + 1]
    for i, a in enumerate(args):
        if a == "--protected" and i + 1 < len(args):
            protected.append(args[i + 1])

    try:
        changed = changed_files(root, base)
        findings = violations(changed, protected)
    except (RuntimeError, OSError) as e:
        print(f"FAIL  git 不可用或基线不可解析（fail-closed：查不了 = 不过）：{e}")
        print("\nzero-increment gate: FAIL（git 侧失败）")
        return 1

    for f, p in findings:
        print(f"VIOL  [T20] {f}  零增量违约：触碰机制层领地 {p}"
              f"（specs/orchestration-loop.md T20；循环抽象缺口 → 回 L0 裁决，非本票返工）")
    label = base if base != "HEAD" else "工作树（HEAD 起）"
    if findings:
        print(f"\nzero-increment gate: FAIL（{label}：diff {len(set(changed))} 文件，"
              f"{len(findings)} 个机制层文件被触碰）")
        return 1
    print(f"zero-increment gate: PASS（{label}：diff {len(set(changed))} 文件 × "
          f"机制层 {len(protected)} 条领地：交集 0）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

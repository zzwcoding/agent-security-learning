#!/usr/bin/env python3
"""边界闸（票 28）：specs/modules.md「## 边界规则」节的第二个消费者。

check_specs.py 只校验这一节的**格式**（节缺席 FAIL、无理由例外 FAIL）；
本闸把每条禁令对代码库**真跑 import 检查**——规则表是唯一事实来源：

- 表里每行禁令都必须有闸消费（缺行 → 表与闸失配 FAIL）；
- 闸里每个检查器都必须能在表里找到自己的行（删规则不删闸 → FAIL）；
- 豁免按「例外」列解析（无理由的例外 check_specs.py 已经拦了，这里只管执行）。

零依赖（python3 标准库），本地 `pnpm check:boundary`，CI 挂父仓库 ci.yml 的 ts job。
用法：
    python3 tools/check_boundary.py               # 对代码库真跑
    python3 tools/check_boundary.py --self-test   # 喂违规样本必红 / 豁免样本必绿
"""
import json
import os
import re
import sys
import tempfile
from pathlib import Path

# workspace 包根（相对 soc-demo/）；判向只认这些前缀
ROOTS = [
    "services/agent", "services/case-backend", "services/ingest", "services/web",
    "services/guards", "services/gateway", "packages/mcp-audit", "evals", "scripts", "tools",
]
SERVICES_TS = ["services/agent", "services/case-backend", "services/ingest", "services/web"]
WORKSPACES = ["services/agent", "services/case-backend", "services/ingest", "services/web",
              "packages/mcp-audit", "evals"]
# R8 依赖链方向：fixtures→ingest→case-backend→agent→{guards,gateway,...}
# （fixtures/chroma/openfga 无代码目录；代码级链条就这三级 + 两个 py 叶子）
CHAIN = {"services/ingest": 0, "services/case-backend": 1, "services/agent": 2,
         "services/guards": 3, "services/gateway": 3}

# 规则注册表：key 是「禁止」单元格里的稳定短语，一个 key 对应一个检查器
KEYS = [
    ("R1", "各 workspace 包互相 import"),
    ("R2", "引用 services 内部实现"),
    ("R3", "中立层 import services"),
    ("R4", "反引仓库级"),
    ("R5", "packages/mcp-audit"),
    ("R6", "services/web"),
    ("R7", "互不 import"),
    ("R8", "依赖方向单向"),
    ("R9", "healthz"),
    ("R10", "m14 机制目录"),
    ("R11", "自签/改面任务票"),
    ("R12", "审批内部"),
]

H2 = re.compile(r"^##\s+(.+?)\s*$")
ROW = re.compile(r"^\|(.+)\|\s*$")
SEP = re.compile(r":?-{2,}:?")
NO_EXC = {"—", "-", "（无）", "无", "none", "n/a"}
TICK = re.compile(r"`([^`]+)`")

# TS import 三种形态：from 导入（含 export...from 再导出）、副作用导入、动态导入
FROM_RE = re.compile(r"[ \t]*(?:import|export)\s+(type\s+)?[^;\"']*?from\s*[\"']([^\"']+)[\"']")
SIDE_RE = re.compile(r"[ \t]*import\s+[\"']([^\"']+)[\"']")
DYN_RE = re.compile(r"import\(\s*[\"']([^\"']+)[\"']\s*\)")
# py 侧：guards/gateway 互引、中立层反向 import
PY_PAIR_RE = re.compile(r"^\s*(?:from|import)\s+(guards|gateway)\b", re.M)
PY_IN_RE = re.compile(r"^\s*(?:from|import)\s+(services|evals|packages)\b", re.M)


def boundary_rows(root):
    """解析「## 边界规则」表 → [(禁止, 例外)]；节缺席返回 None。"""
    path = root / "specs" / "modules.md"
    if not path.exists():
        return None
    lines = path.read_text(encoding="utf-8").splitlines()
    for i, line in enumerate(lines):
        if line.strip() == "## 边界规则":
            j = i + 1
            # 跳过表前的空行与引语行（> …）；表行必须紧邻小节
            while j < len(lines) and (not lines[j].strip() or lines[j].lstrip().startswith(">")):
                j += 1
            rows = []
            while j < len(lines) and ROW.match(lines[j]):
                cells = [c.strip() for c in lines[j].strip().strip("|").split("|")]
                if not all(SEP.fullmatch(c) for c in cells):
                    rows.append((cells[0] if cells else "", cells[1] if len(cells) > 1 else ""))
                j += 1
            return rows[1:]  # 去表头
    return None


def parse_evals_exemption(cell):
    """R2「例外」列 → (豁免文件集, 禁触文件名集)。

    豁免写法：`evals/src/{runner,scenarios,judge,assertions}.ts`（花括号展开；组装件的
    .test.ts 伴侣文件与被测组装件同角色，一并豁免——suite.test.ts 单独点名即为先例）
    与 `suite.test.ts`（裸文件名按 evals/src/ 解）。禁触子句里的 `db.ts`/`store.ts`
    是绝对禁令，绝不进豁免集。
    """
    whitelist, bans = set(), set()
    for clause in cell.split("；"):
        clause = clause.strip()
        if "禁触" in clause:
            if "case-backend" in clause:
                bans.update(re.findall(r"`([^`]+\.ts)`", clause))
            continue
        for m in re.finditer(r"([\w./\-]*\{[^}]+\}\.ts)", clause):
            base, braces = m.group(1).split("{", 1)
            for stem in braces.rsplit("}", 1)[0].split(","):
                stem = base + stem.strip()
                whitelist.add(stem + ".ts")
                whitelist.add(stem + ".test.ts")
        for m in re.finditer(r"`([^`/\s]+\.ts)`", clause):
            whitelist.add("evals/src/" + m.group(1))
    return whitelist, bans


def workspace_names(root):
    names = {}
    for d in WORKSPACES:
        pj = root / d / "package.json"
        if pj.exists():
            try:
                names[json.loads(pj.read_text(encoding="utf-8")).get("name", "")] = d
            except (ValueError, OSError):
                pass
    return {k: v for k, v in names.items() if k}


def ts_files(root):
    out = []
    for base in ("services", "packages", "evals", "scripts"):
        bd = root / base
        if not bd.is_dir():
            continue
        for f in sorted(bd.rglob("*")):
            if f.suffix in {".ts", ".tsx", ".js", ".mjs"} and f.is_file() \
                    and "node_modules" not in f.parts:
                out.append(f)
    return out


def resolve_spec(spec, src_rel, names):
    """import 说明符 → 仓库内相对 posix 路径；仓库外/第三方返回 None。

    约定：纯 `import type` 是编译期契约（运行时模块边不存在，与 fixtures/tickets
    契约锁定同理由），不算「引用内部实现」——扫描层直接跳过。
    """
    if spec.startswith("."):
        s = os.path.normpath(os.path.join(os.path.dirname(src_rel), spec))
        if s.startswith(".."):
            return None
        for ext in (".js", ".mjs"):
            if s.endswith(ext):
                s = s[: -len(ext)] + ".ts"
        return s
    for name, d in names.items():
        if spec == name or spec.startswith(name + "/"):
            return d + spec[len(name):]
    return None


def root_of(rel):
    for r in sorted(ROOTS, key=len, reverse=True):
        if rel == r or rel.startswith(r + "/"):
            return r
    return None


def collect_edges(root, names):
    """扫 TS import → [(src_root, dst_rel, dst_root, 文件, 行, 说明符)]。"""
    edges = []
    for f in ts_files(root):
        src_rel = f.relative_to(root).as_posix()
        text = f.read_text(encoding="utf-8", errors="ignore")
        hits = []
        for m in FROM_RE.finditer(text):
            if m.group(1):  # 纯 type 导入：无运行时模块边
                continue
            hits.append((m.group(2), m.start()))
        hits += [(m.group(1), m.start()) for m in SIDE_RE.finditer(text)]
        hits += [(m.group(1), m.start()) for m in DYN_RE.finditer(text)]
        for spec, pos in hits:
            dst_rel = resolve_spec(spec, src_rel, names)
            dst_root = root_of(dst_rel) if dst_rel else None
            line = text.count("\n", 0, pos) + 1
            edges.append((root_of(src_rel), dst_rel, dst_root, src_rel, line, spec))
    return edges


def check_r1(edges, v):
    """services/* 各包互相 import 源码内部 → 跨服务只许走公开 REST/SSE 面。"""
    for src, dst_rel, dst, f, line, spec in edges:
        if src in SERVICES_TS and dst in SERVICES_TS and src != dst:
            v.append(("R1", f, line, f"跨服务 import 源码内部（{spec}）；跨服务只走公开 REST/SSE 面"))


def check_r2(edges, root, v):
    """evals 引用 services 内部实现 → 只许五个组装件（及 .test.ts 伴侣）；
    case-backend db.ts/store.ts 对任何 evals 文件都是绝对禁令。"""
    rows = boundary_rows(root) or []
    exc = next((c for 禁, c in rows if "引用 services 内部实现" in 禁), "")
    whitelist, bans = parse_evals_exemption(exc)
    for src, dst_rel, dst, f, line, spec in edges:
        if src != "evals" or not dst or not dst.startswith("services/"):
            continue
        base = os.path.basename(dst_rel or "")
        if dst == "services/case-backend" and base in bans:
            v.append(("R2", f, line, f"禁触 case-backend {base}（写路径绝对禁令；{spec}）"))
        elif f in whitelist:
            continue
        else:
            v.append(("R2", f, line, f"非豁免文件引用 services 内部（{spec}）；豁免=例外列组装入口清单"))


def check_r3(edges, root, v):
    """scripts/、tools/ 中立层 import services/evals/packages 内部（ts 边 + py 反向）。"""
    for src, dst_rel, dst, f, line, spec in edges:
        if src in ("scripts", "tools") and dst and (
                dst.startswith("services/") or dst in ("packages/mcp-audit", "evals")):
            v.append(("R3", f, line, f"中立层 import 工程内部（{spec}）；中立层保持可独立执行"))
    for base in ("scripts", "tools"):
        bd = root / base
        if not bd.is_dir():
            continue
        for f in sorted(bd.rglob("*.py")):
            for m in PY_IN_RE.finditer(f.read_text(encoding="utf-8", errors="ignore")):
                rel = f.relative_to(root).as_posix()
                line = f.read_text(encoding="utf-8", errors="ignore").count("\n", 0, m.start()) + 1
                v.append(("R3", rel, line, f"中立层 py import 工程内部（{m.group(1)}）"))


def check_r4(edges, v, exc_cell=""):
    """services/、evals/ 反引仓库级 scripts/ → replay 类走子进程（scripts 不在模块图内）。

    票 46：R2 只圈 services 向，evals 反引 scripts 曾落在 R2/R4 之间的盲区——检查器
    与规则表 R4 措辞同步扩到 evals（测试与 rig 同口径，replay 类走子进程）。
    豁免：例外列里的反引号精确文件路径（票 62 先例——跨仓契约锁需函数级注入），
    只豁免逐路径匹配的源文件，不许写成目录/通配。"""
    exempt = set(TICK.findall(exc_cell))
    for src, dst_rel, dst, f, line, spec in edges:
        if src and (src.startswith("services/") or src == "evals") and dst == "scripts":
            if f in exempt:
                continue
            v.append(("R4", f, line, f"反引 scripts/（{spec}）；replay 类改子进程执行"))


def check_r5(edges, v):
    """packages/mcp-audit import 任何 workspace 包 → 独立 CLI（m12 卡）。"""
    for src, dst_rel, dst, f, line, spec in edges:
        if src == "packages/mcp-audit" and dst and dst != src and (
                dst.startswith("services/") or dst in ("packages/mcp-audit", "evals")):
            v.append(("R5", f, line, f"mcp-audit import workspace 包（{spec}）；独立交付不进模块图"))


def check_r6(edges, v):
    """services/web import 任何他包源码 → 纯展示壳，数据全走同源代理 REST/SSE。"""
    for src, dst_rel, dst, f, line, spec in edges:
        if src == "services/web" and dst and dst != src and (
                dst.startswith("services/") or dst in ("packages/mcp-audit", "evals")):
            v.append(("R6", f, line, f"web import 他包源码（{spec}）；web 是纯展示壳"))


def check_r7(root, v):
    """guards 与 gateway 互不 import（py 侧经 REST）。"""
    for svc, other in (("services/guards", "gateway"), ("services/gateway", "guards")):
        bd = root / svc
        if not bd.is_dir():
            continue
        for f in sorted(bd.rglob("*.py")):
            text = f.read_text(encoding="utf-8", errors="ignore")
            for m in PY_PAIR_RE.finditer(text):
                if m.group(1) == other:
                    line = text.count("\n", 0, m.start()) + 1
                    v.append(("R7", f.relative_to(root).as_posix(), line,
                              f"guards/gateway 互引（import {other}）；py 侧经 REST"))


def check_r8(edges, v):
    """依赖方向单向：ingest→case-backend→agent→guards/gateway；反向/环状即违规。

    R1 全禁时本条自然为空，它是方向线的第二道锁：将来 R1 若给个别豁免，
    反向依赖仍然过不去。"""
    for src, dst_rel, dst, f, line, spec in edges:
        if src in CHAIN and dst in CHAIN and src != dst and CHAIN[src] >= CHAIN[dst]:
            v.append(("R8", f, line, f"依赖方向反向/环状（{src} → {dst}）；链条 fixtures→ingest→case-backend→agent→…"))


def check_r9(root, v):
    """服务级 /healthz 等基础设施端点计入卡面对账；例外=全体服务 /healthz。

    代码级后果：仓库里有服务入口（src/app.ts / app.py）的服务必须真挂 /healthz
    ——豁免是「免卡面申报」，不是「可以没有」。web 无仓库内服务入口 → 不在范围。"""
    services = root / "services"
    if not services.is_dir():
        return
    for svc in sorted(services.iterdir()):
        if not svc.is_dir():
            continue
        entry = next((svc / c for c in ("src/app.ts", "app.py") if (svc / c).is_file()), None)
        if entry and "healthz" not in entry.read_text(encoding="utf-8", errors="ignore"):
            v.append(("R9", entry.relative_to(root).as_posix(), 1,
                      "服务入口未挂 /healthz（基础设施端点计入对账的前提）"))


# m14 领地常量（票 71）：机制目录票 73 才建——目录缺席时 R10-R12 自然绿（机制先于内容）
ORCH_DIR = "services/agent/src/orchestration"
MINT_MODULES = ("services/agent/src/token-ports.ts", "services/agent/src/jiaotu/token-ports-jiaotu.ts")
# 业务模板名黑名单（PRD §13.3/13.4 句式族 id 前缀）：机制层源码（非测试）出现即违界
BIZ_RE = re.compile(r"\b(webshell|ir_host_compromise|phishing|credential_leak)\b", re.I)
PLAYBOOKS_RE = re.compile(r"[\"']([^\"']*playbooks[^\"']*)[\"']")


def check_r10(root, v):
    """m14 机制目录不含业务分支：业务模板名常量/内容层 playbooks import 禁止（PRD §13.1 分层铁律）。

    机制目录（src/orchestration/）票 73 才建——缺席即绿；测试文件可引用业务 fixture
    （行为断言在内容层），故只扫非测试件。注释同样受限：想提业务名，写到内容层去。"""
    bd = root / ORCH_DIR
    if not bd.is_dir():
        return
    for f in sorted(bd.rglob("*.ts")):
        if f.name.endswith(".test.ts"):
            continue
        rel = f.relative_to(root).as_posix()
        text = f.read_text(encoding="utf-8", errors="ignore")
        for m in BIZ_RE.finditer(text):
            line = text.count("\n", 0, m.start()) + 1
            v.append(("R10", rel, line, f"机制层出现业务模板名 `{m.group(1)}`；业务分支属内容层"))
        for m in PLAYBOOKS_RE.finditer(text):
            line = text.count("\n", 0, m.start()) + 1
            v.append(("R10", rel, line, f"机制层 import 内容层模板目录（{m.group(1)}）"))


def _m14_consumer(f):
    """R11/R12 的受限消费方：worker 子图 + m14 机制目录（src_root 同为 services/agent）。"""
    return f.startswith("services/agent/workers/") or f.startswith(ORCH_DIR + "/")


def check_r11(edges, v):
    """worker/m14 禁 import 铸票客户端 → 铸票只许 m3 装配（app.ts/index.ts）经 m9 公开铸票面。

    INV-11 执行缝的静态半边：子票 ⊆ 父菜单靠"铸票唯一通道"结构保证；票面生成后
    不可再改是运行时契约（票 76 遍历断言），本条锁的是获取通道。"""
    for src, dst_rel, dst, f, line, spec in edges:
        if _m14_consumer(f) and dst_rel in MINT_MODULES:
            v.append(("R11", f, line, f"worker/机制层 import 铸票客户端（{spec}）；铸票只许 m3 装配经 m9 公开面"))


def check_r12(edges, v):
    """worker/m14 禁 import 审批内部（src/approvals.ts）→ L2 只经 m3 graph.ts executeApproved 正门。

    M9-S6 沿用：worker 物理无 L2 通道；NodeCtx 注入的 executeApproved 是 m3 卡面正门，
    直引 approvals 内部（开卡/ApprovalToken 字段）即绕正门。"""
    for src, dst_rel, dst, f, line, spec in edges:
        if _m14_consumer(f) and dst_rel == "services/agent/src/approvals.ts":
            v.append(("R12", f, line, f"worker/机制层 import 审批内部（{spec}）；L2 只经 m3 executeApproved 正门（M9-S6）"))


def run_gate(root):
    """跑全部检查器 + 表与闸两向锁 → [(规则, 文件, 行, 消息)]（表失配以规则位「表」并入）。"""
    violations = []
    table_fails = []

    def fail(msg):
        table_fails.append(("表", "", 0, msg))

    rows = boundary_rows(root)
    if rows is None:
        fail("specs/modules.md 缺「## 边界规则」节（闸没有事实来源可消费）")
        return table_fails
    # 两向锁：表里每行禁令有闸消费；闸里每个检查器有表行
    for i, (禁, _exc) in enumerate(rows, 1):
        if not any(key in 禁 for _, key in KEYS):
            fail(f"边界规则第 {i} 行的禁令没有闸消费（每条禁令必须有人查）：{禁[:48]}")
    for rid, key in KEYS:
        if not any(key in 禁 for 禁, _exc in rows):
            fail(f"闸里有「{rid} {key}」检查器，边界规则表里却没有对应行（表与闸失配）")

    names = workspace_names(root)
    edges = collect_edges(root, names)
    check_r1(edges, violations)
    check_r2(edges, root, violations)
    check_r3(edges, root, violations)
    check_r4(edges, violations, next((exc for 禁, exc in rows if "反引仓库级" in 禁), ""))
    check_r5(edges, violations)
    check_r6(edges, violations)
    check_r7(root, violations)
    check_r8(edges, violations)
    check_r9(root, violations)
    check_r10(root, violations)
    check_r11(edges, violations)
    check_r12(edges, violations)
    return violations + table_fails


# ---------- 自测：喂违规样本必红、豁免样本必绿、表与闸失配必红（TDD 先行） ----------

def write_samples(root, bad):
    """搭一棵最小假仓库。bad=True 播违规样本（闸必须抓到），False 是干净基线（必须 0 报）。"""
    def w(rel, text):
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")

    # R9 绿基线：每个有服务入口的服务都挂 /healthz；ingest 的坏样本在 bad 分支覆盖
    health = 'export const routes = ["/healthz"];\n'
    for svc in ("agent", "case-backend", "ingest"):
        w(f"services/{svc}/src/app.ts", health if not (bad and svc == "ingest")
          else 'export const routes = ["/api"];\n')
    w("services/guards/app.py", 'ROUTES = ["/healthz"]\n')
    w("services/gateway/app.py", 'ROUTES = ["/healthz"]\n')
    if bad:
        w("services/agent/src/util.ts", "export const helper = 1;\n")
        # R1+R8：agent 反向引 case-backend 内部
        w("services/agent/src/a.ts",
          'import { openDb } from "../../case-backend/src/db.js";\nexport const x = openDb;\n')
        # 同包相对导入：合法（绿样本）
        w("services/agent/src/self.ts", 'import { helper } from "./util.js";\nexport const y = helper;\n')
        # R4：services 测试反引 scripts/
        w("services/agent/workers/x.test.ts", 'import { replay } from "../../../scripts/replay.js";\n')
        # R4：evals rig 反引 scripts/（票 46 收口——R2 只管 services 向，这里原是盲区）
        w("evals/src/rigs/replay.ts", 'import { replay } from "../../../scripts/replay.js";\n')
        # R2：非豁免文件 / 豁免文件触禁触库
        w("evals/src/other.ts", 'import { buildApp } from "../../services/agent/src/app.js";\n')
        w("evals/src/scenarios.ts", 'import { openDb } from "../../services/case-backend/src/db.js";\n')
        # 豁免绿样本：组装件 / 组装件的 .test.ts 伴侣 / 纯 type 导入
        w("evals/src/runner.ts", 'import { buildApp } from "../../services/agent/src/app.js";\n')
        w("evals/src/judge.test.ts", 'import { LlmUpstreamError } from "../../services/agent/src/llm-client.js";\n')
        w("evals/src/usage.ts", 'import type { TriageLlm } from "../../services/agent/workers/triage/llm.js";\n')
        # R3/R5/R6/R7
        w("scripts/bad.ts", 'import { x } from "../services/agent/src/app.js";\n')
        w("packages/mcp-audit/src/bad.ts", 'import { x } from "../../../services/agent/src/app.js";\n')
        w("services/web/src/bad.ts", 'import { runner } from "../../../evals/src/runner.js";\n')
        w("services/gateway/plugins/p.py", "import guards\n")
        # R10：机制层业务名常量 / 内容层 playbooks import
        w("services/agent/src/orchestration/flow.ts",
          'export const x = "webshell hunt";\n')
        w("services/agent/src/orchestration/dispatch.ts",
          'import { tpl } from "../../playbooks/webshell.js";\nexport const y = tpl;\n')
        # R11：机制层 import 铸票客户端
        w("services/agent/src/orchestration/mint.ts",
          'import { HttpMintClient } from "../token-ports.js";\nexport const m = HttpMintClient;\n')
        # R12：worker import 审批内部
        w("services/agent/workers/hunt/flow.ts",
          'import { openApprovalCard } from "../../src/approvals.js";\nexport const c = openApprovalCard;\n')
    else:
        w("services/agent/src/util.ts", "export const helper = 1;\n")
        w("services/agent/src/a.ts", 'import { helper } from "./util.js";\nexport const x = helper;\n')
        w("evals/src/runner.ts", 'import { buildApp } from "../../services/agent/src/app.js";\n')


def self_test():
    real_root = Path(__file__).resolve().parent.parent
    table_md = (real_root / "specs" / "modules.md").read_text(encoding="utf-8")
    results = []

    def check(name, cond, detail=""):
        results.append(cond)
        print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  [{detail}]" if detail and not cond else ""))

    def tree(mutate=None):
        td = tempfile.TemporaryDirectory()
        root = Path(td.name)
        (root / "specs").mkdir()
        (root / "specs" / "modules.md").write_text(mutate(table_md) if mutate else table_md, encoding="utf-8")
        return td, root

    # ① 违规样本必红：每条 (文件, 规则) 都要被抓到
    td, root = tree()
    write_samples(root, bad=True)
    got = {(v[1], v[0]) for v in run_gate(root)}
    for f, rid in [
        ("services/agent/src/a.ts", "R1"), ("services/agent/src/a.ts", "R8"),
        ("services/agent/workers/x.test.ts", "R4"), ("evals/src/rigs/replay.ts", "R4"),
        ("evals/src/other.ts", "R2"),
        ("evals/src/scenarios.ts", "R2"), ("scripts/bad.ts", "R3"),
        ("packages/mcp-audit/src/bad.ts", "R5"), ("services/web/src/bad.ts", "R6"),
        ("services/gateway/plugins/p.py", "R7"), ("services/ingest/src/app.ts", "R9"),
        ("services/agent/src/orchestration/flow.ts", "R10"),
        ("services/agent/src/orchestration/dispatch.ts", "R10"),
        ("services/agent/src/orchestration/mint.ts", "R11"),
        ("services/agent/workers/hunt/flow.ts", "R12"),
    ]:
        check(f"红样本必抓 {rid} {f}", (f, rid) in got, f"实得={sorted(got)}")
    # ② 豁免样本必绿：组装件 / .test.ts 伴侣 / 纯 type / 同包导入不报
    for f, rid in [("evals/src/runner.ts", "R2"), ("evals/src/judge.test.ts", "R2"),
                   ("evals/src/usage.ts", "R2"), ("services/agent/src/self.ts", "R1")]:
        check(f"豁免样本不报 {rid} {f}", (f, rid) not in got)
    td.cleanup()

    # ③ 干净基线必绿：0 越界 + 表与闸两向锁全过
    td, root = tree()
    write_samples(root, bad=False)
    got = run_gate(root)
    check("干净基线 0 越界", got == [], f"实得={got}")
    td.cleanup()

    def boundary_tail(t):
        """定位「## 边界规则」节内的表行（返回 节前文本, 表行列表, 节后文本）。"""
        head, _, tail = t.partition("## 边界规则")
        lines = tail.splitlines()
        rows = [i for i, l in enumerate(lines) if l.startswith("|")]
        return head, lines, rows

    # ④ 表删一行 → 对应检查器失配必红（删 R9 healthz 行）
    def drop_healthz_row(t):
        head, lines, rows = boundary_tail(t)
        for i in rows:
            if "healthz" in lines[i]:
                del lines[i]
                break
        return head + "## 边界规则" + "\n".join(lines)

    td, root = tree(drop_healthz_row)
    got = run_gate(root)
    check("表删行→闸失配必红", any("表与闸失配" in v[3] for v in got), f"实得={got}")
    td.cleanup()

    # ⑤ 表加一行闸不认识的 → 禁令无人查必红（行要插在表格相邻处才被解析）
    def add_unknown_row(t):
        head, lines, rows = boundary_tail(t)
        lines.insert(rows[-1] + 1, "| `services/x` 不许吃辣 | （无） | 两向锁自测 |")
        return head + "## 边界规则" + "\n".join(lines)

    td, root = tree(add_unknown_row)
    got = run_gate(root)
    check("表加未知行→无人查必红", any("没有闸消费" in v[3] for v in got), f"实得={got}")
    td.cleanup()

    n, total = sum(results), len(results)
    print(f"\nself-test: {n}/{total} 通过")
    return 0 if n == total else 1


def main():
    if "--self-test" in sys.argv:
        return self_test()
    root = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent).resolve()
    findings = run_gate(root)
    for rid, f, line, msg in findings:
        loc = f"{f}:{line}" if f else ""
        print(f"{'VIOL' if rid != '表' else 'FAIL'}  [{rid}] {loc}  {msg}".rstrip())
    if findings:
        n_table = sum(1 for r in findings if r[0] == "表")
        print(f"\nboundary gate: FAIL（{len(findings) - n_table} 越界 / {n_table} 表失配）")
        return 1
    print(f"boundary gate: PASS（0 越界，{len(KEYS)}/{len(KEYS)} 条禁令全有人查）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

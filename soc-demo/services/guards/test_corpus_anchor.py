"""票 32 验收 2：注入语料共享锚（py 引擎侧）。

fixtures/attack/injection-corpus.json 是 guards（llm-guard 主路径，6 族）与
mcp-audit（rules.ts 内嵌规则，7 族）两套引擎的共享语料——锚「同族判定一致」，
不合并实现（决策 #11：双实现刻意保留）。本文件对 py 引擎表态：每族每样本的
族级 hit/miss 必须与语料期望一致。TS 侧对同一份语料有对称闸
（packages/mcp-audit/test/corpus-anchor.test.ts），谁改族判定不改语料，谁那端红。
"""
import json
from pathlib import Path

import injection_scan

ROOT = Path(__file__).parents[2]
CORPUS = json.loads(
    (ROOT / "fixtures" / "attack" / "injection-corpus.json").read_text(encoding="utf-8")
)


def test_corpus_families_subset_of_py_engine_families():
    """共享锚只锁两引擎共有族：语料族集 ⊆ py 引擎族集（mcp_camouflage 是
    mcp-audit 特有族，不许混进共享语料——族集合不同是决策 #11 允许的形态）。"""
    py_families = {family for family, _ in injection_scan.FAMILY_WEIGHTS}
    assert set(CORPUS["families"]) <= py_families, "共享语料混入了 py 引擎没有的族"


def test_py_engine_family_judgment_matches_corpus():
    """逐族逐样本：py 引擎的族级判定 ≡ 语料期望（hit/miss 语义级，不锁计数）。"""
    for family, spec in CORPUS["families"].items():
        for sample in spec["samples"]:
            hit, _count = injection_scan._family_hit(family, sample["text"])
            assert hit == (sample["expect"] == "hit"), (
                f"{family}/{sample['id']}: 语料期望 {sample['expect']}，"
                f"py 引擎实判 {'hit' if hit else 'miss'}（同族判定漂移）"
            )

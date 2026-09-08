#!/usr/bin/env python3
# vt_lookup · Cortex 形态的可执行 analyzer（PRD v1.1 变更 3：analyzer 按 Cortex 真实架构
# 以可执行脚本形态存在，每次富化在一次性 microVM 里真跑）。
#
# 真跑位置：microsandbox 一次性 microVM（票 16）。本文件被 msb run --copy 挂成 VM 内的
# /srv/analyzer.py，情报表 fixtures/ti 以 --copy-dir 只读挂成 /srv/ti。egress 全关
# （--no-net），所以正常 analyzer 不需要外联——情报源是挂载文件，不是 HTTP。
#
# 协议（与 services/agent/workers/enrichment/sandbox.ts 约定）：
#   入：argv[1] = Cortex 调用契约四元组 JSON {data, dataType, tlp, pap}
#   出：stdout 一行 `<<ANALYZER_RESULT>>{result, attempts}`；正常 analyzer 的 attempts 恒为 []
import json
import os
import sys

MARKER = "<<ANALYZER_RESULT>>"
TI_DIR = "/srv/ti"

NO_RECORD = {"success": True, "summary": {"taxonomies": [{"level": "info", "predicate": "no-record"}]}}


def lookup(call):
    """查情报表：命中回 taxonomies/full/artifacts（Cortex 返回契约），未命中回 no-record
    （PRD：对齐 VT 无记录语义——是「没查到」，不是错误）。"""
    data = call["data"]
    if os.sep in data or data in (".", ".."):
        # data 直接当表文件名用：带路径分隔符的一律按未命中处理（VM 内的路径完整性）
        return NO_RECORD
    try:
        with open(os.path.join(TI_DIR, data + ".json")) as f:
            raw = json.load(f)
    except (FileNotFoundError, ValueError):
        return NO_RECORD
    return {
        "success": True,
        "summary": {"taxonomies": raw.get("taxonomies", [])},
        "full": raw.get("full"),
        "artifacts": raw.get("artifacts", []),
    }


def main():
    call = json.loads(sys.argv[1])
    print(MARKER + json.dumps({"result": lookup(call), "attempts": []}))


if __name__ == "__main__":
    main()

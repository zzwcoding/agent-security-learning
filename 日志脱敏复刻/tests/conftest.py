"""测试引导:把项目根挂进 sys.path,让 tests/ 能 import regex_sanitizer。"""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

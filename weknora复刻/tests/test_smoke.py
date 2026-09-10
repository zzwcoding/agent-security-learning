"""阶段 0 冒烟测试：骨架可 import、pytest 链路通。阶段 1 起由业务测试替换。"""

from main import hello


def test_skeleton_importable():
    assert hello() == "weknora-rebuild skeleton"

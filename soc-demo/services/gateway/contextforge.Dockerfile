# 票 12：contextforge 官方件的容器来源（compose services.contextforge 引用本文件）。
#
# 首选官方镜像 ghcr.io/ibm/mcp-contextforge-gateway:1.0.8；本环境 ghcr 对该仓库
# 匿名令牌直接 DENIED（网络受限，已记录进票 12），故降级为官方 PyPI 包钉版自建
# ——镜像里只有官方包，不含任何自写代码：插件/配置/ids 一律由 compose 挂载
# /app/plugins 接入（ADR 0001：自写件不动镜像内部，升级=改下面 pip 钉版一行）。
# ghcr 可达时把 compose 的 build 换成 image: 一行即回到官方镜像。
FROM python:3.12-slim

# cpex 与 gateway 同钉（1.0.8 配套 cpex 0.1.3，插件 API 以此为准）
RUN pip install --no-cache-dir mcp-contextforge-gateway==1.0.8 cpex==0.1.3

WORKDIR /app
EXPOSE 4444
CMD ["mcpgateway", "--host", "0.0.0.0", "--port", "4444"]

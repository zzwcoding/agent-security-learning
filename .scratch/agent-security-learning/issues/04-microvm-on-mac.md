# Mac 上的 microVM 选型

Type: research
Status: resolved
Blocked by:

## Question

macOS（Apple Silicon，有 Docker，无 Linux KVM）环境下，路线 2 "microVM 隔离"一步选什么方案？候选：E2B（云服务 SDK / 自托管对 Linux+KVM 的依赖）、microsandbox（libkrun 路线，Mac 支持度）、Daytona、或以加固 Docker 务实替代。要求：各方案在 Mac 的可行性与部署成本、学习价值对比、明确推荐，并说明"精读 Firecracker/gVisor 设计文档"部分是否不受影响。

## Answer

**推荐：主线用 microsandbox（Mac 本地真实 microVM）+ E2B 云服务 SDK 做对照体验 + 加固 Docker 做隔离层级对照基线；Daytona 排除；Firecracker/gVisor 文档精读不受平台影响，照常进行。**

### 各方案核实结果（2026-08）

**microsandbox —— Mac 可行，部署成本最低，推荐主线**
- 官方 README 明确跨平台支持 macOS（要求 Apple Silicon，Intel Mac 不支持本地运行时），底层是 libkrun，在 Mac 上走 Hypervisor.framework——即真正的硬件虚拟化 microVM，不是容器。
- 安装一行命令（`brew install superradcompany/tap/microsandbox` 或 npm/curl），Python/TS/Rust/Go SDK 齐全，`Sandbox.create()` 以子进程方式拉起 microVM，无需任何基础设施。
- 对学习项目特别对口的点：SDK 原生带网络白名单（`allowed_hosts`/`allowed_ports`）和按域名限定 secret 注入，正好覆盖路线中" egress 控制 + 凭证隔离"的实验目标；还有 MCP server，可直接给 Agent 当代码执行工具。
- 风险：官方自述仍是 **beta 软件**，可能有 breaking changes。学习用途可接受。
- 来源：[microsandbox/microsandbox README](https://github.com/microsandbox/microsandbox)、[macOS 故障排查文档（要求 Apple Silicon）](https://docs.microsandbox.dev/troubleshooting/macos)

**E2B —— 云服务 SDK 在 Mac 上可用（推荐作对照体验）；自托管在 Mac 上不可行（跳过）**
- 自托管（e2b-dev/infra）前提核实：Terraform 部署，支持 GCP / AWS(beta) / 通用 Linux 机器；编排栈为 Nomad + Consul + Packer，还需要 Cloudflare 域名 + PostgreSQL；计算节点跑 Firecracker，官方故障排查明确"Firecracker requires bare metal or nested virtualization support"（AWS 默认 `m8i.4xlarge` 裸金属/嵌套虚拟化实例）。macOS 无 KVM，本地自托管排除；且整套集群对学习项目是明显的过度工程。
- 云服务 SDK 只是 API 客户端，Mac 上零障碍，免费额度足够体验"工业界如何把 Firecracker microVM 包装成产品"（模板、生命周期、API 形态），与 microsandbox 形成"托管 vs 本地"对照。
- 来源：[e2b-dev/infra self-host.md](https://github.com/e2b-dev/infra/blob/main/self-host.md)、[e2b-dev/infra README](https://github.com/e2b-dev/infra)

**Daytona —— 排除**
- 一手事实：daytonaio/daytona 仓库顶部公告"**This repository is no longer maintained. As of June 2026, Daytona's core development has moved to a private codebase**"——开源版停更，对一个以"读得懂、讲得清"为目标的学习项目是硬伤。
- 另：其沙箱建立在 OCI/Docker 兼容性之上，默认隔离是容器而非 microVM；自托管历史上需要 K8s 集群，部署成本最高。隔离学习价值不优于其他候选。
- 来源：[daytonaio/daytona README（停更公告）](https://github.com/daytonaio/daytona)

**加固 Docker —— 不作为替代，作为对照基线保留（成本≈0）**
- Docker Desktop 本身在 Linux VM 里跑容器，Mac 上天然可用。用 seccomp/AppArmor 等价物、cap-drop、只读 rootfs、网络隔离做一套"加固容器"，再与 microsandbox 的 microVM 对比攻击面（共享内核 vs 独立内核），正好是隔离原理从文档到手感的桥。它是教学对照组，不是 microVM 的平替。

### "精读 Firecracker/gVisor 设计文档"是否受平台影响

**不受影响，照常安排。** 核实到的事实是：Firecracker VMM 基于 Linux KVM，官方 tested platforms 全是 Linux 裸金属（[Firecracker README](https://github.com/firecracker-microvm/firecracker)），gVisor 的 runsc 同理是 Linux-only runtime——这影响的是"动手跑"，不是"读文档"。design.md、jailer、seccomp 过滤、gVisor 的 sentry/Gofer 架构都是纯阅读材料，Mac 上无障碍。若读到后面想亲手跑一把，可选加餐：Docker Desktop 的 Linux VM 内装 runsc，或开一台最小 Linux 云主机跑 Firecracker quickstart——属可选项，不阻塞路线。

### 落地顺序建议

1. `brew install superradcompany/tap/microsandbox` → `msb run python` 跑通，再用 Python SDK 给起步 Agent 接一个 `run_code` 工具（顺手用上网络白名单）。
2. 加固 Docker 容器跑同一段"逃逸演示"代码，对比两者隔离边界，写进复盘文档。
3. 注册 E2B 云账号，用免费额度体验 SDK 与模板机制，只作对照不自托管。
4. Firecracker design doc + gVisor architecture guide 精读照常。

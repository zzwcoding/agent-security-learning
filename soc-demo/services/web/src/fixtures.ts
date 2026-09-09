// 演示布景打包：fixtures/alerts/ 的具名 fixture 在构建期打进前端包（各 <1KB）。
// 回放按钮（FR-M10.1）拿它们 POST ingest 的 webhook 正门——与 scripts/replay.ts
// 是同一个动作：数据只走正门，绝不直接塞库（m1 卡三条铁律之一）。
// glob 是构建期的：Docker 镜像里需要 COPY fixtures/（见 services/web/Dockerfile）。
export interface FixtureAlert {
  file: string;
  payload: unknown;
}

const mods = import.meta.glob("../../../fixtures/alerts/*.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;

export const FIXTURE_ALERTS: FixtureAlert[] = Object.entries(mods)
  .map(([path, payload]) => ({ file: path.split("/").pop() ?? path, payload }))
  .sort((a, b) => (a.file < b.file ? -1 : 1));

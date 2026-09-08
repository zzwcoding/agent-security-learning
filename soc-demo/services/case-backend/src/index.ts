import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";

const PORT = Number(process.env.PORT ?? 3002);
// 库文件落仓库 data/ 目录（soc-demo/data）；CASE_DB_PATH 可覆盖
const dataDir = new URL("../../../data/", import.meta.url);
mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.CASE_DB_PATH ?? fileURLToPath(new URL("case-backend.sqlite", dataDir));

buildApp({ db: openDb(dbPath) })
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => console.log(`case-backend listening on :${PORT}, db=${dbPath}`));

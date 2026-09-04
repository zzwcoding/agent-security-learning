import { buildApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 3002);

buildApp()
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => console.log(`case-backend listening on :${PORT}`));

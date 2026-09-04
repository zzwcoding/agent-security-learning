import { buildApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 3003);

buildApp()
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => console.log(`agent listening on :${PORT}`));

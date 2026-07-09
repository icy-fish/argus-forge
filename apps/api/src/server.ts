import cors from "@fastify/cors";
import Fastify from "fastify";
import { config } from "./config.js";
import { closeDb } from "./db.js";
import { ingestRoutes } from "./routes/ingest.js";
import { metricRoutes } from "./routes/metrics.js";
import { sessionRoutes } from "./routes/sessions.js";

export async function buildServer() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: config.CORS_ORIGIN === "*" ? true : config.CORS_ORIGIN });

  app.get("/health", async () => ({ ok: true, service: "argus-forge-api" }));
  await app.register(ingestRoutes);
  await app.register(sessionRoutes);
  await app.register(metricRoutes);

  return app;
}

if (!process.env.VITEST) {
  const app = await buildServer();
  const shutdown = async () => {
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
}

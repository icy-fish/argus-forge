import cors from "@fastify/cors";
import Fastify from "fastify";
import { config } from "./config.js";
import { closeDb } from "./db.js";
import { ingestRoutes } from "./routes/ingest.js";
import { metricRoutes } from "./routes/metrics.js";
import { sessionRoutes } from "./routes/sessions.js";

export async function buildServer() {
  const app = Fastify({
    disableRequestLogging: true,
    logger: {
      level: config.API_LOG_LEVEL,
      redact: [
        "httpRequest.headers.authorization",
        "httpRequest.headers.cookie",
        "httpRequest.body.authorization",
        "httpRequest.body.apiKey",
        "httpRequest.body.token"
      ]
    }
  });

  if (config.API_HTTP_REQUEST_LOG_DETAILS) {
    app.addHook("preHandler", async (request) => {
      request.log.debug(
        {
          httpRequest: {
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: request.body
          }
        },
        "http request"
      );
    });
    app.addHook("onSend", async (request, reply, payload) => {
      request.log.debug(
        {
          httpResponse: {
            statusCode: reply.statusCode,
            headers: reply.getHeaders(),
            body: payload,
            responseTimeMs: reply.elapsedTime
          }
        },
        "http response"
      );
      return payload;
    });
  }

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

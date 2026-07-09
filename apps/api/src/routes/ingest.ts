import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { sendError } from "../utils/errors.js";
import { IngestService } from "../services/ingestService.js";

export async function ingestRoutes(app: FastifyInstance) {
  const service = new IngestService(prisma);

  app.post("/v1/ingest/event", async (request, reply) => {
    try {
      return await service.ingestSingle(request.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/v1/ingest/events", async (request, reply) => {
    try {
      return await service.ingestBatch(request.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

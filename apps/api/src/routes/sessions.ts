import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { sendError } from "../utils/errors.js";
import { parseTimeRange } from "../utils/time.js";
import { SessionService } from "../services/sessionService.js";

export async function sessionRoutes(app: FastifyInstance) {
  const service = new SessionService(prisma);

  app.get("/v1/sessions", async (request, reply) => {
    try {
      const query = request.query as Record<string, unknown>;
      return await service.list({
        ...parseTimeRange(query),
        page: query.page ? Number(query.page) : undefined,
        pageSize: query.pageSize ? Number(query.pageSize) : undefined,
        search: typeof query.search === "string" ? query.search : undefined
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/v1/sessions/:id", async (request, reply) => {
    try {
      return await service.detail((request.params as { id: string }).id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/v1/sessions/:id/timeline", async (request, reply) => {
    try {
      return await service.timeline((request.params as { id: string }).id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/v1/sessions/:id/metrics", async (request, reply) => {
    try {
      return await service.metricsForSession((request.params as { id: string }).id);
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { sendError } from "../utils/errors.js";
import { parseTimeRange } from "../utils/time.js";
import { MetricService } from "../services/metricService.js";

export async function metricRoutes(app: FastifyInstance) {
  const service = new MetricService(prisma);

  app.get("/v1/metrics/summary", async (request, reply) => {
    try {
      return { data: await service.summary(parseTimeRange(request.query as Record<string, unknown>)) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/v1/metrics/tools", async (request, reply) => {
    try {
      return { data: await service.tools(parseTimeRange(request.query as Record<string, unknown>)) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/v1/metrics/models", async (request, reply) => {
    try {
      return { data: await service.models(parseTimeRange(request.query as Record<string, unknown>)) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/v1/metrics/latency", async (request, reply) => {
    try {
      return { data: await service.latency(parseTimeRange(request.query as Record<string, unknown>)) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/v1/metrics/throughput", async (request, reply) => {
    try {
      return { data: await service.throughput(parseTimeRange(request.query as Record<string, unknown>)) };
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

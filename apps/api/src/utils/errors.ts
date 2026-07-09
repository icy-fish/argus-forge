import type { FastifyReply } from "fastify";
import { ZodError } from "zod";

export class NotFoundError extends Error {
  code = "NOT_FOUND";
}

export function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: { code: "VALIDATION_ERROR", message: "Invalid request payload", details: error.flatten() }
    });
  }
  if (error instanceof NotFoundError) {
    return reply.status(404).send({ error: { code: error.code, message: error.message } });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message } });
}

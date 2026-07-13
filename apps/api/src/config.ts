import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().default("file:./dev.db"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  API_LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  API_HTTP_REQUEST_LOG_DETAILS: z
    .string()
    .optional()
    .transform((value) => value === "1" || value === "true")
});

export const config = envSchema.parse(process.env);

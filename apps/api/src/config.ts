import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().default("postgres://flowless:flowless@localhost:5432/flowless"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("127.0.0.1"),
  APP_ORIGIN: z.string().default("http://localhost:5173"),
  APP_TIMEZONE: z.string().default("Asia/Shanghai"),
  SESSION_SECRET: z.string().min(32).default("development-only-change-this-secret"),
  COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_OUTPUT_MODE: z.enum(["json_schema", "json_object"]).default("json_schema"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  LOG_LEVEL: z.string().default("info"),
});

export const config = envSchema.parse(process.env);

import { z } from 'zod';

const boolean = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');
const schema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5001),
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  CLIENT_ORIGIN: z.url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  DB_SSL: boolean.default(false),
  DB_SSL_REJECT_UNAUTHORIZED: boolean.default(true),
  DB_SSL_CA_FILE: z.string().trim().default(''),
  SESSION_HOURS: z.coerce.number().int().min(1).max(168).default(8),
  COOKIE_SECURE: boolean.optional(),
  WORKER_POLL_MS: z.coerce.number().int().min(100).max(30000).default(1000),
  WORKER_STALE_MS: z.coerce.number().int().min(30000).default(60000),
});

export function readConfig(env = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(
      `Revisa estas variables: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  }
  const config = result.data;
  return {
    ...config,
    CLIENT_ORIGIN: new URL(config.CLIENT_ORIGIN).origin,
    COOKIE_SECURE: config.COOKIE_SECURE ?? config.NODE_ENV === 'production',
  };
}

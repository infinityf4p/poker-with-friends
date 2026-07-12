import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const publicOriginSchema = z
  .string()
  .url()
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'PUBLIC_ORIGIN must use HTTP or HTTPS',
      });
    }
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'PUBLIC_ORIGIN must not contain credentials, a path, a query, or a hash',
      });
    }
  })
  .transform((value) => {
    try {
      return new URL(value).origin;
    } catch {
      return value;
    }
  });

const snapshotKeySchema = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      const decoded = Buffer.from(value, 'base64');
      return decoded.byteLength === 32 && decoded.toString('base64') === value;
    } catch {
      return false;
    }
  }, 'SNAPSHOT_KEY must be a canonical base64 encoded 32-byte key');

const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().positive().max(65_535).default(3000),
    PUBLIC_ORIGIN: publicOriginSchema.default('http://localhost:5173'),
    DATABASE_URL: z.string().min(1),
    COOKIE_SECRET: z.string().min(32),
    SNAPSHOT_KEY: snapshotKeySchema,
    TOKEN_PEPPER: z.string().min(32),
    ADMIN_USERNAME: z.string().min(1).max(64).default('admin'),
    ADMIN_PASSWORD_HASH: z.string().optional(),
    TRUST_PROXY: booleanString,
    RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    ROOM_IDLE_HOURS: z.coerce.number().int().min(1).max(168).default(12),
    APP_BUILD_SHA: z.string().default('development'),
    WEB_DIST_DIR: z.string().default('apps/web/dist'),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== 'production') return;

    if (new URL(value.PUBLIC_ORIGIN).protocol !== 'https:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PUBLIC_ORIGIN'],
        message: 'PUBLIC_ORIGIN must use HTTPS in production',
      });
    }

    const insecureSecret = (secret: string) =>
      /development-only|replace_with|change-me/i.test(secret);
    for (const [name, secret] of [
      ['COOKIE_SECRET', value.COOKIE_SECRET],
      ['TOKEN_PEPPER', value.TOKEN_PEPPER],
      ['SNAPSHOT_KEY', value.SNAPSHOT_KEY],
    ] as const) {
      if (insecureSecret(secret)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `${name} must not use an example or placeholder value in production`,
        });
      }
    }
    if (value.SNAPSHOT_KEY === 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SNAPSHOT_KEY'],
        message: 'SNAPSHOT_KEY must not use the all-zero development key in production',
      });
    }
    if (value.COOKIE_SECRET === value.TOKEN_PEPPER) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TOKEN_PEPPER'],
        message: 'TOKEN_PEPPER must be generated independently from COOKIE_SECRET',
      });
    }
    if (/replace_with/i.test(value.DATABASE_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'DATABASE_URL must not contain a placeholder password in production',
      });
    }
    if (!value.ADMIN_PASSWORD_HASH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ADMIN_PASSWORD_HASH'],
        message: 'ADMIN_PASSWORD_HASH is required in production',
      });
    } else if (!value.ADMIN_PASSWORD_HASH.startsWith('$argon2id$')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ADMIN_PASSWORD_HASH'],
        message: 'ADMIN_PASSWORD_HASH must be an Argon2id hash in production',
      });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${message}`);
  }
  return result.data;
}

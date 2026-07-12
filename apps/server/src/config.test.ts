import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const baseEnv = {
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgres://poker:poker@127.0.0.1:5432/poker',
  COOKIE_SECRET: 'cookie-secret-generated-for-tests-only',
  SNAPSHOT_KEY: Buffer.alloc(32, 1).toString('base64'),
  TOKEN_PEPPER: 'token-pepper-generated-for-tests-only',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('accepts a canonical development origin and canonical snapshot key', () => {
    expect(loadConfig(baseEnv)).toMatchObject({
      NODE_ENV: 'test',
      PUBLIC_ORIGIN: 'http://localhost:5173',
    });
  });

  it('normalizes harmless origin syntax while rejecting paths and non-canonical keys', () => {
    expect(loadConfig({ ...baseEnv, PUBLIC_ORIGIN: 'http://localhost:5173/' }).PUBLIC_ORIGIN).toBe(
      'http://localhost:5173',
    );
    expect(loadConfig({ ...baseEnv, PUBLIC_ORIGIN: 'http://localhost:80' }).PUBLIC_ORIGIN).toBe(
      'http://localhost',
    );
    expect(() => loadConfig({ ...baseEnv, PUBLIC_ORIGIN: 'http://localhost:5173/path' })).toThrow(
      'PUBLIC_ORIGIN must not contain credentials',
    );
    expect(() => loadConfig({ ...baseEnv, PUBLIC_ORIGIN: 'not a URL' })).toThrow(
      'Invalid configuration',
    );
    expect(() => loadConfig({ ...baseEnv, SNAPSHOT_KEY: `${baseEnv.SNAPSHOT_KEY}!` })).toThrow(
      'SNAPSHOT_KEY must be a canonical base64 encoded 32-byte key',
    );
  });

  it('fails closed on insecure production origins, placeholders, and missing admin hashes', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        COOKIE_SECRET: 'development-only-cookie-secret-change-me',
        TOKEN_PEPPER: 'development-only-token-pepper-change-me',
        SNAPSHOT_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      }),
    ).toThrow('PUBLIC_ORIGIN must use HTTPS in production');
  });

  it('accepts independently generated production secrets and an Argon2id admin hash', () => {
    expect(
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'https://poker.example.com',
        COOKIE_SECRET: 'c'.repeat(48),
        TOKEN_PEPPER: 't'.repeat(48),
        SNAPSHOT_KEY: Buffer.alloc(32, 2).toString('base64'),
        ADMIN_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=1$example$safetesthash',
      }).NODE_ENV,
    ).toBe('production');
  });
});

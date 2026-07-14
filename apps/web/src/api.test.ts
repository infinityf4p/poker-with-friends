import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

function rejectWith(body: unknown, status = 400): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api error messages', () => {
  it('uses the server top-level message when present', async () => {
    rejectWith({ message: '账号已存在', issues: [{ message: 'ignored' }] }, 409);

    await expect(api('/api/admin/users')).rejects.toMatchObject({
      status: 409,
      message: '账号已存在',
    });
  });

  it('falls back to the first Zod issue from older servers', async () => {
    rejectWith({
      error: 'BAD_REQUEST',
      issues: [{ message: '账号只能包含字母、数字、点、下划线和短横线' }],
    });

    await expect(api('/api/admin/users')).rejects.toMatchObject({
      status: 400,
      message: '账号只能包含字母、数字、点、下划线和短横线',
    });
  });

  it('uses a concise fallback for malformed error responses', async () => {
    rejectWith({ error: 'BAD_REQUEST' });

    await expect(api('/api/admin/users')).rejects.toMatchObject({
      status: 400,
      message: '请求失败，请重试',
    });
  });
});

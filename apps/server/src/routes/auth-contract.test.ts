import {
  adminAdjustStackSchema,
  adminKickPlayerSchema,
  adminRestorePlayerSchema,
  changeUserPasswordSchema,
  createUserAccountSchema,
  joinRoomSchema,
  userLoginSchema,
} from '@poker-with-friends/protocol';
import { describe, expect, it } from 'vitest';
import { invalidRouteParameter, validationErrorBody } from './http.js';

describe('permanent user auth contract', () => {
  it('accepts an administrator-created account and a strong temporary password', () => {
    expect(
      createUserAccountSchema.safeParse({
        username: 'table.player-1',
        displayName: 'Player 1',
        password: 'temporary-passphrase',
      }).success,
    ).toBe(true);
  });

  it('rejects weak temporary passwords and invalid account names', () => {
    const parsed = createUserAccountSchema.safeParse({
      username: 'bad name',
      password: 'temporary-passphrase',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(validationErrorBody(parsed.error.issues)).toMatchObject({
        error: 'BAD_REQUEST',
        message: '账号只能包含字母、数字、点、下划线和短横线',
      });
    }
  });

  it('requires a display name when the login account is too long for a seat label', () => {
    const username = 'player_name_that_is_longer_than_twenty';
    const parsed = createUserAccountSchema.safeParse({
      username,
      password: 'temporary-passphrase',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(validationErrorBody(parsed.error.issues)).toMatchObject({
        error: 'BAD_REQUEST',
        message: '账号超过 20 位时必须填写 20 位以内的显示名称',
      });
    }
    expect(
      createUserAccountSchema.safeParse({
        username,
        displayName: '长账号玩家',
        password: 'temporary-passphrase',
      }).success,
    ).toBe(true);
  });

  it('keeps a readable fallback when validation has no issues', () => {
    expect(validationErrorBody([])).toEqual({
      error: 'BAD_REQUEST',
      message: '请求参数无效',
      issues: [],
    });
  });

  it('allows invite joins to use the account display name by default', () => {
    expect(joinRoomSchema.parse({})).toEqual({});
  });

  it('requires a different password during first-login password change', () => {
    const password = 'same-long-passphrase';
    expect(
      changeUserPasswordSchema.safeParse({ currentPassword: password, newPassword: password })
        .success,
    ).toBe(false);
    expect(userLoginSchema.safeParse({ username: 'player_1', password }).success).toBe(true);
  });

  it('validates audited administrator stack and membership operations', () => {
    expect(adminAdjustStackSchema.parse({ stack: 3_500, reason: '现场筹码校准' })).toEqual({
      stack: 3_500,
      reason: '现场筹码校准',
    });
    expect(adminAdjustStackSchema.safeParse({ stack: -1, reason: 'bad' }).success).toBe(false);
    expect(adminKickPlayerSchema.parse({})).toEqual({ reason: '管理员移出' });
    expect(adminRestorePlayerSchema.parse({})).toEqual({});
  });

  it('rejects malformed database identifiers and invite tokens before querying PostgreSQL', () => {
    expect(invalidRouteParameter({ id: 'not-a-uuid' })).toBe('id');
    expect(invalidRouteParameter({ playerId: '00000000-0000-4000-8000-000000000012' })).toBeNull();
    expect(invalidRouteParameter({ token: '../unexpected' })).toBe('token');
    expect(invalidRouteParameter({ token: 'a'.repeat(43) })).toBeNull();
  });
});

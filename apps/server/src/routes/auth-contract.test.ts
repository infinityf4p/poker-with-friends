import {
  adminAdjustStackSchema,
  adminKickPlayerSchema,
  adminRestorePlayerSchema,
  changeUserPasswordSchema,
  createUserAccountSchema,
  joinRoomSchema,
  registrationSchema,
  resetUserPasswordSchema,
  updateAdminProfileSchema,
  updateUserProfileSchema,
  userLoginSchema,
} from '@poker-with-friends/protocol';
import { describe, expect, it } from 'vitest';
import { invalidRouteParameter, validationErrorBody } from './http.js';

describe('permanent user auth contract', () => {
  it('accepts a six-character administrator-created account password', () => {
    expect(
      createUserAccountSchema.safeParse({
        username: 'table.player-1',
        displayName: 'Player 1',
        password: 'abc123',
      }).success,
    ).toBe(true);
    expect(resetUserPasswordSchema.safeParse({}).success).toBe(true);
    expect(resetUserPasswordSchema.safeParse({ password: 'abc123' }).success).toBe(false);
  });

  it('rejects invalid account names with the complete validation message', () => {
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

  it('rejects passwords shorter than six characters with a complete validation message', () => {
    const parsed = createUserAccountSchema.safeParse({
      username: 'player_1',
      password: '12345',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(validationErrorBody(parsed.error.issues)).toMatchObject({
        error: 'BAD_REQUEST',
        message: '密码至少需要 6 位',
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

  it('requires an invite for registration and protects profile password changes', () => {
    expect(
      registrationSchema.safeParse({
        inviteCode: 'a'.repeat(43),
        username: 'player_1',
        password: 'abc123',
      }).success,
    ).toBe(true);
    expect(updateUserProfileSchema.safeParse({ displayName: '新昵称' }).success).toBe(true);
    expect(updateAdminProfileSchema.safeParse({ newPassword: 'abc123' }).success).toBe(false);
    expect(
      updateUserProfileSchema.safeParse({ currentPassword: 'old-pass', newPassword: 'new-pass' })
        .success,
    ).toBe(true);
  });

  it('keeps optional password changes valid without affecting direct login', () => {
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

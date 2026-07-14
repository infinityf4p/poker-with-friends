import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  addRoomMemberSchema,
  adminAdjustStackSchema,
  adminKickPlayerSchema,
  adminLoginSchema,
  adminPlayAsSelfSchema,
  adminRestorePlayerSchema,
  changeUserPasswordSchema,
  createRoomSchema,
  createUserAccountSchema,
  identifierSchema,
  inviteTokenSchema,
  joinRoomSchema,
  resetUserPasswordSchema,
  userLoginSchema,
} from '@poker-with-friends/protocol';
import type { AppConfig } from '../config.js';
import type { AuthenticatedAdmin, AuthenticatedUser, PokerRepository } from '../repository.js';
import type { RoomManager } from '../room/manager.js';
import { ADMIN_COOKIE, USER_COOKIE, sessionCookieOptions } from '../security/cookies.js';
import { safeErrorLogContext } from '../security/logging.js';
import { isAllowedBrowserOrigin, requiresSameOrigin } from '../security/origin.js';

interface HttpDependencies {
  config: AppConfig;
  repository: PokerRepository;
  rooms: RoomManager;
}

interface ValidationIssue {
  message: string;
}

export function validationErrorBody(issues: readonly ValidationIssue[]) {
  return {
    error: 'BAD_REQUEST' as const,
    message: issues[0]?.message ?? '请求参数无效',
    issues,
  };
}

function sendValidationError(reply: FastifyReply, issues: readonly ValidationIssue[]) {
  return reply.code(400).send(validationErrorBody(issues));
}

export function invalidRouteParameter(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  const values = params as Record<string, unknown>;
  for (const key of ['id', 'playerId']) {
    if (key in values && !identifierSchema.safeParse(values[key]).success) return key;
  }
  if ('token' in values && !inviteTokenSchema.safeParse(values.token).success) return 'token';
  return null;
}

async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: PokerRepository,
): Promise<AuthenticatedAdmin | null> {
  const admin = await repository.getAdminBySession(request.cookies[ADMIN_COOKIE]);
  if (!admin) {
    await reply.code(401).send({ error: 'UNAUTHORIZED', message: '请先登录管理员账号' });
    return null;
  }
  return admin;
}

async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: PokerRepository,
  allowPasswordChange = false,
): Promise<AuthenticatedUser | null> {
  const user = await repository.getUserBySession(request.cookies[USER_COOKIE]);
  if (!user) {
    await reply.code(401).send({ error: 'UNAUTHORIZED', message: '请先登录玩家账号' });
    return null;
  }
  if (user.mustChangePassword && !allowPasswordChange) {
    await reply
      .code(403)
      .send({ error: 'PASSWORD_CHANGE_REQUIRED', message: '请先修改管理员下发的初始密码' });
    return null;
  }
  return user;
}

export async function registerHttpRoutes(
  app: FastifyInstance,
  deps: HttpDependencies,
): Promise<void> {
  const { config, repository, rooms } = deps;
  const cookieOptions = sessionCookieOptions(config.NODE_ENV === 'production');

  app.addHook('onRequest', async (request, reply) => {
    if (
      requiresSameOrigin(request.method) &&
      !isAllowedBrowserOrigin(request.headers.origin, config.PUBLIC_ORIGIN)
    ) {
      return reply
        .code(403)
        .send({ error: 'FORBIDDEN', message: '请求来源未获授权，请从本站重新操作' });
    }
  });

  app.addHook('preValidation', async (request, reply) => {
    if (invalidRouteParameter(request.params)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: '路径参数格式无效' });
    }
  });

  app.get('/health/live', async () => ({ status: 'ok', build: config.APP_BUILD_SHA }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await repository.ping();
      return { status: 'ready', build: config.APP_BUILD_SHA };
    } catch {
      return reply.code(503).send({ status: 'not_ready' });
    }
  });

  app.get('/robots.txt', async (_request, reply) => {
    return reply.type('text/plain; charset=utf-8').send('User-agent: *\nDisallow: /\n');
  });

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = userLoginSchema.safeParse(request.body);
      if (!parsed.success) return sendValidationError(reply, parsed.error.issues);
      const user = await repository.verifyUser(parsed.data.username, parsed.data.password);
      if (!user) {
        return reply.code(401).send({ error: 'INVALID_CREDENTIALS', message: '账号或密码错误' });
      }
      const token = await repository.createUserSession(user.id);
      reply.setCookie(USER_COOKIE, token, cookieOptions);
      return user;
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    await repository.deleteUserSession(request.cookies[USER_COOKIE]);
    reply.clearCookie(USER_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/auth/session', async (request, reply) => {
    const user = await requireUser(request, reply, repository, true);
    return user ?? undefined;
  });

  app.post('/api/auth/password', async (request, reply) => {
    const user = await requireUser(request, reply, repository, true);
    if (!user) return;
    const parsed = changeUserPasswordSchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, parsed.error.issues);
    const changed = await repository.changeUserPassword(
      user.id,
      parsed.data.currentPassword,
      parsed.data.newPassword,
    );
    if (!changed) {
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS', message: '当前密码不正确' });
    }
    reply.setCookie(USER_COOKIE, changed.sessionToken, cookieOptions);
    return changed.user;
  });

  app.get('/api/me/rooms', async (request, reply) => {
    const user = await requireUser(request, reply, repository);
    if (!user) return;
    return repository.listUserRooms(user.id);
  });

  app.get('/api/rooms', async (request, reply) => {
    const user = await requireUser(request, reply, repository);
    if (!user) return;
    return repository.listLobbyRooms(user.id);
  });

  app.post(
    '/api/admin/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = adminLoginSchema.safeParse(request.body);
      if (!parsed.success) return sendValidationError(reply, parsed.error.issues);
      const admin = await repository.verifyAdmin(parsed.data.username, parsed.data.password);
      if (!admin)
        return reply.code(401).send({ error: 'INVALID_CREDENTIALS', message: '账号或密码错误' });
      const token = await repository.createAdminSession(admin.id);
      reply.setCookie(ADMIN_COOKIE, token, cookieOptions);
      return { id: admin.id, username: admin.username };
    },
  );

  app.post('/api/admin/logout', async (request, reply) => {
    await repository.deleteAdminSession(request.cookies[ADMIN_COOKIE]);
    reply.clearCookie(ADMIN_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/admin/session', async (request, reply) => {
    const admin = await requireAdmin(request, reply, repository);
    return admin ?? undefined;
  });

  app.get('/api/admin/users', async (request, reply) => {
    if (!(await requireAdmin(request, reply, repository))) return;
    return repository.listUserAccounts();
  });

  app.post('/api/admin/users', async (request, reply) => {
    const admin = await requireAdmin(request, reply, repository);
    if (!admin) return;
    const parsed = createUserAccountSchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, parsed.error.issues);
    try {
      return reply.code(201).send(await repository.createUserAccount(admin.id, parsed.data));
    } catch (error) {
      if (error instanceof Error && error.message === 'USERNAME_TAKEN') {
        return reply.code(409).send({ error: 'USERNAME_TAKEN', message: '账号已存在' });
      }
      if (error instanceof Error && error.message === 'INVALID_DISPLAY_NAME') {
        return reply.code(400).send({
          error: 'BAD_REQUEST',
          message: '账号超过 20 位时必须填写 20 位以内的显示名称',
        });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>(
    '/api/admin/users/:id/reset-password',
    async (request, reply) => {
      const admin = await requireAdmin(request, reply, repository);
      if (!admin) return;
      const parsed = resetUserPasswordSchema.safeParse(request.body);
      if (!parsed.success) return sendValidationError(reply, parsed.error.issues);
      if (
        !(await repository.resetUserPassword(admin.id, request.params.id, parsed.data.password))
      ) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: '账号不存在' });
      }
      return reply.code(204).send();
    },
  );

  app.get('/api/admin/rooms', async (request, reply) => {
    if (!(await requireAdmin(request, reply, repository))) return;
    return repository.listRooms(config.PUBLIC_ORIGIN);
  });

  app.get<{ Params: { id: string } }>('/api/admin/rooms/:id/players', async (request, reply) => {
    if (!(await requireAdmin(request, reply, repository))) return;
    return repository.listRoomPlayers(request.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/admin/rooms/:id/snapshot', async (request, reply) => {
    if (!(await requireAdmin(request, reply, repository))) return;
    try {
      return { public: await rooms.adminSnapshot(request.params.id), private: null };
    } catch (error) {
      if (error instanceof Error && error.message === 'ROOM_NOT_FOUND') {
        return reply.code(404).send({ error: 'NOT_FOUND', message: '房间不存在' });
      }
      request.log.error(
        { failure: safeErrorLogContext(error), roomId: request.params.id },
        'admin room snapshot failed',
      );
      return reply.code(503).send({ error: 'ROOM_FROZEN', message: '牌局当前无法恢复' });
    }
  });

  app.post<{ Params: { id: string; playerId: string } }>(
    '/api/admin/rooms/:id/players/:playerId/chips',
    async (request, reply) => {
      const admin = await requireAdmin(request, reply, repository);
      if (!admin) return;
      const parsed = adminAdjustStackSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendValidationError(reply, parsed.error.issues);
      }
      try {
        const result = await rooms.adminAdjustStack(
          request.params.id,
          admin.id,
          request.params.playerId,
          parsed.data.stack,
          parsed.data.reason,
          parsed.data.operationId ?? randomUUID(),
        );
        if (!result.ok) {
          return reply
            .code(result.code === 'NOT_FOUND' ? 404 : 409)
            .send({ error: result.code, message: result.message });
        }
        return result;
      } catch (error) {
        if (error instanceof Error && error.message === 'ROOM_NOT_FOUND') {
          return reply.code(404).send({ error: 'NOT_FOUND', message: '房间不存在' });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string; playerId: string } }>(
    '/api/admin/rooms/:id/players/:playerId/kick',
    async (request, reply) => {
      const admin = await requireAdmin(request, reply, repository);
      if (!admin) return;
      const parsed = adminKickPlayerSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendValidationError(reply, parsed.error.issues);
      }
      try {
        const result = await rooms.adminKickPlayer(
          request.params.id,
          admin.id,
          request.params.playerId,
          parsed.data.reason,
          parsed.data.operationId ?? randomUUID(),
        );
        if (!result.ok) {
          return reply
            .code(result.code === 'NOT_FOUND' ? 404 : 409)
            .send({ error: result.code, message: result.message });
        }
        return result;
      } catch (error) {
        if (error instanceof Error && error.message === 'ROOM_NOT_FOUND') {
          return reply.code(404).send({ error: 'NOT_FOUND', message: '房间不存在' });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string; playerId: string } }>(
    '/api/admin/rooms/:id/players/:playerId/restore',
    async (request, reply) => {
      const admin = await requireAdmin(request, reply, repository);
      if (!admin) return;
      const parsed = adminRestorePlayerSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendValidationError(reply, parsed.error.issues);
      }
      try {
        const result = await rooms.adminReinstatePlayer(
          request.params.id,
          admin.id,
          request.params.playerId,
          parsed.data.operationId ?? randomUUID(),
        );
        if (!result.ok) {
          return reply
            .code(result.code === 'NOT_FOUND' ? 404 : 409)
            .send({ error: result.code, message: result.message });
        }
        return result;
      } catch (error) {
        if (error instanceof Error && error.message === 'ROOM_NOT_FOUND') {
          return reply.code(404).send({ error: 'NOT_FOUND', message: '房间不存在' });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/admin/rooms/:id/players', async (request, reply) => {
    const admin = await requireAdmin(request, reply, repository);
    if (!admin) return;
    const parsed = addRoomMemberSchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, parsed.error.issues);
    try {
      const membership = await repository.addUserToRoom(
        request.params.id,
        parsed.data.userId,
        parsed.data.nickname,
        'ADMIN',
        admin.id,
      );
      await rooms.refreshPlayers(membership.roomId);
      return reply.code(201).send(membership);
    } catch (error) {
      if (error instanceof Error && ['ROOM_NOT_FOUND', 'USER_NOT_FOUND'].includes(error.message)) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: '房间或账号不存在' });
      }
      if (error instanceof Error && error.message === 'ROOM_FULL') {
        return reply.code(409).send({ error: 'ROOM_FULL', message: '房间已满' });
      }
      if (error instanceof Error && error.message === 'NICKNAME_TAKEN') {
        return reply.code(409).send({ error: 'NICKNAME_TAKEN', message: '昵称已被使用' });
      }
      if (error instanceof Error && error.message === 'INVALID_NICKNAME') {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: '昵称格式无效' });
      }
      if (error instanceof Error && error.message === 'MEMBERSHIP_KICKED') {
        return reply
          .code(409)
          .send({ error: 'MEMBERSHIP_KICKED', message: '该账号已被踢出，请先恢复' });
      }
      if (error instanceof Error && error.message === 'MEMBERSHIP_CONFLICT') {
        return reply.code(409).send({ error: 'MEMBERSHIP_CONFLICT', message: '账号已在房间中' });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>(
    '/api/admin/rooms/:id/play-as-self',
    async (request, reply) => {
      const admin = await requireAdmin(request, reply, repository);
      if (!admin) return;
      const parsed = adminPlayAsSelfSchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendValidationError(reply, parsed.error.issues);
      const user = await repository.ensureAdminPlayerAccount(admin);
      try {
        const membership = await repository.addUserToRoom(
          request.params.id,
          user.id,
          parsed.data.nickname,
          'ADMIN',
          admin.id,
        );
        await rooms.refreshPlayers(membership.roomId);
        const token = await repository.createUserSession(user.id);
        reply.setCookie(USER_COOKIE, token, cookieOptions);
        return reply.code(201).send({ ...membership, user });
      } catch (error) {
        if (error instanceof Error && error.message === 'ROOM_NOT_FOUND') {
          return reply.code(404).send({ error: 'NOT_FOUND', message: '房间不存在' });
        }
        if (error instanceof Error && error.message === 'ROOM_FULL') {
          return reply.code(409).send({ error: 'ROOM_FULL', message: '房间已满' });
        }
        if (error instanceof Error && error.message === 'NICKNAME_TAKEN') {
          return reply.code(409).send({ error: 'NICKNAME_TAKEN', message: '昵称已被使用' });
        }
        if (error instanceof Error && error.message === 'INVALID_NICKNAME') {
          return reply.code(400).send({ error: 'BAD_REQUEST', message: '昵称格式无效' });
        }
        if (error instanceof Error && error.message === 'MEMBERSHIP_KICKED') {
          return reply.code(409).send({ error: 'MEMBERSHIP_KICKED', message: '该身份已被踢出' });
        }
        throw error;
      }
    },
  );

  app.post('/api/admin/rooms', async (request, reply) => {
    const admin = await requireAdmin(request, reply, repository);
    if (!admin) return;
    const parsed = createRoomSchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, parsed.error.issues);
    const created = await repository.createRoom(admin, parsed.data.name, parsed.data.settings);
    return reply.code(201).send({
      roomId: created.roomId,
      inviteUrl: `${config.PUBLIC_ORIGIN}/join/${created.inviteToken}`,
    });
  });

  app.post<{ Params: { id: string } }>('/api/admin/rooms/:id/invite', async (request, reply) => {
    const admin = await requireAdmin(request, reply, repository);
    if (!admin) return;
    try {
      const token = await repository.rotateInvite(request.params.id, admin.id);
      return { inviteUrl: `${config.PUBLIC_ORIGIN}/join/${token}` };
    } catch (error) {
      if (error instanceof Error && error.message === 'ROOM_NOT_FOUND') {
        return reply.code(404).send({ error: 'NOT_FOUND', message: '房间不存在' });
      }
      if (error instanceof Error && error.message === 'ROOM_ARCHIVED') {
        return reply.code(409).send({ error: 'ROOM_ARCHIVED', message: '已归档房间不能生成邀请' });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>('/api/admin/rooms/:id/archive', async (request, reply) => {
    const admin = await requireAdmin(request, reply, repository);
    if (!admin) return;
    try {
      const archived = await rooms.adminArchive(request.params.id, admin.id);
      if (!archived) {
        return reply
          .code(409)
          .send({ error: 'ACTIVE_HAND', message: '进行中的手牌只能使用强制中止并退款' });
      }
      return { ok: true };
    } catch (error) {
      if (error instanceof Error && error.message === 'ROOM_NOT_FOUND') {
        return reply.code(404).send({ error: 'NOT_FOUND' });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>(
    '/api/admin/rooms/:id/force-abort',
    async (request, reply) => {
      const admin = await requireAdmin(request, reply, repository);
      if (!admin) return;
      try {
        await rooms.adminForceAbort(request.params.id, admin.id);
        return { ok: true, refunded: true, archived: true };
      } catch (error) {
        if (error instanceof Error && error.message === 'ROOM_NOT_FOUND') {
          return reply.code(404).send({ error: 'NOT_FOUND' });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/rooms/:id/enter', async (request, reply) => {
    const user = await requireUser(request, reply, repository);
    if (!user) return;
    const parsed = joinRoomSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendValidationError(reply, parsed.error.issues);
    try {
      const joined = await repository.addUserToRoom(
        request.params.id,
        user.id,
        parsed.data.nickname,
        'SELF',
      );
      await rooms.refreshPlayers(joined.roomId);
      return reply.code(201).send(joined);
    } catch (error) {
      if (error instanceof Error && error.message === 'ROOM_NOT_FOUND') {
        return reply.code(404).send({ error: 'ROOM_NOT_FOUND', message: '牌桌不存在或已结束' });
      }
      if (error instanceof Error && error.message === 'ROOM_FULL') {
        return reply.code(409).send({ error: 'ROOM_FULL', message: '牌桌已经坐满了' });
      }
      if (error instanceof Error && error.message === 'NICKNAME_TAKEN') {
        return reply.code(409).send({ error: 'NICKNAME_TAKEN', message: '桌上已有相同昵称' });
      }
      if (error instanceof Error && error.message === 'INVALID_NICKNAME') {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: '昵称格式无效' });
      }
      if (error instanceof Error && error.message === 'MEMBERSHIP_KICKED') {
        return reply.code(409).send({
          error: 'MEMBERSHIP_KICKED',
          message: '你暂时不能重新加入这张牌桌',
        });
      }
      if (error instanceof Error && error.message === 'MEMBERSHIP_CONFLICT') {
        return reply.code(409).send({ error: 'MEMBERSHIP_CONFLICT', message: '你已经在这张牌桌' });
      }
      throw error;
    }
  });

  app.post<{ Params: { token: string } }>('/api/rooms/:token/join', async (request, reply) => {
    const user = await requireUser(request, reply, repository);
    if (!user) return;
    const parsed = joinRoomSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendValidationError(reply, parsed.error.issues);
    try {
      const joined = await repository.joinByInvite(
        request.params.token,
        user.id,
        parsed.data.nickname,
      );
      if (!joined)
        return reply.code(404).send({ error: 'INVITE_NOT_FOUND', message: '邀请无效或已过期' });
      await rooms.refreshPlayers(joined.roomId);
      return reply.code(201).send(joined);
    } catch (error) {
      if (error instanceof Error && error.message === 'ROOM_FULL') {
        return reply.code(409).send({ error: 'ROOM_FULL', message: '房间已满' });
      }
      if (error instanceof Error && error.message === 'NICKNAME_TAKEN') {
        return reply.code(409).send({ error: 'NICKNAME_TAKEN', message: '昵称已被使用' });
      }
      if (error instanceof Error && error.message === 'INVALID_NICKNAME') {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: '昵称格式无效' });
      }
      if (error instanceof Error && error.message === 'MEMBERSHIP_KICKED') {
        return reply.code(409).send({ error: 'MEMBERSHIP_KICKED', message: '你已被该房间踢出' });
      }
      if (error instanceof Error && error.message === 'MEMBERSHIP_CONFLICT') {
        return reply.code(409).send({ error: 'MEMBERSHIP_CONFLICT', message: '你已加入该房间' });
      }
      throw error;
    }
  });

  app.get<{ Params: { token: string } }>(
    '/api/rooms/:token/invite-preview',
    async (request, reply) => {
      const preview = await repository.invitePreview(request.params.token);
      if (!preview)
        return reply.code(404).send({ error: 'INVITE_NOT_FOUND', message: '邀请无效或已过期' });
      return preview;
    },
  );

  /** @deprecated Prefer /api/auth/session and /api/me/rooms. */
  app.get('/api/player/session', async (request, reply) => {
    const user = await requireUser(request, reply, repository, true);
    return user ?? undefined;
  });

  app.get<{ Params: { id: string } }>('/api/rooms/:id', async (request, reply) => {
    const user = await requireUser(request, reply, repository);
    if (!user) return;
    const player = await repository.getPlayerForUser(user.id, request.params.id);
    if (!player) {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
    try {
      return await rooms.snapshot(request.params.id, player.id);
    } catch (error) {
      request.log.error(
        { failure: safeErrorLogContext(error), roomId: request.params.id },
        'room snapshot recovery failed',
      );
      return reply
        .code(503)
        .send({ error: 'ROOM_FROZEN', message: '牌局恢复失败，已冻结等待处理' });
    }
  });

  app.get<{ Params: { id: string } }>('/api/rooms/:id/history', async (request, reply) => {
    const [user, admin] = await Promise.all([
      repository.getUserBySession(request.cookies[USER_COOKIE]),
      repository.getAdminBySession(request.cookies[ADMIN_COOKIE]),
    ]);
    const player =
      user && !user.mustChangePassword
        ? await repository.getPlayerForUser(user.id, request.params.id)
        : null;
    if (!admin && !player) {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
    return repository.history(request.params.id);
  });
}

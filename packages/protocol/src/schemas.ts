import { z } from 'zod';

const integerAmount = z.number().int().nonnegative().max(1_000_000_000);
export const identifierSchema = z.string().uuid();
export const inviteTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/, '邀请码格式无效');
const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9_.-]+$/, '账号只能包含字母、数字、点、下划线和短横线');
const userPasswordSchema = z.string().min(12).max(256);
const nicknameSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value), '昵称不能包含控制字符');

export const roomModeSchema = z.enum(['ONLINE', 'LIVE']);
export const playerActionSchema = z.enum(['FOLD', 'CHECK', 'CALL', 'BET_TO', 'RAISE_TO', 'ALL_IN']);

export const roomSettingsSchema = z
  .object({
    mode: roomModeSchema,
    smallBlind: z.number().int().positive().max(1_000_000),
    bigBlind: z.number().int().positive().max(2_000_000),
    startingStack: z.number().int().positive().max(1_000_000_000),
    stackCap: z.number().int().positive().max(1_000_000_000),
    actionTimeoutSeconds: z.number().int().min(10).max(180),
    resultDisplaySeconds: z.number().int().min(1).max(30).default(3),
    nextHandCountdownSeconds: z.number().int().min(1).max(30).default(5),
    maxPlayers: z.literal(6).default(6),
  })
  .superRefine((value, ctx) => {
    if (value.bigBlind < value.smallBlind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bigBlind'],
        message: '大盲必须不小于小盲',
      });
    }
    if (value.stackCap < value.startingStack) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stackCap'],
        message: '补充上限不能低于起始筹码',
      });
    }
  });

export const adminLoginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(8).max(256),
});

export const userLoginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(256),
});

export const changeUserPasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: userPasswordSchema,
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    path: ['newPassword'],
    message: '新密码不能与当前密码相同',
  });

export const createUserAccountSchema = z
  .object({
    username: usernameSchema,
    displayName: nicknameSchema.optional(),
    password: userPasswordSchema,
  })
  .superRefine((value, ctx) => {
    if (!value.displayName && value.username.length > 20) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['displayName'],
        message: '账号超过 20 位时必须填写 20 位以内的显示名称',
      });
    }
  });

export const resetUserPasswordSchema = z.object({ password: userPasswordSchema });

export const addRoomMemberSchema = z.object({
  userId: identifierSchema,
  nickname: nicknameSchema.optional(),
});

export const adminPlayAsSelfSchema = z.object({ nickname: nicknameSchema.optional() });

export const adminAdjustStackSchema = z.object({
  stack: integerAmount,
  reason: z.string().trim().min(1).max(120),
  operationId: identifierSchema.optional(),
});

export const adminKickPlayerSchema = z.object({
  reason: z.string().trim().min(1).max(120).default('管理员移出'),
  operationId: identifierSchema.optional(),
});

export const adminRestorePlayerSchema = z.object({ operationId: identifierSchema.optional() });

export const createRoomSchema = z.object({
  name: z.string().trim().min(1).max(48),
  settings: roomSettingsSchema,
});

export const joinRoomSchema = z.object({
  nickname: nicknameSchema.optional(),
});

export const commandBaseSchema = z.object({
  commandId: identifierSchema,
  expectedSeq: z.number().int().nonnegative(),
  turnToken: z.string().min(16).max(256).optional(),
});

export const seatClaimCommandSchema = commandBaseSchema.extend({
  payload: z.object({ seat: z.number().int().min(0).max(5) }),
});

export const emptyCommandSchema = commandBaseSchema.extend({ payload: z.object({}) });

export const topUpCommandSchema = commandBaseSchema.extend({
  payload: z.object({ targetStack: integerAmount }),
});

export const handActionCommandSchema = commandBaseSchema.extend({
  turnToken: z.string().min(16).max(256),
  payload: z.object({
    action: playerActionSchema,
    amountTo: integerAmount.optional(),
  }),
});

export const liveStreetDealtCommandSchema = commandBaseSchema.extend({
  payload: z.object({ street: z.enum(['FLOP', 'TURN', 'RIVER']) }),
});

export const liveResultProposeCommandSchema = commandBaseSchema.extend({
  payload: z.object({
    winnersByPot: z.record(z.string().min(1), z.array(identifierSchema).min(1).max(6)),
  }),
});

export const liveResultProposalIdCommandSchema = commandBaseSchema.extend({
  payload: z.object({ proposalId: identifierSchema }),
});

export type AdminLoginInput = z.infer<typeof adminLoginSchema>;
export type UserLoginInput = z.infer<typeof userLoginSchema>;
export type ChangeUserPasswordInput = z.infer<typeof changeUserPasswordSchema>;
export type CreateUserAccountInput = z.infer<typeof createUserAccountSchema>;
export type ResetUserPasswordInput = z.infer<typeof resetUserPasswordSchema>;
export type AddRoomMemberInput = z.infer<typeof addRoomMemberSchema>;
export type AdminPlayAsSelfInput = z.infer<typeof adminPlayAsSelfSchema>;
export type AdminAdjustStackInput = z.infer<typeof adminAdjustStackSchema>;
export type AdminKickPlayerInput = z.infer<typeof adminKickPlayerSchema>;
export type AdminRestorePlayerInput = z.infer<typeof adminRestorePlayerSchema>;
export type CreateRoomInput = z.infer<typeof createRoomSchema>;
export type JoinRoomInput = z.infer<typeof joinRoomSchema>;
export type SeatClaimCommand = z.infer<typeof seatClaimCommandSchema>;
export type EmptyCommand = z.infer<typeof emptyCommandSchema>;
export type TopUpCommand = z.infer<typeof topUpCommandSchema>;
export type HandActionCommand = z.infer<typeof handActionCommandSchema>;
export type LiveStreetDealtCommand = z.infer<typeof liveStreetDealtCommandSchema>;
export type LiveResultProposeCommand = z.infer<typeof liveResultProposeCommandSchema>;
export type LiveResultProposalIdCommand = z.infer<typeof liveResultProposalIdCommandSchema>;

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { AdminRoomSummary, RoomMode } from '@poker-with-friends/protocol';
import {
  api,
  type AdminRoomPlayerSummary,
  type AdminSession,
  type AdminUserSummary,
  type CreateRoomResponse,
} from '../api';
import { Icon } from '../icons';
import { formatPoints, statusLabel } from '../poker-ui';
import { navigate } from '../navigation';
import { Brand, ErrorBox, Loading, Modal, ModeBadge } from '../components/ui';

export function AdminPage() {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [checking, setChecking] = useState(true);
  const [rooms, setRooms] = useState<AdminRoomSummary[]>([]);
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [tab, setTab] = useState<'rooms' | 'accounts'>('rooms');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [selectedRoom, setSelectedRoom] = useState<AdminRoomSummary | null>(null);
  const [roomPlayers, setRoomPlayers] = useState<AdminRoomPlayerSummary[]>([]);
  const [roomPlayersLoading, setRoomPlayersLoading] = useState(false);
  const [roomPlayersError, setRoomPlayersError] = useState<string | null>(null);
  const [latestInvite, setLatestInvite] = useState<{ roomId: string; url: string } | null>(null);
  const [inviteCopyStatus, setInviteCopyStatus] = useState<'idle' | 'copied'>('idle');
  const [rotatingRoomId, setRotatingRoomId] = useState<string | null>(null);
  const [registrationInvite, setRegistrationInvite] = useState<string | null>(null);
  const [registrationInviteLoading, setRegistrationInviteLoading] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const loadRooms = async () => setRooms(await api<AdminRoomSummary[]>('/api/admin/rooms'));
  const loadUsers = async () => setUsers(await api<AdminUserSummary[]>('/api/admin/users'));
  const loadRoomPlayers = async (roomId: string) =>
    setRoomPlayers(await api<AdminRoomPlayerSummary[]>(`/api/admin/rooms/${roomId}/players`));
  const createRegistrationInvite = async () => {
    if (registrationInviteLoading) return;
    setRegistrationInviteLoading(true);
    try {
      const result = await api<{ code: string }>('/api/admin/registration-invites', {
        method: 'POST',
      });
      setRegistrationInvite(result.code);
      await navigator.clipboard?.writeText(result.code).catch(() => undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '生成注册邀请码失败');
    } finally {
      setRegistrationInviteLoading(false);
    }
  };
  useEffect(() => {
    api<AdminSession>('/api/admin/session')
      .then((admin) => {
        setSession(admin);
        return Promise.all([loadRooms(), loadUsers()]).catch((caught) =>
          setError(caught instanceof Error ? caught.message : '管理数据加载失败'),
        );
      })
      .catch(() => setSession(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <Loading label="正在加载管理页面…" />;
  if (!session) {
    return (
      <AdminLogin
        error={error}
        onSubmit={async (username, password) => {
          try {
            const admin = await api<AdminSession>('/api/admin/login', {
              method: 'POST',
              body: JSON.stringify({ username, password }),
            });
            setSession(admin);
            setError(null);
            await Promise.all([loadRooms(), loadUsers()]);
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : '登录失败');
          }
        }}
      />
    );
  }

  const rotateInvite = async (roomId: string) => {
    if (rotatingRoomId) return;
    setRotatingRoomId(roomId);
    try {
      const result = await api<{ inviteUrl: string }>(`/api/admin/rooms/${roomId}/invite`, {
        method: 'POST',
      });
      setLatestInvite({ roomId, url: result.inviteUrl });
      setInviteCopyStatus('idle');
      if (navigator.clipboard) {
        await navigator.clipboard
          .writeText(result.inviteUrl)
          .then(() => setInviteCopyStatus('copied'))
          .catch(() => undefined);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '生成邀请失败');
    } finally {
      setRotatingRoomId(null);
    }
  };

  const archive = async (room: AdminRoomSummary, force = false) => {
    const question = force ? '将退回本手全部投入并归档牌桌，确定继续？' : '确定归档该牌桌？';
    if (!window.confirm(question)) return;
    try {
      await api(`/api/admin/rooms/${room.id}/${force ? 'force-abort' : 'archive'}`, {
        method: 'POST',
      });
      await loadRooms();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '操作失败');
    }
  };

  return (
    <main className="dashboard-page real-admin">
      <header className="dashboard-header page-container">
        <Brand />
        <div className="admin-header-actions">
          <button
            className="profile-button"
            aria-label={`编辑管理员资料 ${session.displayName ?? session.username}`}
            title="账号设置"
            onClick={() => setProfileOpen(true)}
          >
            <span>
              <small>{session.displayName ?? '管理员'}</small>
              <strong>@{session.username}</strong>
            </span>
            <b className="admin-avatar">
              <Icon name="settings" size={18} />
            </b>
          </button>
          <button
            className="icon-button"
            aria-label="退出管理员账号"
            title="退出管理员账号"
            onClick={async () => {
              try {
                await api('/api/admin/logout', { method: 'POST' });
                setSession(null);
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : '退出登录失败');
              }
            }}
          >
            <Icon name="logout" size={18} />
          </button>
        </div>
      </header>
      <div className="page-container dashboard-content">
        <section className="welcome-row">
          <div>
            <h1>{tab === 'rooms' ? '牌桌管理' : '账号管理'}</h1>
          </div>
          <div className="welcome-actions">
            <button
              className="secondary-button"
              onClick={() => void createRegistrationInvite()}
              disabled={registrationInviteLoading}
            >
              <Icon name="key" size={17} />{' '}
              {registrationInviteLoading ? '生成中…' : '生成注册邀请码'}
            </button>
            {tab === 'rooms' && (
              <button
                className="create-button"
                onClick={() => {
                  setError(null);
                  setCreating(true);
                }}
              >
                <Icon name="plus" size={18} /> 新建牌桌
              </button>
            )}
          </div>
        </section>
        <nav className="admin-tabs" aria-label="管理区">
          <button
            aria-pressed={tab === 'rooms'}
            className={tab === 'rooms' ? 'active' : ''}
            onClick={() => setTab('rooms')}
          >
            <Icon name="table" size={17} /> 牌桌 <span>{rooms.length}</span>
          </button>
          <button
            aria-pressed={tab === 'accounts'}
            className={tab === 'accounts' ? 'active' : ''}
            onClick={() => setTab('accounts')}
          >
            <Icon name="users" size={17} /> 账号 <span>{users.length}</span>
          </button>
        </nav>
        {error && <ErrorBox onClose={() => setError(null)}>{error}</ErrorBox>}
        {latestInvite && (
          <div className="invite-output">
            <div>
              <small role="status" aria-live="polite">
                {inviteCopyStatus === 'copied' ? '邀请链接已复制' : '邀请链接已更新'}
              </small>
              <code>{latestInvite.url}</code>
            </div>
            <button
              onClick={() => {
                if (!navigator.clipboard) {
                  setError('当前浏览器无法自动复制，请长按或选中邀请链接手动复制');
                  return;
                }
                setInviteCopyStatus('idle');
                void navigator.clipboard
                  .writeText(latestInvite.url)
                  .then(() => setInviteCopyStatus('copied'))
                  .catch(() => setError('复制失败，请长按或选中邀请链接手动复制'));
              }}
            >
              {inviteCopyStatus === 'copied' ? '已复制' : '复制'}
            </button>
          </div>
        )}
        {registrationInvite && (
          <div className="invite-output">
            <div>
              <small role="status">注册邀请码（已复制）</small>
              <code>{registrationInvite}</code>
            </div>
            <button onClick={() => setRegistrationInvite(null)}>知道了</button>
          </div>
        )}
        {tab === 'rooms' ? (
          <section className="real-room-grid">
            {rooms.map((room) => (
              <article className="room-card" key={room.id}>
                <div className="room-card-top">
                  <ModeBadge mode={room.mode} />
                  <span className={`status-pill status-pill--${room.status.toLowerCase()}`}>
                    {statusLabel[room.status] ?? room.status}
                  </span>
                </div>
                <div className="real-room-title">
                  <span>
                    <Icon name={room.mode === 'ONLINE' ? 'cards' : 'table'} size={21} />
                  </span>
                  <div>
                    <h2>{room.name}</h2>
                    <p>
                      第 {room.handNumber} 手 · {room.playerCount}/6 人
                    </p>
                  </div>
                </div>
                <div className="room-card-actions real-admin-actions">
                  <button onClick={() => navigate(`/room/${room.id}?view=public`)}>
                    <Icon name="eye" size={15} /> 旁观
                  </button>
                  <button
                    onClick={() => {
                      setRoomPlayers([]);
                      setRoomPlayersError(null);
                      setRoomPlayersLoading(true);
                      setSelectedRoom(room);
                      void loadRoomPlayers(room.id)
                        .catch((caught) =>
                          setRoomPlayersError(
                            caught instanceof Error ? caught.message : '玩家列表加载失败',
                          ),
                        )
                        .finally(() => setRoomPlayersLoading(false));
                    }}
                  >
                    <Icon name="users" size={15} /> 玩家与筹码
                  </button>
                  <button
                    disabled={rotatingRoomId !== null || room.status === 'ARCHIVED'}
                    onClick={() => void rotateInvite(room.id)}
                  >
                    <Icon name="copy" size={15} />{' '}
                    {rotatingRoomId === room.id ? '生成中…' : '邀请链接'}
                  </button>
                  {room.status !== 'ARCHIVED' &&
                    room.status !== 'ACTIVE' &&
                    room.status !== 'DISPUTED' && (
                      <button onClick={() => void archive(room)}>归档牌桌</button>
                    )}
                  {(room.status === 'ACTIVE' || room.status === 'DISPUTED') && (
                    <button className="danger-button" onClick={() => void archive(room, true)}>
                      退回本手并结束牌桌
                    </button>
                  )}
                </div>
              </article>
            ))}
            {rooms.length === 0 && <div className="empty-state">暂无牌桌</div>}
          </section>
        ) : (
          <AccountsPanel
            users={users}
            onReset={async (user) => {
              const result = await api<{ temporaryPassword: string }>(
                `/api/admin/users/${user.id}/reset-password`,
                {
                  method: 'POST',
                  body: JSON.stringify({}),
                },
              );
              await loadUsers();
              return result;
            }}
          />
        )}
      </div>
      {creating && (
        <CreateRoomDialog
          onClose={() => setCreating(false)}
          onCreate={async (body) => {
            const created = await api<CreateRoomResponse>('/api/admin/rooms', {
              method: 'POST',
              body: JSON.stringify(body),
            });
            setLatestInvite({ roomId: created.roomId, url: created.inviteUrl });
            setInviteCopyStatus('idle');
            if (navigator.clipboard) {
              await navigator.clipboard
                .writeText(created.inviteUrl)
                .then(() => setInviteCopyStatus('copied'))
                .catch(() => undefined);
            }
            await loadRooms().catch((caught) =>
              setError(caught instanceof Error ? caught.message : '牌桌已创建，列表刷新失败'),
            );
            setCreating(false);
          }}
        />
      )}
      {selectedRoom && (
        <RoomPlayersDialog
          room={selectedRoom}
          users={users}
          players={roomPlayers}
          loading={roomPlayersLoading}
          error={roomPlayersError}
          onClose={() => {
            setSelectedRoom(null);
            setRoomPlayersError(null);
          }}
          onRefresh={() => loadRoomPlayers(selectedRoom.id)}
          onError={setRoomPlayersError}
        />
      )}
      {profileOpen && (
        <AdminProfileDialog
          admin={session}
          onClose={() => setProfileOpen(false)}
          onSaved={(updated) => {
            setSession(updated);
            setProfileOpen(false);
          }}
        />
      )}
    </main>
  );
}

function AdminLogin({
  error,
  onSubmit,
}: {
  error: string | null;
  onSubmit: (username: string, password: string) => Promise<void>;
}) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  return (
    <main className="login-page">
      <section className="login-card">
        <Brand />
        <div className="login-heading">
          <h1>管理员登录</h1>
        </div>
        {error && <ErrorBox>{error}</ErrorBox>}
        <form
          className="login-form"
          onSubmit={(event) => {
            event.preventDefault();
            setPending(true);
            void onSubmit(username, password).finally(() => setPending(false));
          }}
        >
          <label className="field">
            <span>账号</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
            />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              autoFocus
            />
          </label>
          <button className="primary-button" disabled={pending || !password}>
            {pending ? '正在登录…' : '登录'}
          </button>
        </form>
      </section>
    </main>
  );
}

function AdminProfileDialog({
  admin,
  onClose,
  onSaved,
}: {
  admin: AdminSession;
  onClose: () => void;
  onSaved: (admin: AdminSession) => void;
}) {
  const [displayName, setDisplayName] = useState(admin.displayName ?? admin.username);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordChange = newPassword.length > 0;
  const valid =
    displayName.trim().length > 0 &&
    displayName.trim().length <= 20 &&
    (!currentPassword || (passwordChange && newPassword.length >= 6)) &&
    (!passwordChange || currentPassword.length > 0);
  return (
    <Modal title="管理员账号设置" onClose={onClose} locked={pending}>
      {error && <ErrorBox onClose={() => setError(null)}>{error}</ErrorBox>}
      <form
        className="sheet-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          setPending(true);
          void api<AdminSession>('/api/admin/profile', {
            method: 'PATCH',
            body: JSON.stringify({
              displayName: displayName.trim(),
              ...(passwordChange ? { currentPassword, newPassword } : {}),
            }),
          })
            .then(onSaved)
            .catch((caught) => setError(caught instanceof Error ? caught.message : '保存失败'))
            .finally(() => setPending(false));
        }}
      >
        <label className="field">
          <span>全局昵称</span>
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={20}
            autoFocus
          />
          {displayName.trim().length === 0 || displayName.trim().length > 20 ? (
            <small className="field-error">昵称需要 1–20 个字符。</small>
          ) : null}
        </label>
        <label className="field">
          <span>当前密码（修改密码时填写）</span>
          <input
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
          />
        </label>
        <label className="field">
          <span>新密码（可选）</span>
          <input
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            minLength={6}
          />
          {newPassword.length > 0 && newPassword.length < 6 && (
            <small className="field-error">密码至少需要 6 位。</small>
          )}
        </label>
        <button className="primary-button" disabled={pending || !valid}>
          {pending ? '保存中…' : '保存账号设置'}
        </button>
      </form>
    </Modal>
  );
}

function AccountsPanel({
  users,
  onReset,
}: {
  users: AdminUserSummary[];
  onReset: (user: AdminUserSummary) => Promise<{ temporaryPassword: string }>;
}) {
  const [resetting, setResetting] = useState<AdminUserSummary | null>(null);
  return (
    <section className="account-list">
      <header className="data-header">
        <span>玩家账号</span>
        <span>登录状态</span>
        <span />
      </header>
      {users.map((user) => (
        <article key={user.id}>
          <span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span>
          <span className="account-identity">
            <strong>{user.displayName}</strong>
            <small>
              @{user.username} · {formatPoints(user.chipBalance ?? 0)} 账户筹码 ·{' '}
              {new Date(user.createdAt).toLocaleDateString()}
            </small>
          </span>
          <span className={`account-state ${user.loginEnabled ? 'active' : ''}`}>
            {user.loginEnabled ? '可登录' : '已停用'}
          </span>
          <button className="secondary-button compact-button" onClick={() => setResetting(user)}>
            <Icon name="key" size={15} /> 重置密码
          </button>
        </article>
      ))}
      {users.length === 0 && <div className="empty-state">暂无玩家账号</div>}
      {resetting && (
        <ResetPasswordDialog
          user={resetting}
          onClose={() => setResetting(null)}
          onSubmit={() => onReset(resetting)}
        />
      )}
    </section>
  );
}

function ResetPasswordDialog({
  user,
  onClose,
  onSubmit,
}: {
  user: AdminUserSummary;
  onClose: () => void;
  onSubmit: () => Promise<{ temporaryPassword: string }>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);
  return (
    <Modal title={`重置 ${user.displayName} 的密码`} onClose={onClose}>
      {error && <ErrorBox>{error}</ErrorBox>}
      {temporaryPassword ? (
        <div className="reset-password-result">
          <p>新密码只显示这一次，请立即复制并安全转交给用户。</p>
          <code>{temporaryPassword}</code>
          <div className="modal-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => void navigator.clipboard?.writeText(temporaryPassword)}
            >
              复制密码
            </button>
            <button className="primary-button" type="button" onClick={onClose}>
              完成
            </button>
          </div>
        </div>
      ) : (
        <div className="sheet-form">
          <p className="form-hint">系统会生成一组随机密码，并使该账号的旧登录会话失效。</p>
          <button
            className="primary-button"
            type="button"
            disabled={pending}
            onClick={() => {
              setPending(true);
              void onSubmit()
                .then((result) => setTemporaryPassword(result.temporaryPassword))
                .catch((caught) => setError(caught instanceof Error ? caught.message : '重置失败'))
                .finally(() => setPending(false));
            }}
          >
            {pending ? '正在生成…' : '生成并重置密码'}
          </button>
        </div>
      )}
    </Modal>
  );
}

function RoomPlayersDialog({
  room,
  users,
  players,
  loading,
  error,
  onClose,
  onRefresh,
  onError,
}: {
  room: AdminRoomSummary;
  users: AdminUserSummary[];
  players: AdminRoomPlayerSummary[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const availableUsers = useMemo(() => {
    const assigned = new Set(players.map((player) => player.userId));
    return users.filter((user) => user.loginEnabled && !assigned.has(user.id));
  }, [players, users]);
  const [userId, setUserId] = useState(availableUsers[0]?.id ?? '');
  const [chipPlayer, setChipPlayer] = useState<AdminRoomPlayerSummary | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!availableUsers.some((user) => user.id === userId)) {
      setUserId(availableUsers[0]?.id ?? '');
    }
  }, [availableUsers, userId]);

  const mutate = async (path: string, body?: unknown): Promise<boolean> => {
    setPending(true);
    try {
      await api(path, {
        method: 'POST',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      await onRefresh().catch((caught) =>
        onError(
          caught instanceof Error
            ? `操作已成功，但列表刷新失败：${caught.message}`
            : '操作已成功，但列表刷新失败',
        ),
      );
      return true;
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : '管理操作失败');
      return false;
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal title={`${room.name} · 玩家与筹码`} onClose={onClose}>
      {error && <ErrorBox onClose={() => onError(null)}>{error}</ErrorBox>}
      <div className="room-player-tools">
        <button
          className="secondary-button"
          onClick={() => navigate(`/room/${room.id}?view=public`)}
        >
          <Icon name="eye" size={16} /> 旁观
        </button>
      </div>
      <form
        className="assign-player"
        onSubmit={(event) => {
          event.preventDefault();
          if (!userId) return;
          void mutate(`/api/admin/rooms/${room.id}/players`, { userId }).then((ok) => {
            if (!ok) return;
            const next = availableUsers.find((user) => user.id !== userId);
            setUserId(next?.id ?? '');
          });
        }}
      >
        <label className="field">
          <span>添加玩家</span>
          <select
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            disabled={!availableUsers.length}
          >
            {availableUsers.map((user) => (
              <option value={user.id} key={user.id}>
                {user.displayName} (@{user.username})
              </option>
            ))}
          </select>
        </label>
        <button className="primary-button" disabled={!userId || pending}>
          <Icon name="plus" size={16} /> 添加
        </button>
      </form>
      <div className="room-player-list">
        {loading && (
          <div className="empty-state" role="status">
            正在加载玩家…
          </div>
        )}
        {!loading &&
          players.map((player) => {
            const inactive = player.membershipStatus !== 'ACTIVE';
            return (
              <article key={player.playerId} className={inactive ? 'inactive' : ''}>
                <span className="avatar">{player.nickname.slice(0, 1).toUpperCase()}</span>
                <span className="player-identity">
                  <strong>{player.nickname}</strong>
                  <small>
                    @{player.username} ·{' '}
                    {player.seat === null ? '未选座' : `座位 ${player.seat + 1}`} ·{' '}
                    {player.connected ? '在线' : '离线'}
                  </small>
                </span>
                <span className="player-stack">
                  <small>筹码</small>
                  <strong>{formatPoints(player.stack)}</strong>
                </span>
                <span className="row-actions">
                  <button disabled={pending || inactive} onClick={() => setChipPlayer(player)}>
                    <Icon name="chip" size={15} /> 调整
                  </button>
                  {inactive ? (
                    <button
                      disabled={pending}
                      onClick={() =>
                        void mutate(
                          `/api/admin/rooms/${room.id}/players/${player.playerId}/restore`,
                          {},
                        )
                      }
                    >
                      <Icon name="refresh" size={15} /> 恢复
                    </button>
                  ) : (
                    <button
                      className="danger-link"
                      disabled={pending}
                      onClick={() => {
                        if (window.confirm(`确定将 ${player.nickname} 移出牌桌？`))
                          void mutate(
                            `/api/admin/rooms/${room.id}/players/${player.playerId}/kick`,
                            {
                              reason: '管理员移出牌桌',
                            },
                          );
                      }}
                    >
                      <Icon name="door" size={15} /> 移出
                    </button>
                  )}
                </span>
              </article>
            );
          })}
        {!loading && players.length === 0 && <div className="empty-state">暂无玩家</div>}
      </div>
      {chipPlayer && (
        <ChipDialog
          player={chipPlayer}
          onClose={() => setChipPlayer(null)}
          onSubmit={(stack, reason) =>
            mutate(`/api/admin/rooms/${room.id}/players/${chipPlayer.playerId}/chips`, {
              stack,
              targetStack: stack,
              reason,
            })
          }
        />
      )}
    </Modal>
  );
}

function ChipDialog({
  player,
  onClose,
  onSubmit,
}: {
  player: AdminRoomPlayerSummary;
  onClose: () => void;
  onSubmit: (stack: number, reason: string) => Promise<boolean>;
}) {
  const [stack, setStack] = useState(player.stack);
  const [reason, setReason] = useState('筹码校准');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`调整 ${player.nickname} 的筹码`} onClose={onClose}>
      {error && <ErrorBox onClose={() => setError(null)}>{error}</ErrorBox>}
      <form
        className="sheet-form"
        onSubmit={(event) => {
          event.preventDefault();
          setPending(true);
          setError(null);
          void onSubmit(stack, reason.trim())
            .then((ok) => {
              if (ok) onClose();
              else setError('筹码调整未成功，请检查牌局状态后重试');
            })
            .catch((caught) => setError(caught instanceof Error ? caught.message : '筹码调整失败'))
            .finally(() => setPending(false));
        }}
      >
        <label className="field">
          <span>调整后筹码</span>
          <input
            type="number"
            min="0"
            step="1"
            value={stack}
            onChange={(event) => setStack(Number(event.target.value))}
            required
            autoFocus
          />
        </label>
        <label className="field">
          <span>原因</span>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={120}
            required
          />
        </label>
        <button
          className="primary-button"
          disabled={pending || stack < 0 || !Number.isInteger(stack) || !reason.trim()}
        >
          {pending ? '正在保存…' : `保存为 ${formatPoints(stack)}`}
        </button>
      </form>
    </Modal>
  );
}

function CreateRoomDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [mode, setMode] = useState<RoomMode>('LIVE');
  const [name, setName] = useState('周末牌桌');
  const [smallBlind, setSmallBlind] = useState(10);
  const [bigBlind, setBigBlind] = useState(20);
  const [stack, setStack] = useState(5_000);
  const [timeout, setTimeoutValue] = useState(30);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid =
    name.trim().length > 0 &&
    smallBlind > 0 &&
    bigBlind >= smallBlind &&
    stack >= bigBlind * 20 &&
    timeout >= 10 &&
    timeout <= 180;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || pending) return;
    setPending(true);
    setError(null);
    void onCreate({
      name: name.trim(),
      settings: {
        mode,
        smallBlind,
        bigBlind,
        startingStack: stack,
        stackCap: stack,
        actionTimeoutSeconds: timeout,
        resultDisplaySeconds: 3,
        nextHandCountdownSeconds: 5,
        maxPlayers: 6,
      },
    })
      .catch((caught) => setError(caught instanceof Error ? caught.message : '创建牌桌失败'))
      .finally(() => setPending(false));
  };
  return (
    <Modal title="新建牌桌" onClose={onClose}>
      <form className="sheet-form" onSubmit={submit}>
        {error && <ErrorBox onClose={() => setError(null)}>{error}</ErrorBox>}
        <div className="mode-choice" role="radiogroup" aria-label="牌桌模式">
          {(['ONLINE', 'LIVE'] as const).map((item) => (
            <button
              type="button"
              role="radio"
              key={item}
              className={mode === item ? 'active' : ''}
              aria-checked={mode === item}
              tabIndex={mode === item ? 0 : -1}
              onClick={() => setMode(item)}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
                  return;
                }
                event.preventDefault();
                const nextMode = mode === 'ONLINE' ? 'LIVE' : 'ONLINE';
                setMode(nextMode);
                const radios =
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                    '[role="radio"]',
                  );
                radios?.[nextMode === 'ONLINE' ? 0 : 1]?.focus();
              }}
            >
              <b>
                <Icon name={item === 'ONLINE' ? 'cards' : 'table'} size={23} />
              </b>
              <span>{item === 'ONLINE' ? '线上牌桌' : '线下牌桌'}</span>
            </button>
          ))}
        </div>
        <label className="field">
          <span>牌桌名称</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={48}
            required
          />
        </label>
        <div className="form-grid">
          <label className="field">
            <span>小盲</span>
            <input
              type="number"
              min="1"
              value={smallBlind}
              onChange={(event) => setSmallBlind(+event.target.value)}
            />
          </label>
          <label className="field">
            <span>大盲</span>
            <input
              type="number"
              min={smallBlind}
              value={bigBlind}
              onChange={(event) => setBigBlind(+event.target.value)}
            />
          </label>
          <label className="field">
            <span>起始/补充上限</span>
            <input
              type="number"
              min={bigBlind * 20}
              value={stack}
              onChange={(event) => setStack(+event.target.value)}
            />
          </label>
          <label className="field">
            <span>行动秒数</span>
            <input
              type="number"
              min="10"
              max="180"
              value={timeout}
              onChange={(event) => setTimeoutValue(+event.target.value)}
            />
          </label>
        </div>
        <button className="primary-button" disabled={!valid || pending}>
          {pending ? '正在创建…' : '创建牌桌'}
        </button>
      </form>
    </Modal>
  );
}

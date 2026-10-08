import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { AdminRoomSummary, RoomMode, TablePosition } from '@poker-with-friends/protocol';
import {
  api,
  type AdminRoomPlayerSummary,
  type AdminAccountLedgerEntry,
  type AdminHandHistoryItem,
  type AdminSession,
  type AdminUserSummary,
  type CreateRoomResponse,
} from '../api';
import { Icon } from '../icons';
import { formatPoints, statusLabel } from '../poker-ui';
import { historyActions, historySettlement, naturalAction, phaseLabel } from '../poker-ui';
import { PlayingCard } from '../components/cards';
import { navigate } from '../navigation';
import { Brand, ErrorBox, Loading, Modal, ModeBadge } from '../components/ui';
import { ThemeModeSelect } from '../theme';

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
  const [accountChipUser, setAccountChipUser] = useState<AdminUserSummary | null>(null);
  const [accountLedgerUser, setAccountLedgerUser] = useState<AdminUserSummary | null>(null);
  const [historyRoom, setHistoryRoom] = useState<AdminRoomSummary | null>(null);

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
          <button className="secondary-button compact-button" onClick={() => navigate('/')}>
            返回大厅
          </button>
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
                  <span className="status-pill">
                    {room.visibility === 'PRIVATE' ? '私有' : '公开'}
                  </span>
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
                  <button onClick={() => setHistoryRoom(room)}>
                    <Icon name="history" size={15} /> 牌局历史
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
            onAdjust={(user) => setAccountChipUser(user)}
            onLedger={(user) => setAccountLedgerUser(user)}
            onDelete={async (user) => {
              await api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' });
              setUsers((current) => current.filter((item) => item.id !== user.id));
              await loadRooms().catch((caught) =>
                setError(
                  caught instanceof Error
                    ? `账号已删除，牌桌列表刷新失败：${caught.message}`
                    : '账号已删除，牌桌列表刷新失败',
                ),
              );
            }}
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
            setUsers((current) =>
              current.map((user) =>
                user.linkedAdminId === updated.id
                  ? {
                      ...user,
                      username: updated.username,
                      displayName: updated.displayName ?? updated.username,
                    }
                  : user,
              ),
            );
            setProfileOpen(false);
          }}
        />
      )}
      {accountChipUser && (
        <AccountChipDialog
          user={accountChipUser}
          onClose={() => setAccountChipUser(null)}
          onSaved={async () => {
            await loadUsers();
            setAccountChipUser(null);
          }}
        />
      )}
      {accountLedgerUser && (
        <AccountLedgerDialog user={accountLedgerUser} onClose={() => setAccountLedgerUser(null)} />
      )}
      {historyRoom && (
        <AdminHistoryDialog room={historyRoom} onClose={() => setHistoryRoom(null)} />
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
              name="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="section-admin-login username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              name="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="section-admin-login current-password"
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
  const [newPassword, setNewPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordChange = newPassword.length > 0;
  const valid =
    displayName.trim().length > 0 &&
    displayName.trim().length <= 20 &&
    (!passwordChange || (newPassword.length >= 6 && newPassword.length <= 256));
  return (
    <Modal title="管理员账号设置" onClose={onClose} locked={pending}>
      {error && <ErrorBox onClose={() => setError(null)}>{error}</ErrorBox>}
      <section className="settings-section">
        <div className="settings-section__heading">
          <strong>外观</strong>
          <small>颜色模式会保存在当前设备。</small>
        </div>
        <div className="settings-controls">
          <ThemeModeSelect />
        </div>
      </section>
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
              ...(passwordChange ? { newPassword } : {}),
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
          <span>新密码（可选）</span>
          <input
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            minLength={6}
            maxLength={256}
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
  onAdjust,
  onLedger,
  onReset,
  onDelete,
}: {
  users: AdminUserSummary[];
  onAdjust: (user: AdminUserSummary) => void;
  onLedger: (user: AdminUserSummary) => void;
  onReset: (user: AdminUserSummary) => Promise<{ temporaryPassword: string }>;
  onDelete: (user: AdminUserSummary) => Promise<void>;
}) {
  const [resetting, setResetting] = useState<AdminUserSummary | null>(null);
  const [deleting, setDeleting] = useState<AdminUserSummary | null>(null);
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
            <strong>
              {user.displayName}
              {user.linkedAdminId && <span className="account-admin-badge">管理员</span>}
            </strong>
            <small>
              @{user.username} · {formatPoints(user.chipBalance ?? 0)} 账户筹码 ·{' '}
              {new Date(user.createdAt).toLocaleDateString()}
            </small>
          </span>
          <span className={`account-state ${user.loginEnabled ? 'active' : ''}`}>
            {user.loginEnabled ? '可登录' : '已停用'}
          </span>
          <span className="account-row-actions">
            <button className="secondary-button compact-button" onClick={() => onAdjust(user)}>
              调整筹码
            </button>
            <button className="secondary-button compact-button" onClick={() => onLedger(user)}>
              筹码记录
            </button>
            {!user.linkedAdminId && (
              <>
                <button
                  className="secondary-button compact-button"
                  onClick={() => setResetting(user)}
                >
                  <Icon name="key" size={15} /> 重置密码
                </button>
                <button className="danger-button compact-button" onClick={() => setDeleting(user)}>
                  删除账号
                </button>
              </>
            )}
          </span>
        </article>
      ))}
      {users.length === 0 && <div className="empty-state">暂无玩家账号</div>}
      {deleting && (
        <DeleteAccountDialog
          user={deleting}
          onClose={() => setDeleting(null)}
          onSubmit={() => onDelete(deleting)}
        />
      )}
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

function DeleteAccountDialog({
  user,
  onClose,
  onSubmit,
}: {
  user: AdminUserSummary;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`删除 ${user.displayName} 的账号`} onClose={onClose} locked={pending}>
      {error && <ErrorBox onClose={() => setError(null)}>{error}</ErrorBox>}
      <p>
        确定删除 {user.displayName}（@{user.username}
        ）？删除后该账号将无法登录，历史牌局与筹码记录会保留。此操作无法撤销。
      </p>
      <p>如果该账号仍属于未结束的牌局，请先结束牌局再删除。</p>
      <div className="modal-actions">
        <button className="secondary-button" type="button" onClick={onClose} disabled={pending}>
          取消
        </button>
        <button
          className="danger-button"
          type="button"
          disabled={pending}
          onClick={() => {
            if (pending) return;
            setPending(true);
            setError(null);
            void onSubmit()
              .then(onClose)
              .catch((caught) =>
                setError(caught instanceof Error ? caught.message : '删除账号失败'),
              )
              .finally(() => setPending(false));
          }}
        >
          {pending ? '删除中…' : '确认删除账号'}
        </button>
      </div>
    </Modal>
  );
}

function AccountChipDialog({
  user,
  onClose,
  onSaved,
}: {
  user: AdminUserSummary;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [balance, setBalance] = useState(user.chipBalance ?? 0);
  const [reason, setReason] = useState('管理员调整账户筹码');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid =
    Number.isInteger(balance) &&
    balance >= 0 &&
    balance <= 1_000_000_000 &&
    reason.trim().length > 0;
  return (
    <Modal title={`调整 ${user.displayName} 的账户筹码`} onClose={onClose} locked={pending}>
      {error && <ErrorBox onClose={() => setError(null)}>{error}</ErrorBox>}
      <form
        className="sheet-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          setPending(true);
          void api<AdminUserSummary>(`/api/admin/users/${user.id}/chips`, {
            method: 'PATCH',
            body: JSON.stringify({ balance, reason: reason.trim() }),
          })
            .then(() => onSaved())
            .catch((caught) =>
              setError(caught instanceof Error ? caught.message : '账户筹码调整失败'),
            )
            .finally(() => setPending(false));
        }}
      >
        <p className="form-hint">
          当前余额 {formatPoints(user.chipBalance ?? 0)}
          。调整会写入账户流水，并同步刷新该用户所在的牌桌。
        </p>
        <label className="field">
          <span>调整后总筹码</span>
          <input
            type="number"
            min="0"
            max="1000000000"
            step="1"
            value={balance}
            onChange={(event) => setBalance(Number(event.target.value))}
            autoFocus
            required
          />
        </label>
        <label className="field">
          <span>调整原因</span>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={120}
            required
          />
        </label>
        <button className="primary-button" disabled={pending || !valid}>
          {pending ? '正在保存…' : `保存为 ${formatPoints(balance)}`}
        </button>
      </form>
    </Modal>
  );
}

function AccountLedgerDialog({ user, onClose }: { user: AdminUserSummary; onClose: () => void }) {
  const [entries, setEntries] = useState<AdminAccountLedgerEntry[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setStatus('loading');
    void api<AdminAccountLedgerEntry[]>(`/api/admin/users/${user.id}/chip-ledger`)
      .then((result) => {
        setEntries(result);
        setStatus('ready');
      })
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : '筹码记录加载失败');
        setStatus('error');
      });
  };
  useEffect(load, [user.id]);
  return (
    <Modal
      title={`${user.displayName} · 筹码变化记录`}
      onClose={onClose}
      className="chip-log-modal"
    >
      {status === 'loading' && <Loading label="正在加载筹码记录…" />}
      {status === 'error' && (
        <div className="history-state history-state--error">
          <ErrorBox>{error ?? '筹码记录加载失败'}</ErrorBox>
          <button className="secondary-button" onClick={load}>
            重试
          </button>
        </div>
      )}
      {status === 'ready' && (
        <div className="chip-log-list">
          <section>
            <header>
              <strong>账户流水</strong>
              <small>{entries.length} 条</small>
            </header>
            {entries.length === 0 ? (
              <p className="empty-state">暂无筹码变化记录</p>
            ) : (
              <ol>
                {entries.map((entry) => (
                  <li key={entry.id}>
                    <span>
                      <strong>{accountLedgerKindLabel(entry.kind)}</strong>
                      <small>
                        {new Date(entry.createdAt).toLocaleString('zh-CN')}
                        {entry.roomName ? ` · ${entry.roomName}` : ''}
                      </small>
                    </span>
                    <b className={entry.delta >= 0 ? 'positive' : 'negative'}>
                      {entry.delta >= 0 ? '+' : ''}
                      {formatPoints(entry.delta)}
                    </b>
                    <small>余额 {formatPoints(entry.balanceAfter)}</small>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}

function accountLedgerKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    ACCOUNT_INITIAL_GRANT: '初始账户筹码',
    ROOM_BUY_IN: '带入牌局',
    ROOM_TOP_UP: '牌桌补充',
    ADMIN_ACCOUNT_ADJUSTMENT: '管理员调整',
  };
  return labels[kind] ?? kind;
}

function AdminHistoryDialog({ room, onClose }: { room: AdminRoomSummary; onClose: () => void }) {
  const [items, setItems] = useState<AdminHandHistoryItem[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [expandedHandId, setExpandedHandId] = useState<string | null>(null);
  const load = () => {
    setStatus('loading');
    void api<AdminHandHistoryItem[]>(`/api/admin/rooms/${room.id}/history`)
      .then((result) => {
        setItems(result);
        setExpandedHandId(result[0]?.handId ?? null);
        setStatus('ready');
      })
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : '牌局历史加载失败');
        setStatus('error');
      });
  };
  useEffect(load, [room.id]);
  return (
    <Modal
      title={`${room.name} · 牌局历史`}
      onClose={onClose}
      className="history-modal admin-history-modal"
    >
      {status === 'loading' && <Loading label="正在加载牌局历史…" />}
      {status === 'error' && (
        <div className="history-state history-state--error">
          <ErrorBox>{error ?? '牌局历史加载失败'}</ErrorBox>
          <button className="secondary-button" onClick={load}>
            重试
          </button>
        </div>
      )}
      {status === 'ready' && (
        <div className="history-list">
          {items.map((hand) => {
            const { names, positions } = historyPeople(hand);
            const actions = historyActions(hand, names, positions);
            const settlement = historySettlement(hand.result);
            const expanded = expandedHandId === hand.handId;
            return (
              <article key={hand.handId} className={`history-hand ${expanded ? 'expanded' : ''}`}>
                <button
                  type="button"
                  className="history-hand__summary"
                  aria-expanded={expanded}
                  onClick={() => setExpandedHandId(expanded ? null : hand.handId)}
                >
                  <span className="history-hand__number">
                    <b>#{hand.handNumber}</b>
                    <time dateTime={hand.startedAt}>
                      {new Date(hand.startedAt).toLocaleString('zh-CN')}
                    </time>
                  </span>
                  <span className="history-hand__outcome">
                    <strong>
                      {settlement ? `${formatPoints(settlement.totalPot)} 筹码底池` : '进行中'}
                    </strong>
                    <small>{hand.cards ? '已保存完整牌面' : '仅有公开下注记录'}</small>
                  </span>
                  <ModeBadge mode={hand.mode} />
                  <Icon name="chevron" size={17} className="history-chevron" />
                </button>
                {expanded && (
                  <div className="history-hand__detail">
                    {!hand.cards && (
                      <p className="form-hint">
                        该牌局创建于完整牌面记录上线前，当前仅能查看公开下注和结算信息。
                      </p>
                    )}
                    {hand.cards && <AdminHandCards hand={hand} names={names} />}
                    {settlement && <AdminSettlement settlement={settlement} names={names} />}
                    <div className="history-streets">
                      {(['PREFLOP', 'FLOP', 'TURN', 'RIVER', 'SHOWDOWN'] as const).map((street) => {
                        const streetActions = actions.filter((action) => action.street === street);
                        if (!streetActions.length) return null;
                        return (
                          <section key={street}>
                            <h4>{phaseLabel[street]}</h4>
                            <ol>
                              {streetActions.map((action, index) => (
                                <li key={`${action.seq}-${index}`}>
                                  <span
                                    aria-hidden="true"
                                    className={`history-action-dot history-action-dot--${action.action.toLowerCase()}`}
                                  />
                                  <span className="history-action__copy">
                                    {naturalAction(action)}
                                  </span>
                                  {action.stackAfter !== undefined && (
                                    <small>余 {formatPoints(action.stackAfter)}</small>
                                  )}
                                </li>
                              ))}
                            </ol>
                          </section>
                        );
                      })}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
          {items.length === 0 && (
            <div className="history-state">
              <strong>暂无牌局记录</strong>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function historyPeople(hand: AdminHandHistoryItem) {
  const names = new Map<string, string>();
  const positions = new Map<string, TablePosition[]>();
  for (const event of hand.events) {
    const payload =
      event.publicPayload && typeof event.publicPayload === 'object'
        ? (event.publicPayload as Record<string, unknown>)
        : {};
    const participants = Array.isArray(payload.participants) ? payload.participants : [];
    for (const value of participants) {
      if (!value || typeof value !== 'object') continue;
      const participant = value as Record<string, unknown>;
      if (typeof participant.playerId !== 'string') continue;
      if (typeof participant.nickname === 'string')
        names.set(participant.playerId, participant.nickname);
      if (Array.isArray(participant.positions))
        positions.set(participant.playerId, participant.positions as TablePosition[]);
    }
  }
  return { names, positions };
}

function AdminHandCards({
  hand,
  names,
}: {
  hand: AdminHandHistoryItem;
  names: Map<string, string>;
}) {
  if (!hand.cards) return null;
  return (
    <section className="admin-history-cards" aria-label="完整牌面">
      <header>
        <strong>完整牌面</strong>
        <small>管理员可见</small>
      </header>
      <div className="admin-history-board">
        <span>公共牌</span>
        <div>
          {hand.cards.communityCards.length ? (
            hand.cards.communityCards.map((card, index) => (
              <PlayingCard key={`${card}-${index}`} card={card} compact still />
            ))
          ) : (
            <small>无公共牌</small>
          )}
        </div>
      </div>
      <ul>
        {hand.cards.participantIds.map((playerId) => (
          <li key={playerId}>
            <span>{names.get(playerId) ?? '玩家'}</span>
            <div>
              {(hand.cards?.holeCards[playerId] ?? []).map((card, index) => (
                <PlayingCard key={`${card}-${index}`} card={card} compact still />
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AdminSettlement({
  settlement,
  names,
}: {
  settlement: ReturnType<typeof historySettlement>;
  names: Map<string, string>;
}) {
  if (!settlement) return null;
  return (
    <section className="history-result" aria-label="本手结算">
      <header>
        <span>
          <Icon name="crown" size={18} /> 结算结果
        </span>
        <strong>{formatPoints(settlement.totalPot)} 筹码</strong>
      </header>
      <ul className="history-payouts">
        {settlement.payouts.map((payout) => (
          <li key={payout.playerId}>
            <span className="mini-avatar">{(names.get(payout.playerId) ?? '玩').slice(0, 1)}</span>
            <span>
              <strong>{names.get(payout.playerId) ?? '玩家'}</strong>
              <small>赢得底池</small>
            </span>
            <b>+{formatPoints(payout.amount)}</b>
          </li>
        ))}
        {settlement.refunds.map((refund) => (
          <li key={`refund-${refund.playerId}`} className="refund">
            <span className="mini-avatar">{(names.get(refund.playerId) ?? '玩').slice(0, 1)}</span>
            <span>
              <strong>{names.get(refund.playerId) ?? '玩家'}</strong>
              <small>退回</small>
            </span>
            <b>+{formatPoints(refund.amount)}</b>
          </li>
        ))}
      </ul>
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
  const [visibility, setVisibility] = useState<'PUBLIC' | 'PRIVATE'>('PUBLIC');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid =
    name.trim().length > 0 &&
    smallBlind > 0 &&
    bigBlind >= smallBlind &&
    stack >= bigBlind * 20 &&
    timeout >= 10 &&
    timeout <= 180 &&
    (visibility === 'PUBLIC' || password.length >= 4);
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
      visibility,
      ...(password ? { password } : {}),
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
        <fieldset className="mode-choice">
          <legend>访问权限</legend>
          <label>
            <input
              type="radio"
              checked={visibility === 'PUBLIC'}
              onChange={() => setVisibility('PUBLIC')}
            />
            公开（大厅可加入）
          </label>
          <label>
            <input
              type="radio"
              checked={visibility === 'PRIVATE'}
              onChange={() => setVisibility('PRIVATE')}
            />
            私有（邀请链接或密码）
          </label>
        </fieldset>
        {visibility === 'PRIVATE' && (
          <label className="field">
            <span>牌局密码（至少 4 位）</span>
            <input
              type="password"
              minLength={4}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        )}
        <button className="primary-button" disabled={!valid || pending}>
          {pending ? '正在创建…' : '创建牌桌'}
        </button>
      </form>
    </Modal>
  );
}

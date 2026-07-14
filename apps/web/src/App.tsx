import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type {
  AdminRoomSummary,
  Card,
  HandHistoryItem,
  PlayerAction,
  PublicRoomProjection,
  RoomMode,
} from '@poker-with-friends/protocol';
import {
  api,
  type AdminSession,
  type CreateRoomResponse,
  type InvitePreview,
  type JoinResponse,
  type AdminRoomPlayerSummary,
  type AdminUserSummary,
  type LobbyRoomSummary,
  type UserSession,
} from './api';
import { Icon, type IconName } from './icons';
import {
  actingCopy,
  actionChinese,
  betSuggestions,
  cardRankLabel,
  formatPoints,
  friendlyRoomMessage,
  historyActions,
  historySettlement,
  naturalAction,
  phaseLabel,
  positionLabel,
  positionsForRoom,
  statusLabel,
  type EnhancedRoomProjection,
  type EnhancedSeat,
  type TableActionItem,
  type TablePosition,
} from './poker-ui';
import { useRoom } from './use-room';

type Route =
  | { kind: 'home' }
  | { kind: 'admin' }
  | { kind: 'join'; token: string }
  | { kind: 'room'; roomId: string };

function currentRoute(): Route {
  const parts = window.location.pathname.split('/').filter(Boolean);
  if (parts[0] === 'admin') return { kind: 'admin' };
  if (parts[0] === 'join' && parts[1]) return { kind: 'join', token: parts[1] };
  if (parts[0] === 'room' && parts[1]) return { kind: 'room', roomId: parts[1] };
  return { kind: 'home' };
}

function navigate(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo({ top: 0, left: 0 });
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <button className="brand real-brand" onClick={() => navigate('/')} aria-label="返回首页">
      <span className="brand-mark real-brand-mark">
        <Icon name="spade" size={23} />
      </span>
      {!compact && (
        <span>
          <strong>Poker with Friends</strong>
          <small>PLAY TOGETHER</small>
        </span>
      )}
    </button>
  );
}

function ModeBadge({ mode }: { mode: RoomMode }) {
  return (
    <span className={`mode-badge mode-badge--${mode.toLowerCase()}`}>
      <Icon name={mode === 'ONLINE' ? 'cards' : 'table'} size={14} />
      {mode === 'ONLINE' ? '线上 · 自动发牌' : '线下 · 实体牌面'}
    </span>
  );
}

function Loading({ label = '正在加载…' }: { label?: string }) {
  return (
    <main className="state-page">
      <span className="loader" />
      <p>{label}</p>
    </main>
  );
}

function ErrorBox({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  return (
    <div className="real-error" role="alert">
      <span>
        <Icon name="warning" size={17} />
      </span>
      <p>{children}</p>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="关闭提示">
          <Icon name="close" size={17} />
        </button>
      )}
    </div>
  );
}

function IconButton({
  icon,
  label,
  onClick,
  className = '',
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <Icon name={icon} />
    </button>
  );
}

function App() {
  const [route, setRoute] = useState<Route>(currentRoute);
  useEffect(() => {
    const update = () => setRoute(currentRoute());
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);

  if (route.kind === 'admin') return <AdminPage />;
  if (route.kind === 'join') return <JoinPage token={route.token} />;
  if (route.kind === 'room') return <RoomPage roomId={route.roomId} />;
  return <HomePage />;
}

function HomePage() {
  const [session, setSession] = useState<UserSession | null>(null);
  const [rooms, setRooms] = useState<LobbyRoomSummary[]>([]);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null);

  const loadRooms = async () => setRooms(await api<LobbyRoomSummary[]>('/api/rooms'));
  useEffect(() => {
    api<UserSession>('/api/auth/session')
      .then((user) => {
        setSession(user);
        setPasswordOpen(user.mustChangePassword);
        if (!user.mustChangePassword) {
          return loadRooms().catch((caught) =>
            setError(caught instanceof Error ? caught.message : '无法载入房间列表'),
          );
        }
      })
      .catch(() => setSession(null))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (!session || session.mustChangePassword) return;
    const refresh = () => void loadRooms().catch(() => undefined);
    const interval = window.setInterval(refresh, 6_000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
    };
  }, [session?.id, session?.mustChangePassword]);

  const enterRoom = async (room: LobbyRoomSummary) => {
    if (room.membership && room.membership.status !== 'KICKED') {
      navigate(`/room/${room.roomId}`);
      return;
    }
    if (room.membership?.status === 'KICKED') {
      setError('你暂时不能重新加入这张牌桌');
      return;
    }
    if (room.availableSeats === 0) {
      setError('这张牌桌已经坐满了');
      return;
    }
    setJoiningRoomId(room.roomId);
    setError(null);
    try {
      const joined = await api<JoinResponse>(`/api/rooms/${room.roomId}/enter`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      navigate(`/room/${joined.roomId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '没能加入这张牌桌');
      await loadRooms().catch(() => undefined);
    } finally {
      setJoiningRoomId(null);
    }
  };

  if (checking) return <Loading label="正在验证玩家会话…" />;
  if (!session) {
    return (
      <UserLogin
        error={error}
        onSubmit={async (username, password) => {
          try {
            const user = await api<UserSession>('/api/auth/login', {
              method: 'POST',
              body: JSON.stringify({ username, password }),
            });
            setSession(user);
            setError(null);
            setPasswordOpen(user.mustChangePassword);
            if (!user.mustChangePassword) await loadRooms();
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : '登录失败');
          }
        }}
      />
    );
  }

  return (
    <main className="lobby-page">
      <header className="lobby-header page-container">
        <Brand />
        <div className="account-actions">
          <button type="button" className="account-pill" onClick={() => setPasswordOpen(true)}>
            <span className="avatar">{session.displayName.slice(0, 1).toUpperCase()}</span>
            <span>
              <small>@{session.username}</small>
              <strong>{session.displayName}</strong>
            </span>
          </button>
          <IconButton
            icon="logout"
            label="退出登录"
            onClick={() => {
              void api('/api/auth/logout', { method: 'POST' })
                .then(() => setSession(null))
                .catch((caught) =>
                  setError(caught instanceof Error ? caught.message : '退出登录失败'),
                );
            }}
          />
        </div>
      </header>
      <div className="page-container lobby-content">
        <section className="lobby-hero">
          <div>
            <span className="eyebrow">牌桌大厅</span>
            <h1>{session.displayName}，挑一桌坐下。</h1>
            <p>所有朋友桌都在这里。看到空位就能直接加入，不用再找邀请码。</p>
          </div>
          <div className="lobby-overview" aria-label="牌桌概览">
            <span>
              <Icon name="table" size={20} />
              <strong>{rooms.length}</strong>
              <small>张牌桌</small>
            </span>
            <i />
            <span>
              <Icon name="users" size={20} />
              <strong>{rooms.reduce((sum, room) => sum + room.playerCount, 0)}</strong>
              <small>位玩家</small>
            </span>
          </div>
        </section>
        {error && <ErrorBox onClose={() => setError(null)}>{error}</ErrorBox>}
        <section className="lobby-room-section" aria-labelledby="all-rooms-heading">
          <header>
            <div>
              <span className="eyebrow">现在可以加入</span>
              <h2 id="all-rooms-heading">全部牌桌</h2>
            </div>
            <button
              type="button"
              className="lobby-refresh"
              onClick={() => void loadRooms()}
              aria-label="刷新牌桌列表"
            >
              <Icon name="refresh" size={16} /> 刷新
            </button>
          </header>
          <div className="lobby-room-grid">
            {rooms.map((room) => (
              <LobbyRoomCard
                key={room.roomId}
                room={room}
                joining={joiningRoomId === room.roomId}
                onEnter={() => void enterRoom(room)}
              />
            ))}
            {rooms.length === 0 && (
              <div className="empty-state rich-empty lobby-room-empty">
                <Icon name="table" size={32} />
                <strong>还没有人开桌</strong>
                <span>开一张新桌，朋友登录后就能直接看到并加入。</span>
              </div>
            )}
          </div>
        </section>
        <button type="button" className="admin-entry" onClick={() => navigate('/admin')}>
          <Icon name="table" size={16} /> 开桌管理
        </button>
      </div>
      {passwordOpen && (
        <PasswordDialog
          locked={session.mustChangePassword}
          onClose={() => setPasswordOpen(false)}
          onComplete={async (updated) => {
            setSession(updated);
            await loadRooms().catch((caught) =>
              setError(caught instanceof Error ? caught.message : '密码已修改，但房间列表载入失败'),
            );
            setPasswordOpen(false);
          }}
        />
      )}
    </main>
  );
}

function LobbyRoomCard({
  room,
  joining,
  onEnter,
}: {
  room: LobbyRoomSummary;
  joining: boolean;
  onEnter: () => void;
}) {
  const joined = Boolean(room.membership && room.membership.status !== 'KICKED');
  const blocked = room.membership?.status === 'KICKED';
  const full = room.availableSeats === 0 && !joined;
  const onlineCount = room.players.filter((player) => player.connected).length;
  const actionLabel = joined
    ? '进入牌桌'
    : blocked
      ? '暂不能加入'
      : full
        ? '牌桌已满'
        : joining
          ? '正在加入…'
          : '加入牌桌';
  return (
    <article
      className={`lobby-room-card ${joined ? 'lobby-room-card--joined' : ''}`}
      data-room-id={room.roomId}
    >
      <header>
        <span className={`room-card-icon room-card-icon--${room.mode.toLowerCase()}`}>
          <Icon name={room.mode === 'ONLINE' ? 'cards' : 'table'} size={25} />
        </span>
        <span className="lobby-room-title">
          <ModeBadge mode={room.mode} />
          <strong>{room.name}</strong>
        </span>
        <span className={`room-live-state ${room.status === 'ACTIVE' ? 'is-playing' : ''}`}>
          <i /> {statusLabel[room.status] ?? room.status}
        </span>
      </header>
      <div className="lobby-room-facts">
        <span>
          <small>盲注</small>
          <strong>
            {formatPoints(room.settings.smallBlind)}/{formatPoints(room.settings.bigBlind)}
          </strong>
        </span>
        <span>
          <small>人数</small>
          <strong>
            {room.playerCount}/{room.settings.maxPlayers}
          </strong>
        </span>
        <span>
          <small>进度</small>
          <strong>{room.handNumber ? `第 ${room.handNumber} 手` : '等待开牌'}</strong>
        </span>
      </div>
      <div className="lobby-room-players">
        <div className="room-avatar-stack" aria-hidden="true">
          {room.players.slice(0, 4).map((player, index) => (
            <span
              key={`${player.nickname}-${index}`}
              className={player.connected ? 'is-online' : ''}
            >
              {player.nickname.slice(0, 1).toUpperCase()}
            </span>
          ))}
          {room.players.length === 0 && <span className="is-empty">+</span>}
          {room.players.length > 4 && <span>+{room.players.length - 4}</span>}
        </div>
        <span>
          <strong>
            {room.playerCount
              ? room.players.map((player) => player.nickname).join('、')
              : '等你入座'}
          </strong>
          <small>
            {onlineCount > 0 ? `${onlineCount} 人在线` : '暂时无人在线'} ·{' '}
            {room.availableSeats > 0 ? `还有 ${room.availableSeats} 个位置` : '已经坐满'}
          </small>
        </span>
      </div>
      <footer>
        <span className="room-membership-copy">
          {joined && room.membership ? (
            <>
              <Icon name="check" size={15} />
              <span>
                <strong>
                  {room.membership.seat === null
                    ? '已加入，等待选座'
                    : `${room.membership.seat + 1} 号位`}
                </strong>
                <small>{formatPoints(room.membership.stack)} 筹码</small>
              </span>
            </>
          ) : (
            <>
              <Icon name="door" size={15} />
              <span>
                <strong>{full ? '这桌暂时没有空位' : '登录账号直接加入'}</strong>
                <small>
                  {room.mode === 'LIVE' ? '线下发牌，线上记筹码' : '网站自动发牌与结算'}
                </small>
              </span>
            </>
          )}
        </span>
        <button
          type="button"
          data-testid={`join-room-${room.roomId}`}
          className={joined ? 'secondary-button' : 'primary-button'}
          onClick={onEnter}
          disabled={joining || blocked || full}
        >
          {actionLabel}
          {!joining && !blocked && !full && <Icon name="arrow-right" size={16} />}
        </button>
      </footer>
    </article>
  );
}

function UserLogin({
  error,
  onSubmit,
}: {
  error: string | null;
  onSubmit: (username: string, password: string) => Promise<void>;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  return (
    <main className="login-page account-login">
      <div className="login-ambient login-ambient--one" />
      <div className="login-ambient login-ambient--two" />
      <section className="login-card account-login-card">
        <Brand />
        <div className="login-visual" aria-hidden="true">
          <span>
            <Icon name="cards" size={38} />
          </span>
          <i />
          <i />
          <i />
        </div>
        <div className="login-heading">
          <span className="eyebrow">朋友局 · 随时开桌</span>
          <h1>
            <span>朋友到齐，</span>
            <span>牌桌就绪。</span>
          </h1>
          <p>登录后可以查看并加入所有朋友桌。线上自动发牌，线下专注收发筹码。</p>
        </div>
        {error && <ErrorBox>{error}</ErrorBox>}
        <form
          className="login-form"
          onSubmit={(event) => {
            event.preventDefault();
            setPending(true);
            void onSubmit(username.trim(), password).finally(() => setPending(false));
          }}
        >
          <label className="field field-with-icon">
            <span>账号</span>
            <span>
              <Icon name="user" size={18} />
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                autoFocus
                required
              />
            </span>
          </label>
          <label className="field field-with-icon">
            <span>密码</span>
            <span>
              <Icon name="lock" size={18} />
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </span>
          </label>
          <button className="primary-button" disabled={pending || !username.trim() || !password}>
            {pending ? '正在登录…' : '登录并进入牌桌大厅'}
            {!pending && <Icon name="arrow-right" size={18} />}
          </button>
        </form>
        <button type="button" className="text-button" onClick={() => navigate('/admin')}>
          我来开桌
        </button>
        <p className="safety-line">
          <Icon name="spark" size={14} /> 约上朋友，坐下就开牌
        </p>
      </section>
    </main>
  );
}

function PasswordDialog({
  locked,
  onClose,
  onComplete,
}: {
  locked: boolean;
  onClose: () => void;
  onComplete: (session: UserSession) => Promise<void>;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Modal
      title={locked ? '首次登录，请设置新密码' : '修改登录密码'}
      onClose={onClose}
      locked={locked}
    >
      <p>新密码至少 12 位。提交成功后，其他设备上的旧会话将失效。</p>
      {error && <ErrorBox>{error}</ErrorBox>}
      <form
        className="sheet-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (newPassword !== confirm) {
            setError('两次输入的新密码不一致');
            return;
          }
          setPending(true);
          api<UserSession>('/api/auth/password', {
            method: 'POST',
            body: JSON.stringify({ currentPassword, newPassword }),
          })
            .then(onComplete)
            .catch((caught) => setError(caught instanceof Error ? caught.message : '修改失败'))
            .finally(() => setPending(false));
        }}
      >
        <label className="field">
          <span>当前密码</span>
          <input
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
            required
            autoFocus
          />
        </label>
        <label className="field">
          <span>新密码</span>
          <input
            type="password"
            minLength={12}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        <label className="field">
          <span>再次输入新密码</span>
          <input
            type="password"
            minLength={12}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        <button
          className="primary-button"
          disabled={pending || newPassword.length < 12 || newPassword !== confirm}
        >
          {pending ? '正在保存…' : '保存新密码'}
        </button>
      </form>
    </Modal>
  );
}

function AdminPage() {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [checking, setChecking] = useState(true);
  const [rooms, setRooms] = useState<AdminRoomSummary[]>([]);
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [tab, setTab] = useState<'rooms' | 'accounts'>('rooms');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [selectedRoom, setSelectedRoom] = useState<AdminRoomSummary | null>(null);
  const [roomPlayers, setRoomPlayers] = useState<AdminRoomPlayerSummary[]>([]);
  const [roomPlayersLoading, setRoomPlayersLoading] = useState(false);
  const [roomPlayersError, setRoomPlayersError] = useState<string | null>(null);
  const [latestInvite, setLatestInvite] = useState<{ roomId: string; url: string } | null>(null);
  const [rotatingRoomId, setRotatingRoomId] = useState<string | null>(null);

  const loadRooms = async () => setRooms(await api<AdminRoomSummary[]>('/api/admin/rooms'));
  const loadUsers = async () => setUsers(await api<AdminUserSummary[]>('/api/admin/users'));
  const loadRoomPlayers = async (roomId: string) =>
    setRoomPlayers(await api<AdminRoomPlayerSummary[]>(`/api/admin/rooms/${roomId}/players`));
  useEffect(() => {
    api<AdminSession>('/api/admin/session')
      .then((admin) => {
        setSession(admin);
        return Promise.all([loadRooms(), loadUsers()]).catch((caught) =>
          setError(caught instanceof Error ? caught.message : '无法载入管理数据'),
        );
      })
      .catch(() => setSession(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <Loading label="正在进入开桌管理…" />;
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
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(result.inviteUrl).catch(() => undefined);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '生成邀请失败');
    } finally {
      setRotatingRoomId(null);
    }
  };

  const archive = async (room: AdminRoomSummary, force = false) => {
    const question = force
      ? '这会退回本手全部投入并永久归档房间，确定继续？'
      : '确定归档这个房间？';
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
        <button
          className="profile-button"
          onClick={async () => {
            try {
              await api('/api/admin/logout', { method: 'POST' });
              setSession(null);
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : '退出登录失败');
            }
          }}
        >
          <span>
            <small>开桌人</small>
            <strong>{session.username}</strong>
          </span>
          <b className="admin-avatar">
            <Icon name="shield" size={18} />
          </b>
        </button>
      </header>
      <div className="page-container dashboard-content">
        <section className="welcome-row">
          <div>
            <span className="eyebrow">组局小助手</span>
            <h1>{tab === 'rooms' ? '牌桌管理' : '账号管理'}</h1>
            <p>
              {tab === 'rooms'
                ? '开桌、拉朋友入座，今晚就从这里开始。'
                : '给朋友建个账号，之后就能直接进桌。'}
            </p>
          </div>
          <button
            className="create-button"
            onClick={() => {
              setError(null);
              if (tab === 'rooms') setCreating(true);
              else setCreatingAccount(true);
            }}
          >
            <Icon name="plus" size={18} /> {tab === 'rooms' ? '新建房间' : '新建账号'}
          </button>
        </section>
        <nav className="admin-tabs" aria-label="管理区">
          <button
            aria-pressed={tab === 'rooms'}
            className={tab === 'rooms' ? 'active' : ''}
            onClick={() => setTab('rooms')}
          >
            <Icon name="table" size={17} /> 房间 <span>{rooms.length}</span>
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
              <small>新邀请已生成，旧邀请同时失效</small>
              <code>{latestInvite.url}</code>
            </div>
            <button
              onClick={() => {
                if (!navigator.clipboard) {
                  setError('当前浏览器无法自动复制，请长按或选中邀请链接手动复制');
                  return;
                }
                void navigator.clipboard
                  .writeText(latestInvite.url)
                  .catch(() => setError('复制失败，请长按或选中邀请链接手动复制'));
              }}
            >
              复制
            </button>
          </div>
        )}
        {tab === 'rooms' ? (
          <section className="real-room-grid">
            {rooms.map((room) => (
              <article className="room-card" key={room.id}>
                <div className="room-card-top">
                  <ModeBadge mode={room.mode} />
                  <span className={`status-pill status-pill--${room.status.toLowerCase()}`}>
                    {room.status}
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
                    <Icon name="eye" size={15} /> 旁观牌桌
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
                            caught instanceof Error ? caught.message : '无法载入玩家',
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
                    <Icon name="copy" size={15} /> {rotatingRoomId === room.id ? '生成中…' : '邀请'}
                  </button>
                  {room.status !== 'ARCHIVED' &&
                    room.status !== 'ACTIVE' &&
                    room.status !== 'DISPUTED' && (
                      <button onClick={() => void archive(room)}>归档</button>
                    )}
                  {(room.status === 'ACTIVE' || room.status === 'DISPUTED') && (
                    <button className="danger-button" onClick={() => void archive(room, true)}>
                      退回本手并收桌
                    </button>
                  )}
                </div>
              </article>
            ))}
            {rooms.length === 0 && <div className="empty-state">还没有牌桌，先开一桌等朋友。</div>}
          </section>
        ) : (
          <AccountsPanel
            users={users}
            onReset={async (user, password) => {
              await api(`/api/admin/users/${user.id}/reset-password`, {
                method: 'POST',
                body: JSON.stringify({ password }),
              });
              await loadUsers();
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
            if (navigator.clipboard) {
              await navigator.clipboard.writeText(created.inviteUrl).catch(() => undefined);
            }
            await loadRooms().catch((caught) =>
              setError(caught instanceof Error ? caught.message : '房间已创建，但列表刷新失败'),
            );
            setCreating(false);
          }}
        />
      )}
      {creatingAccount && (
        <CreateAccountDialog
          onClose={() => setCreatingAccount(false)}
          onCreate={async (body) => {
            const created = await api<AdminUserSummary>('/api/admin/users', {
              method: 'POST',
              body: JSON.stringify(body),
            });
            setError(null);
            setUsers((current) => [...current.filter((user) => user.id !== created.id), created]);
            setCreatingAccount(false);
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
          <span className="eyebrow">开桌入口</span>
          <h1>开桌管理</h1>
          <p>开桌的人从这里登录；其他朋友直接回首页进入牌桌。</p>
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
            {pending ? '正在登录…' : '开始组局'}
          </button>
        </form>
      </section>
    </main>
  );
}

function AccountsPanel({
  users,
  onReset,
}: {
  users: AdminUserSummary[];
  onReset: (user: AdminUserSummary, password: string) => Promise<void>;
}) {
  const [resetting, setResetting] = useState<AdminUserSummary | null>(null);
  return (
    <section className="account-list">
      <header className="data-header">
        <span>玩家账号</span>
        <span>登录状态</span>
        <span>密码</span>
        <span />
      </header>
      {users.map((user) => (
        <article key={user.id}>
          <span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span>
          <span className="account-identity">
            <strong>{user.displayName}</strong>
            <small>
              @{user.username} · {new Date(user.createdAt).toLocaleDateString()}
            </small>
          </span>
          <span className={`account-state ${user.loginEnabled ? 'active' : ''}`}>
            {user.loginEnabled ? '可登录' : '已停用'}
          </span>
          <span className={user.mustChangePassword ? 'password-state pending' : 'password-state'}>
            {user.mustChangePassword ? '待首次修改' : '已设置'}
          </span>
          <button className="secondary-button compact-button" onClick={() => setResetting(user)}>
            <Icon name="key" size={15} /> 重置密码
          </button>
        </article>
      ))}
      {users.length === 0 && <div className="empty-state">还没有普通玩家账号。</div>}
      {resetting && (
        <ResetPasswordDialog
          user={resetting}
          onClose={() => setResetting(null)}
          onSubmit={async (password) => {
            await onReset(resetting, password);
            setResetting(null);
          }}
        />
      )}
    </section>
  );
}

function CreateAccountDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (body: { username: string; displayName?: string; password: string }) => Promise<void>;
}) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedUsername = username.trim();
  const usernameValid = /^[A-Za-z0-9_.-]{3,64}$/.test(normalizedUsername);
  const displayNameValid =
    displayName.trim().length <= 20 &&
    (displayName.trim().length > 0 || normalizedUsername.length <= 20);
  const passwordValid = password.length >= 12 && password.length <= 256;
  return (
    <Modal title="给朋友创建账号" onClose={onClose}>
      <p>先设置一个临时密码，朋友首次登录后可以换成自己的密码。</p>
      {error && <ErrorBox onClose={() => setError(null)}>{error}</ErrorBox>}
      <form
        className="sheet-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!usernameValid || !displayNameValid || !passwordValid) return;
          setError(null);
          setPending(true);
          void onCreate({
            username: normalizedUsername,
            ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
            password,
          })
            .catch((caught) =>
              setError(caught instanceof Error ? caught.message : '账号创建失败，请检查输入后重试'),
            )
            .finally(() => setPending(false));
        }}
      >
        <label className="field">
          <span>登录账号</span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="off"
            pattern="[A-Za-z0-9_.-]{3,64}"
            maxLength={64}
            aria-describedby="create-account-username-help"
            aria-invalid={username.length > 0 && !usernameValid}
            required
            autoFocus
          />
          <small id="create-account-username-help" className="field-help">
            3–64 位，仅限英文、数字、点、下划线和短横线，例如 player_1。
          </small>
          {username.length > 0 && !usernameValid && (
            <small className="field-error" role="alert">
              登录账号格式不符合要求。
            </small>
          )}
        </label>
        <label className="field">
          <span>显示名称</span>
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={20}
            placeholder="未填写时使用账号名"
            aria-describedby="create-account-display-help"
          />
          <small id="create-account-display-help" className="field-help">
            最多 20 个字符，可以使用中文；账号超过 20 位时必须填写。
          </small>
          {!displayNameValid && (
            <small className="field-error" role="alert">
              请填写不超过 20 个字符的显示名称。
            </small>
          )}
        </label>
        <label className="field">
          <span>临时密码</span>
          <input
            type="password"
            minLength={12}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            maxLength={256}
            aria-describedby="create-account-password-help"
            aria-invalid={password.length > 0 && !passwordValid}
            required
          />
          <small id="create-account-password-help" className="field-help">
            至少 12 位；当前 {password.length} 位。
          </small>
          {password.length > 0 && !passwordValid && (
            <small className="field-error" role="alert">
              临时密码至少需要 12 位。
            </small>
          )}
        </label>
        <p className="sheet-safety">
          <Icon name="key" size={15} /> 请通过可信渠道把临时密码单独发给玩家。
        </p>
        <button
          className="primary-button"
          disabled={pending || !usernameValid || !displayNameValid || !passwordValid}
        >
          {pending ? '正在创建…' : '创建账号'}
        </button>
      </form>
    </Modal>
  );
}

function ResetPasswordDialog({
  user,
  onClose,
  onSubmit,
}: {
  user: AdminUserSummary;
  onClose: () => void;
  onSubmit: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`重置 ${user.displayName} 的密码`} onClose={onClose}>
      <p>重置会使现有玩家会话失效，并要求下次登录修改临时密码。</p>
      {error && <ErrorBox>{error}</ErrorBox>}
      <form
        className="sheet-form"
        onSubmit={(event) => {
          event.preventDefault();
          setPending(true);
          void onSubmit(password)
            .catch((caught) => setError(caught instanceof Error ? caught.message : '重置失败'))
            .finally(() => setPending(false));
        }}
      >
        <label className="field">
          <span>新临时密码</span>
          <input
            type="password"
            minLength={12}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            required
            autoFocus
          />
        </label>
        <button className="primary-button" disabled={pending || password.length < 12}>
          {pending ? '正在重置…' : '确认重置'}
        </button>
      </form>
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
  const [nickname, setNickname] = useState('');
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
          <Icon name="eye" size={16} /> 旁观牌桌
        </button>
        <button
          className="secondary-button"
          disabled={pending}
          onClick={() => {
            setPending(true);
            api<{ roomId: string }>(`/api/admin/rooms/${room.id}/play-as-self`, {
              method: 'POST',
              body: JSON.stringify({}),
            })
              .then((membership) => navigate(`/room/${membership.roomId}`))
              .catch((caught) =>
                onError(caught instanceof Error ? caught.message : '无法以玩家身份加入'),
              )
              .finally(() => setPending(false));
          }}
        >
          <Icon name="play" size={16} /> 以玩家身份加入并进入
        </button>
      </div>
      <form
        className="assign-player"
        onSubmit={(event) => {
          event.preventDefault();
          if (!userId) return;
          void mutate(`/api/admin/rooms/${room.id}/players`, {
            userId,
            ...(nickname.trim() ? { nickname: nickname.trim() } : {}),
          }).then((ok) => {
            if (!ok) return;
            setNickname('');
            const next = availableUsers.find((user) => user.id !== userId);
            setUserId(next?.id ?? '');
          });
        }}
      >
        <label className="field">
          <span>把账号加入房间</span>
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
        <label className="field">
          <span>桌上昵称（可选）</span>
          <input
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            maxLength={20}
            placeholder="默认使用显示名称"
          />
        </label>
        <button className="primary-button" disabled={!userId || pending}>
          <Icon name="plus" size={16} /> 加入房间
        </button>
      </form>
      <div className="room-player-list">
        {loading && (
          <div className="empty-state" role="status">
            正在载入房间成员…
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
                        if (window.confirm(`确定把 ${player.nickname} 移出房间？`))
                          void mutate(
                            `/api/admin/rooms/${room.id}/players/${player.playerId}/kick`,
                            {
                              reason: '开桌人移出牌桌',
                            },
                          );
                      }}
                    >
                      <Icon name="door" size={15} /> 踢出
                    </button>
                  )}
                </span>
              </article>
            );
          })}
        {!loading && players.length === 0 && (
          <div className="empty-state">这个房间还没有账号成员。</div>
        )}
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
  const [reason, setReason] = useState('线下筹码校准');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`调整 ${player.nickname} 的筹码`} onClose={onClose}>
      <p>按桌面上的实际筹码填写，保存后会马上同步到牌桌。</p>
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
  const [name, setName] = useState('周末好友桌');
  const [smallBlind, setSmallBlind] = useState(10);
  const [bigBlind, setBigBlind] = useState(20);
  const [stack, setStack] = useState(2_000);
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
      .catch((caught) => setError(caught instanceof Error ? caught.message : '创建房间失败'))
      .finally(() => setPending(false));
  };
  return (
    <Modal title="开一张新桌" onClose={onClose}>
      <form className="sheet-form" onSubmit={submit}>
        {error && <ErrorBox onClose={() => setError(null)}>{error}</ErrorBox>}
        <div className="mode-choice">
          {(['ONLINE', 'LIVE'] as const).map((item) => (
            <button
              type="button"
              key={item}
              className={mode === item ? 'active' : ''}
              aria-pressed={mode === item}
              onClick={() => setMode(item)}
            >
              <b>
                <Icon name={item === 'ONLINE' ? 'cards' : 'table'} size={23} />
              </b>
              <span>{item === 'ONLINE' ? '线上牌桌' : '线下牌桌'}</span>
              <small>{item === 'ONLINE' ? '完整线上发牌' : '现场牌＋数字筹码'}</small>
            </button>
          ))}
        </div>
        <label className="field">
          <span>房间名称</span>
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
        <p className="sheet-safety">房间第一手开始后规则锁定，模式无法切换。</p>
        <button className="primary-button" disabled={!valid || pending}>
          {pending ? '正在创建…' : '创建并生成邀请'}
        </button>
      </form>
    </Modal>
  );
}

function JoinPage({ token }: { token: string }) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [session, setSession] = useState<UserSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    Promise.all([
      api<InvitePreview>(`/api/rooms/${token}/invite-preview`),
      api<UserSession>('/api/auth/session').catch(() => null),
    ])
      .then(([room, user]) => {
        setPreview(room);
        setSession(user);
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : '邀请无效'));
  }, [token]);
  if (!preview && !error) return <Loading label="正在打开牌桌邀请…" />;
  if (!preview) {
    return (
      <main className="state-page">
        <ErrorBox>{error}</ErrorBox>
        <button className="secondary-button" onClick={() => navigate('/')}>
          返回首页
        </button>
      </main>
    );
  }
  return (
    <main className="invite-page real-invite">
      <header className="invite-header page-container">
        <Brand compact />
        <span className="secure-pill">
          <Icon name="spark" size={14} /> 朋友邀请
        </span>
      </header>
      <section className="invite-card">
        <div className={`invite-emblem invite-emblem--${preview.mode.toLowerCase()}`}>
          <span>
            <Icon name={preview.mode === 'ONLINE' ? 'cards' : 'table'} size={32} />
          </span>
        </div>
        <ModeBadge mode={preview.mode} />
        <h1>{preview.name}</h1>
        <p className="invite-subtitle">
          当前 {preview.playerCount}/6 人 · 盲注 {preview.settings.smallBlind}/
          {preview.settings.bigBlind} · 起始 {preview.settings.startingStack}
        </p>
        <div className="invite-seats">
          {Array.from({ length: 6 }, (_, index) => preview.nicknames[index] ?? null).map(
            (name, index) => (
              <div key={index} className={name ? '' : 'invite-seat-empty'}>
                <span className="mini-avatar">{name ? name.slice(0, 1) : '+'}</span>
                <small>{name ?? '空位'}</small>
              </div>
            ),
          )}
        </div>
        <div className="invite-rules">
          <h2>这桌怎么玩</h2>
          <ul>
            <li>
              <span>
                <Icon name="check" size={15} />
              </span>
              <p>
                <strong>人齐再开牌</strong>每手开始前，桌上玩家一起点准备。
              </p>
            </li>
            <li>
              <span>
                <Icon name="check" size={15} />
              </span>
              <p>
                <strong>{preview.mode === 'ONLINE' ? '自动发牌和比牌' : '实体牌配数字筹码'}</strong>
                下注顺序和底池都由网站处理。
              </p>
            </li>
            <li>
              <span>
                <Icon name="check" size={15} />
              </span>
              <p>
                <strong>位置每手顺时针轮换</strong>轮到谁、该下多少都会清楚显示。
              </p>
            </li>
          </ul>
        </div>
        {error && <ErrorBox onClose={() => setError(null)}>{error}</ErrorBox>}
        {!session ? (
          <InviteSignIn onSignedIn={setSession} />
        ) : session.mustChangePassword ? (
          <div className="join-account-gate">
            <Icon name="key" size={20} />
            <div>
              <strong>请先完成首次密码修改</strong>
              <p>为了保护账号，修改临时密码后才能加入牌桌。</p>
            </div>
            <button className="primary-button" onClick={() => navigate('/')}>
              去修改密码
            </button>
          </div>
        ) : (
          <form
            className="join-form"
            onSubmit={(event) => {
              event.preventDefault();
              setPending(true);
              api<JoinResponse>(`/api/rooms/${token}/join`, {
                method: 'POST',
                body: JSON.stringify({}),
              })
                .then((joined) => navigate(`/room/${joined.roomId}`))
                .catch((caught) => setError(caught instanceof Error ? caught.message : '加入失败'))
                .finally(() => setPending(false));
            }}
          >
            <div className="joining-as">
              <span className="avatar">{session.displayName.slice(0, 1)}</span>
              <span>
                <small>将以此账号加入</small>
                <strong>
                  {session.displayName} · @{session.username}
                </strong>
              </span>
            </div>
            <button className="primary-button" disabled={pending}>
              {pending ? '正在加入…' : '加入牌桌'}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}

function InviteSignIn({ onSignedIn }: { onSignedIn: (session: UserSession) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="join-form invite-signin"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        api<UserSession>('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ username: username.trim(), password }),
        })
          .then(onSignedIn)
          .catch((caught) => setError(caught instanceof Error ? caught.message : '登录失败'))
          .finally(() => setPending(false));
      }}
    >
      <div className="signin-callout">
        <Icon name="user" size={19} />
        <span>
          <strong>登录后接受邀请</strong>
          <small>房间成员与账号绑定，不再使用临时昵称或恢复码。</small>
        </span>
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
      <label className="field">
        <span>账号</span>
        <input
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          required
        />
      </label>
      <label className="field">
        <span>密码</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      <button className="primary-button" disabled={pending || !username.trim() || !password}>
        {pending ? '正在登录…' : '登录'}
      </button>
    </form>
  );
}

function RoomPage({ roomId }: { roomId: string }) {
  const publicView = new URLSearchParams(window.location.search).get('view') === 'public';
  const connection = useRoom(roomId, publicView);
  const [notice, setNotice] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HandHistoryItem[]>([]);
  const [historyStatus, setHistoryStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [winnerForm, setWinnerForm] = useState(false);
  const [claimingSeat, setClaimingSeat] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);
  const { room, me } = connection;

  useEffect(() => {
    const timer = window.setInterval(() => {
      const proposalDeadline = room?.liveResultProposal
        ? room.liveResultProposal.objectedByPlayerIds.length > 0 ||
          room.liveResultProposal.confirmedByPlayerIds.length > 0
          ? room.liveResultProposal.disputeAt
          : room.liveResultProposal.expiresAt
        : null;
      const deadline = room?.prompt?.deadlineAt ?? room?.nextHandAt ?? proposalDeadline;
      setSeconds(
        deadline ? Math.max(0, Math.ceil((new Date(deadline).getTime() - Date.now()) / 1_000)) : 0,
      );
    }, 250);
    return () => window.clearInterval(timer);
  }, [room?.liveResultProposal, room?.nextHandAt, room?.prompt?.deadlineAt]);

  const send = async (
    event: string,
    payload: Record<string, unknown> = {},
    needsTurnToken = false,
  ) => {
    const ok = await connection.send(event, payload, { needsTurnToken });
    if (!ok) return;
    if (event === 'seat.claim') {
      const seat = typeof payload.seat === 'number' ? payload.seat + 1 : null;
      setNotice(seat ? `已坐到 ${seat} 号位` : '座位已选好');
    } else if (event === 'player.ready') setNotice('下一手已准备');
    else if (event === 'player.sitOut') setNotice('下一手先休息');
    else if (event === 'stack.topUp') setNotice('筹码已补至房间上限');
    else if (event === 'hand.act') {
      const action = payload.action as PlayerAction | undefined;
      const amountTo = typeof payload.amountTo === 'number' ? payload.amountTo : undefined;
      setNotice(
        `${action ? (actionChinese[action] ?? '行动') : '行动'}${amountTo === undefined ? '' : ` ${formatPoints(amountTo)}`}`,
      );
    } else setNotice('操作已确认');
  };

  const claimSeat = async (seat: number) => {
    setClaimingSeat(seat);
    try {
      await send('seat.claim', { seat });
    } finally {
      setClaimingSeat(null);
    }
  };

  const loadHistory = async () => {
    setHistoryOpen(true);
    setHistoryStatus('loading');
    setHistoryError(null);
    try {
      const items = await api<HandHistoryItem[]>(`/api/rooms/${roomId}/history`);
      setHistory(items);
      setHistoryStatus('ready');
    } catch (caught) {
      setHistoryStatus('error');
      setHistoryError(caught instanceof Error ? caught.message : '牌谱没有加载出来');
    }
  };

  if (connection.loading) return <Loading label="正在恢复牌桌状态…" />;
  if (!room) {
    return (
      <main className="state-page">
        <ErrorBox>{connection.error ?? '没能打开这张牌桌，请回到首页再试一次。'}</ErrorBox>
        <button className="secondary-button" onClick={() => navigate('/')}>
          <Icon name="arrow-left" size={16} /> 返回我的房间
        </button>
      </main>
    );
  }
  if (!me && !publicView) {
    return (
      <main className="state-page">
        <Icon name="lock" size={32} />
        <h1>
          {connection.error === '你已被移出该房间' ? '你已离开这张牌桌' : '你还没加入这张牌桌'}
        </h1>
        <p>
          {connection.error === '你已被移出该房间'
            ? '回到首页看看其他牌桌，或让朋友再发一次邀请。'
            : '请从“我的牌桌”进入，或让开桌的朋友发一个邀请。'}
        </p>
        <button className="primary-button" onClick={() => navigate('/')}>
          <Icon name="arrow-left" size={16} /> 返回我的房间
        </button>
      </main>
    );
  }
  const enhancedRoom = room as EnhancedRoomProjection;
  const mySeat = !me || me.seat === null ? null : enhancedRoom.seats[me.seat];
  const readyEligibleCount = enhancedRoom.seats.filter(
    (seat) => seat.playerId && seat.connected && !seat.sittingOut && seat.stack > 0,
  ).length;
  const isMyTurn = Boolean(me && room.prompt?.playerId === me.playerId);
  const isLiveDealer = Boolean(me && me.seat !== null && room.liveDealerSeat === me.seat);
  const frozen = room.status === 'DISPUTED' || room.status === 'ARCHIVED';
  const timerProgress = room.prompt
    ? Math.max(0, Math.min(1, seconds / room.settings.actionTimeoutSeconds))
    : 0;
  const actingSeat =
    room.actingSeat === null
      ? null
      : enhancedRoom.seats.find((seat) => seat.seat === room.actingSeat);
  const actingPositions = actingSeat
    ? (positionsForRoom(enhancedRoom).get(actingSeat.seat) ?? [])
    : [];
  const actingAnnouncement = actingSeat?.playerId
    ? `轮到 ${actingPositions.length ? positionLabel(actingPositions) : `座位 ${actingSeat.seat + 1}`}，${actingSeat.nickname ?? '玩家'}`
    : room.status === 'ACTIVE'
      ? '等待下一位玩家行动'
      : '等待下一手确认';

  return (
    <main
      className={`table-page real-table-page ${room.status === 'BETWEEN_HANDS' ? 'payout-settled' : ''}`}
    >
      <header className="table-header">
        <IconButton
          icon="arrow-left"
          label="返回我的房间"
          onClick={() => navigate('/')}
          className="round-button"
        />
        <div className="table-title">
          <span>
            <i className={connection.connected ? 'connection-dot' : 'connection-dot offline'} />{' '}
            {connection.connected ? '在线' : '重连中'}
            {publicView && ' · 旁观中'}
          </span>
          <strong>{room.name}</strong>
          <small>
            第 {room.handNumber} 手 · {statusLabel[room.status] ?? room.status}
          </small>
        </div>
        <button
          className="table-history-trigger"
          aria-label="查看牌谱"
          aria-busy={historyStatus === 'loading'}
          onClick={() => {
            if (historyStatus === 'loading') setHistoryOpen(true);
            else void loadHistory();
          }}
        >
          <span className="table-history-trigger__icon">
            <Icon name="book" size={18} />
          </span>
          <span className="table-history-trigger__copy">
            <small>{historyStatus === 'ready' ? `${history.length} 手` : '回看'}</small>
            <strong>牌谱</strong>
          </span>
        </button>
      </header>
      <div className={`acting-banner ${isMyTurn ? 'acting-banner--mine' : ''}`}>
        <progress className="acting-progress" max={1} value={timerProgress} aria-hidden="true" />
        <span className="sr-only" aria-live="polite">
          {actingAnnouncement}
        </span>
        <span className="turn-ring">
          <Icon name="clock" size={17} />
        </span>
        <strong>{actingCopy(enhancedRoom, seconds)}</strong>
        {room.phase && (
          <small role="timer">
            {phaseLabel[room.phase] ?? room.phase} · {seconds} 秒
          </small>
        )}
      </div>
      {(connection.error || pageError || notice) && (
        <div className="table-notice-wrap">
          {connection.error && (
            <ErrorBox onClose={connection.clearError}>{connection.error}</ErrorBox>
          )}
          {pageError && <ErrorBox onClose={() => setPageError(null)}>{pageError}</ErrorBox>}
          {notice && (
            <div className="success-box" role="status" onAnimationEnd={() => setNotice(null)}>
              {notice}
            </div>
          )}
        </div>
      )}
      <div className="table-layout real-table-layout">
        <section className="table-column">
          <div className="table-mode-row">
            <ModeBadge mode={room.mode} />
            <span>{room.phase ? (phaseLabel[room.phase] ?? room.phase) : '等待开始'}</span>
            <span className="fair-chip">数字筹码</span>
          </div>
          <PokerTable
            room={enhancedRoom}
            meId={me?.playerId ?? ''}
            holeCards={me?.holeCards ?? []}
            canClaim={Boolean(me && !frozen && !connection.busy && me.seat === null)}
            claimingSeat={claimingSeat}
            onClaim={(seat) => void claimSeat(seat)}
          />
          <div className="room-message">
            <span>{friendlyRoomMessage(room.message)}</span>
            {room.nextHandAt && <b>{seconds} 秒后进入下一阶段</b>}
          </div>
          <RecentActions actions={enhancedRoom.recentActions ?? []} />
          {me && (
            <div className="quick-actions real-quick-actions">
              <button
                onClick={() => void send('player.ready')}
                disabled={
                  frozen || connection.busy || mySeat?.ready === true || readyEligibleCount < 2
                }
              >
                <span>
                  <Icon name="check" size={19} />
                </span>
                <small>
                  {readyEligibleCount < 2 ? '等朋友入座' : mySeat?.ready ? '已准备' : '准备下一手'}
                </small>
              </button>
              <button
                onClick={() => void send('player.sitOut')}
                disabled={frozen || connection.busy}
              >
                <span>
                  <Icon name="pause" size={19} />
                </span>
                <small>下手休息</small>
              </button>
              <button
                onClick={() => void send('stack.topUp', { targetStack: room.settings.stackCap })}
                disabled={
                  room.status === 'ACTIVE' ||
                  frozen ||
                  connection.busy ||
                  (mySeat?.stack ?? 0) >= room.settings.stackCap
                }
              >
                <span>
                  <Icon name="chip" size={19} />
                </span>
                <small>补至 {formatPoints(room.settings.stackCap)}</small>
              </button>
            </div>
          )}
        </section>
        <section className="operation-column">
          <fieldset className="command-surface" disabled={connection.busy || frozen}>
            {publicView || !me ? (
              <WaitingPanel
                icon="eye"
                title="正在旁观"
                text="这里可以看牌桌进度，但不会看到任何人的底牌，也不能代替玩家操作。"
              />
            ) : room.status === 'LOBBY' || room.status === 'BETWEEN_HANDS' ? (
              <ReadyConfirmation
                room={enhancedRoom}
                mySeat={mySeat}
                busy={connection.busy}
                onReady={() => void send('player.ready')}
              />
            ) : room.mode === 'ONLINE' || room.prompt ? (
              <OnlineActions
                room={enhancedRoom}
                heroSeat={mySeat}
                isMyTurn={isMyTurn}
                seconds={seconds}
                onAction={(action, amountTo) =>
                  void send(
                    'hand.act',
                    { action, ...(amountTo === undefined ? {} : { amountTo }) },
                    true,
                  )
                }
              />
            ) : (
              <LiveActions
                room={room}
                meId={me.playerId}
                isDealer={isLiveDealer}
                seconds={seconds}
                onStreet={(street) => void send('live.streetDealt', { street })}
                onObject={(proposalId) => void send('live.resultObject', { proposalId })}
                onConfirm={(proposalId) => void send('live.resultConfirm', { proposalId })}
                onPropose={() => setWinnerForm(true)}
              />
            )}
          </fieldset>
        </section>
      </div>
      {winnerForm && (
        <LiveWinnerDialog
          room={room}
          onClose={() => setWinnerForm(false)}
          onSubmit={(winnersByPot) => connection.send('live.resultPropose', { winnersByPot })}
        />
      )}
      {historyOpen && (
        <HistoryDialog
          items={history}
          room={enhancedRoom}
          status={historyStatus}
          error={historyError}
          onRetry={() => void loadHistory()}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      {me && room.prompt && isMyTurn && (
        <MobileActionDock
          room={enhancedRoom}
          heroSeat={mySeat}
          seconds={seconds}
          busy={connection.busy || frozen}
          onAction={(action, amountTo) =>
            void send('hand.act', { action, ...(amountTo === undefined ? {} : { amountTo }) }, true)
          }
        />
      )}
    </main>
  );
}

function PokerTable({
  room,
  meId,
  holeCards,
  canClaim,
  claimingSeat,
  onClaim,
}: {
  room: EnhancedRoomProjection;
  meId: string;
  holeCards: Card[];
  canClaim: boolean;
  claimingSeat: number | null;
  onClaim: (seat: number) => void;
}) {
  const totalPot = room.pots.reduce((sum, pot) => sum + pot.amount, 0);
  const positions = positionsForRoom(room);
  return (
    <div className={`table-arena table-arena--${room.mode.toLowerCase()} real-table-arena`}>
      <div className="felt-table">
        <div className="felt-line" />
        <div className="real-table-center">
          <div className="pot-label">
            <small>底池</small>
            <strong key={totalPot} className="chip-pop">
              {formatPoints(totalPot)}
            </strong>
            <span>{room.pots.length > 1 ? `${room.pots.length} 个池` : '积分'}</span>
          </div>
          {room.mode === 'ONLINE' ? (
            <>
              <div className="community-cards">
                {room.communityCards.map((card, index) => (
                  <PlayingCard
                    card={card}
                    key={`${room.handNumber}-${card}-${index}`}
                    dealIndex={index}
                  />
                ))}
                {Array.from({ length: 5 - room.communityCards.length }, (_, index) => (
                  <span className="card-placeholder" key={index} />
                ))}
              </div>
              <div className="hero-cards">
                {holeCards.map((card) => (
                  <PlayingCard
                    card={card}
                    key={`${room.handNumber}-${card}`}
                    compact
                    dealIndex={0}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="live-center">
              <span className="live-center-icon">
                <Icon name="table" size={27} />
              </span>
              <small>现场牌面为准</small>
              <strong>
                {room.pendingLiveStreet
                  ? `等待确认 ${room.pendingLiveStreet}`
                  : (room.phase ?? '等待准备')}
              </strong>
            </div>
          )}
        </div>
      </div>
      {room.seats.map((seat) => (
        <Seat
          key={seat.seat}
          seat={seat}
          own={seat.playerId === meId}
          positions={positions.get(seat.seat) ?? []}
          canClaim={canClaim}
          claiming={claimingSeat === seat.seat}
          onClaim={() => onClaim(seat.seat)}
        />
      ))}
    </div>
  );
}

function Seat({
  seat,
  own,
  positions,
  canClaim,
  claiming,
  onClaim,
}: {
  seat: EnhancedSeat;
  own: boolean;
  positions: TablePosition[];
  canClaim: boolean;
  claiming: boolean;
  onClaim: () => void;
}) {
  if (!seat.playerId)
    return (
      <button
        type="button"
        className={`table-seat table-seat--${seat.seat} table-seat--empty`}
        data-testid={`seat-${seat.seat}`}
        aria-label={
          claiming
            ? `正在选择 ${seat.seat + 1} 号位`
            : canClaim
              ? `选择 ${seat.seat + 1} 号位`
              : `${seat.seat + 1} 号位空位`
        }
        onClick={onClaim}
        disabled={!canClaim || claiming}
      >
        <span>{claiming ? <span className="seat-loader" /> : <Icon name="plus" size={18} />}</span>
        <small>{claiming ? '落座中' : canClaim ? '入座' : '空位'}</small>
        <b>{seat.seat + 1}号</b>
      </button>
    );
  const status = seat.folded
    ? '已弃牌'
    : seat.allIn
      ? '全下'
      : seat.isActing
        ? '行动中'
        : seat.sittingOut
          ? '暂离'
          : !seat.connected
            ? '离线'
            : seat.ready
              ? '已准备'
              : '已入座';
  return (
    <div
      className={`table-seat table-seat--${seat.seat} ${own ? 'table-seat--own' : ''} ${seat.isActing ? 'table-seat--status-acting' : ''}`}
    >
      <div className="seat-avatar">
        <span className="mini-avatar">{seat.nickname?.slice(0, 1)}</span>
        {positions.length > 0 && <b title={positionLabel(positions)}>{positions.join('/')}</b>}
      </div>
      <div className="seat-copy">
        <strong>{own ? '你' : seat.nickname}</strong>
        <span>
          <Icon name="chip" size={12} /> {formatPoints(seat.stack)}
        </span>
        <small>
          {status}
          {seat.committedHand ? ` · 已投 ${seat.committedHand}` : ''}
        </small>
      </div>
      {seat.revealedCards && (
        <div className="revealed-cards">
          {seat.revealedCards.map((card) => (
            <PlayingCard card={card} key={card} compact />
          ))}
        </div>
      )}
    </div>
  );
}

function PlayingCard({
  card,
  compact = false,
  dealIndex = 0,
}: {
  card: Card;
  compact?: boolean;
  dealIndex?: number;
}) {
  const suit = card.slice(-1).toLowerCase();
  const rank = cardRankLabel(card);
  const symbol: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const suitName: Record<string, string> = { s: '黑桃', h: '红桃', d: '方片', c: '梅花' };
  const normalizedDealIndex = Math.max(0, Math.min(4, Math.trunc(dealIndex)));
  return (
    <span
      className={`playing-card playing-card--deal-${normalizedDealIndex} ${compact ? 'playing-card--compact' : ''} ${suit === 'h' || suit === 'd' ? 'playing-card--red' : ''}`}
      aria-label={`${suitName[suit]} ${rank}`}
    >
      <b>{rank}</b>
      <i>{symbol[suit]}</i>
    </span>
  );
}

function OnlineActions({
  room,
  heroSeat,
  isMyTurn,
  seconds,
  onAction,
}: {
  room: EnhancedRoomProjection;
  heroSeat: EnhancedSeat | null;
  isMyTurn: boolean;
  seconds: number;
  onAction: (action: PlayerAction, amountTo?: number) => void;
}) {
  const prompt = room.prompt;
  const minimum = prompt?.minRaiseTo ?? prompt?.minBetTo ?? 0;
  const [amountInput, setAmountInput] = useState(String(minimum));
  useEffect(() => setAmountInput(String(minimum)), [minimum, room.serverSeq]);
  if (room.status !== 'ACTIVE')
    return (
      <WaitingPanel
        icon="check"
        title="等待下一手"
        text="所有在线在座玩家确认后，系统才会开始下一手。"
      />
    );
  if (!isMyTurn || !prompt)
    return (
      <WaitingPanel
        icon="clock"
        title="等待其他玩家行动"
        text={friendlyRoomMessage(room.message) || '牌桌状态会实时更新。'}
      />
    );
  const actions = new Set(prompt.legalActions);
  const wagerAction: PlayerAction | null = actions.has('RAISE_TO')
    ? 'RAISE_TO'
    : actions.has('BET_TO')
      ? 'BET_TO'
      : null;
  const suggestions = betSuggestions(room, heroSeat);
  const amount = Number(amountInput);
  const amountValid =
    amountInput.trim() !== '' &&
    Number.isInteger(amount) &&
    amount >= minimum &&
    amount <= prompt.maxTo;
  const timerPercent = Math.max(0, Math.min(1, seconds / room.settings.actionTimeoutSeconds)) * 100;
  return (
    <section className="operation-panel online-panel">
      <div className="operation-head">
        <div>
          <span className="eyebrow">轮到你了</span>
          <h2>轮到你行动</h2>
        </div>
        <span className="turn-timer">
          <span className="turn-timer-ring">
            <svg viewBox="0 0 42 42" aria-hidden="true">
              <circle className="turn-timer-track" cx="21" cy="21" r="18" pathLength="100" />
              <circle
                className="turn-timer-value"
                cx="21"
                cy="21"
                r="18"
                pathLength="100"
                strokeDasharray="100"
                strokeDashoffset={100 - timerPercent}
              />
            </svg>
            <i>{seconds}</i>
          </span>
          <small>秒</small>
        </span>
      </div>
      <div className="call-summary">
        <span>需要跟注</span>
        <strong>{formatPoints(prompt.callAmount)}</strong>
        <small>超时可过牌则自动过牌，否则弃牌</small>
      </div>
      {wagerAction && minimum <= prompt.maxTo && (
        <div className="raise-control">
          <div>
            <label htmlFor="raise">
              {wagerAction === 'BET_TO' ? '下注到' : '加注到'}（本轮总投入）
            </label>
            <label className="amount-input">
              <Icon name="chip" size={15} />
              <input
                type="number"
                min={minimum}
                max={prompt.maxTo}
                step="1"
                inputMode="numeric"
                value={amountInput}
                onChange={(event) => setAmountInput(event.target.value)}
                aria-label="精确输入下注后总投入"
                aria-invalid={!amountValid}
                aria-describedby="desktop-wager-help"
              />
            </label>
          </div>
          <div className="bet-suggestions">
            {suggestions.map((suggestion) => (
              <button
                type="button"
                className={amount === suggestion.amountTo ? 'active' : ''}
                aria-pressed={amount === suggestion.amountTo}
                key={`${suggestion.semantic}-${suggestion.amountTo}`}
                onClick={() => setAmountInput(String(suggestion.amountTo))}
              >
                <strong>{suggestion.label}</strong>
                <small>{formatPoints(suggestion.amountTo)}</small>
              </button>
            ))}
          </div>
          <input
            id="raise"
            type="range"
            min={minimum}
            max={prompt.maxTo}
            step={room.settings.smallBlind}
            value={amountValid ? amount : minimum}
            onChange={(event) => setAmountInput(event.target.value)}
          />
          <div className="range-bounds">
            <span>最小 {formatPoints(minimum)}</span>
            <span>最大 {formatPoints(prompt.maxTo)}</span>
          </div>
          <small
            id="desktop-wager-help"
            className={amountValid ? 'field-help' : 'field-error'}
            role={amountValid ? undefined : 'alert'}
          >
            {amountValid
              ? '这里填写本轮累计投入，不是本次额外增加的筹码。'
              : `请输入 ${formatPoints(minimum)} 至 ${formatPoints(prompt.maxTo)} 之间的整数。`}
          </small>
        </div>
      )}
      <div className="poker-actions real-poker-actions">
        {actions.has('FOLD') && (
          <button className="fold-button" onClick={() => onAction('FOLD')}>
            <Icon name="close" size={16} /> 弃牌
          </button>
        )}
        {actions.has('CHECK') && (
          <button className="call-button" onClick={() => onAction('CHECK')}>
            <Icon name="check" size={16} /> 过牌
          </button>
        )}
        {actions.has('CALL') && (
          <button className="call-button" onClick={() => onAction('CALL')}>
            <Icon name="chip" size={16} /> 跟注 {formatPoints(prompt.callAmount)}
          </button>
        )}
        {wagerAction && (
          <button
            className="raise-button"
            disabled={!amountValid}
            onClick={() => onAction(wagerAction, amount)}
          >
            {wagerAction === 'BET_TO' ? '下注到' : '加注到'}{' '}
            {amountValid ? formatPoints(amount) : '—'}
          </button>
        )}
        {actions.has('ALL_IN') && (
          <button className="allin-button" onClick={() => onAction('ALL_IN')}>
            全下 {formatPoints(prompt.maxTo)}
          </button>
        )}
      </div>
    </section>
  );
}

function WaitingPanel({
  icon = 'spade',
  title,
  text,
}: {
  icon?: IconName;
  title: string;
  text: string;
}) {
  return (
    <section className="operation-panel waiting-panel-real">
      <span className="waiting-symbol">
        <Icon name={icon} size={27} />
      </span>
      <h2>{title}</h2>
      <p>{text}</p>
    </section>
  );
}

function ReadyConfirmation({
  room,
  mySeat,
  busy,
  onReady,
}: {
  room: EnhancedRoomProjection;
  mySeat: EnhancedSeat | null;
  busy: boolean;
  onReady: () => void;
}) {
  const eligible = room.seats.filter(
    (seat) => seat.playerId && seat.connected && !seat.sittingOut && seat.stack > 0,
  );
  const ready = room.readyCount ?? eligible.filter((seat) => seat.ready).length;
  const required = room.requiredReadyCount ?? eligible.length;
  const waiting = eligible.filter((seat) => !seat.ready);
  const enoughPlayers = eligible.length >= 2;
  return (
    <section className="operation-panel ready-panel">
      <div className="ready-head">
        <span className="ready-icon">
          <Icon name="check" size={22} />
        </span>
        <div>
          <span className="eyebrow">人齐再开 · 每手确认</span>
          <h2>准备开始下一手</h2>
        </div>
        <strong>
          {ready}
          <small> / {required}</small>
        </strong>
      </div>
      <progress
        className="ready-progress"
        max={Math.max(1, required)}
        value={Math.min(ready, Math.max(1, required))}
        aria-label={`已确认 ${ready} 人，共需 ${required} 人`}
      />
      <ul className="ready-list">
        {eligible.map((seat) => (
          <li key={seat.playerId} className={seat.ready ? 'confirmed' : ''}>
            <span className="mini-avatar">{seat.nickname?.slice(0, 1)}</span>
            <span>
              <strong>{seat.nickname}</strong>
              <small>{seat.ready ? '已准备' : '还没准备'}</small>
            </span>
            <Icon name={seat.ready ? 'check' : 'clock'} size={17} />
          </li>
        ))}
      </ul>
      {!enoughPlayers ? (
        <p className="waiting-names">至少两人才能开牌，再等一位朋友入座。</p>
      ) : waiting.length > 0 ? (
        <p className="waiting-names">还等 {waiting.map((seat) => seat.nickname).join('、')} 准备</p>
      ) : null}
      {mySeat ? (
        <button
          className="primary-button ready-button"
          disabled={
            busy ||
            mySeat.ready ||
            !enoughPlayers ||
            !eligible.some((seat) => seat.playerId === mySeat.playerId)
          }
          onClick={onReady}
        >
          <Icon name="check" size={18} />{' '}
          {!enoughPlayers ? '等朋友入座' : mySeat.ready ? '你准备好了，等等朋友' : '我准备好了'}
        </button>
      ) : (
        <p className="sheet-safety">先在牌桌选个空位，坐下后就能一起准备。</p>
      )}
    </section>
  );
}

function RecentActions({ actions }: { actions: TableActionItem[] }) {
  if (!actions.length) return null;
  return (
    <section className="recent-actions" aria-label="本手最近行动">
      <header>
        <span>
          <Icon name="history" size={14} /> 本手最近行动
        </span>
        <small>最新在上</small>
      </header>
      {[...actions]
        .slice(-4)
        .reverse()
        .map((action) => (
          <p key={`${action.seq}-${action.playerId ?? 'table'}`}>
            <i>{phaseLabel[action.street] ?? action.street}</i>
            <span>{naturalAction(action)}</span>
          </p>
        ))}
    </section>
  );
}

function MobileActionDock({
  room,
  heroSeat,
  seconds,
  busy,
  onAction,
}: {
  room: EnhancedRoomProjection;
  heroSeat: EnhancedSeat | null;
  seconds: number;
  busy: boolean;
  onAction: (action: PlayerAction, amountTo?: number) => void;
}) {
  const prompt = room.prompt!;
  const actions = new Set(prompt.legalActions);
  const wagerAction: PlayerAction | null = actions.has('RAISE_TO')
    ? 'RAISE_TO'
    : actions.has('BET_TO')
      ? 'BET_TO'
      : null;
  const minimum = prompt.minRaiseTo ?? prompt.minBetTo ?? 0;
  const [raiseOpen, setRaiseOpen] = useState(false);
  const [amountInput, setAmountInput] = useState(String(minimum));
  useEffect(() => setAmountInput(String(minimum)), [minimum, room.serverSeq]);
  const amount = Number(amountInput);
  const valid =
    amountInput.trim() !== '' &&
    Number.isInteger(amount) &&
    amount >= minimum &&
    amount <= prompt.maxTo;
  return (
    <>
      <div className="mobile-action-dock" role="group" aria-label="行动操作区" aria-busy={busy}>
        <div className="mobile-turn-copy">
          <span>轮到你 · {seconds} 秒</span>
          <small>
            {prompt.callAmount > 0 ? `跟注 ${formatPoints(prompt.callAmount)}` : '可过牌'}
          </small>
        </div>
        <div className="mobile-action-buttons">
          {actions.has('FOLD') && (
            <button disabled={busy} className="fold-button" onClick={() => onAction('FOLD')}>
              <Icon name="close" size={17} />
              弃牌
            </button>
          )}
          {actions.has('CHECK') && (
            <button
              disabled={busy}
              className="call-button primary-action"
              onClick={() => onAction('CHECK')}
            >
              <Icon name="check" size={17} />
              过牌
            </button>
          )}
          {actions.has('CALL') && (
            <button
              disabled={busy}
              className="call-button primary-action"
              onClick={() => onAction('CALL')}
            >
              <Icon name="chip" size={17} />
              跟注 {formatPoints(prompt.callAmount)}
            </button>
          )}
          {wagerAction && (
            <button disabled={busy} className="raise-button" onClick={() => setRaiseOpen(true)}>
              {wagerAction === 'BET_TO' ? '下注' : '加注'}
            </button>
          )}
          {!wagerAction && actions.has('ALL_IN') && (
            <button disabled={busy} className="allin-button" onClick={() => onAction('ALL_IN')}>
              全下 {formatPoints(prompt.maxTo)}
            </button>
          )}
        </div>
      </div>
      {raiseOpen && wagerAction && (
        <Modal
          title={wagerAction === 'BET_TO' ? '下注到（本轮总投入）' : '加注到（本轮总投入）'}
          onClose={() => setRaiseOpen(false)}
        >
          <div className="mobile-wager-sheet">
            <label className="amount-input">
              <Icon name="chip" size={18} />
              <input
                type="number"
                min={minimum}
                max={prompt.maxTo}
                step="1"
                inputMode="numeric"
                value={amountInput}
                onChange={(event) => setAmountInput(event.target.value)}
                aria-label="精确输入下注后总投入"
                aria-invalid={!valid}
                aria-describedby="mobile-wager-help"
              />
            </label>
            <div className="bet-suggestions">
              {betSuggestions(room, heroSeat).map((suggestion) => (
                <button
                  type="button"
                  className={amount === suggestion.amountTo ? 'active' : ''}
                  aria-pressed={amount === suggestion.amountTo}
                  key={`${suggestion.semantic}-${suggestion.amountTo}`}
                  onClick={() => setAmountInput(String(suggestion.amountTo))}
                >
                  <strong>{suggestion.label}</strong>
                  <small>{formatPoints(suggestion.amountTo)}</small>
                </button>
              ))}
            </div>
            <input
              type="range"
              min={minimum}
              max={prompt.maxTo}
              step={room.settings.smallBlind}
              value={valid ? amount : minimum}
              onChange={(event) => setAmountInput(event.target.value)}
            />
            <div className="range-bounds">
              <span>最小 {formatPoints(minimum)}</span>
              <span>最大 {formatPoints(prompt.maxTo)}</span>
            </div>
            <small
              id="mobile-wager-help"
              className={valid ? 'field-help' : 'field-error'}
              role={valid ? undefined : 'alert'}
            >
              {valid
                ? '金额表示本轮累计投入。'
                : `请输入 ${formatPoints(minimum)} 至 ${formatPoints(prompt.maxTo)} 之间的整数。`}
            </small>
            <button
              className="primary-button"
              disabled={!valid || busy}
              onClick={() => {
                onAction(wagerAction, amount);
                setRaiseOpen(false);
              }}
            >
              {wagerAction === 'BET_TO' ? '下注到' : '加注到'} {valid ? formatPoints(amount) : '—'}
            </button>
            {actions.has('ALL_IN') && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  onAction('ALL_IN');
                  setRaiseOpen(false);
                }}
              >
                全下 {formatPoints(prompt.maxTo)}
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

function LiveActions({
  room,
  meId,
  isDealer,
  seconds,
  onStreet,
  onObject,
  onConfirm,
  onPropose,
}: {
  room: PublicRoomProjection;
  meId: string;
  isDealer: boolean;
  seconds: number;
  onStreet: (street: 'FLOP' | 'TURN' | 'RIVER') => void;
  onObject: (proposalId: string) => void;
  onConfirm: (proposalId: string) => void;
  onPropose: () => void;
}) {
  const proposal = room.liveResultProposal;
  const eligible = room.pots.some((pot) => pot.eligiblePlayerIds.includes(meId));
  const objected = (proposal?.objectedByPlayerIds.length ?? 0) > 0;
  const confirmationRound = !objected && (proposal?.confirmedByPlayerIds.length ?? 0) > 0;
  if (room.status === 'DISPUTED') {
    return (
      <WaitingPanel title="这手先暂停" text="结果还没商量好，请联系开桌的朋友处理后再继续。" />
    );
  }
  return (
    <section className="operation-panel live-panel real-live-panel">
      <div className="operation-head">
        <div>
          <span className="eyebrow">线下牌桌</span>
          <h2>现场操作台</h2>
        </div>
        <span className="phase-tag">{room.phase ?? room.status}</span>
      </div>
      {room.pendingLiveStreet && (
        <article className="live-task">
          <span>
            <Icon name="cards" size={21} />
          </span>
          <div>
            <small>下注轮已结束</small>
            <h3>请在线下发出 {room.pendingLiveStreet}</h3>
            <p>确认后才会启动下一轮行动计时。</p>
          </div>
          {isDealer ? (
            <button className="primary-button" onClick={() => onStreet(room.pendingLiveStreet!)}>
              已发 {room.pendingLiveStreet}
            </button>
          ) : (
            <em>等待发牌确认人</em>
          )}
        </article>
      )}
      {room.phase === 'SHOWDOWN' && !proposal && (
        <article className="live-task">
          <span>
            <Icon name="table" size={21} />
          </span>
          <div>
            <small>摊牌</small>
            <h3>分别提交各底池赢家</h3>
            <p>系统只允许选择该底池仍有资格的玩家。</p>
          </div>
          {isDealer ? (
            <button className="primary-button" onClick={onPropose}>
              提交结果
            </button>
          ) : (
            <em>等待发牌确认人</em>
          )}
        </article>
      )}
      {proposal && (
        <article className="proposal-card real-proposal">
          <div className="proposal-top">
            <span>结果提议</span>
            <small>
              {objected
                ? '已有异议'
                : confirmationRound
                  ? '等待全员确认'
                  : seconds > 0
                    ? `${seconds} 秒无异议自动结算`
                    : '正在结算'}
            </small>
          </div>
          {room.pots.map((pot) => (
            <div className="proposal-pot" key={pot.id}>
              <b>{pot.id === 'pot-0' ? '主池' : `边池 ${Number(pot.id.slice(4))}`}</b>
              <span>
                {proposal.winnersByPot[pot.id]
                  ?.map((id) => room.seats.find((seat) => seat.playerId === id)?.nickname)
                  .join('、')}
              </span>
              <em>{pot.amount}</em>
            </div>
          ))}
          <div className="proposal-actions">
            {!objected && !confirmationRound && eligible && (
              <button className="dispute-button" onClick={() => onObject(proposal.id)}>
                提出异议
              </button>
            )}
            {confirmationRound && eligible && !proposal.confirmedByPlayerIds.includes(meId) && (
              <button className="confirm-button" onClick={() => onConfirm(proposal.id)}>
                确认新方案
              </button>
            )}
            {objected && isDealer && (
              <button className="primary-button" onClick={onPropose}>
                提交新方案
              </button>
            )}
          </div>
          {confirmationRound && (
            <p>{proposal.confirmedByPlayerIds.length} 人已确认；所有有资格玩家确认后立即结算。</p>
          )}
        </article>
      )}
      {!room.pendingLiveStreet && room.phase !== 'SHOWDOWN' && !proposal && (
        <WaitingPanel
          title={room.status === 'ACTIVE' ? '现场手牌进行中' : '等待玩家准备'}
          text={friendlyRoomMessage(room.message) || '网站记录下注和筹码，实体牌面以现场为准。'}
        />
      )}
    </section>
  );
}

function LiveWinnerDialog({
  room,
  onClose,
  onSubmit,
}: {
  room: PublicRoomProjection;
  onClose: () => void;
  onSubmit: (winners: Record<string, string[]>) => Promise<boolean>;
}) {
  const initial = Object.fromEntries(
    room.pots.map((pot) => [pot.id, pot.eligiblePlayerIds.slice(0, 1)]),
  );
  const [winners, setWinners] = useState<Record<string, string[]>>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="提交各底池赢家" onClose={onClose}>
      {error && <ErrorBox onClose={() => setError(null)}>{error}</ErrorBox>}
      <div className="winner-pots">
        {room.pots.map((pot) => (
          <fieldset key={pot.id}>
            <legend>
              {pot.id === 'pot-0' ? '主池' : `边池 ${Number(pot.id.slice(4))}`} · {pot.amount}
            </legend>
            {pot.eligiblePlayerIds.map((id) => {
              const seat = room.seats.find((item) => item.playerId === id)!;
              const checked = winners[pot.id]?.includes(id) ?? false;
              return (
                <label key={id}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setWinners((current) => ({
                        ...current,
                        [pot.id]: checked
                          ? current[pot.id]!.filter((item) => item !== id)
                          : [...(current[pot.id] ?? []), id],
                      }))
                    }
                  />
                  <span>{seat.nickname}</span>
                </label>
              );
            })}
          </fieldset>
        ))}
      </div>
      <p className="sheet-safety">可勾选多名赢家以平分底池；奇数筹码按按钮位后顺时针分配。</p>
      <button
        className="primary-button"
        disabled={pending || room.pots.some((pot) => !winners[pot.id]?.length)}
        onClick={() => {
          setPending(true);
          setError(null);
          void onSubmit(winners)
            .then((ok) => {
              if (ok) onClose();
              else setError('提交未成功，牌桌状态可能已更新，请检查后重试');
            })
            .catch((caught) => setError(caught instanceof Error ? caught.message : '提交结果失败'))
            .finally(() => setPending(false));
        }}
      >
        {pending ? '正在提交…' : '提交并开始 10 秒异议期'}
      </button>
    </Modal>
  );
}

function HistoryDialog({
  items,
  room,
  status,
  error,
  onRetry,
  onClose,
}: {
  items: HandHistoryItem[];
  room: EnhancedRoomProjection;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  const [expandedHandId, setExpandedHandId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(20);
  const nameMap = useMemo(
    () =>
      new Map(
        room.seats
          .filter((seat) => seat.playerId)
          .map((seat) => [seat.playerId!, seat.nickname ?? '玩家']),
      ),
    [room.seats],
  );
  useEffect(() => {
    setExpandedHandId(items[0]?.handId ?? null);
    setVisibleCount(20);
  }, [items]);
  const positionsBySeat = positionsForRoom(room);
  const positionMap = new Map(
    room.seats
      .filter((seat) => seat.playerId)
      .map((seat) => [seat.playerId!, positionsBySeat.get(seat.seat) ?? []]),
  );
  const streetOrder = ['PREFLOP', 'FLOP', 'TURN', 'RIVER', 'SHOWDOWN'] as const;
  const visibleItems = items.slice(0, visibleCount);
  return (
    <Modal title="牌谱" className="history-modal" onClose={onClose}>
      <div className="history-intro">
        <span className="history-intro__mark">
          <Icon name="book" size={19} />
        </span>
        <span className="history-intro__copy">
          <strong>牌局回放</strong>
          <small>点开任意一手，逐街回看每次行动</small>
        </span>
        <b className="history-intro__count">{items.length} 手</b>
      </div>
      {status === 'loading' && (
        <div className="history-state" role="status">
          <span className="loader" />
          <strong>正在整理牌谱</strong>
          <small>赢家、底池和每次行动马上就好。</small>
        </div>
      )}
      {status === 'error' && (
        <div className="history-state history-state--error">
          <ErrorBox>{error ?? '牌谱没有加载出来'}</ErrorBox>
          <button className="secondary-button" onClick={onRetry}>
            <Icon name="refresh" size={16} /> 再试一次
          </button>
        </div>
      )}
      <div className="history-list">
        {status === 'ready' &&
          visibleItems.map((hand) => {
            const actions = historyActions(hand, nameMap, positionMap);
            const historicalNames = new Map(nameMap);
            for (const action of actions) {
              if (action.playerId) historicalNames.set(action.playerId, action.nickname);
            }
            const settlement = historySettlement(hand.result);
            const winners = settlement?.payouts ?? [];
            const winnerCopy = winners.length
              ? winners
                  .map((winner) => historicalNames.get(winner.playerId) ?? '玩家')
                  .slice(0, 2)
                  .join('、')
              : hand.endedAt
                ? '已结算'
                : '进行中';
            const reasonCopy =
              settlement?.reason === 'UNCONTESTED'
                ? '其余玩家弃牌'
                : settlement?.reason === 'SHOWDOWN'
                  ? '线上摊牌'
                  : settlement?.reason === 'LIVE_CONFIRMED'
                    ? '现场结果确认'
                    : hand.endedAt
                      ? '结算完成'
                      : '牌局进行中';
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
                      {new Date(hand.startedAt).toLocaleString('zh-CN', {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </span>
                  <span className="history-hand__outcome">
                    <strong>{winnerCopy}</strong>
                    <small>
                      {reasonCopy}
                      {settlement?.totalPot ? ` · 底池 ${formatPoints(settlement.totalPot)}` : ''}
                    </small>
                  </span>
                  <ModeBadge mode={hand.mode} />
                  <Icon name="chevron" size={17} className="history-chevron" />
                </button>
                {expanded && (
                  <div className="history-hand__detail">
                    {settlement && (
                      <section className="history-result" aria-label="本手结算">
                        <header>
                          <span>
                            <Icon name="crown" size={18} /> 结算结果
                          </span>
                          <strong>{formatPoints(settlement.totalPot)} 筹码</strong>
                        </header>
                        {settlement.communityCards.length > 0 && (
                          <div className="history-board" aria-label="公共牌">
                            {settlement.communityCards.map((card, index) => (
                              <PlayingCard card={card} compact dealIndex={index} key={card} />
                            ))}
                          </div>
                        )}
                        <ul className="history-payouts">
                          {settlement.payouts.map((payout) => (
                            <li key={payout.playerId}>
                              <span className="mini-avatar">
                                {(historicalNames.get(payout.playerId) ?? '玩').slice(0, 1)}
                              </span>
                              <span>
                                <strong>{historicalNames.get(payout.playerId) ?? '玩家'}</strong>
                                <small>
                                  {payout.potIndexes
                                    .map((pot) => (pot === 0 ? '主池' : `边池 ${pot}`))
                                    .join('、')}
                                </small>
                              </span>
                              <b>+{formatPoints(payout.amount)}</b>
                            </li>
                          ))}
                          {settlement.refunds.map((refund) => (
                            <li key={`refund-${refund.playerId}`} className="refund">
                              <span className="mini-avatar">
                                {(historicalNames.get(refund.playerId) ?? '玩').slice(0, 1)}
                              </span>
                              <span>
                                <strong>{historicalNames.get(refund.playerId) ?? '玩家'}</strong>
                                <small>未被跟注部分退回</small>
                              </span>
                              <b>+{formatPoints(refund.amount)}</b>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                    <div className="history-streets">
                      {streetOrder.map((street) => {
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
                      {actions.length === 0 && (
                        <p className="empty-state">这一手还没有可以回看的行动。</p>
                      )}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        {status === 'ready' && items.length === 0 && (
          <div className="history-state">
            <span className="history-empty-cards" aria-hidden="true">
              <i />
              <i />
              <Icon name="spade" size={21} />
            </span>
            <strong>第一手还没打完</strong>
            <small>结算后，赢家、底池和每次下注都会自动整理到这里。</small>
          </div>
        )}
      </div>
      {status === 'ready' && visibleCount < items.length && (
        <button
          type="button"
          className="secondary-button history-load-more"
          onClick={() => setVisibleCount((count) => Math.min(items.length, count + 20))}
        >
          再显示 {Math.min(20, items.length - visibleCount)} 手
        </button>
      )}
    </Modal>
  );
}

let bodyScrollLockCount = 0;
let bodyOverflowBeforeModal = '';

function lockBodyScroll(): () => void {
  if (bodyScrollLockCount === 0) {
    bodyOverflowBeforeModal = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  bodyScrollLockCount += 1;
  return () => {
    bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
    if (bodyScrollLockCount === 0) {
      document.body.style.overflow = bodyOverflowBeforeModal;
      bodyOverflowBeforeModal = '';
    }
  };
}

function Modal({
  title,
  children,
  onClose,
  locked = false,
  className = '',
}: {
  title: string;
  children: ReactNode;
  onClose?: () => void;
  locked?: boolean;
  className?: string;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const unlockBodyScroll = lockBodyScroll();
    const frame = window.requestAnimationFrame(() => {
      const activeElement =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const firstControl = dialogRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
      );
      if (!activeElement || !dialogRef.current?.contains(activeElement)) {
        (firstControl ?? dialogRef.current)?.focus();
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
      unlockBodyScroll();
      previousFocus?.focus();
    };
  }, []);

  const dialog = (
    <div
      className="sheet-backdrop"
      onMouseDown={(event) => {
        if (!locked && onClose && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={`bottom-sheet real-modal ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !locked && onClose) {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== 'Tab') return;
          const controls = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ) ?? [],
          ).filter((control) => control.offsetParent !== null);
          if (!controls.length) return;
          const first = controls[0]!;
          const last = controls[controls.length - 1]!;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="sheet-handle" aria-hidden="true" />
        <header>
          <h2 id={titleId}>{title}</h2>
          {!locked && onClose && (
            <button
              type="button"
              className="round-button"
              onClick={onClose}
              aria-label={`关闭${title}`}
            >
              <Icon name="close" size={18} />
            </button>
          )}
        </header>
        {children}
      </section>
    </div>
  );
  return createPortal(dialog, document.body);
}

export default App;

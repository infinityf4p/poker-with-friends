import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_ROOM_SETTINGS,
  type RoomMode,
  type RoomSettings,
} from '@poker-with-friends/protocol';
import {
  api,
  type CreateRoomResponse,
  type JoinResponse,
  type LobbyRoomSummary,
  type UserSession,
} from '../api';
import { Icon } from '../icons';
import { formatPoints, statusLabel } from '../poker-ui';
import { navigate } from '../navigation';
import { Brand, ErrorBox, IconButton, Loading, Modal, ModeBadge } from '../components/ui';
import { PlayingCard } from '../components/cards';

export function LobbyPage() {
  const [session, setSession] = useState<UserSession | null>(null);
  const [rooms, setRooms] = useState<LobbyRoomSummary[]>([]);
  const [checking, setChecking] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null);
  const [modeFilter, setModeFilter] = useState<RoomMode | 'ALL'>('ALL');
  const [availableOnly, setAvailableOnly] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [registrationInvite, setRegistrationInvite] = useState<string | null>(null);
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const joiningRef = useRef(false);
  const refreshingRef = useRef(false);
  const loggingOutRef = useRef(false);
  const mountedRef = useRef(false);
  const sessionGeneration = useRef(0);
  const roomsRequest = useRef(0);

  const loadRooms = async () => {
    const request = ++roomsRequest.current;
    const generation = sessionGeneration.current;
    const isCurrent = () =>
      mountedRef.current &&
      request === roomsRequest.current &&
      generation === sessionGeneration.current;
    try {
      const updatedRooms = await api<LobbyRoomSummary[]>('/api/rooms');
      if (isCurrent()) setRooms(updatedRooms);
    } catch (caught) {
      if (isCurrent()) throw caught;
    }
  };
  const refreshRooms = async () => {
    if (refreshingRef.current || loggingOutRef.current) return;
    const generation = sessionGeneration.current;
    refreshingRef.current = true;
    setRefreshing(true);
    setError(null);
    try {
      await loadRooms();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '牌桌列表刷新失败');
    } finally {
      if (!mountedRef.current || generation !== sessionGeneration.current) return;
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };
  useEffect(() => {
    mountedRef.current = true;
    const generation = sessionGeneration.current;
    const isCurrent = () => mountedRef.current && generation === sessionGeneration.current;
    api<UserSession>('/api/auth/session')
      .then((user) => {
        if (!isCurrent()) return;
        setSession(user);
        return loadRooms().catch((caught) =>
          setError(caught instanceof Error ? caught.message : '牌桌列表加载失败'),
        );
      })
      .catch(() => {
        if (isCurrent()) setSession(null);
      })
      .finally(() => {
        if (isCurrent()) setChecking(false);
      });
    return () => {
      mountedRef.current = false;
      sessionGeneration.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    const refresh = () => {
      if (!loggingOutRef.current) void loadRooms().catch(() => undefined);
    };
    const interval = window.setInterval(refresh, 6_000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
    };
  }, [session?.id]);

  const enterRoom = async (room: LobbyRoomSummary) => {
    if (joiningRef.current || loggingOutRef.current) return;
    if (room.membership && room.membership.status !== 'KICKED') {
      navigate(`/room/${room.roomId}`);
      return;
    }
    if (room.membership?.status === 'KICKED') {
      setError('暂时无法重新加入该牌桌');
      return;
    }
    if (room.availableSeats === 0) {
      setError('牌桌已满');
      return;
    }
    joiningRef.current = true;
    const generation = sessionGeneration.current;
    const isCurrent = () => mountedRef.current && generation === sessionGeneration.current;
    setJoiningRoomId(room.roomId);
    setError(null);
    try {
      const joined = await api<JoinResponse>(`/api/rooms/${room.roomId}/enter`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (isCurrent()) navigate(`/room/${joined.roomId}`);
    } catch (caught) {
      if (!isCurrent()) return;
      setError(caught instanceof Error ? caught.message : '加入牌桌失败');
      await loadRooms().catch(() => undefined);
    } finally {
      if (!isCurrent()) return;
      joiningRef.current = false;
      setJoiningRoomId(null);
    }
  };

  const logout = async () => {
    if (loggingOutRef.current || joiningRef.current) return;
    loggingOutRef.current = true;
    setLoggingOut(true);
    try {
      await api('/api/auth/logout', { method: 'POST' });
      if (!mountedRef.current) return;
      sessionGeneration.current += 1;
      refreshingRef.current = false;
      setRefreshing(false);
      setSession(null);
      setRooms([]);
      setError(null);
    } catch (caught) {
      if (mountedRef.current) {
        setError(caught instanceof Error ? caught.message : '退出登录失败');
      }
    } finally {
      loggingOutRef.current = false;
      if (mountedRef.current) setLoggingOut(false);
    }
  };

  const createRegistrationInvite = async () => {
    if (creatingInvite) return;
    setCreatingInvite(true);
    setError(null);
    try {
      const result = await api<{ code: string }>('/api/auth/registration-invites', {
        method: 'POST',
      });
      setRegistrationInvite(result.code);
      await navigator.clipboard?.writeText(result.code).catch(() => undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '邀请码生成失败');
    } finally {
      setCreatingInvite(false);
    }
  };

  const visibleRooms = rooms.filter((room) => {
    const canEnter =
      room.membership?.status !== 'KICKED' && (room.availableSeats > 0 || room.membership !== null);
    return (modeFilter === 'ALL' || room.mode === modeFilter) && (!availableOnly || canEnter);
  });

  if (checking) return <Loading />;
  if (!session) {
    return (
      <UserLogin
        error={error}
        onSubmit={async (username, password) => {
          const generation = sessionGeneration.current;
          try {
            const user = await api<UserSession>('/api/auth/login', {
              method: 'POST',
              body: JSON.stringify({ username, password }),
            });
            if (!mountedRef.current || generation !== sessionGeneration.current) return;
            sessionGeneration.current += 1;
            setSession(user);
            setError(null);
            await loadRooms().catch((caught) =>
              setError(caught instanceof Error ? caught.message : '牌桌列表加载失败'),
            );
          } catch (caught) {
            if (mountedRef.current && generation === sessionGeneration.current) {
              setError(caught instanceof Error ? caught.message : '登录失败');
            }
          }
        }}
        onRegister={async (inviteCode, username, password) => {
          const generation = sessionGeneration.current;
          try {
            const user = await api<UserSession>('/api/auth/register', {
              method: 'POST',
              body: JSON.stringify({ inviteCode, username, password }),
            });
            if (!mountedRef.current || generation !== sessionGeneration.current) return;
            sessionGeneration.current += 1;
            setSession(user);
            setError(null);
            await loadRooms().catch((caught) =>
              setError(caught instanceof Error ? caught.message : '牌桌列表加载失败'),
            );
          } catch (caught) {
            if (mountedRef.current && generation === sessionGeneration.current) {
              setError(caught instanceof Error ? caught.message : '注册失败');
            }
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
          <div className="account-pill">
            <span className="avatar">{session.displayName.slice(0, 1).toUpperCase()}</span>
            <span>
              <small>@{session.username}</small>
              <strong>{session.displayName}</strong>
              <small>{formatPoints(session.chipBalance ?? 0)} 账户筹码</small>
            </span>
          </div>
          <IconButton
            icon="logout"
            label={loggingOut ? '正在退出登录' : '退出登录'}
            disabled={joiningRoomId !== null || loggingOut}
            busy={loggingOut}
            onClick={() => void logout()}
          />
          <button
            type="button"
            className="text-button account-profile-button"
            onClick={() => setProfileOpen(true)}
          >
            账号设置
          </button>
          <button
            type="button"
            className="text-button account-invite-button"
            onClick={() => void createRegistrationInvite()}
            disabled={creatingInvite}
          >
            {creatingInvite ? '生成中…' : '生成注册邀请码'}
          </button>
        </div>
      </header>
      <div className="page-container lobby-content">
        <section className="lobby-heading">
          <div>
            <h1>牌桌大厅</h1>
            <p className="lobby-heading__sub">创建牌局后自动成为房主，分享邀请码邀请朋友。</p>
          </div>
          <button
            type="button"
            className="primary-button lobby-create-button"
            onClick={() => setCreateOpen(true)}
          >
            <Icon name="plus" size={17} /> 创建牌局
          </button>
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
        {registrationInvite && (
          <div className="invite-code-banner" role="status">
            <span>
              <strong>注册邀请码</strong>
              <code>{registrationInvite}</code>
            </span>
            <button
              type="button"
              className="text-button"
              onClick={() => setRegistrationInvite(null)}
            >
              知道了
            </button>
          </div>
        )}
        <section className="lobby-room-section" aria-label="浏览牌桌">
          <header className="lobby-room-toolbar">
            <div className="lobby-filters" role="group" aria-label="牌桌类型">
              {(
                [
                  ['ALL', '全部'],
                  ['ONLINE', '线上'],
                  ['LIVE', '线下'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  type="button"
                  key={mode}
                  className="lobby-filter"
                  aria-pressed={modeFilter === mode}
                  onClick={() => setModeFilter(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="lobby-filter-controls">
              <label className="lobby-available-filter">
                <input
                  type="checkbox"
                  checked={availableOnly}
                  onChange={(event) => setAvailableOnly(event.target.checked)}
                />
                <span>仅可加入</span>
              </label>
              <IconButton
                icon="refresh"
                label={refreshing ? '正在刷新牌桌列表' : '刷新牌桌列表'}
                className="lobby-refresh"
                onClick={() => void refreshRooms()}
                disabled={refreshing || loggingOut}
                busy={refreshing}
              />
            </div>
          </header>
          <div className="lobby-room-grid" aria-label="牌桌列表">
            {visibleRooms.map((room) => (
              <LobbyRoomCard
                key={room.roomId}
                room={room}
                joining={joiningRoomId === room.roomId}
                disabled={joiningRoomId !== null || loggingOut}
                onEnter={() => void enterRoom(room)}
              />
            ))}
            {visibleRooms.length === 0 && (
              <div className="empty-state rich-empty lobby-room-empty">
                <Icon name="table" size={32} />
                <strong>{rooms.length === 0 ? '暂无牌桌' : '暂无符合条件的牌桌'}</strong>
                {rooms.length > 0 && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setModeFilter('ALL');
                      setAvailableOnly(false);
                    }}
                  >
                    清除筛选
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
        <button type="button" className="admin-entry" onClick={() => navigate('/admin')}>
          <Icon name="table" size={16} /> 管理员入口
        </button>
      </div>
      {createOpen && (
        <CreateRoomDialog
          pending={creating}
          error={createError}
          onClose={() => {
            if (creating) return;
            setCreateOpen(false);
            setCreateError(null);
          }}
          onSubmit={async (name, settings) => {
            setCreating(true);
            setCreateError(null);
            try {
              const created = await api<CreateRoomResponse>('/api/rooms', {
                method: 'POST',
                body: JSON.stringify({ name, settings }),
              });
              navigate(`/room/${created.roomId}`);
            } catch (caught) {
              setCreateError(caught instanceof Error ? caught.message : '创建牌局失败');
            } finally {
              setCreating(false);
            }
          }}
        />
      )}
      {profileOpen && (
        <UserProfileDialog
          user={session}
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

function LobbyRoomCard({
  room,
  joining,
  disabled,
  onEnter,
}: {
  room: LobbyRoomSummary;
  joining: boolean;
  disabled: boolean;
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
          <h3>{room.name}</h3>
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
              : '暂无玩家'}
          </strong>
          <small>
            {onlineCount > 0 ? `${onlineCount} 人在线` : '无人在线'} ·{' '}
            {room.availableSeats > 0 ? `${room.availableSeats} 个空位` : '已满'}
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
                <strong>{blocked ? '暂不能加入' : full ? '牌桌已满' : '可直接加入'}</strong>
              </span>
            </>
          )}
        </span>
        <button
          type="button"
          data-testid={`join-room-${room.roomId}`}
          className={joined ? 'secondary-button' : 'primary-button'}
          onClick={onEnter}
          disabled={disabled || blocked || full}
          aria-busy={joining || undefined}
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
  onRegister,
}: {
  error: string | null;
  onSubmit: (username: string, password: string) => Promise<void>;
  onRegister: (inviteCode: string, username: string, password: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [pending, setPending] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const submittingRef = useRef(false);
  return (
    <main className="login-page account-login">
      <section className="login-card account-login-card">
        <Brand />
        <div className="login-cards" aria-hidden="true">
          <PlayingCard card="As" />
          <PlayingCard card="Kh" dealIndex={1} />
        </div>
        <div className="login-heading">
          <h1>{mode === 'login' ? '登录' : '邀请码注册'}</h1>
          <p>{mode === 'login' ? '登录后进入牌桌大厅' : '输入朋友分享的邀请码创建账号'}</p>
        </div>
        {error && <ErrorBox>{error}</ErrorBox>}
        <form
          className="login-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (username.trim().length < 3) return;
            if (mode === 'register' && !inviteCode.trim()) return;
            if (submittingRef.current) return;
            submittingRef.current = true;
            setPending(true);
            const action =
              mode === 'login'
                ? onSubmit(username.trim(), password)
                : onRegister(inviteCode.trim(), username.trim(), password);
            void action.finally(() => {
              submittingRef.current = false;
              setPending(false);
            });
          }}
        >
          <label className="field field-with-icon">
            <span>用户名</span>
            <span>
              <Icon name="user" size={18} />
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                autoFocus
                disabled={pending}
                required
                minLength={3}
              />
            </span>
            {username.length > 0 && username.trim().length < 3 && (
              <small className="field-error">用户名至少需要 3 位</small>
            )}
          </label>
          {mode === 'register' && (
            <label className="field field-with-icon">
              <span>邀请码</span>
              <span>
                <Icon name="key" size={18} />
                <input
                  value={inviteCode}
                  onChange={(event) => setInviteCode(event.target.value)}
                  autoComplete="one-time-code"
                  disabled={pending}
                  required
                />
              </span>
            </label>
          )}
          <label className="field field-with-icon">
            <span>密码</span>
            <span>
              <Icon name="lock" size={18} />
              <input
                type={passwordVisible ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                disabled={pending}
                required
                minLength={mode === 'register' ? 6 : 1}
              />
              <button
                type="button"
                className="password-toggle"
                aria-label={passwordVisible ? '隐藏密码' : '显示密码'}
                title={passwordVisible ? '隐藏密码' : '显示密码'}
                aria-pressed={passwordVisible}
                onClick={() => setPasswordVisible((visible) => !visible)}
              >
                <Icon name={passwordVisible ? 'eye-off' : 'eye'} size={18} />
              </button>
            </span>
          </label>
          <button
            className="primary-button"
            disabled={
              pending ||
              username.trim().length < 3 ||
              !password ||
              (mode === 'register' && !inviteCode.trim())
            }
            aria-busy={pending || undefined}
          >
            {pending
              ? mode === 'login'
                ? '正在登录…'
                : '正在注册…'
              : mode === 'login'
                ? '登录'
                : '创建账号'}
            {!pending && <Icon name="arrow-right" size={18} />}
          </button>
        </form>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            setMode((current) => (current === 'login' ? 'register' : 'login'));
            setPassword('');
          }}
        >
          {mode === 'login' ? '使用邀请码注册' : '已有账号，返回登录'}
        </button>
        <button type="button" className="text-button" onClick={() => navigate('/admin')}>
          管理员入口
        </button>
      </section>
    </main>
  );
}

function UserProfileDialog({
  user,
  onClose,
  onSaved,
}: {
  user: UserSession;
  onClose: () => void;
  onSaved: (user: UserSession) => void;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
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
    <Modal title="账号设置" onClose={onClose} locked={pending}>
      {error && <ErrorBox onClose={() => setError(null)}>{error}</ErrorBox>}
      <form
        className="sheet-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          setPending(true);
          void api<UserSession>('/api/auth/profile', {
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

function CreateRoomDialog({
  pending,
  error,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (name: string, settings: RoomSettings) => Promise<void>;
}) {
  const [name, setName] = useState('朋友牌局');
  const [mode, setMode] = useState<RoomMode>('ONLINE');
  const [submitted, setSubmitted] = useState(false);
  const valid = name.trim().length > 0;
  return (
    <Modal title="创建牌局" onClose={onClose} locked={pending} className="create-room-modal">
      <form
        className="stacked-form"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (!valid) return;
          void onSubmit(name.trim(), { ...DEFAULT_ROOM_SETTINGS, mode });
        }}
      >
        {error && <ErrorBox>{error}</ErrorBox>}
        <label className="field">
          <span>牌局名称</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={48}
            autoFocus
          />
          {submitted && !valid && <small className="field-error">请输入牌局名称</small>}
        </label>
        <fieldset className="mode-choice">
          <legend>牌局类型</legend>
          <label>
            <input type="radio" checked={mode === 'ONLINE'} onChange={() => setMode('ONLINE')} />
            <span>线上牌桌</span>
          </label>
          <label>
            <input type="radio" checked={mode === 'LIVE'} onChange={() => setMode('LIVE')} />
            <span>线下牌桌</span>
          </label>
        </fieldset>
        <p className="form-hint">每位玩家初始带入 5,000 筹码，房主创建后会自动加入 1 号位。</p>
        <button
          type="submit"
          className="primary-button"
          disabled={pending || !valid}
          aria-busy={pending || undefined}
        >
          {pending ? '正在创建…' : '创建并进入牌桌'}
          {!pending && <Icon name="arrow-right" size={17} />}
        </button>
      </form>
    </Modal>
  );
}

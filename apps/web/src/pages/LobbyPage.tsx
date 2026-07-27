import { useEffect, useState } from 'react';
import { api, type JoinResponse, type LobbyRoomSummary, type UserSession } from '../api';
import { Icon } from '../icons';
import { formatPoints, statusLabel } from '../poker-ui';
import { navigate } from '../navigation';
import { Brand, ErrorBox, IconButton, Loading, ModeBadge } from '../components/ui';

export function LobbyPage() {
  const [session, setSession] = useState<UserSession | null>(null);
  const [rooms, setRooms] = useState<LobbyRoomSummary[]>([]);
  const [checking, setChecking] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null);

  const loadRooms = async () => setRooms(await api<LobbyRoomSummary[]>('/api/rooms'));
  const refreshRooms = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      await loadRooms();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '牌桌列表刷新失败');
    } finally {
      setRefreshing(false);
    }
  };
  useEffect(() => {
    api<UserSession>('/api/auth/session')
      .then((user) => {
        setSession(user);
        return loadRooms().catch((caught) =>
          setError(caught instanceof Error ? caught.message : '牌桌列表加载失败'),
        );
      })
      .catch(() => setSession(null))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (!session) return;
    const refresh = () => void loadRooms().catch(() => undefined);
    const interval = window.setInterval(refresh, 6_000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
    };
  }, [session?.id]);

  const enterRoom = async (room: LobbyRoomSummary) => {
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
    setJoiningRoomId(room.roomId);
    setError(null);
    try {
      const joined = await api<JoinResponse>(`/api/rooms/${room.roomId}/enter`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      navigate(`/room/${joined.roomId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '加入牌桌失败');
      await loadRooms().catch(() => undefined);
    } finally {
      setJoiningRoomId(null);
    }
  };

  if (checking) return <Loading />;
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
            await loadRooms();
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
          <div className="account-pill">
            <span className="avatar">{session.displayName.slice(0, 1).toUpperCase()}</span>
            <span>
              <small>@{session.username}</small>
              <strong>{session.displayName}</strong>
            </span>
          </div>
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
            <h1>牌桌大厅</h1>
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
              <h2 id="all-rooms-heading">全部牌桌</h2>
            </div>
            <button
              type="button"
              className="lobby-refresh"
              onClick={() => void refreshRooms()}
              disabled={refreshing}
              aria-busy={refreshing}
              aria-label="刷新牌桌列表"
            >
              <Icon name="refresh" size={16} /> {refreshing ? '刷新中' : '刷新'}
            </button>
          </header>
          <div className="lobby-room-grid">
            {rooms.map((room) => (
              <LobbyRoomCard
                key={room.roomId}
                room={room}
                joining={joiningRoomId === room.roomId}
                onEnter={() => void enterRoom(room)}
                onSpectate={() => navigate(`/room/${room.roomId}?view=public`)}
              />
            ))}
            {rooms.length === 0 && (
              <div className="empty-state rich-empty lobby-room-empty">
                <Icon name="table" size={32} />
                <strong>暂无牌桌</strong>
              </div>
            )}
          </div>
        </section>
        <button type="button" className="admin-entry" onClick={() => navigate('/admin')}>
          <Icon name="table" size={16} /> 管理员入口
        </button>
      </div>
    </main>
  );
}

function LobbyRoomCard({
  room,
  joining,
  onEnter,
  onSpectate,
}: {
  room: LobbyRoomSummary;
  joining: boolean;
  onEnter: () => void;
  onSpectate: () => void;
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
                <strong>{blocked ? '仅可旁观' : full ? '牌桌已满' : '可加入'}</strong>
              </span>
            </>
          )}
        </span>
        <span className="lobby-room-actions">
          {!joined && (
            <button
              type="button"
              data-testid={`spectate-room-${room.roomId}`}
              className="secondary-button"
              onClick={onSpectate}
            >
              <Icon name="eye" size={16} /> 旁观
            </button>
          )}
          <button
            type="button"
            data-testid={`join-room-${room.roomId}`}
            className="primary-button"
            onClick={onEnter}
            disabled={joining || blocked || full}
          >
            {actionLabel}
            {!joining && !blocked && !full && <Icon name="arrow-right" size={16} />}
          </button>
        </span>
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
          <h1>登录</h1>
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
            {pending ? '正在登录…' : '登录'}
            {!pending && <Icon name="arrow-right" size={18} />}
          </button>
        </form>
        <button type="button" className="text-button" onClick={() => navigate('/admin')}>
          管理员入口
        </button>
      </section>
    </main>
  );
}

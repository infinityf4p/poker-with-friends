import { useEffect, useRef, useState } from 'react';
import { api, type InvitePreview, type JoinResponse, type UserSession } from '../api';
import { Icon } from '../icons';
import { navigate } from '../navigation';
import { Brand, ErrorBox, IconButton, Loading, ModeBadge } from '../components/ui';
import { formatPoints } from '../poker-ui';

export function JoinPage({ token }: { token: string }) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [session, setSession] = useState<UserSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const joiningRef = useRef(false);
  const requestGeneration = useRef(0);
  useEffect(() => {
    const generation = ++requestGeneration.current;
    setPreview(null);
    setSession(null);
    setError(null);
    setPending(false);
    joiningRef.current = false;
    Promise.all([
      api<InvitePreview>(`/api/rooms/${token}/invite-preview`),
      api<UserSession>('/api/auth/session').catch(() => null),
    ])
      .then(([room, user]) => {
        if (requestGeneration.current !== generation) return;
        setPreview(room);
        setSession(user);
      })
      .catch((caught) => {
        if (requestGeneration.current !== generation) return;
        setError(caught instanceof Error ? caught.message : '邀请链接无效');
      });
    return () => {
      requestGeneration.current += 1;
    };
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
        <Brand />
        <IconButton icon="arrow-left" label="返回大厅" onClick={() => navigate('/')} />
      </header>
      <section className="invite-card">
        <div className={`invite-emblem invite-emblem--${preview.mode.toLowerCase()}`}>
          <span>
            <Icon name={preview.mode === 'ONLINE' ? 'cards' : 'table'} size={32} />
          </span>
        </div>
        <ModeBadge mode={preview.mode} />
        <h1>{preview.name}</h1>
        <dl className="invite-stats">
          <div>
            <dt>人数</dt>
            <dd>
              {preview.playerCount}/{preview.settings.maxPlayers}
            </dd>
          </div>
          <div>
            <dt>盲注</dt>
            <dd>
              {formatPoints(preview.settings.smallBlind)}/{formatPoints(preview.settings.bigBlind)}
            </dd>
          </div>
          <div>
            <dt>起始筹码</dt>
            <dd>{formatPoints(preview.settings.startingStack)}</dd>
          </div>
        </dl>
        <div className="invite-seats">
          {Array.from(
            { length: preview.settings.maxPlayers },
            (_, index) => preview.nicknames[index] ?? null,
          ).map((name, index) => (
            <div key={index} className={name ? '' : 'invite-seat-empty'}>
              <span className="mini-avatar">{name ? name.slice(0, 1) : '+'}</span>
              <small>{name ?? '空位'}</small>
            </div>
          ))}
        </div>
        {error && <ErrorBox onClose={() => setError(null)}>{error}</ErrorBox>}
        {!session ? (
          <InviteSignIn key={token} onSignedIn={setSession} />
        ) : (
          <form
            className="join-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (joiningRef.current) return;
              joiningRef.current = true;
              const generation = requestGeneration.current;
              setError(null);
              setPending(true);
              api<JoinResponse>(`/api/rooms/${token}/join`, {
                method: 'POST',
                body: JSON.stringify({}),
              })
                .then((joined) => {
                  if (requestGeneration.current !== generation) return;
                  navigate(`/room/${joined.roomId}`);
                })
                .catch((caught) => {
                  if (requestGeneration.current !== generation) return;
                  setError(caught instanceof Error ? caught.message : '加入牌桌失败');
                })
                .finally(() => {
                  if (requestGeneration.current !== generation) return;
                  joiningRef.current = false;
                  setPending(false);
                });
            }}
          >
            <div className="joining-as">
              <span className="avatar">{session.displayName.slice(0, 1)}</span>
              <span>
                <small>当前账号</small>
                <strong>
                  {session.displayName} · @{session.username}
                </strong>
              </span>
            </div>
            <button className="primary-button" disabled={pending} aria-busy={pending || undefined}>
              {pending ? '正在加入…' : '加入牌桌'}
              {!pending && <Icon name="arrow-right" size={18} />}
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
  const [passwordVisible, setPasswordVisible] = useState(false);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return (
    <form
      className="join-form invite-signin"
      onSubmit={(event) => {
        event.preventDefault();
        if (submittingRef.current) return;
        submittingRef.current = true;
        setError(null);
        setPending(true);
        api<UserSession>('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ username: username.trim(), password }),
        })
          .then((user) => {
            if (mountedRef.current) onSignedIn(user);
          })
          .catch((caught) => {
            if (mountedRef.current) setError(caught instanceof Error ? caught.message : '登录失败');
          })
          .finally(() => {
            submittingRef.current = false;
            if (mountedRef.current) setPending(false);
          });
      }}
    >
      <div className="signin-callout">
        <Icon name="user" size={19} />
        <span>
          <strong>登录后加入牌桌</strong>
        </span>
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
      <label className="field">
        <span>账号</span>
        <input
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          disabled={pending}
          required
        />
      </label>
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
        disabled={pending || !username.trim() || !password}
        aria-busy={pending || undefined}
      >
        {pending ? '正在登录…' : '登录'}
      </button>
    </form>
  );
}

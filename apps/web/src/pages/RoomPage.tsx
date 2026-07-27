import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  Card,
  HandHistoryItem,
  PlayerAction,
  PublicRoomProjection,
} from '@poker-with-friends/protocol';
import { api } from '../api';
import { Icon, type IconName } from '../icons';
import {
  actingCopy,
  actionChinese,
  betSuggestions,
  displaySeatForHero,
  formatPoints,
  handRankChinese,
  historyActions,
  historySettlement,
  naturalAction,
  phaseLabel,
  positionLabel,
  positionsForRoom,
  settlementReasonChinese,
  statusLabel,
  type EnhancedRoomProjection,
  type EnhancedSeat,
  type TablePosition,
} from '../poker-ui';
import {
  playDeal,
  playBet,
  playSettle,
  playTurnAlert,
  playWin,
  primeSound,
  setSoundEnabled,
  soundEnabled,
} from '../sound';
import { useRoom } from '../use-room';
import { navigate } from '../navigation';
import { ErrorBox, IconButton, Loading, Modal, ModeBadge } from '../components/ui';
import { PlayingCard } from '../components/cards';

export function RoomPage({ roomId }: { roomId: string }) {
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
  const [peeking, setPeeking] = useState(false);
  const { room, me } = connection;
  const bannerRef = useRef<HTMLDivElement>(null);
  const wasBusyRef = useRef(false);
  const [soundOn, setSoundOn] = useState(soundEnabled);
  const [rotateView, setRotateView] = useState(() => {
    try {
      return localStorage.getItem('pwf:view-rotate') !== 'off';
    } catch {
      return true;
    }
  });
  const toggleSound = () => {
    setSoundEnabled(!soundOn);
    setSoundOn(!soundOn);
  };
  const toggleRotateView = () => {
    setRotateView((current) => {
      try {
        localStorage.setItem('pwf:view-rotate', current ? 'off' : 'on');
      } catch {
        /* private mode */
      }
      return !current;
    });
  };

  useEffect(() => {
    const unlock = () => {
      void primeSound();
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
    window.addEventListener('pointerdown', unlock, { capture: true, once: true });
    window.addEventListener('keydown', unlock, { capture: true, once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
  }, []);

  // While a command runs, the surrounding <fieldset> disables the button the
  // user just activated and the panel may unmount, dropping keyboard focus to
  // <body>. Recover by moving focus to the acting banner, which also carries
  // the live announcement of what happens next.
  useEffect(() => {
    if (wasBusyRef.current && !connection.busy && document.activeElement === document.body) {
      bannerRef.current?.focus({ preventScroll: true });
    }
    wasBusyRef.current = connection.busy;
  }, [connection.busy]);

  useEffect(() => {
    setPeeking(false);
  }, [room?.handNumber]);

  // Table sounds: my turn, streets being dealt, and hand settlement.
  const wasMyTurnRef = useRef(false);
  useEffect(() => {
    const myTurn = Boolean(me && room?.prompt?.playerId === me.playerId);
    if (myTurn && !wasMyTurnRef.current) playTurnAlert();
    wasMyTurnRef.current = myTurn;
  }, [me, room?.prompt?.playerId]);

  const boardCountRef = useRef(0);
  useEffect(() => {
    const count = room?.communityCards.length ?? 0;
    if (count > boardCountRef.current) playDeal();
    boardCountRef.current = count;
  }, [room?.communityCards.length]);

  const committedTotal = room?.seats.reduce((sum, seat) => sum + seat.committedHand, 0) ?? 0;
  const committedRef = useRef<{ handNumber: number; total: number } | null>(null);
  useEffect(() => {
    const handNumber = room?.handNumber;
    if (handNumber === undefined) return;
    const previous = committedRef.current;
    if (previous?.handNumber === handNumber && committedTotal > previous.total) playBet();
    committedRef.current = { handNumber, total: committedTotal };
  }, [committedTotal, room?.handNumber]);

  const settledHandRef = useRef<number | null>(null);
  useEffect(() => {
    const summary = room?.lastHandSummary;
    if (!summary || room?.status !== 'BETWEEN_HANDS') return;
    if (settledHandRef.current === summary.handNumber) return;
    settledHandRef.current = summary.handNumber;
    if (me && summary.winners.some((winner) => winner.playerId === me.playerId)) playWin();
    else playSettle();
  }, [me, room?.lastHandSummary, room?.status]);

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

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 4_500);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!me || room?.prompt?.playerId !== me.playerId) return;
    if (!window.matchMedia('(max-width: 919px)').matches) return;
    window.scrollTo({ top: 0, left: 0 });
  }, [me?.playerId, room?.prompt?.playerId]);

  const send = async (
    event: string,
    payload: Record<string, unknown> = {},
    needsTurnToken = false,
  ) => {
    const ok = await connection.send(event, payload, { needsTurnToken });
    if (!ok) return;
    if (event === 'seat.claim') {
      const seat = typeof payload.seat === 'number' ? payload.seat + 1 : null;
      setNotice(seat ? `已选择 ${seat} 号位` : '座位已选择');
    } else if (event === 'player.ready') setNotice('下一手已准备');
    else if (event === 'player.sitOut') setNotice('下一手暂离');
    else if (event === 'stack.topUp') setNotice('筹码已补至牌桌上限');
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
      setHistoryError(caught instanceof Error ? caught.message : '牌谱加载失败');
    }
  };

  if (connection.loading) return <Loading label="正在恢复牌桌状态…" />;
  if (!room) {
    return (
      <main className="state-page">
        <ErrorBox>{connection.error ?? '牌桌加载失败'}</ErrorBox>
        <button className="secondary-button" onClick={() => navigate('/')}>
          <Icon name="arrow-left" size={16} /> 返回牌桌大厅
        </button>
      </main>
    );
  }
  if (!me && !publicView) {
    return (
      <main className="state-page">
        <Icon name="lock" size={32} />
        <h1>{connection.error === '你已被移出牌桌' ? '你已被移出牌桌' : '尚未加入牌桌'}</h1>
        <button className="primary-button" onClick={() => navigate('/')}>
          <Icon name="arrow-left" size={16} /> 返回牌桌大厅
        </button>
      </main>
    );
  }
  const enhancedRoom = room as EnhancedRoomProjection;
  const mySeat = !me || me.seat === null ? null : enhancedRoom.seats[me.seat];
  const readyEligibleCount = enhancedRoom.seats.filter(
    (seat) =>
      seat.playerId &&
      seat.connected &&
      seat.stack > 0 &&
      (!seat.sittingOut || seat.playerId === me?.playerId),
  ).length;
  const isMyTurn = Boolean(me && room.prompt?.playerId === me.playerId);
  const isLiveDealer = Boolean(me && me.seat !== null && room.liveDealerSeat === me.seat);
  const frozen = room.status === 'DISPUTED' || room.status === 'ARCHIVED';
  const peekCards = me?.peekCards ?? null;
  const canPeek = Boolean(
    room.status === 'ACTIVE' && mySeat?.folded && peekCards && Object.keys(peekCards).length > 0,
  );
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
          label="返回牌桌大厅"
          onClick={() => navigate('/')}
          className="round-button"
        />
        <div className="table-title">
          <span>
            <i className={connection.connected ? 'connection-dot' : 'connection-dot offline'} />{' '}
            {connection.connected ? '在线' : '重连中'}
            {publicView && ' · 旁观中'}
          </span>
          <h1>{room.name}</h1>
          <small>
            第 {room.handNumber} 手 · {statusLabel[room.status] ?? room.status}
          </small>
        </div>
        {!publicView && (
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
        )}
      </header>
      <div
        className={`acting-banner ${isMyTurn ? 'acting-banner--mine' : ''}`}
        ref={bannerRef}
        tabIndex={-1}
      >
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
            {phaseLabel[room.phase] ?? room.phase}
            {room.prompt || room.nextHandAt || room.liveResultProposal ? ` · ${seconds} 秒` : ''}
          </small>
        )}
      </div>
      <div className="table-notice-wrap">
        {connection.error && (
          <ErrorBox onClose={connection.clearError}>{connection.error}</ErrorBox>
        )}
        {pageError && <ErrorBox onClose={() => setPageError(null)}>{pageError}</ErrorBox>}
        {/* Kept mounted so screen readers reliably announce notices (live
            regions inserted together with their content are often skipped). */}
        <div className={`success-box ${notice ? '' : 'success-box--empty'}`} role="status">
          {notice}
        </div>
      </div>
      <div className="table-layout real-table-layout">
        <section className="table-column">
          <div className="table-mode-row">
            <ModeBadge mode={room.mode} />
            <span>{room.phase ? (phaseLabel[room.phase] ?? room.phase) : '等待开始'}</span>
            <span className="table-view-controls">
              {me && me.seat !== null && (
                <button
                  type="button"
                  className={rotateView ? 'active' : ''}
                  aria-pressed={rotateView}
                  onClick={toggleRotateView}
                  title="以自己为底边显示牌桌"
                >
                  <Icon name="rotate" size={14} /> 我的视角
                </button>
              )}
              <button
                type="button"
                className={soundOn ? 'active' : ''}
                aria-pressed={soundOn}
                onClick={toggleSound}
                title={soundOn ? '关闭音效' : '开启音效'}
              >
                <Icon name={soundOn ? 'sound' : 'sound-off'} size={14} />{' '}
                {soundOn ? '音效开' : '音效关'}
              </button>
            </span>
          </div>
          <PokerTable
            room={enhancedRoom}
            meId={me?.playerId ?? ''}
            holeCards={me?.holeCards ?? []}
            peekedCards={canPeek && peeking ? peekCards : null}
            canClaim={Boolean(me && !frozen && !connection.busy && me.seat === null)}
            claimingSeat={claimingSeat}
            viewSeat={rotateView && me && me.seat !== null ? me.seat : null}
            onClaim={(seat) => void claimSeat(seat)}
          />
          {me && (
            <div className="quick-actions real-quick-actions">
              <button
                onClick={() => void send('player.ready')}
                disabled={
                  room.status === 'ACTIVE' ||
                  frozen ||
                  connection.busy ||
                  mySeat?.ready === true ||
                  readyEligibleCount < 2
                }
              >
                <span>
                  <Icon name="check" size={19} />
                </span>
                <small>
                  {readyEligibleCount < 2
                    ? '等待玩家'
                    : mySeat?.ready
                      ? '已准备'
                      : mySeat?.sittingOut
                        ? '回座并准备'
                        : '准备下一手'}
                </small>
              </button>
              <button
                onClick={() => void send('player.sitOut')}
                disabled={frozen || connection.busy}
              >
                <span>
                  <Icon name="pause" size={19} />
                </span>
                <small>下一手暂离</small>
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
              <WaitingPanel icon="eye" title="正在旁观" />
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
                canPeek={canPeek}
                peeking={peeking}
                onTogglePeek={() => setPeeking((current) => !current)}
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
  peekedCards,
  canClaim,
  claimingSeat,
  viewSeat,
  onClaim,
}: {
  room: EnhancedRoomProjection;
  meId: string;
  holeCards: Card[];
  peekedCards: Record<string, Card[]> | null;
  canClaim: boolean;
  claimingSeat: number | null;
  /** When set, seats are visually rotated so this seat renders at the bottom edge. */
  viewSeat: number | null;
  onClaim: (seat: number) => void;
}) {
  const totalPot = room.pots.reduce((sum, pot) => sum + pot.amount, 0);
  const positions = positionsForRoom(room);
  const heroFolded = room.seats.some((seat) => seat.playerId === meId && seat.folded);
  const summary = room.status === 'BETWEEN_HANDS' ? (room.lastHandSummary ?? null) : null;
  const winnerIds = new Set((summary?.winners ?? []).map((winner) => winner.playerId));
  // Seat display position 3 is the bottom edge, where the hero cards live.
  return (
    <section
      className={`table-arena table-arena--${room.mode.toLowerCase()} real-table-arena`}
      aria-label="牌桌"
    >
      <div className="felt-table">
        <div className="felt-line" />
        <div className="real-table-center">
          <div className="pot-label">
            <small>底池</small>
            <strong key={totalPot} className="chip-pop">
              {formatPoints(totalPot)}
            </strong>
            <span>{room.pots.length > 1 ? `${room.pots.length} 个池` : '筹码'}</span>
          </div>
          {summary && summary.winners.length > 0 && (
            <div className="settlement-banner" role="status">
              <span className="settlement-banner__crown">
                <Icon name="crown" size={20} />
              </span>
              <div className="settlement-banner__winners">
                {summary.winners.map((winner) => (
                  <div className="settlement-banner__winner" key={winner.playerId}>
                    <strong>{winner.playerId === meId ? '你' : winner.nickname}</strong>
                    <b className="chip-pop">+{formatPoints(winner.amount)}</b>
                    <small>
                      {winner.handRankCategory !== undefined
                        ? (handRankChinese[winner.handRankCategory] ?? '获胜')
                        : (settlementReasonChinese[summary.reason] ?? '获胜')}
                    </small>
                  </div>
                ))}
              </div>
            </div>
          )}
          {room.mode === 'ONLINE' ? (
            <>
              <div className="community-cards" role="group" aria-label="公共牌">
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
              <div
                className={`hero-cards ${heroFolded ? 'hero-cards--folded' : ''}`}
                role="group"
                aria-label="你的手牌"
              >
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
              <strong>
                {room.pendingLiveStreet
                  ? `等待确认${phaseLabel[room.pendingLiveStreet] ?? room.pendingLiveStreet}`
                  : room.phase
                    ? (phaseLabel[room.phase] ?? room.phase)
                    : '等待准备'}
              </strong>
            </div>
          )}
        </div>
      </div>
      {room.seats.map((seat) => (
        <Seat
          key={seat.seat}
          seat={seat}
          displaySeat={displaySeatForHero(seat.seat, viewSeat)}
          own={seat.playerId === meId}
          // The hero's cards are already large at the felt edge — the small
          // seat-side reveal would only duplicate them.
          hideRevealed={seat.playerId === meId && holeCards.length > 0}
          winner={Boolean(seat.playerId && winnerIds.has(seat.playerId))}
          positions={positions.get(seat.seat) ?? []}
          peekedCards={
            seat.playerId && !seat.revealedCards ? (peekedCards?.[seat.playerId] ?? null) : null
          }
          canClaim={canClaim}
          claiming={claimingSeat === seat.seat}
          onClaim={() => onClaim(seat.seat)}
        />
      ))}
    </section>
  );
}

function Seat({
  seat,
  displaySeat,
  own,
  hideRevealed = false,
  winner,
  positions,
  peekedCards,
  canClaim,
  claiming,
  onClaim,
}: {
  seat: EnhancedSeat;
  /** Visual position slot (0-5); differs from seat.seat when the view is rotated. */
  displaySeat: number;
  own: boolean;
  hideRevealed?: boolean;
  winner: boolean;
  positions: TablePosition[];
  peekedCards: Card[] | null;
  canClaim: boolean;
  claiming: boolean;
  onClaim: () => void;
}) {
  if (!seat.playerId)
    return (
      <button
        type="button"
        className={`table-seat table-seat--${displaySeat} table-seat--empty`}
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
  const stateClass = seat.isActing
    ? 'table-seat--status-acting'
    : seat.folded
      ? 'table-seat--status-folded'
      : seat.sittingOut
        ? 'table-seat--status-sit_out'
        : '';
  return (
    <div
      className={`table-seat table-seat--${displaySeat} ${own ? 'table-seat--own' : ''} ${winner ? 'table-seat--winner' : ''} ${stateClass}`}
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
          {seat.owesBigBlind ? ' · 回座需补盲' : ''}
        </small>
      </div>
      {seat.revealedCards && !hideRevealed && (
        <div className="revealed-cards">
          {seat.revealedCards.map((card, index) => (
            <PlayingCard card={card} key={card} compact dealIndex={index} />
          ))}
        </div>
      )}
      {!seat.revealedCards && peekedCards && (
        <div className="revealed-cards revealed-cards--peek" aria-label={`${seat.nickname} 的手牌`}>
          {peekedCards.map((card, index) => (
            <PlayingCard card={card} key={card} compact dealIndex={index} />
          ))}
        </div>
      )}
    </div>
  );
}

function OnlineActions({
  room,
  heroSeat,
  isMyTurn,
  seconds,
  canPeek,
  peeking,
  onTogglePeek,
  onAction,
}: {
  room: EnhancedRoomProjection;
  heroSeat: EnhancedSeat | null;
  isMyTurn: boolean;
  seconds: number;
  canPeek: boolean;
  peeking: boolean;
  onTogglePeek: () => void;
  onAction: (action: PlayerAction, amountTo?: number) => void;
}) {
  const prompt = room.prompt;
  const minimum = prompt?.minRaiseTo ?? prompt?.minBetTo ?? 0;
  const [amountInput, setAmountInput] = useState(String(minimum));
  // Reset only when a new prompt arrives — unrelated room updates (another
  // player reconnecting, seat changes) must not clobber a half-typed amount.
  useEffect(() => setAmountInput(String(minimum)), [minimum, prompt?.deadlineAt]);
  if (room.status !== 'ACTIVE') return <WaitingPanel icon="check" title="等待下一手" />;
  if (heroSeat?.folded) {
    return (
      <WaitingPanel icon="eye" title="你已弃牌">
        {canPeek && (
          <>
            <button
              type="button"
              className={peeking ? 'secondary-button' : 'primary-button'}
              aria-pressed={peeking}
              onClick={onTogglePeek}
            >
              <Icon name="eye" size={17} /> {peeking ? '收起手牌' : '旁观其他玩家手牌'}
            </button>
            {peeking && <p className="peek-hint">仅你可见，其他玩家不会收到提示</p>}
          </>
        )}
      </WaitingPanel>
    );
  }
  if (!isMyTurn || !prompt) return <WaitingPanel icon="clock" title="等待其他玩家行动" />;
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
        <span>需跟注</span>
        <strong>{formatPoints(prompt.callAmount)}</strong>
      </div>
      {wagerAction && minimum <= prompt.maxTo && (
        <div className="raise-control">
          <div>
            <label htmlFor="raise">{wagerAction === 'BET_TO' ? '下注到' : '加注到'}</label>
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
                aria-describedby={amountValid ? undefined : 'desktop-wager-error'}
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
          {!amountValid && (
            <small id="desktop-wager-error" className="field-error" role="alert">
              请输入 {formatPoints(minimum)} 至 {formatPoints(prompt.maxTo)} 之间的整数。
            </small>
          )}
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
  children,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
}) {
  return (
    <section className="operation-panel waiting-panel-real">
      <span className="waiting-symbol">
        <Icon name={icon} size={27} />
      </span>
      <h2>{title}</h2>
      {children}
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
  const canReturn = Boolean(
    mySeat?.playerId && mySeat.connected && mySeat.sittingOut && mySeat.stack > 0,
  );
  const displayedPlayers =
    canReturn && mySeat && !eligible.some((seat) => seat.playerId === mySeat.playerId)
      ? [...eligible, mySeat]
      : eligible;
  const ready = room.readyCount ?? eligible.filter((seat) => seat.ready).length;
  const required = canReturn
    ? Math.max(room.requiredReadyCount ?? eligible.length, eligible.length) + 1
    : (room.requiredReadyCount ?? eligible.length);
  const enoughPlayers = displayedPlayers.length >= 2;
  const canReady = Boolean(mySeat?.connected && mySeat.stack > 0);
  return (
    <section className="operation-panel ready-panel">
      <div className="ready-head">
        <span className="ready-icon">
          <Icon name="check" size={22} />
        </span>
        <div>
          <h2>准备下一手</h2>
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
        {displayedPlayers.map((seat) => (
          <li key={seat.playerId} className={seat.ready ? 'confirmed' : ''}>
            <span className="mini-avatar">{seat.nickname?.slice(0, 1)}</span>
            <span>
              <strong>{seat.nickname}</strong>
              <small>{seat.sittingOut ? '暂离' : seat.ready ? '已准备' : '未准备'}</small>
            </span>
            <Icon name={seat.ready ? 'check' : 'clock'} size={17} />
          </li>
        ))}
      </ul>
      {mySeat?.sittingOut && mySeat.owesBigBlind && (
        <p className="ready-note">回座将补 {formatPoints(room.settings.bigBlind)} 死盲</p>
      )}
      {mySeat ? (
        <button
          className="primary-button ready-button"
          disabled={busy || mySeat.ready || !enoughPlayers || !canReady}
          onClick={onReady}
        >
          <Icon name="check" size={18} />{' '}
          {!enoughPlayers
            ? '等待玩家'
            : mySeat.ready
              ? '已准备'
              : mySeat.sittingOut
                ? '回座并准备'
                : '准备下一手'}
        </button>
      ) : null}
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
  useEffect(() => setAmountInput(String(minimum)), [minimum, prompt.deadlineAt]);
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
          title={wagerAction === 'BET_TO' ? '下注到' : '加注到'}
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
                aria-describedby={valid ? undefined : 'mobile-wager-error'}
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
              aria-label={wagerAction === 'BET_TO' ? '下注到' : '加注到'}
            />
            <div className="range-bounds">
              <span>最小 {formatPoints(minimum)}</span>
              <span>最大 {formatPoints(prompt.maxTo)}</span>
            </div>
            {!valid && (
              <small id="mobile-wager-error" className="field-error" role="alert">
                请输入 {formatPoints(minimum)} 至 {formatPoints(prompt.maxTo)} 之间的整数。
              </small>
            )}
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
  const eligiblePlayerCount = new Set(room.pots.flatMap((pot) => pot.eligiblePlayerIds)).size;
  const objected = (proposal?.objectedByPlayerIds.length ?? 0) > 0;
  const confirmationRound = !objected && (proposal?.confirmedByPlayerIds.length ?? 0) > 0;
  const pendingStreet = room.pendingLiveStreet
    ? (phaseLabel[room.pendingLiveStreet] ?? room.pendingLiveStreet)
    : null;
  if (room.status === 'DISPUTED') {
    return <WaitingPanel title="结果存在异议，本手已暂停" />;
  }
  return (
    <section className="operation-panel live-panel real-live-panel">
      <div className="operation-head">
        <div>
          <h2>线下牌局</h2>
        </div>
        <span className="phase-tag">
          {room.phase ? (phaseLabel[room.phase] ?? room.phase) : statusLabel[room.status]}
        </span>
      </div>
      {room.pendingLiveStreet && (
        <article className="live-task">
          <span>
            <Icon name="cards" size={21} />
          </span>
          <div>
            <h3>请发出{pendingStreet}</h3>
          </div>
          {isDealer ? (
            <button className="primary-button" onClick={() => onStreet(room.pendingLiveStreet!)}>
              确认已发{pendingStreet}
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
            <h3>提交底池赢家</h3>
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
            <span>结果确认</span>
            <small>
              {objected
                ? '已提出异议'
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
            <p>
              已确认 {proposal.confirmedByPlayerIds.length}/{eligiblePlayerCount}
            </p>
          )}
        </article>
      )}
      {!room.pendingLiveStreet && room.phase !== 'SHOWDOWN' && !proposal && (
        <WaitingPanel title={room.status === 'ACTIVE' ? '现场手牌进行中' : '等待玩家准备'} />
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
        {pending ? '正在提交…' : '提交结果'}
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
    <Modal
      title={status === 'ready' ? `牌谱 · ${items.length} 手` : '牌谱'}
      className="history-modal"
      onClose={onClose}
    >
      {status === 'loading' && (
        <div className="history-state" role="status">
          <span className="loader" />
          <strong>正在加载牌谱</strong>
        </div>
      )}
      {status === 'error' && (
        <div className="history-state history-state--error">
          <ErrorBox>{error ?? '牌谱加载失败'}</ErrorBox>
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
                            {settlement.communityCards.map((card) => (
                              <PlayingCard card={card} compact still key={card} />
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
                      {actions.length === 0 && <p className="empty-state">本手暂无行动</p>}
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
            <strong>暂无已结算牌局</strong>
          </div>
        )}
      </div>
      {status === 'ready' && visibleCount < items.length && (
        <button
          type="button"
          className="secondary-button history-load-more"
          onClick={() => setVisibleCount((count) => Math.min(items.length, count + 20))}
        >
          加载更多（{Math.min(20, items.length - visibleCount)} 手）
        </button>
      )}
    </Modal>
  );
}

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  Card,
  ChipLedgerResponse,
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
  formatPoints,
  historyActions,
  historySettlement,
  naturalAction,
  phaseLabel,
  positionLabel,
  positionsForRoom,
  statusLabel,
  type EnhancedRoomProjection,
  type EnhancedSeat,
  type TablePosition,
} from '../poker-ui';
import { useRoom } from '../use-room';
import { navigate } from '../navigation';
import { Brand, ErrorBox, IconButton, Loading, Modal, ModeBadge } from '../components/ui';
import { PlayingCard } from '../components/cards';
import { SkinModeSelect, ThemeModeSelect } from '../theme';

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
  const [chipLogOpen, setChipLogOpen] = useState(false);
  const [chipLog, setChipLog] = useState<ChipLedgerResponse | null>(null);
  const [chipLogStatus, setChipLogStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [chipLogError, setChipLogError] = useState<string | null>(null);
  const [winnerForm, setWinnerForm] = useState(false);
  const [claimingSeat, setClaimingSeat] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [peeking, setPeeking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [motion, setMotion] = useState(true);
  const { room, me, chat, sendChat } = connection;

  useEffect(() => {
    setPeeking(false);
    setWinnerForm(false);
    setNotice(null);
  }, [roomId, room?.handNumber]);

  useEffect(() => {
    const update = () => {
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
    };
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [room?.liveResultProposal, room?.nextHandAt, room?.prompt?.deadlineAt]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 4_500);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const send = async (
    event: string,
    payload: Record<string, unknown> = {},
    needsTurnToken = false,
  ) => {
    const ok = await connection.send(event, payload, { needsTurnToken });
    if (!ok) return false;
    if (event === 'seat.claim') {
      const seat = typeof payload.seat === 'number' ? payload.seat + 1 : null;
      setNotice(seat ? `已选择 ${seat} 号位` : '座位已选择');
    } else if (event === 'player.ready') setNotice('准备状态已更新');
    else if (event === 'player.sitOut') setNotice('下一手暂离');
    else if (event === 'stack.topUp') setNotice('筹码已补至牌桌上限');
    else if (event === 'hand.act') {
      const action = payload.action as PlayerAction | undefined;
      const amountTo = typeof payload.amountTo === 'number' ? payload.amountTo : undefined;
      setNotice(
        `${action ? (actionChinese[action] ?? '行动') : '行动'}${amountTo === undefined ? '' : ` ${formatPoints(amountTo)}`}`,
      );
    } else setNotice('操作已确认');
    return true;
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

  const loadChipLog = async () => {
    setChipLogOpen(true);
    setChipLogStatus('loading');
    setChipLogError(null);
    try {
      const result = await api<ChipLedgerResponse>(`/api/rooms/${roomId}/chips`);
      setChipLog(result);
      setChipLogStatus('ready');
    } catch (caught) {
      setChipLogStatus('error');
      setChipLogError(caught instanceof Error ? caught.message : '筹码日志加载失败');
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
  const mySeat = enhancedRoom.seats.find((seat) => seat.playerId === me?.playerId) ?? null;
  const isMyTurn = Boolean(me && room.prompt?.playerId === me.playerId);
  const isLiveDealer = Boolean(me && me.seat !== null && room.liveDealerSeat === me.seat);
  const frozen = room.status === 'DISPUTED' || room.status === 'ARCHIVED';
  const commandsDisabled = connection.busy || frozen || !connection.connected;
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
  const isOwner = Boolean(me && room.ownerPlayerId === me.playerId);
  const kickPlayer = async (playerId: string) => {
    if (!isOwner || playerId === me?.playerId) return;
    if (!window.confirm('确定要将这位玩家移出牌局吗？')) return;
    try {
      await api(`/api/rooms/${roomId}/players/${playerId}/kick`, {
        method: 'POST',
        body: JSON.stringify({ reason: '房主移出' }),
      });
      setNotice('玩家已移出牌局');
    } catch (caught) {
      setPageError(caught instanceof Error ? caught.message : '移出玩家失败');
    }
  };

  return (
    <main
      className={`table-page real-table-page ${room.status === 'BETWEEN_HANDS' ? 'payout-settled' : ''}`}
      data-motion={motion ? 'on' : 'off'}
    >
      <aside className="table-sidebar">
        <Brand />
        <nav className="sidebar-nav" aria-label="牌桌导航">
          <button onClick={() => navigate('/')}>
            <Icon name="table" size={18} />
            牌桌大厅
          </button>
          <button className="active" aria-current="page">
            <Icon name="spade" size={18} />
            当前牌桌
          </button>
          <button onClick={() => void loadHistory()}>
            <Icon name="history" size={18} />
            牌局记录
          </button>
          <button onClick={() => void loadChipLog()}>
            <Icon name="chip" size={18} />
            筹码日志
          </button>
        </nav>
        <div className="sidebar-table-details">
          <small>当前牌桌</small>
          <strong>{room.name}</strong>
          <ModeBadge mode={room.mode} />
          <dl>
            <div>
              <dt>盲注</dt>
              <dd>
                {formatPoints(room.settings.smallBlind)} / {formatPoints(room.settings.bigBlind)}
              </dd>
            </div>
            <div>
              <dt>座位</dt>
              <dd>{room.seats.filter((seat) => seat.playerId).length} / 6</dd>
            </div>
            <div>
              <dt>筹码上限</dt>
              <dd>{formatPoints(room.settings.stackCap)}</dd>
            </div>
          </dl>
        </div>
        <div className="sidebar-account">
          <span className="avatar">
            {mySeat?.nickname?.slice(0, 1) ?? <Icon name="user" size={18} />}
          </span>
          <span>
            <strong>{mySeat?.nickname ?? (publicView ? '旁观者' : '未入座')}</strong>
            <small>
              {mySeat
                ? `${formatPoints(mySeat.stack)} 桌上筹码 · ${formatPoints(me?.accountChips ?? 0)} 账户`
                : 'Poker with Friends'}
            </small>
          </span>
        </div>
      </aside>
      <div className="table-workspace">
        <header className="table-header">
          <IconButton
            icon="arrow-left"
            label="返回牌桌大厅"
            onClick={() => navigate('/')}
            className="round-button"
          />
          <div className="table-title">
            <h1>{room.name}</h1>
            <small>
              {formatPoints(room.settings.smallBlind)} / {formatPoints(room.settings.bigBlind)} · 6
              人桌
            </small>
          </div>
          <div className="table-header-meta">
            <i className={connection.connected ? 'connection-dot' : 'connection-dot offline'} />
            {connection.connected ? (publicView ? '旁观中' : '已连接') : '重连中'}
            <span>第 {room.handNumber} 手</span>
          </div>
          <div className="table-tools">
            <ThemeModeSelect />
            <SkinModeSelect />
            <button
              className="table-history-trigger"
              aria-label="查看牌谱"
              title="查看牌谱"
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
            <IconButton icon="settings" label="牌桌设置" onClick={() => setSettingsOpen(true)} />
          </div>
        </header>
        <div className={`acting-banner ${isMyTurn ? 'acting-banner--mine' : ''}`}>
          <progress className="acting-progress" max={1} value={timerProgress} aria-hidden="true" />
          <span className="sr-only" aria-live="polite">
            {actingAnnouncement}
          </span>
          <span className="turn-ring">
            <Icon name="clock" size={17} />
          </span>
          <strong>
            {room.status === 'DISPUTED' || room.status === 'ARCHIVED'
              ? statusLabel[room.status]
              : room.prompt
                ? isMyTurn
                  ? `轮到你行动 · ${seconds} 秒`
                  : actingCopy(enhancedRoom, seconds)
                : room.nextHandAt
                  ? `${seconds} 秒后开始下一手`
                  : statusLabel[room.status]}
          </strong>
        </div>
        {(connection.error || pageError || notice) && (
          <div className="table-notice-wrap">
            {connection.error && (
              <ErrorBox onClose={connection.clearError}>{connection.error}</ErrorBox>
            )}
            {pageError && <ErrorBox onClose={() => setPageError(null)}>{pageError}</ErrorBox>}
            {notice && (
              <div className="success-box" role="status">
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
            </div>
            <PokerTable
              room={enhancedRoom}
              meId={me?.playerId ?? ''}
              holeCards={me?.holeCards ?? []}
              peekedCards={canPeek && peeking ? peekCards : null}
              canClaim={Boolean(me && !commandsDisabled && me.seat === null)}
              claimingSeat={claimingSeat}
              onClaim={(seat) => void claimSeat(seat)}
              canKick={isOwner}
              onKick={(playerId) => void kickPlayer(playerId)}
            />
          </section>
          <section className="operation-column">
            <fieldset
              className="command-surface"
              disabled={commandsDisabled || (isMyTurn && !me?.turnToken)}
              aria-busy={connection.busy}
            >
              {publicView || !me ? (
                <WaitingPanel icon="eye" title="正在旁观" />
              ) : frozen ? (
                <WaitingPanel icon="pause" title={statusLabel[room.status] ?? room.status} />
              ) : !mySeat ? (
                <WaitingPanel icon="user" title="等待入座" />
              ) : room.status === 'LOBBY' || room.status === 'BETWEEN_HANDS' ? (
                <ReadyConfirmation
                  room={enhancedRoom}
                  mySeat={mySeat}
                  busy={connection.busy}
                  onReady={() => void send('player.ready')}
                />
              ) : room.mode === 'ONLINE' || room.prompt ? (
                <OnlineActions
                  key={`${room.roomId}-${room.handNumber}-${room.prompt?.playerId}-${room.prompt?.deadlineAt}`}
                  room={enhancedRoom}
                  heroSeat={mySeat}
                  isMyTurn={isMyTurn}
                  disabled={!connection.connected || frozen || !me.turnToken}
                  busy={connection.busy}
                  seconds={seconds}
                  canPeek={canPeek}
                  peeking={peeking}
                  onTogglePeek={() => setPeeking((current) => !current)}
                  onAction={(action, amountTo) =>
                    send(
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
            {!publicView && (
              <ChatPanel messages={chat ?? []} onSend={sendChat ?? (async () => false)} />
            )}
          </section>
        </div>
        {me && mySeat && (
          <footer className="table-footer quick-actions real-quick-actions">
            <span>{statusLabel[room.status]}</span>
            <button
              onClick={() => void send(mySeat.sittingOut ? 'player.ready' : 'player.sitOut')}
              disabled={
                commandsDisabled ||
                (mySeat.sittingOut && (room.status === 'ACTIVE' || mySeat.stack <= 0))
              }
            >
              <Icon name={mySeat.sittingOut ? 'play' : 'pause'} size={16} />
              {mySeat.sittingOut ? '返回牌局' : '下一手暂离'}
            </button>
            <button
              onClick={() => void send('stack.topUp', { targetStack: room.settings.stackCap })}
              disabled={
                commandsDisabled ||
                room.status === 'ACTIVE' ||
                mySeat.stack >= room.settings.stackCap
              }
            >
              <Icon name="chip" size={16} />
              补充筹码
            </button>
          </footer>
        )}
      </div>
      {settingsOpen && (
        <Modal title="牌桌设置" onClose={() => setSettingsOpen(false)}>
          <dl className="table-settings-list">
            <div>
              <dt>牌桌模式</dt>
              <dd>{room.mode === 'ONLINE' ? '线上牌桌' : '线下牌桌'}</dd>
            </div>
            <div>
              <dt>盲注</dt>
              <dd>
                {room.settings.smallBlind} / {room.settings.bigBlind}
              </dd>
            </div>
            <div>
              <dt>初始筹码</dt>
              <dd>{formatPoints(room.settings.startingStack)}</dd>
            </div>
            <div>
              <dt>筹码上限</dt>
              <dd>{formatPoints(room.settings.stackCap)}</dd>
            </div>
            <div>
              <dt>行动时限</dt>
              <dd>{room.settings.actionTimeoutSeconds} 秒</dd>
            </div>
          </dl>
          <label className="motion-setting">
            <span>牌桌动画</span>
            <input
              type="checkbox"
              checked={motion}
              onChange={(event) => setMotion(event.target.checked)}
            />
          </label>
        </Modal>
      )}
      {winnerForm && (
        <LiveWinnerDialog
          room={room}
          disabled={commandsDisabled || !isLiveDealer}
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
      {chipLogOpen && (
        <ChipLogDialog
          data={chipLog}
          status={chipLogStatus}
          error={chipLogError}
          onRetry={() => void loadChipLog()}
          onClose={() => setChipLogOpen(false)}
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
  onClaim,
  canKick,
  onKick,
}: {
  room: EnhancedRoomProjection;
  meId: string;
  holeCards: Card[];
  peekedCards: Record<string, Card[]> | null;
  canClaim: boolean;
  claimingSeat: number | null;
  onClaim: (seat: number) => void;
  canKick: boolean;
  onKick: (playerId: string) => void;
}) {
  const totalPot = room.pots.reduce((sum, pot) => sum + pot.amount, 0);
  const positions = positionsForRoom(room);
  const heroSeatIndex = room.seats.find((seat) => seat.playerId === meId)?.seat ?? 0;
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
          visualSeat={(seat.seat - heroSeatIndex + 6) % 6}
          handNumber={room.handNumber}
          holeCards={seat.playerId === meId ? holeCards : []}
          own={seat.playerId === meId}
          positions={positions.get(seat.seat) ?? []}
          peekedCards={
            seat.playerId && !seat.revealedCards ? (peekedCards?.[seat.playerId] ?? null) : null
          }
          canClaim={canClaim}
          claiming={claimingSeat === seat.seat}
          onClaim={() => onClaim(seat.seat)}
          canKick={canKick && seat.playerId !== meId}
          onKick={() => seat.playerId && onKick(seat.playerId)}
        />
      ))}
    </section>
  );
}

function Seat({
  seat,
  visualSeat,
  handNumber,
  holeCards,
  own,
  positions,
  peekedCards,
  canClaim,
  claiming,
  onClaim,
  canKick,
  onKick,
}: {
  seat: EnhancedSeat;
  visualSeat: number;
  handNumber: number;
  holeCards: Card[];
  own: boolean;
  positions: TablePosition[];
  peekedCards: Card[] | null;
  canClaim: boolean;
  claiming: boolean;
  onClaim: () => void;
  canKick: boolean;
  onKick: () => void;
}) {
  if (!seat.playerId)
    return (
      <button
        type="button"
        className={`table-seat table-seat--${visualSeat} table-seat--empty`}
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
            : seat.hasCards
              ? '等待行动'
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
  const visibleCards = own && holeCards.length ? holeCards : (seat.revealedCards ?? peekedCards);
  return (
    <div
      className={`table-seat table-seat--${visualSeat} ${own ? 'table-seat--own' : ''} ${stateClass}`}
      data-testid={`player-seat-${seat.seat}`}
      data-state={status}
      aria-label={`${seat.nickname}${own ? '，你' : ''}，${formatPoints(seat.stack)} 筹码，${status}`}
    >
      {visibleCards?.length ? (
        <div
          className={`seat-cards ${own ? 'hero-cards' : 'revealed-cards'} ${peekedCards ? 'revealed-cards--peek' : ''}`}
          role="group"
          aria-label={own ? '你的手牌' : `${seat.nickname} 的手牌`}
        >
          {visibleCards.map((card, index) => (
            <PlayingCard card={card} key={`${handNumber}-${card}`} compact dealIndex={index} />
          ))}
        </div>
      ) : seat.hasCards && !seat.folded ? (
        <div className="seat-cards concealed-cards" aria-label="两张未公开手牌">
          <span className="card-back">
            <Icon name="spade" size={19} />
          </span>
          <span className="card-back">
            <Icon name="spade" size={19} />
          </span>
        </div>
      ) : null}
      <div className="seat-avatar">
        <span className="mini-avatar">{seat.nickname?.slice(0, 1)}</span>
      </div>
      <div className="seat-copy">
        <strong title={seat.nickname ?? undefined}>
          {seat.nickname}
          {own && <em>你</em>}
        </strong>
        <span>
          <Icon name="chip" size={12} /> {formatPoints(seat.stack)}
        </span>
        {((seat.topUpTotal ?? 0) > 0 || (seat.lastTopUpAmount ?? 0) > 0) && (
          <small className="seat-top-up">
            补充 +{formatPoints(seat.lastTopUpAmount ?? seat.topUpTotal ?? 0)}
          </small>
        )}
        <small>{status}</small>
      </div>
      {positions.length > 0 && (
        <b
          className={`seat-position ${positions.includes('BTN') ? 'seat-position--dealer' : ''}`}
          title={positionLabel(positions)}
        >
          {positions.includes('BTN') ? 'D' : positions.join('/')}
        </b>
      )}
      {seat.committedStreet > 0 && (
        <div className="seat-bet" key={`${handNumber}-${seat.committedStreet}`}>
          <Icon name="chip" size={13} />
          <span>{formatPoints(seat.committedStreet)}</span>
        </div>
      )}
      {canKick && (
        <button
          type="button"
          className="seat-kick-button"
          onClick={onKick}
          aria-label={`移出${seat.nickname}`}
        >
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );
}

export function OnlineActions({
  room,
  heroSeat,
  isMyTurn,
  disabled = false,
  busy = false,
  seconds,
  canPeek,
  peeking,
  onTogglePeek,
  onAction,
}: {
  room: EnhancedRoomProjection;
  heroSeat: EnhancedSeat | null;
  isMyTurn: boolean;
  disabled?: boolean;
  busy?: boolean;
  seconds: number;
  canPeek: boolean;
  peeking: boolean;
  onTogglePeek: () => void;
  onAction: (action: PlayerAction, amountTo?: number) => Promise<boolean>;
}) {
  const prompt = room.prompt;
  const minimum = prompt?.minRaiseTo ?? prompt?.minBetTo ?? 0;
  const [amountInput, setAmountInput] = useState(String(minimum));
  const [confirmAllIn, setConfirmAllIn] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => {
    if (disabled) setConfirmAllIn(false);
  }, [disabled]);
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
          </>
        )}
      </WaitingPanel>
    );
  }
  if (heroSeat?.allIn) return <WaitingPanel icon="chip" title="你已全下" />;
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
  const submit = async (action: PlayerAction, amountTo?: number) => {
    setPending(true);
    setActionError(null);
    try {
      if (await onAction(action, amountTo)) setConfirmAllIn(false);
      else setActionError('操作未成功，请重试');
    } catch {
      setActionError('操作未成功，请重试');
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="operation-panel online-panel">
      <div className="operation-head">
        <h2>轮到你行动</h2>
        <span className={`turn-timer ${seconds <= 10 ? 'turn-timer--urgent' : ''}`}>
          <Icon name="clock" size={15} />
          {seconds} 秒
        </span>
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
              </button>
            ))}
          </div>
          <input
            id="raise"
            type="range"
            min={minimum}
            max={prompt.maxTo}
            step="1"
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
      <div className="poker-actions real-poker-actions" aria-label="行动操作区">
        {actions.has('FOLD') && (
          <button className="fold-button" disabled={pending} onClick={() => void submit('FOLD')}>
            <Icon name="close" size={16} /> 弃牌
          </button>
        )}
        {actions.has('CHECK') && (
          <button className="call-button" disabled={pending} onClick={() => void submit('CHECK')}>
            <Icon name="check" size={16} /> 过牌
          </button>
        )}
        {actions.has('CALL') && (
          <button
            className="call-button"
            disabled={pending}
            onClick={() =>
              prompt.callAmount >= (heroSeat?.stack ?? Infinity)
                ? setConfirmAllIn(true)
                : void submit('CALL')
            }
          >
            <Icon name="chip" size={16} /> 跟注 {formatPoints(prompt.callAmount)}
          </button>
        )}
        {wagerAction && (
          <button
            className="raise-button"
            disabled={!amountValid || pending}
            onClick={() =>
              amount === prompt.maxTo ? setConfirmAllIn(true) : void submit(wagerAction, amount)
            }
          >
            {wagerAction === 'BET_TO' ? '下注到' : '加注到'}{' '}
            {amountValid ? formatPoints(amount) : '—'}
          </button>
        )}
        {actions.has('ALL_IN') && (
          <button className="allin-button" disabled={pending} onClick={() => setConfirmAllIn(true)}>
            全下
          </button>
        )}
      </div>
      {confirmAllIn && (
        <Modal title="确认全下" onClose={() => setConfirmAllIn(false)} locked={pending || busy}>
          {actionError && <ErrorBox>{actionError}</ErrorBox>}
          <div className="allin-confirmation">
            <Icon name="chip" size={28} />
            <strong>{formatPoints(heroSeat?.stack ?? prompt.maxTo)}</strong>
            <span>剩余筹码</span>
          </div>
          <div className="proposal-actions">
            <button
              className="secondary-button"
              disabled={pending}
              onClick={() => setConfirmAllIn(false)}
            >
              取消
            </button>
            <button
              className="primary-button"
              disabled={pending || busy || disabled}
              onClick={() => void submit(actions.has('ALL_IN') ? 'ALL_IN' : 'CALL')}
            >
              {pending ? '提交中…' : '确认全下'}
            </button>
          </div>
        </Modal>
      )}
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

export function ReadyConfirmation({
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
  const eligible = room.seats.filter((seat) => seat.playerId && !seat.sittingOut && seat.stack > 0);
  const ready = room.readyCount ?? eligible.filter((seat) => seat.ready).length;
  const required = room.requiredReadyCount ?? eligible.length;
  return (
    <section className="operation-panel ready-panel">
      <div className="ready-head">
        <span className="ready-icon">
          <Icon name="check" size={22} />
        </span>
        <div>
          <h2>{room.handNumber === 0 ? '等待开牌' : '准备下一手'}</h2>
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
              <small>{seat.ready ? '已准备' : seat.connected ? '未准备' : '等待重连'}</small>
            </span>
            <Icon name={seat.ready ? 'check' : 'clock'} size={17} />
          </li>
        ))}
      </ul>
      {mySeat ? (
        <button
          className="primary-button ready-button"
          disabled={busy || !mySeat.connected || mySeat.stack <= 0}
          onClick={onReady}
        >
          <Icon name="check" size={18} />{' '}
          {mySeat.ready
            ? '取消'
            : mySeat.sittingOut
              ? '返回并准备'
              : mySeat.stack <= 0
                ? '等待补充筹码'
                : '准备下一手'}
        </button>
      ) : null}
    </section>
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
  disabled,
  onClose,
  onSubmit,
}: {
  room: PublicRoomProjection;
  disabled: boolean;
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
    <Modal title="提交各底池赢家" onClose={onClose} locked={pending}>
      {error && <ErrorBox onClose={() => setError(null)}>{error}</ErrorBox>}
      <div className="winner-pots">
        {room.pots.map((pot) => (
          <fieldset key={pot.id} disabled={pending || disabled}>
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
        disabled={disabled || pending || room.pots.some((pot) => !winners[pot.id]?.length)}
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

function ChipLogDialog({
  data,
  status,
  error,
  onRetry,
  onClose,
}: {
  data: ChipLedgerResponse | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  const entries = data?.account ?? [];
  return (
    <Modal title="筹码日志" onClose={onClose} className="chip-log-modal">
      {status === 'loading' && (
        <div className="history-state">
          <span className="loader" />
          <strong>正在加载日志…</strong>
        </div>
      )}
      {status === 'error' && (
        <div className="history-state history-state--error">
          <ErrorBox>{error ?? '筹码日志加载失败'}</ErrorBox>
          <button type="button" className="secondary-button" onClick={onRetry}>
            重试
          </button>
        </div>
      )}
      {status === 'ready' && (
        <div className="chip-log-list">
          <section>
            <header>
              <strong>账户余额变动</strong>
              <small>{entries.length} 条记录</small>
            </header>
            {entries.length === 0 ? (
              <p className="empty-state">暂无记录</p>
            ) : (
              <ol>
                {entries.map((entry) => (
                  <li key={entry.id}>
                    <span>
                      <strong>
                        {entry.kind === 'ACCOUNT_INITIAL_GRANT'
                          ? '初始账户筹码'
                          : entry.kind === 'ROOM_TOP_UP'
                            ? '补充到牌桌'
                            : entry.kind === 'ROOM_BUY_IN'
                              ? '带入牌局'
                              : entry.kind}
                      </strong>
                      <small>{new Date(entry.createdAt).toLocaleString()}</small>
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
          <section>
            <header>
              <strong>本桌筹码变动</strong>
              <small>{data?.room.length ?? 0} 条记录</small>
            </header>
            <ol>
              {(data?.room ?? []).map((entry) => (
                <li key={entry.id}>
                  <span>
                    <strong>
                      {entry.nickname ? `${entry.nickname} · ` : ''}
                      {entry.kind === 'INITIAL_ALLOCATION'
                        ? '初始带入'
                        : entry.kind === 'TOP_UP'
                          ? '补充筹码'
                          : entry.kind}
                    </strong>
                    <small>{new Date(entry.createdAt).toLocaleString()}</small>
                  </span>
                  <b className={entry.delta >= 0 ? 'positive' : 'negative'}>
                    {entry.delta >= 0 ? '+' : ''}
                    {formatPoints(entry.delta)}
                  </b>
                  <small>桌上 {formatPoints(entry.balanceAfter)}</small>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </Modal>
  );
}

function ChatPanel({
  messages,
  onSend,
}: {
  messages: { id: string; nickname: string; text: string; createdAt: string }[];
  onSend: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const emojis = ['😀', '😂', '👏', '👍', '🎉', '😅', '🤔', '💰', '🔥', '❤️'];
  return (
    <section className="chat-panel" aria-label="聊天室">
      <header>
        <strong>聊天室</strong>
        <small>{messages.length}/100</small>
      </header>
      <div className="chat-messages">
        {messages.length === 0 ? (
          <span className="chat-empty">和牌友打个招呼吧</span>
        ) : (
          messages.map((m) => (
            <p key={m.id}>
              <b>{m.nickname}</b>
              <span>{m.text}</span>
            </p>
          ))
        )}
      </div>
      <div className="chat-emoji">
        {emojis.map((emoji) => (
          <button type="button" key={emoji} onClick={() => setText((value) => value + emoji)}>
            {emoji}
          </button>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const value = text.trim();
          if (!value) return;
          void onSend(value).then((ok) => {
            if (ok) setText('');
          });
        }}
      >
        <input
          aria-label="聊天消息"
          value={text}
          maxLength={120}
          onChange={(event) => setText(event.target.value)}
          placeholder="发送消息…"
        />
        <button type="submit">发送</button>
      </form>
    </section>
  );
}

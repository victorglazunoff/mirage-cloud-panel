import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { HoldButton } from '@/modules/kabina';
import ChatQueue from '@/modules/kabina-chat/ChatQueue';
import { TurnWorkList } from '@/modules/kabina-chat/ChatWork';
import { ChevronRight, Equalizer, QueueLines } from '@/modules/kabina-chat/ChatIcons';
import { todoProgress } from '@/modules/kabina-chat/utils/agentWork';
import type { BackgroundWork } from '@/modules/kabina-chat/utils/agentWork';
import type { TodoItem } from '@/modules/kabina-chat/utils/chatFeed';
import { useEscapeLayer } from '@/shared/hooks/useEscapeLayer';

/** «ХОД 06:12 · ШАГ 27»: what the line says about the running turn. */
export type TurnView = {
  running: boolean;
  elapsed: string;
  steps: number;
  /** «· работает», «· ждёт твоего решения ↑». */
  statusText: string;
  tone: 'run' | 'wait' | 'idle';
  /** «Bash npm test», «пишет ответ», «думает» — the ✻ line, as in Claude Code; null hides it. */
  activity?: string | null;
  /** «12 с · ↓ 1.2k ток.» after the activity. */
  activityMeta?: string | null;
};

/** The turn's plan (TodoWrite) and background jobs: the «план / фон» chip and its list. */
export type TurnWork = { todos: TodoItem[] | null; background: BackgroundWork[] };

/** The follow-ups waiting for the end of the turn, and the actions on one of them. */
export type QueueView = {
  items: string[];
  editItem: (index: number, text: string) => void;
  removeItem: (index: number) => void;
  moveItem: (from: number, to: number) => void;
};

type ChatStatusLineProps = {
  isPhone: boolean;
  /** Narrow desktop composer (artifact beside it): the status words hide. */
  compact: boolean;
  turn: TurnView;
  queue: QueueView;
  /** Hold-to-stop of the running turn (the authors' abort). */
  onStop: () => void;
  /**
   * Why the running turn cannot be stopped from here; «Стоп» is then inactive
   * and says so: `text` in its tooltip and spoken name, `line` on the desktop
   * line, `short` in place of the activity on the phone.
   */
  stopUnavailable?: { text: string; line: string; short: string } | null;
  /** «сейчас | после хода», shown while a turn runs. */
  when: ReactNode;
  /** A note that must be seen (a refused steer): it shows the line even without a turn. */
  notice: string | null;
  /** A quiet hint for the running turn (desktop: what a «/» command does mid-turn). */
  hint: ReactNode;
  /** Running subagents (phone: the desktop header shows them). */
  agentsCount: number;
  /** The HUD already shows «ход 06:12 · шаг 27» and the subagents (ChatLayoutB): not twice. */
  clockInHud?: boolean;
  /** Plan and background jobs; the chip shows while there is either. */
  work?: TurnWork;
};

/**
 * Rendered by the kabina-chat composer right above its box: the one status
 * line of the chat. No turn and an empty queue — nothing at all (the feed
 * keeps the height). During a turn: «● ход 01:23 · шаг 5», «Стоп» (hold) and
 * «сейчас | после хода». Queued follow-ups — the «очередь · N» chip, which
 * unfolds the queue list over the feed (edit, remove, drag to reorder).
 */
export default function ChatStatusLine({ isPhone, compact, turn, queue, onStop, stopUnavailable = null, when, notice, hint, agentsCount, clockInHud = false, work }: ChatStatusLineProps) {
  // The queue list unfolded over the feed.
  const [isQueueOpen, setIsQueueOpen] = useState(false);
  // The plan / background list unfolded over the feed.
  const [isWorkOpen, setIsWorkOpen] = useState(false);
  const todos = work?.todos?.length ? work.todos : null;
  const background = work?.background ?? [];
  const hasWork = Boolean(todos) || background.length > 0;
  const lineRef = useRef<HTMLDivElement>(null);
  const count = queue.items.length;

  // The last row left (sent, or removed): fold the list.
  useEffect(() => {
    if (count === 0) setIsQueueOpen(false);
  }, [count]);

  useEffect(() => {
    if (!hasWork) setIsWorkOpen(false);
  }, [hasWork]);

  // A press outside the line and its list, or Esc, folds it.
  // Esc closes the open panel only when it is the newest layer.
  const isTopLayer = useEscapeLayer(isQueueOpen || isWorkOpen);
  useEffect(() => {
    if (!isQueueOpen && !isWorkOpen) return undefined;
    const onPointer = (event: PointerEvent) => {
      if (lineRef.current?.contains(event.target as Node)) return;
      setIsQueueOpen(false);
      setIsWorkOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isTopLayer()) {
        event.preventDefault();
        setIsQueueOpen(false);
        setIsWorkOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [isQueueOpen, isTopLayer, isWorkOpen]);

  if (!turn.running && count === 0 && !notice && !hasWork) return null;
  const plan = todos ? todoProgress(todos) : null;

  const ledClass = turn.tone === 'wait' ? 'kb-led-wait' : turn.tone === 'run' ? 'kb-led-run' : 'kb-led-idle';

  return (
    <div ref={lineRef} className="kbc-sline" data-phone={isPhone ? '' : undefined} data-queue={count > 0 ? '' : undefined} role="group" aria-label="Состояние хода">
      {isWorkOpen && hasWork && (
        <div className="kbc-qpop kbc-workpop kb-pop" role="dialog" aria-label="План и фоновая работа">
          <TurnWorkList todos={todos} background={background} live={turn.running} />
        </div>
      )}

      {isQueueOpen && (
        <div className="kbc-qpop kb-pop">
          <ChatQueue
            items={queue.items}
            isPhone={isPhone}
            onEdit={queue.editItem}
            onRemove={queue.removeItem}
            onMove={queue.moveItem}
            onClose={() => setIsQueueOpen(false)}
          />
        </div>
      )}

      {turn.running && (
        <HoldButton
          className="kbc-sl-stop"
          onConfirm={onStop}
          disabled={Boolean(stopUnavailable)}
          title={stopUnavailable?.text}
          ariaLabel={stopUnavailable ? `Стоп недоступен: ${stopUnavailable.text}` : 'Остановить ход — удерживай полторы секунды'}
          tag={isPhone ? 'ДЕРЖИ' : 'УДЕРЖИВАЙ'}
        />
      )}

      {/* The phone has no room for both: the reason stands in for the activity. */}
      {turn.running && isPhone && stopUnavailable && (
        <span className="kbc-sl-turn kbc-sl-live kbc-sl-away kb-m" role="status" title={stopUnavailable.text}>
          <span className="kbc-sl-spin" aria-hidden="true">✻</span>
          <span className="kbc-sl-act">{stopUnavailable.short}</span>
        </span>
      )}

      {turn.running && turn.activity && !(isPhone && stopUnavailable) && (
        <span className="kbc-sl-turn kbc-sl-live kb-m" role="status" data-tone={turn.tone}>
          <span className="kbc-sl-spin" aria-hidden="true">✻</span>
          <span className="kbc-sl-act">{turn.activity}{turn.tone === 'wait' ? ' ↑' : turn.activity.endsWith('…') ? '' : '…'}</span>
          {turn.activityMeta && <span className="kbc-sl-meta">({turn.activityMeta})</span>}
        </span>
      )}

      {turn.running && !turn.activity && !clockInHud && (
        <span className="kbc-sl-turn kb-m" role="status">
          <span className={`kb-led ${ledClass}`} />
          <span className="kbc-sl-clock">
            <span className="kbc-sl-word" data-word="turn">ход </span><b>{turn.elapsed}</b>
            <span className="kbc-sl-steps"> · <span className="kbc-sl-word" data-word="step">шаг </span><b>{turn.steps}</b></span>
          </span>
          {!isPhone && <span className="kbc-scanbar" aria-hidden="true"><span className="kb-scan" /></span>}
          {!isPhone && !compact && (
            <span className="kbc-sl-status" data-tone={turn.tone}>{turn.statusText}</span>
          )}
        </span>
      )}

      <span className="kbc-sl-gap" />

      {notice
        ? <span className="kbc-notice kbc-sl-note" title={notice}>{notice}</span>
        : turn.running && stopUnavailable && !isPhone
          ? <span className="kbc-notice kbc-sl-note" title={stopUnavailable.text}>{stopUnavailable.line}</span>
          : turn.running && hint}

      {isPhone && turn.running && agentsCount > 0 && !clockInHud && (
        <Link className="kbc-sl-agents" to="/agents" aria-label={`Субагентов работает: ${agentsCount}`}>
          <Equalizer />
          <span className="kb-m">{agentsCount}</span>
        </Link>
      )}

      {hasWork && (
        <button
          type="button"
          className="kbc-sl-work"
          aria-expanded={isWorkOpen}
          aria-label={[
            plan ? `План: сделано ${plan.done} из ${plan.total}` : null,
            background.length ? `в фоне: ${background.length}` : null,
          ].filter(Boolean).join(', ') + ` — ${isWorkOpen ? 'свернуть' : 'показать'}`}
          onClick={() => {
            setIsWorkOpen((open) => !open);
            setIsQueueOpen(false);
          }}
        >
          {plan && (
            <span className="kbc-sl-plan kb-m" data-done={plan.done === plan.total ? '' : undefined}>
              <span className="kbc-sl-planbox" aria-hidden="true" />
              {plan.done}/{plan.total}
            </span>
          )}
          {background.length > 0 && (
            <span className="kbc-sl-bg kb-m">
              <span className="kbc-sl-bgmark" aria-hidden="true" />
              {!isPhone && 'фон '}{background.length}
            </span>
          )}
          <ChevronRight size={11} strokeWidth={2.4} className="kbc-chev" />
        </button>
      )}

      {turn.running && when}

      {count > 0 && (
        <button
          type="button"
          className="kbc-sl-queue"
          aria-expanded={isQueueOpen}
          aria-label={`Очередь после хода: ${count} — ${isQueueOpen ? 'свернуть' : 'показать'}`}
          onClick={() => {
            setIsQueueOpen((open) => !open);
            setIsWorkOpen(false);
          }}
        >
          <QueueLines size={13} />
          {!isPhone && <span className="kbc-sl-qword">очередь</span>}
          <span className="kbc-sl-qcount kb-m">{count}</span>
          <ChevronRight size={11} strokeWidth={2.4} className="kbc-chev" />
        </button>
      )}
    </div>
  );
}

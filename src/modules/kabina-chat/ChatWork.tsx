import { memo, useState } from 'react';

import { StatusShape } from '@/modules/kabina';
import { CheckIcon, ChevronRight } from '@/modules/kabina-chat/ChatIcons';
import { agentMetaLine, describeAgent, formatWorkTime, todoProgress } from '@/modules/kabina-chat/utils/agentWork';
import type { AgentState, BackgroundWork, LiveAgentSample } from '@/modules/kabina-chat/utils/agentWork';
import type { TodoItem } from '@/modules/kabina-chat/utils/chatFeed';
import type { ChatMessage, KabinaStatusKind } from '@/shared/types';

/**
 * The turn's work drawn as in Claude Code's terminal, in the Kabina's mono and status shapes:
 * a subagent's nested card («● АГЕНТ описание ⎿ что делает · N вызовов · токены · время»),
 * the TodoWrite checklist (☐ ▸ ☑) and the list of background jobs. Rendered by the chat feed
 * (cards, plan) and the turn line's «план / фон» popover.
 */

const SHAPE: Record<AgentState, KabinaStatusKind> = { run: 'run', done: 'ok', err: 'error', stopped: 'idle' };
const STATE_WORD: Record<AgentState, string> = { run: 'работает', done: 'готово', err: 'ошибка', stopped: 'остановлен' };

type AgentCardProps = {
  message: ChatMessage;
  /** The live tree's node for this call while the session's turn runs. */
  live: LiveAgentSample | null;
  /** Clock of the feed (ticks every second while a turn runs). */
  now: number;
  isPhone: boolean;
};

/** A subagent (Task / Agent call) in the feed: nested under Claude, live while it works. */
export const AgentCard = memo(function AgentCard({ message, live, now, isPhone }: AgentCardProps) {
  // The agent's own calls, folded by default (as Claude Code folds them: ctrl+o).
  const [open, setOpen] = useState(false);
  const view = describeAgent(message, now, live);
  const meta = agentMetaLine(view);
  const line = view.state === 'run' ? view.current : view.summary;
  return (
    <div className="kbc-agent" data-state={view.state}>
      <button
        type="button"
        className="kbc-agent-head"
        aria-expanded={open}
        aria-label={`Субагент «${view.name}» — ${STATE_WORD[view.state]}${view.steps.length ? `, ${open ? 'свернуть' : 'показать'} шаги` : ''}`}
        onClick={() => setOpen((value) => !value)}
        disabled={view.steps.length === 0}
      >
        <StatusShape kind={SHAPE[view.state]} />
        <span className="kbc-agent-cap kb-m">{view.background ? 'ФОН · АГЕНТ' : 'АГЕНТ'}</span>
        <span className="kbc-agent-name">{view.name}</span>
        {view.agentType && !isPhone && <span className="kbc-agent-type kb-m">{view.agentType}</span>}
        <span className="kbc-agent-gap" />
        {view.model && <span className="kbc-agent-model kb-m" data-family={view.model}>{view.model}</span>}
        {view.steps.length > 0 && <ChevronRight size={12} className="kbc-chev" />}
      </button>
      <div className="kbc-agent-body kb-m">
        <span className="kbc-agent-elbow" aria-hidden="true">⎿</span>
        <span className="kbc-agent-lines">
          {line && <span className="kbc-agent-now" data-tone={view.state === 'run' ? 'run' : view.state === 'err' ? 'err' : undefined}>{line}</span>}
          <span className="kbc-agent-meta">
            {meta}
            {view.state !== 'run' && <span data-tone={view.state === 'done' ? 'ok' : view.state === 'err' ? 'err' : 'mute'}>{meta ? ' · ' : ''}{STATE_WORD[view.state]}</span>}
          </span>
        </span>
      </div>
      {open && view.steps.length > 0 && (
        <ol className="kbc-steps kbc-agent-steps kb-fadein">
          {view.steps.map((step, index) => (
            <li key={step.key} className="kbc-step kb-m">
              <span className="kbc-step-row" style={{ cursor: 'default' }}>
                <span className="kbc-step-n">#{String(index + 1).padStart(2, '0')}</span>
                <span className="kbc-step-tool">{step.tool}</span>
                {!isPhone && <span className="kbc-step-arg">{step.arg}</span>}
                <span className="kbc-step-res" data-tone={step.tone}>{step.res}</span>
                {isPhone && <span className="kbc-step-arg">{step.arg}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
});

/** ☐ ▸ ☑ — a plan line's state as a shape: empty box, lit box with a tick-arrow, sage box with a check. */
function TodoMark({ status, live }: { status: TodoItem['status']; live: boolean }) {
  return (
    <span className="kbc-todo-mark" data-status={status} data-live={live ? '' : undefined} aria-hidden="true">
      {status === 'completed' && <CheckIcon size={10} />}
    </span>
  );
}

const STATUS_WORD: Record<TodoItem['status'], string> = { pending: 'впереди', in_progress: 'сейчас', completed: 'сделано' };

/** The plan's lines; `live` makes the current line breathe (the turn is still on it). */
export function TodoList({ items, live }: { items: TodoItem[]; live: boolean }) {
  return (
    <ol className="kbc-todos-list">
      {items.map((item, index) => (
        <li key={`${index}-${item.content}`} className="kbc-todo" data-status={item.status}>
          <TodoMark status={item.status} live={live && item.status === 'in_progress'} />
          <span className="kbc-todo-text">
            <span className="kb-sr">{STATUS_WORD[item.status]}: </span>
            {item.status === 'in_progress' && live ? item.activeForm : item.content}
          </span>
        </li>
      ))}
    </ol>
  );
}

type TodoCardProps = {
  items: TodoItem[];
  /** The plan of the running turn: the current line breathes, the card starts unfolded. */
  live: boolean;
};

/** «ПЛАН 1/3» in the feed: Claude's TodoWrite list, latest state, folds to one line. */
export const TodoCard = memo(function TodoCard({ items, live }: TodoCardProps) {
  const progress = todoProgress(items);
  const finished = progress.total > 0 && progress.done === progress.total;
  // Unfolded while there is something left; a finished plan of a past turn is one line.
  const [open, setOpen] = useState(live || !finished);
  return (
    <section className="kbc-todos" data-finished={finished ? '' : undefined} aria-label="План хода">
      <button type="button" className="kbc-tools kbc-todos-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronRight size={12} className="kbc-chev" />
        <span className="kbc-tools-cap kb-m">ПЛАН</span>
        <span className="kbc-todos-count kb-m" data-tone={finished ? 'ok' : live ? 'run' : 'mute'}>
          {progress.done}/{progress.total}
        </span>
        {!open && (
          <span className="kbc-tools-sum kb-m">
            {progress.current ? progress.current.activeForm : finished ? 'всё сделано' : items.find((item) => item.status === 'pending')?.content ?? ''}
          </span>
        )}
      </button>
      {open && <TodoList items={items} live={live} />}
    </section>
  );
});

/** The turn line's popover: the plan (when the turn has one) and the background jobs. */
export function TurnWorkList({ todos, background, live }: { todos: TodoItem[] | null; background: BackgroundWork[]; live: boolean }) {
  return (
    <div className="kbc-work">
      {todos && todos.length > 0 && (
        <div className="kbc-work-sec">
          <span className="kbc-work-cap kb-m">ПЛАН · {todoProgress(todos).done}/{todos.length}</span>
          <TodoList items={todos} live={live} />
        </div>
      )}
      {background.length > 0 && (
        <div className="kbc-work-sec">
          <span className="kbc-work-cap kb-m">В ФОНЕ · {background.length}</span>
          <ul className="kbc-bg-list">
            {background.map((job) => (
              <li key={job.key} className="kbc-bg kb-m">
                <span className="kb-led kb-led-run" aria-hidden="true" style={{ width: 6, height: 6 }} />
                <span className="kbc-bg-label">{job.label}</span>
                <span className="kbc-bg-time">{formatWorkTime(job.elapsedMs)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

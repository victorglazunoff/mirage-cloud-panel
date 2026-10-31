import { memo, useContext, useState } from 'react';
import type { RefObject, UIEventHandler } from 'react';

import { ChatMessageFiles, ChatMessageImages, FileLinkContext, StreamingMarkdown } from '@/modules/chat';
import type { FileLinkRenderer } from '@/modules/chat';
import { PathText } from '@/modules/kabina-chat/FilePathLink';
import { ClaudeErrorCard, FeedSkeleton, TurnStoppedMark } from '@/modules/kabina';
import {
  ChartIcon,
  ChevronRight,
  ClaudeMark,
  ExpandIcon,
  SideIcon,
  SteerArrow,
} from '@/modules/kabina-chat/ChatIcons';
import { AgentCard, TodoCard } from '@/modules/kabina-chat/ChatWork';
import { plural } from '@/modules/kabina-chat/utils/chatFormat';
import type { LiveAgentSample } from '@/modules/kabina-chat/utils/agentWork';
import type { FeedItem, FeedStep, TurnStopSummary } from '@/modules/kabina-chat/utils/chatFeed';
import { apiErrorChip, resultText, stepFilePath } from '@/modules/kabina-chat/utils/chatFeed';

/** What the feed's state cards can do; built once by the chat screen. */
export type FeedActions = {
  /** «Повторить сейчас» after an API failure: a new turn asking Claude to carry on. */
  retry: () => void;
  /** «Продолжить с шага N» under the stop mark. */
  resume: (step: number) => void;
  /** «Сменить модель на Sonnet» after an API failure; null when Sonnet is already chosen. */
  switchToSonnet: (() => void) | null;
};

type ChatFeedProps = {
  items: FeedItem[];
  isPhone: boolean;
  scrollRef: RefObject<HTMLDivElement>;
  /** The authors' scroll handler: wheel and touch reach the top pager even when nothing scrolls. */
  onScroll: UIEventHandler<HTMLDivElement>;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadEarlier: () => void;
  /** The dialog's history is still on its way: a skeleton, never «пусто». */
  isLoading: boolean;
  /** The history could not be read and nothing is on screen. */
  loadError?: boolean;
  /** Reads the history again after `loadError`. */
  onRetry?: () => void;
  /** Artifact open beside the chat, to mark its card «Скрыть». */
  openArtifactId: string | null;
  onToggleArtifact: (artifactId: string) => void;
  /** The «Нужно твоё решение» card(s), rendered last in the feed. */
  decision: React.ReactNode;
  emptyHint: string;
  /** A turn is running: a retry notice stays live, the error and stop actions wait. */
  isProcessing: boolean;
  actions: FeedActions;
  /** Live agent nodes of this session by the tool call that spawned them (while a turn runs). */
  liveAgents: ReadonlyMap<string, LiveAgentSample>;
  /** The feed's clock: running agents count their time from it. */
  now: number;
  /** The dialog's project: an attached image recorded by path is read from it as a fallback. */
  projectId?: string | null;
};

/**
 * Rendered by the kabina-chat screen: the DarkChat feed. The scroll box is
 * the authors' scroll container, so their stick-to-bottom while streaming and
 * load-earlier-at-the-top keep working.
 */
export default function ChatFeed({
  items,
  isPhone,
  scrollRef,
  onScroll,
  hasMore,
  isLoadingMore,
  onLoadEarlier,
  isLoading,
  loadError = false,
  onRetry,
  openArtifactId,
  onToggleArtifact,
  decision,
  emptyHint,
  isProcessing,
  actions,
  liveAgents,
  now,
  projectId = null,
}: ChatFeedProps) {
  // The plan card of the newest turn is live while a turn runs (its current line breathes).
  let lastTodosKey: string | null = null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const candidate = items[index];
    if (candidate.kind === 'todos') {
      lastTodosKey = candidate.key;
      break;
    }
    if (candidate.kind === 'user' && candidate.steeredAtStep === null) break;
  }
  return (
    <div ref={scrollRef} role="log" aria-label="Лента диалога" aria-busy={isLoading} className="kbc-log" onWheel={onScroll} onTouchMove={onScroll}>
      <div className="kbc-feed">
        {hasMore && (
          <button type="button" className="kbc-older kb-m" onClick={onLoadEarlier} disabled={isLoadingMore}>
            {isLoadingMore ? 'гружу…' : 'раньше в диалоге'}
          </button>
        )}
        {items.length === 0 && (
          <FeedPlaceholder
            isLoading={isLoading || isLoadingMore}
            hasMore={hasMore}
            loadError={loadError}
            onRetry={onRetry}
            emptyHint={emptyHint}
          />
        )}
        {items.map((item, index) => (
          <FeedRow
            key={item.key}
            item={item}
            isPhone={isPhone}
            attached={CLAUDE_ROWS.has(items[index - 1]?.kind)}
            isArtifactOpen={item.kind === 'artifact' && item.artifact.artifactId === openArtifactId}
            onToggleArtifact={onToggleArtifact}
            isLast={index === items.length - 1}
            isProcessing={isProcessing}
            actions={actions}
            live={item.kind === 'agent' ? liveAgents.get(String(item.message.toolId ?? '')) ?? null : null}
            now={item.kind === 'agent' ? now : 0}
            isLiveTurn={item.kind === 'todos' && isProcessing && item.key === lastTodosKey}
            projectId={projectId}
          />
        ))}
        {decision}
      </div>
    </div>
  );
}

type FeedPlaceholderProps = {
  isLoading: boolean;
  /** Older history exists: the dialog is not empty, «раньше в диалоге» reaches it. */
  hasMore: boolean;
  loadError: boolean;
  onRetry?: () => void;
  emptyHint: string;
};

/**
 * What an empty feed shows: a skeleton while the history is on its way (or
 * older pages are still being fetched), a retry after a failed read, and the
 * empty hint only for a dialog that really has no messages.
 */
function FeedPlaceholder({ isLoading, hasMore, loadError, onRetry, emptyHint }: FeedPlaceholderProps) {
  if (loadError) {
    return (
      <p className="kbc-empty" role="alert">
        Не удалось открыть историю диалога.{' '}
        {onRetry && <button type="button" className="kbc-empty-retry kb-m" onClick={onRetry}>повторить</button>}
      </p>
    );
  }
  if (isLoading) return <FeedSkeleton />;
  if (hasMore) return null;
  return <p className="kbc-empty">{emptyHint}</p>;
}

/** Rows that belong to Claude's turn: the next work row hangs under them without its own header. */
const CLAUDE_ROWS = new Set<FeedItem['kind'] | undefined>(['assistant', 'journal', 'agent', 'todos']);

type FeedRowProps = {
  item: FeedItem;
  isPhone: boolean;
  /** A journal right after Claude's reply belongs to it (10px apart, no header of its own). */
  attached: boolean;
  isArtifactOpen: boolean;
  onToggleArtifact: (artifactId: string) => void;
  /** The newest row: only it carries the error and stop actions. */
  isLast: boolean;
  isProcessing: boolean;
  actions: FeedActions;
  /** An agent card's live node; null for every other row. */
  live: LiveAgentSample | null;
  /** The clock for an agent card (0 for every other row, so they do not re-render each second). */
  now: number;
  /** A plan card of the running turn. */
  isLiveTurn: boolean;
  projectId: string | null;
};

/** «Правки до шага 22 сохранены — 3 файла. Начатый Bash npm run shots прерван.» */
function stopSummary(stop: TurnStopSummary) {
  const kept = stop.editedFiles > 0
    ? `Правки до шага ${stop.step} сохранены — ${stop.editedFiles} ${plural(stop.editedFiles, 'файл', 'файла', 'файлов')}.`
    : stop.step > 0 ? `До шага ${stop.step} файлы не менялись.` : 'Ход остановлен до первого шага.';
  return (
    <>
      {kept}
      {stop.interrupted && <> Начатый <code>{stop.interrupted}</code> прерван.</>}
    </>
  );
}

const FeedRow = memo(function FeedRow({ item, isPhone, attached, isArtifactOpen, onToggleArtifact, isLast, isProcessing, actions, live, now, isLiveTurn, projectId }: FeedRowProps) {
  switch (item.kind) {
    case 'agent':
    case 'todos':
      return (
        <div className="kbc-claude kbc-work-row" style={attached ? { marginTop: -12 } : undefined}>
          {!attached && (
            <div className="kbc-who kbc-claude-who kb-m">
              <ClaudeMark />
              <span className="kbc-who-claude">CLAUDE</span>
              <span>{item.time}</span>
            </div>
          )}
          {item.kind === 'agent'
            ? <AgentCard message={item.message} live={live} now={now} isPhone={isPhone} />
            : <TodoCard items={item.items} live={isLiveTurn} />}
        </div>
      );
    case 'user':
      return (
        <article className="kbc-you kb-bz">
          <div className="kbc-who kb-m">
            <span className="kbc-who-you">ТЫ</span>
            <span>{item.time}</span>
            {item.steeredAtStep !== null && (
              <span className="kbc-steered">
                <SteerArrow size={10} />
                ВКЛИНЕНО{item.steeredAtStep > 0 ? ` · ШАГ ${item.steeredAtStep}` : ''}
              </span>
            )}
          </div>
          {(item.message.images?.length || item.message.files?.length) ? (
            // The pictures and files sent with the message (live echo and history alike).
            <div className="kbc-you-att">
              {item.message.images?.length ? <ChatMessageImages images={item.message.images} projectId={projectId} /> : null}
              {item.message.files?.length ? <ChatMessageFiles files={item.message.files} /> : null}
            </div>
          ) : null}
          {item.text && <p className="kbc-text">{item.text}</p>}
        </article>
      );
    case 'assistant':
      return (
        <article className="kbc-claude">
          <div className="kbc-who kbc-claude-who kb-m">
            <ClaudeMark />
            <span className="kbc-who-claude">CLAUDE</span>
            <span>{item.time}</span>
          </div>
          <StreamingMarkdown content={item.text} isStreaming={item.isStreaming} className="kbc-md" />
        </article>
      );
    case 'journal':
      return (
        <div className="kbc-claude" style={attached ? { marginTop: -12 } : undefined}>
          {!attached && (
            <div className="kbc-who kbc-claude-who kb-m">
              <ClaudeMark />
              <span className="kbc-who-claude">CLAUDE</span>
              <span>{item.time}</span>
            </div>
          )}
          <Journal steps={item.steps} summary={item.summary} total={item.total} totalTone={item.totalTone} isPhone={isPhone} />
        </div>
      );
    case 'artifact':
      return isPhone ? (
        <button
          type="button"
          className="kbc-partcard kb-bz"
          onClick={() => onToggleArtifact(item.artifact.artifactId)}
          aria-label={`Открыть артефакт «${item.artifact.title}» на весь экран`}
        >
          <span className="kbc-art-ico" aria-hidden="true"><ChartIcon size={18} /></span>
          <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span className="kbc-art-title">{item.artifact.title}</span>
            <span className="kbc-art-meta kb-m">артефакт · {item.time}</span>
          </span>
          <span className="kbc-partcard-open">Открыть <ExpandIcon size={14} /></span>
        </button>
      ) : (
        <div className="kbc-artcard kb-bz" data-open={isArtifactOpen ? '' : undefined}>
          <span className="kbc-art-ico" aria-hidden="true"><ChartIcon size={18} /></span>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span className="kbc-art-title">{item.artifact.title}</span>
            <span className="kbc-art-meta kb-m">артефакт · опубликован {item.time}</span>
          </div>
          <button
            type="button"
            className="kbc-btn-sm"
            aria-pressed={isArtifactOpen}
            onClick={() => onToggleArtifact(item.artifact.artifactId)}
          >
            <span>{isArtifactOpen ? 'Скрыть' : 'Открыть рядом'}</span>
            <SideIcon size={13} />
          </button>
        </div>
      );
    case 'stopped':
      return (
        <TurnStoppedMark
          at={item.at}
          step={item.stop.step || null}
          summary={stopSummary(item.stop)}
          onResume={isLast && !isProcessing ? () => actions.resume(item.stop.step) : undefined}
        />
      );
    case 'apiError':
      if (item.retry) {
        // The reply resumed or the turn ended: the retry is history, one quiet line is enough.
        if (!isProcessing) {
          return (
            <div className="kbc-note kb-m" data-tone="err">
              <span className="kb-led kbc-note-led kb-led-warn" style={{ width: 6, height: 6 }} />
              <span style={{ flex: 1, minWidth: 0 }}>Claude не ответил · {apiErrorChip(item.error)} · повтор {item.retry.attempt}</span>
            </div>
          );
        }
        return (
          <ClaudeErrorCard
            kind={item.error}
            savedStep={item.savedStep || null}
            retryAt={item.at + item.retry.retryDelayMs}
            retryPauseMs={Math.max(1000, item.retry.retryDelayMs)}
            attempt={item.retry.attempt}
            maxAttempts={item.retry.maxRetries || undefined}
            details={item.details}
          />
        );
      }
      return (
        <ClaudeErrorCard
          kind={item.error}
          savedStep={item.savedStep || null}
          onRetryNow={isLast && !isProcessing ? actions.retry : undefined}
          altAction={isLast && !isProcessing && actions.switchToSonnet ? { label: 'Сменить модель на Sonnet', onClick: actions.switchToSonnet } : undefined}
          details={item.details}
        />
      );
    case 'note':
      return (
        <div className="kbc-note kb-m" data-tone={item.tone}>
          <span className={`kb-led kbc-note-led ${item.tone === 'run' ? 'kb-led-run' : item.tone === 'err' ? 'kb-led-warn' : 'kb-led-idle'}`} style={{ width: 6, height: 6 }} />
          <span style={{ flex: 1, minWidth: 0 }}>
            {item.text}
            {item.detail && (
              <details style={{ marginTop: 4, color: 'var(--kb-soft)' }}>
                <summary style={{ cursor: 'pointer' }}>выжимка</summary>
                <span style={{ whiteSpace: 'pre-wrap' }}>{item.detail}</span>
              </details>
            )}
          </span>
        </div>
      );
    default:
      return null;
  }
});

type JournalProps = {
  steps: FeedStep[];
  summary: string;
  total: string;
  totalTone: string;
  isPhone: boolean;
};

/** «ЖУРНАЛ» — one mono line for a run of tool calls; opens into numbered steps, each opens its input and result. */
function Journal({ steps, summary, total, totalTone, isPhone }: JournalProps) {
  const fileLinks = useContext(FileLinkContext);
  // Whether the step list is shown; journals start folded, as in DarkChat.
  const [open, setOpen] = useState(false);
  // The step whose input/result is unfolded below it (one at a time).
  const [openStep, setOpenStep] = useState<string | null>(null);
  return (
    <>
      <button type="button" className="kbc-tools" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronRight size={12} className="kbc-chev" />
        <span className="kbc-tools-cap kb-m">ЖУРНАЛ</span>
        <span className="kbc-tools-sum kb-m">{summary}</span>
        <span className="kbc-tools-total kb-m" data-tone={totalTone}>{total}</span>
      </button>
      {open && (
        <ol className="kbc-steps kb-fadein">
          {steps.map((step) => (
            <li key={step.key} className="kbc-step kb-m">
              {/* The whole row toggles the detail (a button stretched under it); the file name on it is its own link. */}
              <div className="kbc-step-row">
                <button
                  type="button"
                  className="kbc-step-hit"
                  aria-expanded={openStep === step.key}
                  aria-label={`#${step.n} ${step.tool} ${step.arg} — ${step.res}`}
                  onClick={() => setOpenStep((current) => (current === step.key ? null : step.key))}
                />
                <span className="kbc-step-n" aria-hidden="true">#{String(step.n).padStart(2, '0')}</span>
                <span className="kbc-step-tool" aria-hidden="true">{step.tool}</span>
                {!isPhone && <StepArgument step={step} links={fileLinks} />}
                <span className="kbc-step-res" data-tone={step.tone} aria-hidden="true">{step.res}</span>
                {isPhone && <StepArgument step={step} links={fileLinks} />}
              </div>
              {openStep === step.key && <StepDetail step={step} links={fileLinks} />}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

const DETAIL_LIMIT = 4000;

function clip(text: string): string {
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}\n… (ещё ${text.length - DETAIL_LIMIT} знаков)` : text;
}

/** What a step acted on; the file of a Read / Edit / Write step is a link to it. */
function StepArgument({ step, links }: { step: FeedStep; links: FileLinkRenderer | null }) {
  const file = links ? stepFilePath(step.message) : null;
  return (
    <span className="kbc-step-arg" aria-hidden={file ? undefined : true}>
      {file && links ? links.renderFileLink({ path: file, line: null }, step.arg) : step.arg}
    </span>
  );
}

function StepDetail({ step, links }: { step: FeedStep; links: FileLinkRenderer | null }) {
  const input = step.message.toolInput;
  const inputText = typeof input === 'string' ? input : JSON.stringify(input ?? {}, null, 2);
  const output = resultText(step.message);
  return (
    <div className="kbc-step-detail kb-fadein">
      <b>ВХОД</b>
      {'\n'}
      <PathText text={clip(inputText)} links={links} />
      {output && (
        <>
          {'\n\n'}
          <b>{step.message.toolResult?.isError ? 'ОШИБКА' : 'РЕЗУЛЬТАТ'}</b>
          {'\n'}
          <PathText text={clip(output)} links={links} />
        </>
      )}
    </div>
  );
}

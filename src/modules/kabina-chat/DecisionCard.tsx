import { useEffect, useState } from 'react';

import { Markdown, buildClaudeToolPermissionEntry, formatToolInputForDisplay } from '@/modules/chat';
import { PermissionRequestCard, permissionDiffFromToolInput } from '@/modules/kabina';
import { CheckIcon } from '@/modules/kabina-chat/ChatIcons';
import { formatClock } from '@/modules/kabina-chat/utils/chatFeed';
import type { PendingPermissionRequest } from '@/shared/types';

type Decision = { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown };

type DecisionCardsProps = {
  requests: PendingPermissionRequest[];
  onDecision: (requestIds: string | string[], decision: Decision) => void;
  isPhone: boolean;
};

/** What the user decided last, shown as one quiet line after the card goes («Разрешено один раз · 14:33»). */
type DecidedNote = { text: string; tone: 'ok' | 'mute' };

/**
 * Rendered at the end of the kabina-chat feed: «НУЖНО ТВОЁ РЕШЕНИЕ» for each
 * pending permission request — the Kabina `PermissionRequestCard` (a Bash
 * command, or a numbered diff for Write / Edit / MultiEdit): allow once / allow
 * for this session (the live process remembers the rule) / deny — plus the
 * plan-approval and question variants. Decisions go through the authors'
 * permission handler.
 */
export default function DecisionCards({ requests, onDecision, isPhone }: DecisionCardsProps) {
  // The confirmation line of the most recent decision; cleared when a new request arrives.
  const [decided, setDecided] = useState<DecidedNote | null>(null);

  useEffect(() => {
    if (requests.length > 0) setDecided(null);
  }, [requests.length]);

  const decide = (ids: string | string[], decision: Decision, note: DecidedNote) => {
    onDecision(ids, decision);
    setDecided(note);
  };

  return (
    <>
      {requests.map((request) => (
        <DecisionCard key={request.requestId} request={request} requests={requests} decide={decide} isPhone={isPhone} />
      ))}
      {requests.length === 0 && decided && (
        <div className="kbc-decided kb-m kb-fadein" data-tone={decided.tone}>
          <CheckIcon size={14} />
          <span>{decided.text}</span>
        </div>
      )}
    </>
  );
}

type DecisionCardProps = {
  request: PendingPermissionRequest;
  requests: PendingPermissionRequest[];
  decide: (ids: string | string[], decision: Decision, note: DecidedNote) => void;
  isPhone: boolean;
};

function useWaitingMinutes(since: Date | undefined): number {
  // Re-render once a minute so «ждёт N мин» stays true.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!since) return 0;
  return Math.max(0, Math.floor((now - new Date(since).getTime()) / 60_000));
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** The request's tool input as an object (it may arrive as a JSON string). */
function requestInput(request: PendingPermissionRequest): Record<string, unknown> {
  return readRecord(typeof request.input === 'string' ? (() => {
    try {
      return JSON.parse(request.input as string);
    } catch {
      return { value: request.input };
    }
  })() : request.input);
}

/** The command or target of a request as one mono line («$ bash deploy.sh --prod»). */
function describeRequest(request: PendingPermissionRequest): { line: string; note: string | null } {
  const input = requestInput(request);
  if (typeof input.command === 'string') {
    return { line: input.command, note: typeof input.description === 'string' ? input.description : null };
  }
  if (typeof input.file_path === 'string') return { line: `${request.toolName} ${input.file_path}`, note: null };
  if (typeof input.url === 'string') return { line: `${request.toolName} ${input.url}`, note: null };
  const raw = formatToolInputForDisplay(request.input);
  return { line: raw ? `${request.toolName} ${raw}` : request.toolName, note: null };
}

function DecisionCard({ request, requests, decide, isPhone }: DecisionCardProps) {
  const minutes = useWaitingMinutes(request.receivedAt);
  const waitText = minutes < 1 ? 'только что' : `${minutes} мин`;
  const now = () => formatClock(new Date());

  const isPlan = request.toolName === 'ExitPlanMode' || request.toolName === 'exit_plan_mode';
  const isQuestion = request.toolName === 'AskUserQuestion';

  let body: React.ReactNode;
  let actions: React.ReactNode;

  if (isPlan) {
    const plan = String(readRecord(request.input).plan ?? '');
    body = (
      <>
        <p className="kbc-text">Claude составил план и ждёт твоего «да», прежде чем что-то менять.</p>
        {plan && <div className="kbc-plan"><Markdown className="kbc-md">{plan}</Markdown></div>}
      </>
    );
    actions = (
      <div className="kbc-actions">
        <button type="button" className="kb-btn kb-pri" onClick={() => decide(request.requestId, { allow: true }, { text: `План утверждён · ${now()} · Claude приступает`, tone: 'ok' })}>
          Утвердить план
        </button>
        <button
          type="button"
          className="kb-btn kb-ghost"
          onClick={() => decide(request.requestId, { allow: false, message: 'Пользователь просит доработать план.' }, { text: 'План отправлен на доработку', tone: 'mute' })}
        >
          Доработать
        </button>
      </div>
    );
  } else if (isQuestion) {
    return <QuestionCard request={request} decide={decide} waitText={waitText} isPhone={isPhone} />;
  } else {
    const { line, note } = describeRequest(request);
    const rawInput = formatToolInputForDisplay(request.input);
    const entry = buildClaudeToolPermissionEntry(request.toolName, rawInput);
    const sameRule = entry
      ? requests.filter((item) => buildClaudeToolPermissionEntry(item.toolName, formatToolInputForDisplay(item.input)) === entry).map((item) => item.requestId)
      : [request.requestId];
    const context = readRecord(request.context);
    const reason = typeof context.decisionReason === 'string' ? context.decisionReason
      : typeof context.reason === 'string' ? context.reason : null;
    // Write / Edit / MultiEdit show what the file will become (DarkStates P2); everything else its command line.
    const diff = permissionDiffFromToolInput(request.toolName, requestInput(request));
    return (
      <PermissionRequestCard
        toolName={request.toolName}
        reason={reason || `Claude просит разрешить ${request.toolName}. На паузе только этот шаг — остальное ждёт твоего ответа.`}
        waitingSince={request.receivedAt ?? null}
        waitNote="· на паузе только этот шаг"
        command={diff ? undefined : line}
        commandNote={!diff && note && !isPhone ? note : undefined}
        diff={diff}
        variant={isPhone ? 'phone' : 'chat'}
        decision={null}
        onAllowOnce={() => decide(request.requestId, { allow: true }, { text: `Разрешено один раз · ${now()} · ход продолжается`, tone: 'ok' })}
        onAllowSession={entry
          ? () => decide(sameRule, { allow: true, rememberEntry: entry }, { text: `${request.toolName} разрешён до конца сессии · ${now()}`, tone: 'ok' })
          : undefined}
        sessionLabel={isPhone ? 'До конца сессии' : 'Разрешать в этой сессии'}
        onDeny={() => decide(request.requestId, { allow: false, message: 'Пользователь отклонил этот шаг.' }, { text: 'Отклонено · Claude предложит, что делать дальше', tone: 'mute' })}
      />
    );
  }

  return (
    <DecisionFrame waitText={waitText} isPhone={isPhone}>
      {body}
      {actions}
    </DecisionFrame>
  );
}

function DecisionFrame({ waitText, isPhone, children }: { waitText: string; isPhone: boolean; children: React.ReactNode }) {
  return (
    <section aria-label="Нужно твоё решение" className="kbc-decision kb-rise kb-d2">
      <div className="kbc-decision-stripe" aria-hidden="true" />
      <div className="kbc-decision-body">
        <div className="kbc-decision-head">
          <span className="kb-led kb-led-wait" />
          <h2 className="kbc-decision-title kb-m">НУЖНО ТВОЁ РЕШЕНИЕ</h2>
          {isPhone && <div className="kb-spacer" style={{ flex: '1 1 0' }} />}
          <span className="kbc-decision-wait kb-m">{isPhone ? waitText : `ждёт ${waitText} · на паузе только этот шаг`}</span>
        </div>
        {children}
      </div>
    </section>
  );
}

type QuestionShape = { question: string; header?: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string }> };

function QuestionCard({ request, decide, waitText, isPhone }: { request: PendingPermissionRequest; decide: DecisionCardProps['decide']; waitText: string; isPhone: boolean }) {
  const input = readRecord(request.input);
  const questions = (Array.isArray(input.questions) ? input.questions : []) as QuestionShape[];
  // Chosen option labels per question index.
  const [picked, setPicked] = useState<Record<number, string[]>>({});

  const toggle = (index: number, label: string, multi: boolean) => {
    setPicked((current) => {
      const now = current[index] ?? [];
      const next = multi ? (now.includes(label) ? now.filter((item) => item !== label) : [...now, label]) : [label];
      return { ...current, [index]: next };
    });
  };

  const answer = () => {
    const answers: Record<string, string> = {};
    questions.forEach((question, index) => {
      if (picked[index]?.length) answers[question.question] = picked[index].join(', ');
    });
    decide(request.requestId, { allow: true, updatedInput: { ...input, answers } }, { text: 'Ответ отправлен Claude', tone: 'ok' });
  };

  return (
    <DecisionFrame waitText={waitText} isPhone={isPhone}>
      {questions.map((question, index) => (
        <div key={question.question} className="kbc-question">
          <p className="kbc-question-q">{question.question}</p>
          <div className="kbc-options" role="group" aria-label={question.header || question.question}>
            {(question.options ?? []).map((option) => (
              <button
                key={option.label}
                type="button"
                className="kbc-option"
                aria-pressed={Boolean(picked[index]?.includes(option.label))}
                title={option.description}
                onClick={() => toggle(index, option.label, Boolean(question.multiSelect))}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="kbc-actions">
        <button type="button" className="kb-btn kb-pri" onClick={answer} disabled={Object.keys(picked).length === 0}>Ответить</button>
        <button
          type="button"
          className="kb-btn kb-ghost"
          style={{ color: 'var(--kb-soft)' }}
          onClick={() => decide(request.requestId, { allow: true, updatedInput: { ...input, answers: {} } }, { text: 'Вопрос пропущен', tone: 'mute' })}
        >
          Пропустить
        </button>
      </div>
    </DecisionFrame>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import '@/modules/kabina-agents/kabinaAgents.css';
import { kabinaChatPath, LoadErrorState, Skeleton } from '@/modules/kabina';
import AgentDetailPanel from '@/modules/kabina-agents/AgentDetailPanel';
import AgentsEmpty from '@/modules/kabina-agents/AgentsEmpty';
import AgentsFeed from '@/modules/kabina-agents/AgentsFeed';
import AgentsRadarCard from '@/modules/kabina-agents/AgentsRadarCard';
import AgentsSummary from '@/modules/kabina-agents/AgentsSummary';
import AgentsWaitStrip from '@/modules/kabina-agents/AgentsWaitStrip';
import { useAgentsLive } from '@/modules/kabina-agents/hooks/useAgentsLive';
import {
  buildRadarLayout,
  collectWaitingPrompts,
  countAgents,
  defaultSelection,
  eyebrowText,
  formatClock,
  isActiveState,
  isSessionActive,
  leadText,
} from '@/modules/kabina-agents/utils/agentsView';
import { addToDraftText } from '@/shared/chatDrafts';
import type { LiveAgentsSession } from '@/shared/types';

/** A result line under the header («Разрешено один раз · …»), cleared after a while. */
type Notice = { text: string; tone: 'ok' | 'soft' | 'error' };

const NOTICE_MS = 8_000;

/** Wall clock for the running timers and the stage clocks. */
function useSecondTicker(): number {
  // Current time, re-read every second so «02:14» timers count on between frames.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);
  return now;
}

function lastFinishedText(sessions: LiveAgentsSession[]): { text: string; to: string } {
  let best: { at: string; session: LiveAgentsSession; name: string; summary: string | null } | null = null;
  for (const session of sessions) {
    for (const agent of session.agents) {
      if (!agent.endedAt) continue;
      if (!best || agent.endedAt > best.at) best = { at: agent.endedAt, session, name: agent.name, summary: agent.summary };
    }
  }
  if (!best) {
    return { text: 'За последний час агенты не запускались. Начни ход в любом проекте — он появится здесь сразу.', to: '/projects' };
  }
  const tail = best.summary ? `, ${best.summary.replace(/\.$/, '')}` : '';
  return {
    text: `Последний закончил в ${formatClock(best.at, false)} — ${best.session.projectName}, ${best.name}${tail}.`,
    to: best.session.projectId ? kabinaChatPath(best.session.projectId, best.session.sessionId) : '/projects',
  };
}

/**
 * Used by the project-workspace module for `/agents`: the DarkAgents screen on
 * the live agent trees — summary, «ждёт тебя», a radar per working session,
 * the picked agent and the event feed.
 */
export default function AgentsScreen() {
  const navigate = useNavigate();
  const { state, loaded, error, reload, live, stopAgent, stopSession, answerPermission } = useAgentsLive();
  const now = useSecondTicker();
  // The agent the user picked on a radar or in the feed; null follows the default (who waits, else who works).
  const [picked, setPicked] = useState<{ sessionId: string; agentId: string } | null>(null);
  // The outcome of the last action, shown as a line under the header.
  const [notice, setNotice] = useState<Notice | null>(null);
  // An action is on its way; its buttons wait for the answer.
  const [busy, setBusy] = useState(false);
  const detailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const activeSessions = useMemo(() => state.sessions.filter(isSessionActive), [state.sessions]);
  const prompts = useMemo(() => collectWaitingPrompts(activeSessions), [activeSessions]);
  const layouts = useMemo(
    () => new Map(activeSessions.map((session) => [session.sessionId, buildRadarLayout(session)])),
    [activeSessions],
  );
  // Workflow and crowded sessions take the full width first, as in the mock-up.
  const orderedSessions = useMemo(
    () => [...activeSessions].sort((a, b) => Number(Boolean(layouts.get(b.sessionId)?.wide)) - Number(Boolean(layouts.get(a.sessionId)?.wide))),
    [activeSessions, layouts],
  );

  const selection = useMemo(() => {
    const valid = picked
      && activeSessions.some((session) => session.sessionId === picked.sessionId
        && session.agents.some((agent) => agent.id === picked.agentId));
    return valid ? picked : defaultSelection(activeSessions);
  }, [picked, activeSessions]);
  const selectedSession = selection ? activeSessions.find((session) => session.sessionId === selection.sessionId) ?? null : null;
  const selectedAgent = selectedSession?.agents.find((agent) => agent.id === selection?.agentId) ?? null;

  const stoppable = useMemo(
    () => activeSessions.flatMap((session) => session.agents
      .filter((agent) => agent.id !== 'main' && agent.canStop && isActiveState(agent.state))
      .map((agent) => ({ sessionId: session.sessionId, agentId: agent.id }))),
    [activeSessions],
  );

  // One source for the eyebrow, the lead and the board: the sessions the radar draws.
  const counts = useMemo(() => countAgents(activeSessions), [activeSessions]);
  const errorAgent = activeSessions.flatMap((session) => session.agents).find((agent) => agent.state === 'error') ?? null;
  const errorLabel = errorAgent ? (errorAgent.error || errorAgent.name).split('\n')[0].slice(0, 60) : null;
  const firstPrompt = prompts[0] ?? null;

  const pick = useCallback((sessionId: string, agentId: string) => setPicked({ sessionId, agentId }), []);

  const answer = useCallback(async (requestId: string, allow: boolean) => {
    const prompt = prompts.find((candidate) => candidate.requestId === requestId);
    setBusy(true);
    const result = await answerPermission(requestId, allow);
    setBusy(false);
    const name = prompt ? `«${prompt.agent.name}»` : 'агент';
    if (!result.ok) {
      setNotice({ text: result.error ?? 'Ответ не дошёл.', tone: 'error' });
    } else if (allow) {
      setNotice({ text: `Разрешено один раз · ${prompt?.toolName ?? 'шаг'} идёт, ${name} продолжает`, tone: 'ok' });
    } else {
      setNotice({ text: `Отклонено · ${name} получил отказ и ищет другой путь`, tone: 'soft' });
    }
  }, [answerPermission, prompts]);

  const stopAll = useCallback(async () => {
    if (stoppable.length === 0) return;
    setBusy(true);
    const results = await Promise.all(stoppable.map((target) => stopAgent(target.sessionId, target.agentId)));
    setBusy(false);
    const failed = results.filter((result) => !result.ok);
    setNotice(failed.length === 0
      ? { text: `Остановлено агентов: ${results.length} · главные диалоги продолжают`, tone: 'ok' }
      : { text: `Остановлено ${results.length - failed.length} из ${results.length} · ${failed[0].error ?? 'часть не ответила'}`, tone: 'error' });
  }, [stopAgent, stoppable]);

  const stopSelected = useCallback(async () => {
    if (!selectedSession || !selectedAgent) return;
    setBusy(true);
    const result = selectedAgent.id === 'main'
      ? await stopSession(selectedSession.sessionId)
      : await stopAgent(selectedSession.sessionId, selectedAgent.id);
    setBusy(false);
    setNotice(result.ok
      ? { text: `Остановлено · «${selectedAgent.name}»`, tone: 'ok' }
      : { text: result.error ?? 'Остановить не удалось.', tone: 'error' });
  }, [selectedAgent, selectedSession, stopAgent, stopSession]);

  const retrySelected = useCallback(() => {
    if (!selectedSession?.projectId || !selectedAgent) return;
    const reason = selectedAgent.error ? ` — он упал с ошибкой: ${selectedAgent.error.split('\n')[0]}` : '';
    const task = selectedAgent.task ? `\n\nЗадача была: ${selectedAgent.task}` : '';
    // The retry goes through the main dialog: it relaunches the agent with the same task.
    // Added after what is already typed there, never instead of it.
    addToDraftText(selectedSession.sessionId, `Повтори агента «${selectedAgent.name}»${reason}.${task}`);
    navigate(kabinaChatPath(selectedSession.projectId, selectedSession.sessionId));
  }, [navigate, selectedAgent, selectedSession]);

  const pickWaiting = useCallback(() => {
    if (!firstPrompt) return;
    pick(firstPrompt.session.sessionId, firstPrompt.agent.id);
    detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [firstPrompt, pick]);

  const empty = loaded && activeSessions.length === 0;
  const clock = formatClock(now, true);
  const lead = loaded ? leadText(activeSessions, prompts) : 'Собираю живую схему агентов…';
  const finished = empty ? lastFinishedText(state.sessions) : null;
  const noticeColor = notice?.tone === 'ok' ? 'var(--kb-sage)' : notice?.tone === 'error' ? 'var(--kb-sand)' : 'var(--kb-soft)';

  return (
    <div className="kba-screen">
      <AgentsSummary
        eyebrow={eyebrowText(counts.projects, counts.agents)}
        lead={error ? 'Схема агентов не загрузилась — причина ниже.' : lead}
        counts={counts}
        stats={loaded ? state.stats : null}
        waitingLabel={firstPrompt ? `${firstPrompt.session.projectName} · ${firstPrompt.agent.name}` : null}
        errorLabel={errorLabel}
        stoppableCount={stoppable.length}
        busy={busy}
        onStopAll={() => void stopAll()}
      />

      {firstPrompt ? (
        <AgentsWaitStrip
          prompt={firstPrompt}
          more={prompts.length - 1}
          now={now}
          busy={busy}
          onApprove={() => void answer(firstPrompt.requestId, true)}
          onReject={() => void answer(firstPrompt.requestId, false)}
          onPick={pickWaiting}
        />
      ) : null}
      {notice ? (
        <div className="kb-m kba-decision" role="status" style={{ color: noticeColor }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            {notice.tone === 'error' ? <path d="M12 7v6M12 16.5v.5" /> : <path d="M5 12l5 5 9-10" />}
          </svg>
          <span>{notice.text}</span>
        </div>
      ) : null}

      <div className="kba-body">
        <main className="kba-main">
          <div className="kb-heading kb-rise kb-d1 kba-schema-head">
            <span className="kb-m kb-ruler-n" aria-hidden="true">01</span>
            <h2 className="kb-m kb-ruler-title">ЖИВАЯ СХЕМА</h2>
            <span className="kb-ruler-scale" aria-hidden="true" />
            <ul aria-label="Обозначения" className="kb-m kba-legend">
              <li><span className="kba-led kba-led-think" />думает</li>
              <li><span className="kba-led kba-led-tool" />инструмент</li>
              <li data-wait=""><span className="kba-led kba-led-wait" />ждёт тебя</li>
              <li><span className="kba-led kba-led-done" />готово</li>
              <li><span className="kba-led kba-led-error" />ошибка</li>
            </ul>
          </div>

          {!loaded && error ? (
            <div className="kba-cards">
              <LoadErrorState title="Агенты не загрузились" reason={error} onRetry={reload} className="kba-loaderror" />
            </div>
          ) : null}
          {!loaded && !error ? (
            <div role="status" aria-label="Схема загружается" className="kba-cards">
              <Skeleton height={430} radius={6} />
            </div>
          ) : null}
          {empty && finished ? <AgentsEmpty text={finished.text} startTo={finished.to} /> : null}
          {loaded && !empty ? (
            <div className="kba-cards">
              {orderedSessions.map((session) => (
                <AgentsRadarCard
                  key={session.sessionId}
                  session={session}
                  layout={layouts.get(session.sessionId) ?? buildRadarLayout(session)}
                  selectedAgentId={selection?.sessionId === session.sessionId ? selection.agentId : null}
                  receivedAt={state.receivedAt[session.sessionId]}
                  now={now}
                  clock={clock}
                  onSelect={(agentId) => pick(session.sessionId, agentId)}
                />
              ))}
            </div>
          ) : null}
        </main>

        <aside className="kba-aside">
          {selectedSession && selectedAgent ? (
            <div ref={detailRef} style={{ scrollMarginTop: 24 }}>
              <AgentDetailPanel
                session={selectedSession}
                agent={selectedAgent}
                receivedAt={state.receivedAt[selectedSession.sessionId]}
                now={now}
                busy={busy}
                onApprove={(requestId) => void answer(requestId, true)}
                onReject={(requestId) => void answer(requestId, false)}
                onStop={() => void stopSelected()}
                onRetry={retrySelected}
              />
            </div>
          ) : null}
          <AgentsFeed events={state.feed} live={live} now={now} onPick={pick} />
        </aside>
      </div>
    </div>
  );
}

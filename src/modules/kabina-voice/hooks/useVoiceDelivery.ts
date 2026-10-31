import { useCallback } from 'react';

import {
  VOICE_REMIND_BEFORE_MIN,
  calendarTypeFor,
  formatClock,
  formatDayShort,
  messageTextFor,
} from '@/modules/kabina-voice/utils/voiceActionPlan';
import type { VoiceCardView } from '@/modules/kabina-voice/utils/voiceActionPlan';
import { api, readApiJson } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { KabinaProjectRef, ServerEvent, VoiceIntentAction } from '@/shared/types';
import { announceChatEcho } from '@/shared/utils';

/** One line of «Готово»: what was done, or why not. */
export type VoiceResult = {
  id: string;
  ok: boolean;
  /** `run` — handed to Claude and now running; `ok` — done; `fail` — refused. */
  state: 'ok' | 'run' | 'fail';
  title: string;
  sub: string;
  /** Calendar event to remove on «Отменить». */
  calendarEventId?: string;
  /** Dialog to open from the result. */
  href?: string;
};

/** How long a steer may stay unanswered before it is treated as taken. */
const STEER_ANSWER_MS = 4_000;

function chatHref(projectId: string | null, sessionId: string): string {
  return projectId
    ? `/p/${encodeURIComponent(projectId)}/s/${encodeURIComponent(sessionId)}`
    : `/session/${encodeURIComponent(sessionId)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'не получилось';
}

/**
 * Used by the voice overlay for «Выполнить»: creates calendar events through
 * `POST /api/calendar/events`, folds a message into the open chat (`chat.steer`,
 * falling back to `chat.send` when no turn is running) and starts new dialogs in
 * projects (`POST /api/providers/sessions` + `chat.send`). Every action reports its
 * own result line; one failure never stops the others.
 */
export function useVoiceDelivery(projects: KabinaProjectRef[]) {
  const { sendMessage, subscribe } = useWebSocket();

  const sendToSession = useCallback((sessionId: string, content: string) => new Promise<'steered' | 'sent' | 'offline'>((resolve) => {
    const steerId = `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const settle = (value: 'steered' | 'sent' | 'offline') => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unsubscribe();
      // The open chat shows the line at once, as a send from its own composer would.
      if (value !== 'offline') announceChatEcho({ sessionId, content, at: new Date().toISOString(), via: value });
      resolve(value);
    };
    const sendAsTurn = () => settle(sendMessage({ type: 'chat.send', sessionId, content, options: {} }) ? 'sent' : 'offline');
    unsubscribe = subscribe((frame: ServerEvent) => {
      if (frame.steerId !== steerId) return;
      if (frame.kind === 'chat_steered') settle('steered');
      else if (frame.kind === 'protocol_error' && frame.code === 'STEER_UNAVAILABLE') sendAsTurn();
    });
    const timer = window.setTimeout(() => settle('steered'), STEER_ANSWER_MS);
    if (!sendMessage({ type: 'chat.steer', sessionId, steerId, content, options: {} })) settle('offline');
  }), [sendMessage, subscribe]);

  const startSession = useCallback(async (projectId: string, content: string) => {
    const project = projects.find((candidate) => candidate.projectId === projectId);
    if (!project?.path) throw new Error('проект не найден');
    const body = await readApiJson<{ data?: { sessionId?: string } }>(
      await api.providers.createSession({ provider: 'claude', projectPath: project.path, initialMessage: content }),
    );
    const sessionId = body.data?.sessionId;
    if (!sessionId) throw new Error('сервер не дал id диалога');
    if (!sendMessage({ type: 'chat.send', sessionId, content, options: {} })) throw new Error('нет связи с панелью');
    return { sessionId, projectName: project.displayName };
  }, [projects, sendMessage]);

  const run = useCallback(async (cards: VoiceCardView[], actions: VoiceIntentAction[]): Promise<VoiceResult[]> => {
    const byId = new Map(actions.map((action) => [action.id, action]));
    const results: VoiceResult[] = [];

    // Messages for one new dialog of one project go together, so «Новый диалог в проекте»
    // with two tasks opens one conversation, not two.
    const newSessionGroups = new Map<string, Array<{ card: VoiceCardView; action: VoiceIntentAction }>>();

    for (const card of cards) {
      const action = byId.get(card.id);
      if (!action) continue;
      const { delivery } = card;

      if (delivery.kind === 'calendar' && action.kind === 'calendar_event' && action.start) {
        const start = new Date(action.start);
        try {
          const body = await readApiJson<{ data?: { id?: string } }>(await api.calendar.createEvent({
            type: calendarTypeFor(action.eventType),
            title: action.title,
            startsAt: start.toISOString(),
            ...(action.end ? { endsAt: new Date(action.end).toISOString() } : {}),
            contact: action.who.length > 0 ? { name: action.who.join(', ') } : null,
            remindBeforeMin: VOICE_REMIND_BEFORE_MIN,
          }));
          results.push({
            id: card.id, ok: true, state: 'ok',
            title: `${action.title} — в календаре`,
            sub: `${formatDayShort(start)} · ${formatClock(start)} · напомню за ${VOICE_REMIND_BEFORE_MIN} мин`,
            calendarEventId: body.data?.id,
            href: '/calendar',
          });
        } catch (error) {
          results.push({ id: card.id, ok: false, state: 'fail', title: action.title, sub: `не записал: ${errorText(error)}` });
        }
        continue;
      }

      if (delivery.kind === 'session') {
        const outcome = await sendToSession(delivery.sessionId, messageTextFor(action));
        results.push(outcome === 'offline'
          ? { id: card.id, ok: false, state: 'fail', title: card.title, sub: 'нет связи с панелью — не отправлено' }
          : {
              id: card.id, ok: true, state: 'run', title: `${card.title} — у Claude`,
              sub: outcome === 'steered' ? 'вклинил в идущий ход' : 'в текущем диалоге · новый ход',
              href: chatHref(delivery.projectId, delivery.sessionId),
            });
        continue;
      }

      if (delivery.kind === 'new-session') {
        const group = newSessionGroups.get(delivery.projectId) ?? [];
        group.push({ card, action });
        newSessionGroups.set(delivery.projectId, group);
      }
    }

    for (const [projectId, group] of newSessionGroups) {
      const content = group.map(({ action }) => messageTextFor(action)).join('\n\n');
      const title = group.length === 1 ? group[0].card.title : `${group.length} задачи`;
      try {
        const { sessionId, projectName } = await startSession(projectId, content);
        for (const [index, { card }] of group.entries()) {
          results.push({
            id: card.id, ok: true, state: 'run',
            title: `${index === 0 ? title : card.title} — в работе у Claude`,
            sub: `${projectName} · новый диалог`,
            href: chatHref(projectId, sessionId),
          });
        }
      } catch (error) {
        for (const { card } of group) {
          results.push({ id: card.id, ok: false, state: 'fail', title: card.title, sub: `не отправил: ${errorText(error)}` });
        }
      }
    }

    // Keep the order of the cards.
    const order = new Map(cards.map((card, index) => [card.id, index]));
    return results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }, [sendToSession, startSession]);

  /** «Отменить всё»: removes the calendar events this run created; sent messages stay sent. */
  const undoCalendar = useCallback(async (results: VoiceResult[]) => {
    const ids = results.map((result) => result.calendarEventId).filter((id): id is string => Boolean(id));
    await Promise.allSettled(ids.map((id) => api.calendar.deleteEvent(id)));
    return ids.length;
  }, []);

  return { run, undoCalendar };
}

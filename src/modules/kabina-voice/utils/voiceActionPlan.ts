import { toPanelWall } from '@/modules/kabina';
import type { KabinaProjectRef, VoiceIntentAction } from '@/shared/types';

/**
 * Pure rules of the voice overlay (DarkVoice / DarkPhoneVoice): who a phrase goes to,
 * how each parsed action becomes a «Понял» card, and what «Выполнить» will actually do.
 * Kept free of React and network so the rules are unit-tested on their own.
 */

/** Addressee picked in «Куда отправить». */
export type VoiceDestination = 'chat' | 'new' | 'main';

/** Where the overlay was opened: the open chat (if any) decides the default addressee. */
export type VoiceContext = {
  sessionId: string | null;
  projectId: string | null;
};

/** What «Выполнить» does with one checked card. */
export type VoiceDelivery =
  | { kind: 'calendar' }
  | { kind: 'session'; sessionId: string; projectId: string | null }
  | { kind: 'new-session'; projectId: string }
  | { kind: 'none'; reason: string };

/** One «Понял» card as both layouts render it. */
export type VoiceCardView = {
  id: string;
  kind: VoiceIntentAction['kind'];
  kicker: string;
  title: string;
  meta: string;
  /** Desktop right column: big line (time) and small line (day / route). */
  whenBig: string;
  whenSmall: string;
  /** Phone chip under the card. */
  whenChip: string;
  delivery: VoiceDelivery;
  /** False when the card cannot run as is (no time understood, no addressee). */
  runnable: boolean;
};

const WEEKDAY_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTH_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
/** Reminder the overlay sets on every voice-made event («напомню за 15 минут»). */
export const VOICE_REMIND_BEFORE_MIN = 15;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** «11:00» in the panel's zone (panelTime). */
export function formatClock(instant: Date): string {
  const date = toPanelWall(instant);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** «вт 27 окт» in the panel's zone (panelTime). */
export function formatDayShort(instant: Date): string {
  const date = toPanelWall(instant);
  return `${WEEKDAY_SHORT[date.getDay()]} ${date.getDate()} ${MONTH_SHORT[date.getMonth()]}`;
}

/** «0:07» for the recording timer. */
export function formatTimer(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
}

/** Default addressee: the open chat when there is one, otherwise the main assistant (DarkVoice «ПРАВИЛО»). */
export function defaultDestination(context: VoiceContext): VoiceDestination {
  return context.sessionId ? 'chat' : 'main';
}

function projectName(projects: KabinaProjectRef[], projectId: string | null): string | null {
  if (!projectId) return null;
  return projects.find((project) => project.projectId === projectId)?.displayName ?? null;
}

/** Header chip and phone title: «Главный ассистент», «Текущий диалог · Сайт клиента», «Новый диалог · DemoVilla». */
export function destinationLabel(
  destination: VoiceDestination,
  context: VoiceContext,
  newProjectId: string | null,
  projects: KabinaProjectRef[],
): string {
  if (destination === 'chat') {
    const name = projectName(projects, context.projectId);
    return name ? `Текущий диалог · ${name}` : 'Текущий диалог';
  }
  if (destination === 'new') {
    const name = projectName(projects, newProjectId);
    return name ? `Новый диалог · ${name}` : 'Новый диалог в проекте…';
  }
  return 'Главный ассистент';
}

/** Decides where one action goes for the chosen addressee. */
export function planDelivery(
  action: VoiceIntentAction,
  destination: VoiceDestination,
  context: VoiceContext,
  newProjectId: string | null,
): VoiceDelivery {
  if (action.kind === 'calendar_event') {
    return action.start ? { kind: 'calendar' } : { kind: 'none', reason: 'время не понял — поправь текстом' };
  }
  if (destination === 'chat') {
    return context.sessionId
      ? { kind: 'session', sessionId: context.sessionId, projectId: context.projectId }
      : { kind: 'none', reason: 'чат не открыт — выбери другого адресата' };
  }
  if (destination === 'new') {
    return newProjectId
      ? { kind: 'new-session', projectId: newProjectId }
      : { kind: 'none', reason: 'выбери проект в «Куда отправить»' };
  }
  // Main assistant: each action by its own sense.
  if (action.kind === 'project_task') {
    const projectId = action.recipient?.projectId ?? context.projectId;
    return projectId
      ? { kind: 'new-session', projectId }
      : { kind: 'none', reason: 'проект не понял — выбери в «Куда отправить»' };
  }
  return context.sessionId
    ? { kind: 'session', sessionId: context.sessionId, projectId: context.projectId }
    : { kind: 'none', reason: 'некуда отправить — открой чат или выбери проект' };
}

function deliveryRoute(delivery: VoiceDelivery, projects: KabinaProjectRef[]): string {
  if (delivery.kind === 'session') return 'в текущий диалог';
  if (delivery.kind === 'new-session') {
    const name = projectName(projects, delivery.projectId);
    return name ? `новый диалог · ${name}` : 'новый диалог';
  }
  return '';
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Builds the «Понял» card for one action. */
export function buildCardView(
  action: VoiceIntentAction,
  destination: VoiceDestination,
  context: VoiceContext,
  newProjectId: string | null,
  projects: KabinaProjectRef[],
): VoiceCardView {
  const delivery = planDelivery(action, destination, context, newProjectId);
  const runnable = delivery.kind !== 'none';

  if (action.kind === 'calendar_event') {
    const start = action.start ? new Date(action.start) : null;
    const remindAt = start ? new Date(start.getTime() - VOICE_REMIND_BEFORE_MIN * 60_000) : null;
    const who = action.who.length > 0 ? action.who.join(', ') : null;
    const metaParts = [
      who,
      start && remindAt
        ? `напомню за ${VOICE_REMIND_BEFORE_MIN} минут, в ${formatClock(remindAt)}`
        : (delivery.kind === 'none' ? delivery.reason : null),
    ].filter(Boolean);
    return {
      id: action.id,
      kind: action.kind,
      kicker: 'СОБЫТИЕ В КАЛЕНДАРЕ',
      title: action.title,
      meta: metaParts.join(' · ') || (action.whenText ?? ''),
      whenBig: start ? formatClock(start) : '—',
      whenSmall: start ? formatDayShort(start) : (action.whenText ?? 'когда?'),
      whenChip: start ? `${formatDayShort(start)} · ${formatClock(start)}` : 'время не понял',
      delivery,
      runnable,
    };
  }

  const route = deliveryRoute(delivery, projects);
  const project = delivery.kind === 'new-session'
    ? projectName(projects, delivery.projectId)
    : delivery.kind === 'session' ? projectName(projects, delivery.projectId) : null;
  const isTask = action.kind === 'project_task';
  const kicker = isTask
    ? `ЗАДАЧА В ПРОЕКТ${project ? ` · ${project.toUpperCase()}` : ''}`
    : `СООБЩЕНИЕ В ДИАЛОГ${project ? ` · ${project.toUpperCase()}` : ''}`;
  return {
    id: action.id,
    kind: action.kind,
    kicker,
    title: action.summary,
    meta: delivery.kind === 'none' ? delivery.reason : clip(action.text || action.summary, 140),
    whenBig: runnable ? 'сразу' : '—',
    whenSmall: runnable ? route : 'кому?',
    whenChip: runnable ? route : 'кому?',
    delivery,
    runnable,
  };
}

/** Calendar type of the panel for the parser's event type. */
export function calendarTypeFor(eventType: Extract<VoiceIntentAction, { kind: 'calendar_event' }>['eventType']) {
  if (eventType === 'call') return 'call' as const;
  if (eventType === 'meeting') return 'meeting' as const;
  if (eventType === 'task') return 'agent_task' as const;
  if (eventType === 'reminder') return 'message' as const;
  return 'meeting' as const;
}

/** Text Claude receives for a task or a message: the parsed text, else the card title. */
export function messageTextFor(action: VoiceIntentAction): string {
  if (action.kind === 'calendar_event') return action.title;
  return (action.text || action.summary).trim();
}

/** Words of the phrase that the parse recognised (time phrase, names) — underlined in the transcript. */
export function markedWordIndexes(phrase: string, actions: VoiceIntentAction[]): Set<number> {
  const keys = new Set<string>();
  const normalize = (word: string) => word.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}:]/gu, '');
  for (const action of actions) {
    if (action.kind !== 'calendar_event') continue;
    for (const source of [action.whenText ?? '', ...action.who]) {
      source.split(/\s+/).map(normalize).filter((word) => word.length > 1 || /\d/.test(word)).forEach((word) => keys.add(word));
    }
  }
  const marked = new Set<number>();
  phrase.split(/\s+/).forEach((word, index) => {
    if (keys.has(normalize(word))) marked.add(index);
  });
  return marked;
}

/** «Уже распознал» chips (DarkVoice 01): КОГДА / ВРЕМЯ / ДЕЛО / ЗАДАЧА from the parsed actions. */
export function recognizedEntities(actions: VoiceIntentAction[]): Array<{ key: string; label: string; value: string }> {
  const entities: Array<{ key: string; label: string; value: string }> = [];
  const typeWord: Record<string, string> = { call: 'звонок', meeting: 'встреча', task: 'задача', reminder: 'напоминание', other: 'событие' };
  for (const action of actions) {
    if (action.kind === 'calendar_event') {
      if (action.start) {
        const start = new Date(action.start);
        const day = toPanelWall(start);
        entities.push({ key: `${action.id}-day`, label: 'КОГДА', value: `${WEEKDAY_SHORT[day.getDay()]} ${pad(day.getDate())}.${pad(day.getMonth() + 1)}` });
        entities.push({ key: `${action.id}-time`, label: 'ВРЕМЯ', value: formatClock(start) });
      } else if (action.whenText) {
        entities.push({ key: `${action.id}-when`, label: 'КОГДА', value: action.whenText });
      }
      const who = action.who.length > 0 ? ` · ${action.who.join(', ')}` : '';
      entities.push({ key: `${action.id}-what`, label: 'ДЕЛО', value: `${typeWord[action.eventType] ?? 'событие'}${who}` });
    } else {
      entities.push({ key: `${action.id}-task`, label: action.kind === 'project_task' ? 'ЗАДАЧА' : 'СООБЩЕНИЕ', value: clip(action.summary, 40) });
    }
  }
  return entities;
}

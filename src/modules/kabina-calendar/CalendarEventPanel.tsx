import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { IconButton, Modal, Segmented, kabinaChatPath, panelZoneLabel } from '@/modules/kabina';
import { ArrowIcon, CheckIcon, ClockIcon, MoreIcon, TelegramIcon, TrashIcon, TypeIcon } from '@/modules/kabina-calendar/CalendarIcons';
import { calendarTimeZone } from '@/modules/kabina-calendar/hooks/useCalendarEvents';
import {
  TYPE_LABELS,
  addDays,
  describeTimerZone,
  formatAgo,
  formatClock,
  formatCountdown,
  formatDayFull,
  formatRemind,
  isPersonType,
  isSameDay,
  phoneUrl,
  startOfDay,
  telegramUrl,
  toWall,
} from '@/modules/kabina-calendar/utils/calendarModel';
import { api, readApiJson } from '@/shared/api';
import type { CalendarItem, CalendarPrepareResult, KabinaProjectRef } from '@/shared/types';

type CalendarEventPanelProps = {
  item: CalendarItem | null;
  projects: KabinaProjectRef[];
  isNext: boolean;
  nowMs: number;
  googleEnabled: boolean;
  /** The Telegram bot has a linked chat: reminders go there («пришлю в Telegram»). */
  telegramLinked: boolean;
  /** A fresh copy of the item after an action. */
  onChanged: (item: CalendarItem) => void;
  /** Something changed that needs a refetch (an occurrence moved, an error). */
  onRefresh: () => void;
  /** The event (or its whole series; only this occurrence with `onlyThis`) was deleted: drop the selection and refetch. */
  onDeleted: (id: string, onlyThis: boolean) => void;
  onNavigate: (to: string) => void;
};

/** What «Перенести» and «Удалить» touch on one occurrence of a series. */
type OccurrenceScope = 'occurrence' | 'series';

const SCOPES: Array<{ value: OccurrenceScope; label: string }> = [
  { value: 'occurrence', label: 'Только это' },
  { value: 'series', label: 'Вся серия' },
];

type Row = { key: string; value: string; sub: string; contact?: { phone: string | null; telegram: string | null } };

const PREPARE_WHAT: Partial<Record<CalendarItem['type'], string>> = {
  call: 'план звонка',
  message: 'черновик сообщения',
  meeting: 'повестку и бриф',
};

const HINTS: Record<CalendarItem['type'], string> = {
  call: 'План звонка: цель, 3 вопроса, возражения и что предложить — по переписке и прошлым встречам.',
  message: 'Черновик сообщения в тоне вашей переписки — проверишь и отправишь сам.',
  meeting: 'Повестка и бриф: кто будет, что обещали, открытые вопросы по проекту.',
  agent_task: 'Сообщение уйдёт в проект само. До отправки текст можно поправить в диалоге.',
  server_schedule: 'Журнал запусков, длительность и ошибки. Живая служба не перезапускается.',
};

function shortPath(path: string | undefined): string {
  if (!path) return '—';
  const parts = path.split('/').filter(Boolean);
  return parts.length > 1 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : path;
}

/** The «Перенести» presets with the time each one lands on (DarkCalendar `moveOpts`). */
function moveOptions(item: CalendarItem): Array<{ preset: 'plus30m' | 'plus1h' | 'tomorrow'; label: string; to: string }> {
  const start = toWall(item.startsAt);
  const at = (date: Date) => `${formatDayFull(date)} · ${formatClock(date)}`;
  return [
    { preset: 'plus30m', label: 'На 30 минут позже', to: at(new Date(start.getTime() + 30 * 60_000)) },
    { preset: 'plus1h', label: 'На час позже', to: at(new Date(start.getTime() + 60 * 60_000)) },
    { preset: 'tomorrow', label: 'Завтра в это же время', to: at(addDays(start, 1)) },
  ];
}

function rowsFor(item: CalendarItem, projects: KabinaProjectRef[], googleEnabled: boolean, telegramLinked: boolean, nowMs: number): Row[] {
  const project = projects.find((entry) => entry.projectId === item.projectId);
  const projectRow: Row = {
    key: 'ПРОЕКТ',
    value: item.projectName ?? project?.displayName ?? 'Без проекта',
    sub: project ? shortPath(project.path) : '—',
  };
  const start = toWall(item.startsAt);
  // The bot sends the reminder of a planned panel event when a chat is linked (server: calendar reminders).
  const viaTelegram = telegramLinked && item.source === 'panel' && item.remindBeforeMin !== null && item.status === 'planned';
  const inGoogle = googleEnabled && isPersonType(item.type);
  const remindSub = item.source === 'google'
    ? 'напоминания — в Google Календаре'
    : viaTelegram
      ? `пришлю в Telegram ${formatRemind(item.remindBeforeMin)}${inGoogle ? ' · и в Google' : ''}`
      : inGoogle ? 'и в Google-календаре' : 'в панели';

  if (item.source === 'systemd' && item.server) {
    const lastAt = item.server.lastTriggerAt;
    // systemd reads the spec in the server's zone, the grid shows the panel zone (MIRAGE_TIMEZONE).
    const zone = describeTimerZone(item.server, panelZoneLabel());
    return [
      { key: 'РАСПИСАНИЕ', value: item.server.calendarSpec ?? 'по таймеру', sub: item.server.unit },
      ...(zone ? [{ key: 'ПОЯС', value: zone.value, sub: zone.note ?? 'время в спецификации — по поясу сервера' }] : []),
      { key: 'СЕРВЕР', value: window.location.hostname || 'сервер', sub: item.server.activates ?? item.server.unit },
      {
        key: 'ПОСЛЕДНИЙ',
        value: lastAt ? `${formatDayFull(toWall(lastAt))} ${formatClock(toWall(lastAt))}` : 'ещё не запускался',
        sub: item.server.lastResult === 'success' ? 'успешно' : item.server.lastResult ? `результат: ${item.server.lastResult}` : '—',
      },
      { key: 'ПРОЕКТ', value: '—', sub: 'служба сервера' },
    ];
  }

  if (item.type === 'agent_task') {
    const delivery = item.agent?.deliveryStatus;
    return [
      projectRow,
      {
        key: 'ДИАЛОГ',
        value: item.agent?.sessionTitle || (item.sessionId ? 'диалог проекта' : 'новый диалог'),
        sub: item.sessionId ? 'продолжит этот диалог' : 'откроется при отправке',
      },
      {
        key: 'ОТПРАВКА',
        value: `${formatDayFull(start)}, ${formatClock(start)}`,
        sub: delivery === 'sent' ? 'отправлено Claude'
          : delivery === 'failed' ? `не отправлено: ${item.agent?.failureReason ?? 'ошибка'}`
            : delivery === 'cancelled' ? 'отменено' : `Claude · ${formatCountdown(Date.parse(item.startsAt), nowMs) || 'ждёт своего часа'}`,
      },
      { key: 'СООБЩИТЬ', value: 'когда закончит', sub: 'панель' },
    ];
  }

  const who: Row = {
    key: 'КТО',
    value: item.contact?.name ?? 'не указано',
    sub: item.source === 'google' ? 'из Google Календаря' : item.contact?.name ? 'контакт события' : 'уточни в событии',
  };
  const remind: Row = { key: 'НАПОМНИТЬ', value: formatRemind(item.remindBeforeMin), sub: remindSub };
  if (item.type === 'meeting') {
    return [
      who,
      { key: 'ГДЕ', value: item.location ?? 'место не указано', sub: item.location ? 'адрес из события' : 'уточни в событии' },
      projectRow,
      remind,
    ];
  }
  const phone = item.contact?.phone ?? null;
  const telegram = item.contact?.telegram ?? null;
  return [
    who,
    {
      key: 'КОНТАКТ',
      value: phone ?? 'телефон не указан',
      sub: telegram ? `Telegram ${telegram.startsWith('@') ? telegram : `@${telegram.replace(/^.*t\.me\//, '')}`}` : 'Telegram не указан',
      contact: { phone, telegram },
    },
    projectRow,
    remind,
  ];
}

/** «03 / ВЫБРАНО» on the desktop and the phone sheet: everything about one event and what to do with it. */
export default function CalendarEventPanel({
  item, projects, isNext, nowMs, googleEnabled, telegramLinked, onChanged, onRefresh, onDeleted, onNavigate,
}: CalendarEventPanelProps) {
  // «Перенести» menu.
  const [isMoveOpen, setIsMoveOpen] = useState(false);
  // «Перенесено — …» after a move, for the moved event only.
  const [movedId, setMovedId] = useState<string | null>(null);
  // Project picker for «Поручить Claude подготовить» when the event has no project.
  const [isPickingProject, setIsPickingProject] = useState(false);
  // True while «prepare» is in flight.
  const [isPreparing, setIsPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // «Открыть журнал»: the timer's journal, or the reason it is unavailable.
  const [journal, setJournal] = useState<{ title: string; text: string } | null>(null);
  // «⋯» menu of the event (Перенести / Удалить).
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  // «Удалить событие?» confirmation, and the request in flight (which button, for a repeat).
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState<OccurrenceScope | null>(null);
  // «Перенести» on a repeat of a series: only this one or the whole series.
  const [moveScope, setMoveScope] = useState<OccurrenceScope>('occurrence');
  const menuRef = useRef<HTMLSpanElement>(null);

  // The «⋯» menu closes on a click outside it and on Esc.
  useEffect(() => {
    if (!isMenuOpen) return undefined;
    const handlePointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setIsMenuOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsMenuOpen(false);
    };
    document.addEventListener('pointerdown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('pointerdown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [isMenuOpen]);

  if (!item) {
    return <p className="kc-sel-empty">Выбери событие в сетке — здесь будут контакт, заметка и что Claude может подготовить заранее.</p>;
  }

  const start = toWall(item.startsAt);
  const end = toWall(item.endsAt);
  const done = item.status === 'done';
  const person = isPersonType(item.type);
  const isServer = item.type === 'server_schedule';
  const canMark = item.source === 'panel' || item.source === 'google';
  const canMove = item.source === 'panel';
  // Only the panel's own events are deleted here; Google's stay read-only, timers and messages live elsewhere.
  const canDelete = item.source === 'panel' && !item.readOnly;
  const isSeries = Boolean(item.recurrence || item.occurrenceOf);
  // A repeat of a series: «сделано» marks only it, «Перенести» / «Удалить» ask «Только это» or «Вся серия».
  const isOccurrence = Boolean(item.occurrenceOf);
  const movedFrom = item.originalStartsAt && item.originalStartsAt !== item.startsAt ? toWall(item.originalStartsAt) : null;
  const inGoogleToo = Boolean(item.google?.eventId) || (googleEnabled && isPersonType(item.type));
  const countdown = isNext && !done ? formatCountdown(Date.parse(item.startsAt), nowMs) : '';
  // An all-day event ends at the next midnight; its last day is the one before.
  const lastAllDay = addDays(end, -1);
  const when = isServer
    ? `${formatDayFull(start)} · ${formatClock(start)}${item.server?.calendarSpec ? ` · ${item.server.calendarSpec}` : ''}`
    : item.allDay
      ? isSameDay(lastAllDay, start) || lastAllDay < start
        ? `${formatDayFull(start)} · весь день`
        : `${formatDayFull(start)} — ${formatDayFull(lastAllDay)} · весь день`
      : !isSameDay(start, end) && end.getTime() > startOfDay(addDays(start, 1)).getTime()
        // Longer than its day: both ends with their dates.
        ? `${formatDayFull(start)} ${formatClock(start)} → ${formatDayFull(end)} ${formatClock(end)}${countdown ? ` · ${countdown}` : ''}`
        : `${formatDayFull(start)} · ${formatClock(start)}–${formatClock(end)}${countdown ? ` · ${countdown}` : ''}`;
  const movedNote = movedFrom
    ? ` · перенесено с ${isSameDay(movedFrom, start) ? formatClock(movedFrom) : `${formatDayFull(movedFrom)} ${formatClock(movedFrom)}`}`
    : '';
  const typeLabel = item.type === 'agent_task' && item.source === 'panel' ? 'Задача агента' : TYPE_LABELS[item.type].one;
  const note = item.type === 'agent_task' ? item.agent?.content ?? item.note : isServer ? item.server?.description ?? item.note : item.note;
  // «Поручить» prepares for the series. «Сделано», «Перенести» and «Удалить» send the occurrence
  // id (`<series>@<start>`): the server applies them to that repeat only, or to the series with
  // `scope: 'series'`.
  const actionId = item.occurrenceOf ?? item.id;

  const run = async (action: () => Promise<Response>, after?: (fresh: CalendarItem) => void) => {
    setError(null);
    try {
      const body = await readApiJson<{ data: CalendarItem }>(await action());
      // An occurrence keeps its id when only it moves, so the fresh copy replaces it in place.
      onChanged(body.data);
      after?.(body.data);
      onRefresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Не получилось');
    }
  };

  const prepare = async (projectId: string | null) => {
    setIsPreparing(true);
    setError(null);
    try {
      const body = await readApiJson<{ data: CalendarPrepareResult }>(
        await api.calendar.prepare(actionId, { tz: calendarTimeZone(), projectId }),
      );
      onChanged(body.data.event);
      onNavigate(body.data.sessionUrl);
    } catch (prepareError) {
      const code = (prepareError as { code?: string }).code;
      if (code === 'CALENDAR_PROJECT_REQUIRED') setIsPickingProject(true);
      else setError(prepareError instanceof Error ? prepareError.message : 'Не удалось поручить Claude');
    } finally {
      setIsPreparing(false);
    }
  };

  const remove = async (scope: OccurrenceScope) => {
    setIsDeleting(scope);
    setError(null);
    try {
      await readApiJson(await (isOccurrence ? api.calendar.remove(item.id, scope) : api.calendar.remove(item.id)));
      setIsConfirmingDelete(false);
      onDeleted(item.id, isOccurrence && scope === 'occurrence');
    } catch (deleteError) {
      setIsConfirmingDelete(false);
      setError(deleteError instanceof Error ? deleteError.message : 'Не удалось удалить событие');
    } finally {
      setIsDeleting(null);
    }
  };

  const openJournal = async () => {
    const unit = item.server?.unit;
    if (!unit) return;
    setJournal({ title: unit, text: 'Читаю журнал…' });
    try {
      const response = await fetchJournal(unit);
      setJournal({ title: `${response.service}`, text: response.lines.join('\n') || 'Журнал пуст.' });
    } catch (journalError) {
      setJournal({ title: unit, text: journalError instanceof Error ? journalError.message : 'Журнал недоступен.' });
    }
  };

  let primary: ReactNode;
  if (person) {
    const prepared = Boolean(item.preparedAt && item.sessionId && item.projectId);
    primary = prepared ? (
      <>
        <button type="button" className="kb-btn kb-out kc-primary" onClick={() => onNavigate(kabinaChatPath(item.projectId as string, item.sessionId))}>
          <ArrowIcon size={16} strokeWidth={1.7} />
          <span>Открыть подготовку</span>
        </button>
        <span className="kc-hint">Claude готовил {PREPARE_WHAT[item.type]} {formatAgo(item.preparedAt, nowMs)} — в диалоге проекта.</span>
      </>
    ) : (
      <>
        <button
          type="button"
          className="kb-btn kb-pri kc-primary"
          data-busy={isPreparing ? '' : undefined}
          aria-disabled={isPreparing}
          onClick={() => {
            if (!isPreparing) void prepare(null);
          }}
        >
          <TypeIcon type="agent_task" size={16} strokeWidth={1.7} />
          <span>{isPreparing ? `Claude готовит ${PREPARE_WHAT[item.type]}` : 'Поручить Claude подготовить'}</span>
        </button>
        {isPreparing ? (
          <div className="kc-preparing kb-fadein">
            <span className="kc-preparing-line"><span className="kb-led kb-led-run" style={{ width: 7, height: 7 }} />Открываю диалог проекта и ставлю задачу Claude…</span>
            <span className="kc-scanbar" aria-hidden="true"><span /></span>
          </div>
        ) : (
          <span className="kc-hint">{HINTS[item.type]}</span>
        )}
        {isPickingProject && (
          <div className="kc-menu kb-fadein" role="group" aria-label="В каком проекте готовить">
            {projects.slice(0, 8).map((project) => (
              <button key={project.projectId} type="button" className="kc-menu-item" onClick={() => void prepare(project.projectId)}>
                <span>{project.displayName}</span>
                <span className="kb-m kc-menu-to">{shortPath(project.path)}</span>
              </button>
            ))}
          </div>
        )}
      </>
    );
  } else if (item.type === 'agent_task') {
    const target = item.projectId ? kabinaChatPath(item.projectId, item.sessionId) : null;
    primary = (
      <>
        <button type="button" className="kb-btn kb-out kc-primary" aria-disabled={!target} onClick={() => target && onNavigate(target)}>
          <ArrowIcon size={16} strokeWidth={1.7} />
          <span>Открыть диалог</span>
        </button>
        <span className="kc-hint">{HINTS.agent_task}</span>
      </>
    );
  } else {
    primary = (
      <>
        <button type="button" className="kb-btn kb-out kc-primary" onClick={() => void openJournal()}>
          <ArrowIcon size={16} strokeWidth={1.7} />
          <span>Открыть журнал</span>
        </button>
        <span className="kc-hint">{HINTS.server_schedule}</span>
      </>
    );
  }

  return (
    <>
      <div className="kc-sel-top">
        <div className="kc-sel-head">
          <span className="kc-sel-icon" data-type={item.type}><TypeIcon type={item.type} size={16} /></span>
          <span className="kc-sel-kind">
            <span className="kc-sel-type">{typeLabel}{item.source === 'google' ? ' · из Google' : ''}</span>
            <span className="kb-m kc-sel-when" data-next={countdown ? '' : undefined}>{when}{movedNote}</span>
          </span>
          {done && <span className="kb-m kc-badge" data-tone="ok">СДЕЛАНО</span>}
          {item.status === 'no_answer' && (
            <span className="kb-m kc-badge" data-tone="warn"><span className="kc-badge-diamond" aria-hidden="true" />НЕТ ОТВЕТА</span>
          )}
          {canDelete && (
            <span className="kc-sel-more" ref={menuRef}>
              <IconButton
                size="sm"
                aria-label="Действия с событием"
                aria-haspopup="menu"
                aria-expanded={isMenuOpen}
                onClick={() => setIsMenuOpen((open) => !open)}
              >
                <MoreIcon size={16} />
              </IconButton>
              {isMenuOpen && (
                <span className="kc-menu kc-menu-pop kb-fadein" role="menu" aria-label="Действия с событием">
                  {canMove && (
                    <button
                      type="button"
                      role="menuitem"
                      className="kc-menu-item"
                      onClick={() => {
                        setIsMenuOpen(false);
                        setIsMoveOpen(true);
                        setMovedId(null);
                      }}
                    >
                      <span className="kc-menu-label"><ClockIcon size={14} strokeWidth={1.7} />Перенести…</span>
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    className="kc-menu-item"
                    data-danger=""
                    onClick={() => {
                      setIsMenuOpen(false);
                      setIsConfirmingDelete(true);
                    }}
                  >
                    <span className="kc-menu-label"><TrashIcon size={14} strokeWidth={1.7} />Удалить событие</span>
                  </button>
                </span>
              )}
            </span>
          )}
        </div>
        <h3 className="kc-sel-title" data-done={done ? '' : undefined}>{item.title}</h3>
      </div>

      <dl className="kc-rows">
        {rowsFor(item, projects, googleEnabled, telegramLinked, nowMs).map((row) => {
          const tel = phoneUrl(row.contact?.phone ?? null);
          const tg = telegramUrl(row.contact?.telegram ?? null);
          return (
            <div key={row.key}>
              <dt className="kb-m">{row.key}</dt>
              <dd>
                <span className="kc-row-v">{row.value}</span>
                <span className="kb-m kc-row-v2">{row.sub}</span>
              </dd>
              {row.contact && (tel || tg) && (
                // Only the ways that work: a missing phone does not squeeze the text with a dead button.
                <span className="kc-contact-actions">
                  {tel && (
                    <a className="kb-ib" href={tel} aria-label="Позвонить">
                      <TypeIcon type="call" size={14} />
                    </a>
                  )}
                  {tg && (
                    <a className="kb-ib" href={tg} target="_blank" rel="noreferrer" aria-label="Написать в Telegram">
                      <TelegramIcon size={14} />
                    </a>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </dl>

      <div className="kc-note">
        <span className="kb-m kc-note-label">{item.type === 'agent_task' ? 'СООБЩЕНИЕ CLAUDE' : isServer ? 'ЧТО ДЕЛАЕТ' : 'ЗАМЕТКА'}</span>
        <p className={`kc-note-text${item.type === 'agent_task' ? ' kb-m' : ''}`} data-mono={item.type === 'agent_task' ? '' : undefined}>
          {note || (isServer ? 'Описания у таймера нет.' : 'Заметки нет.')}
        </p>
      </div>

      <div className="kc-actions">{primary}</div>

      {(canMark || canMove) && (
        <div className="kc-pair">
          {canMark && (
            <button
              type="button"
              className="kb-btn kb-ghost"
              aria-pressed={done}
              onClick={() => void run(() => api.calendar.done(item.id, !done))}
            >
              <CheckIcon size={14} strokeWidth={1.7} />
              {done ? 'Вернуть в план' : 'Отметить сделанным'}
            </button>
          )}
          {canMove && (
            <button
              type="button"
              className="kb-btn kb-ghost"
              aria-expanded={isMoveOpen}
              onClick={() => {
                setIsMoveOpen((open) => !open);
                setMovedId(null);
              }}
            >
              <ClockIcon size={14} strokeWidth={1.7} />
              Перенести
            </button>
          )}
        </div>
      )}
      {!canMove && (
        <span className="kc-hint">
          {item.source === 'google'
            ? 'Событие из Google Календаря: время и название меняются там, здесь — только «сделано».'
            : item.source === 'systemd'
              ? 'Расписание сервера здесь только читается — меняется в таймере systemd.'
              : 'Время отложенного сообщения меняется в его диалоге.'}
        </span>
      )}

      {isMoveOpen && canMove && (
        <div className="kc-menu kb-fadein" role="group" aria-label="Перенести на">
          {isOccurrence && (
            <div className="kc-menu-scope">
              <Segmented size="sm" ariaLabel="Что перенести" options={SCOPES} value={moveScope} onChange={setMoveScope} />
              <span className="kb-m kc-menu-to">{moveScope === 'series' ? 'все повторы сдвинутся' : formatDayFull(start)}</span>
            </div>
          )}
          {moveOptions(item).map((option) => (
            <button
              key={option.preset}
              type="button"
              className="kc-menu-item"
              onClick={() => void run(() => api.calendar.reschedule(item.id, {
                preset: option.preset,
                ...(isOccurrence ? { scope: moveScope } : {}),
              }), () => {
                setIsMoveOpen(false);
                setMovedId(item.id);
              })}
            >
              <span>{option.label}</span>
              <span className="kb-m kc-menu-to">{option.to}</span>
            </button>
          ))}
        </div>
      )}
      {movedId === item.id && !isMoveOpen && (
        <span className="kc-note-ok kb-fadein">
          <CheckIcon size={14} strokeWidth={1.8} style={{ color: 'var(--kb-sage)' }} />
          {`${isOccurrence ? (moveScope === 'series' ? 'Серия перенесена' : 'Перенесён этот повтор') : 'Перенесено'}${googleEnabled && person ? ' — в Google обновится за минуту' : ''}`}
        </span>
      )}
      {canDelete && (
        <button type="button" className="kc-delete" onClick={() => setIsConfirmingDelete(true)}>
          <TrashIcon size={14} strokeWidth={1.6} />
          Удалить событие
        </button>
      )}
      {error && <span className="kc-error-line">{error}</span>}

      <Modal
        open={isConfirmingDelete}
        onClose={() => (isDeleting ? undefined : setIsConfirmingDelete(false))}
        title={isOccurrence ? 'Удалить повтор?' : 'Удалить событие?'}
        maxWidth={440}
        centered
        phone="fit"
        footer={(
          <div className="kc-confirm-actions" data-wide={isOccurrence ? '' : undefined}>
            <button type="button" className="kb-btn kb-ghost" disabled={isDeleting !== null} onClick={() => setIsConfirmingDelete(false)}>
              Оставить
            </button>
            {isOccurrence && (
              <button type="button" className="kb-btn kc-danger kc-danger-soft" disabled={isDeleting !== null} onClick={() => void remove('series')}>
                {isDeleting === 'series' ? 'Удаляю…' : 'Всю серию'}
              </button>
            )}
            <button
              type="button"
              className="kb-btn kc-danger"
              disabled={isDeleting !== null}
              onClick={() => void remove(isOccurrence ? 'occurrence' : 'series')}
            >
              <TrashIcon size={14} strokeWidth={1.7} />
              {isDeleting && isDeleting !== 'series' ? 'Удаляю…' : isOccurrence ? 'Только этот' : isSeries ? 'Удалить серию' : 'Удалить'}
            </button>
          </div>
        )}
      >
        <div className="kc-confirm">
          <p className="kc-confirm-title">«{item.title}»</p>
          <p className="kc-confirm-text">
            {isOccurrence
              ? `Повтор ${formatDayFull(start)} · ${formatClock(start)}. Удалить только его или всю серию?`
              : isSeries ? 'Удалится вся серия повторов, не только этот день.' : `${when}.`}
            {inGoogleToo ? ' Из Google Календаря событие тоже уйдёт — за минуту.' : ''}
            {' '}Вернуть нельзя.
          </p>
        </div>
      </Modal>

      <Modal open={journal !== null} onClose={() => setJournal(null)} title={`Журнал · ${journal?.title ?? ''}`} maxWidth={860}>
        <pre className="kb-m kc-journal">{journal?.text}</pre>
      </Modal>
    </>
  );
}

async function fetchJournal(unit: string): Promise<{ service: string; lines: string[] }> {
  const body = await readApiJson<{ data: { service: string; lines: string[] } }>(await api.calendar.timerJournal(unit));
  return body.data;
}

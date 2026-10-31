import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { NO_AUTOFILL, SectionRuler } from '@/modules/kabina';
import { CheckIcon, ChevronIcon, MicIcon, PlusIcon, TypeIcon } from '@/modules/kabina-calendar/CalendarIcons';
import { calendarTimeZone } from '@/modules/kabina-calendar/hooks/useCalendarEvents';
import {
  TYPE_LABELS,
  formatClock,
  formatDayFull,
  formatRemind,
  isPersonType,
  isSameDay,
  weekdayIn,
  toWall,
} from '@/modules/kabina-calendar/utils/calendarModel';
import { api, readApiJson } from '@/shared/api';
import type { CalendarEventType, CalendarItem, CalendarParseResult } from '@/shared/types';

type PickableType = Exclude<CalendarEventType, 'server_schedule'>;

/** Types the quick-add preview can switch between, with the short names of the tag. */
const PICKABLE: Array<{ type: PickableType; label: string }> = [
  { type: 'call', label: 'Звонок' },
  { type: 'message', label: 'Сообщение' },
  { type: 'meeting', label: 'Встреча' },
  { type: 'agent_task', label: 'Задача Claude' },
];

function shortTypeLabel(type: CalendarEventType): string {
  return PICKABLE.find((entry) => entry.type === type)?.label ?? TYPE_LABELS[type].one.split(' · ')[0];
}

/** The parsed draft with the type the user picked: a task for Claude has no reminder, people get one. */
function withType(result: CalendarParseResult, type: PickableType | null): CalendarParseResult {
  if (!type || !result.draft || result.draft.type === type) return result;
  const remindBeforeMin = type === 'agent_task' ? null : result.draft.remindBeforeMin ?? 15;
  return { ...result, draft: { ...result.draft, type, remindBeforeMin } };
}

/** The phrase is read this long after the last keystroke. */
const PARSE_DEBOUNCE_MS = 350;

type CalendarQuickAddProps = {
  /** Days on screen: says where the dashed draft is («пунктир в сетке во вторник»). */
  days: Date[];
  isPhone: boolean;
  googleEnabled: boolean;
  /** Reminders go to the linked Telegram chat («напомню за 15 мин · Telegram»). */
  telegramLinked: boolean;
  /** The draft to draw dashed in the grid, or null. */
  onDraft: (draft: CalendarItem | null) => void;
  /** A new event was saved: the screen selects it and refetches. */
  onAdded: (item: CalendarItem) => void;
  onVoice: () => void;
  /** Lets the grid's draft add the event (same as «Добавить»). */
  registerAdd: (add: () => void) => void;
};

function draftToItem(result: CalendarParseResult): CalendarItem | null {
  const draft = result.draft;
  if (!result.ok || !draft) return null;
  return {
    id: 'draft',
    source: 'panel',
    type: draft.type,
    title: draft.title,
    startsAt: draft.startsAt,
    endsAt: draft.endsAt,
    projectId: draft.projectId,
    projectName: draft.projectName,
    contact: draft.contact,
    location: null,
    note: draft.note,
    remindBeforeMin: draft.remindBeforeMin,
    status: 'planned',
    sessionId: null,
    recurrence: draft.recurrence,
    occurrenceOf: null,
    readOnly: false,
    preparedAt: null,
    allDay: false,
    google: null,
    agent: null,
    server: null,
  };
}

/** «Не нашёл ни дату, ни время — допиши…»: the parser's own reasons (whole phrases), capitalised. */
function notFoundLine(missing: string[]): string {
  const reason = missing.length ? missing.join(' · ') : 'не нашёл дату или время';
  return `${reason.charAt(0).toUpperCase()}${reason.slice(1)} — допиши, например «завтра в 11».`;
}

/** «01 / БЫСТРО ДОБАВИТЬ»: a phrase in, a recognised draft (preview + dashed in the grid), «Добавить». */
export default function CalendarQuickAdd({ days, isPhone, googleEnabled, telegramLinked, onDraft, onAdded, onVoice, registerAdd }: CalendarQuickAddProps) {
  // The phrase being typed.
  const [text, setText] = useState('');
  // The server's reading of `text`; null until it answers (or while the phrase is empty).
  const [parsed, setParsed] = useState<{ text: string; result: CalendarParseResult } | null>(null);
  // The last added event, for «Добавлено: …» until the next phrase.
  const [added, setAdded] = useState<CalendarItem | null>(null);
  // True while the event is being saved.
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The type picked in the preview over the parser's guess; reset with every new phrase.
  const [pickedType, setPickedType] = useState<PickableType | null>(null);
  // The type menu of the preview is open.
  const [isTypeMenuOpen, setIsTypeMenuOpen] = useState(false);
  const requestIdRef = useRef(0);
  const typeMenuRef = useRef<HTMLSpanElement>(null);

  const trimmed = text.trim();
  const current = useMemo(
    () => (parsed && parsed.text === trimmed ? withType(parsed.result, pickedType) : null),
    [parsed, trimmed, pickedType],
  );
  // The parser only guessed the type (no verb) and the user has not picked one: the tag says so.
  const typeGuessed = Boolean(current && !current.recognized.type && pickedType === null);

  useEffect(() => {
    if (!isTypeMenuOpen) return undefined;
    const handlePointer = (event: PointerEvent) => {
      if (!typeMenuRef.current?.contains(event.target as Node)) setIsTypeMenuOpen(false);
    };
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setIsTypeMenuOpen(false);
    };
    document.addEventListener('pointerdown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('pointerdown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [isTypeMenuOpen]);
  const draft = useMemo(() => (current ? draftToItem(current) : null), [current]);

  useEffect(() => {
    if (!trimmed) {
      return undefined;
    }
    const requestId = ++requestIdRef.current;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const body = await readApiJson<{ data: CalendarParseResult }>(await api.calendar.parse(trimmed, calendarTimeZone()));
          if (requestId === requestIdRef.current) setParsed({ text: trimmed, result: body.data });
        } catch {
          if (requestId === requestIdRef.current) setParsed(null);
        }
      })();
    }, PARSE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [trimmed]);

  useEffect(() => {
    onDraft(draft);
  }, [draft, onDraft]);

  const add = async () => {
    if (!trimmed || isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      // «Добавить» is live as soon as there is text: a phrase the parser has not answered yet is read now.
      let reading = current;
      if (!reading) {
        const body = await readApiJson<{ data: CalendarParseResult }>(await api.calendar.parse(trimmed, calendarTimeZone()));
        requestIdRef.current += 1;
        setParsed({ text: trimmed, result: body.data });
        reading = withType(body.data, pickedType);
      }
      if (!reading.ok || !reading.draft) {
        setError(notFoundLine(reading.missing));
        return;
      }
      const parsedDraft = reading.draft;
      const response = await api.calendar.create({
        type: parsedDraft.type,
        title: parsedDraft.title,
        startsAt: parsedDraft.startsAt,
        durationMin: parsedDraft.durationMin,
        projectId: parsedDraft.projectId,
        contact: parsedDraft.contact,
        remindBeforeMin: parsedDraft.remindBeforeMin,
        recurrence: parsedDraft.recurrence,
        note: parsedDraft.note,
      });
      const body = await readApiJson<{ data: CalendarItem }>(response);
      setAdded(body.data);
      setText('');
      setParsed(null);
      setPickedType(null);
      onAdded(body.data);
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : 'Не удалось добавить событие');
    } finally {
      setIsSaving(false);
    }
  };

  const addRef = useRef(add);
  useEffect(() => {
    addRef.current = add;
  });
  useEffect(() => {
    registerAdd(() => void addRef.current());
  }, [registerAdd]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void add();
    }
  };

  const canAdd = Boolean(trimmed) && !isSaving;
  let whereHint = '';
  if (draft) {
    const start = toWall(draft.startsAt);
    const inView = days.some((day) => isSameDay(day, start));
    whereHint = inView
      ? (days.length === 1 ? 'пунктир в сетке дня' : `пунктир в сетке ${weekdayIn(start)}`)
      : 'вне показанных дней';
  }
  const addedLine = added
    ? `${TYPE_LABELS[added.type].one.split(' · ')[0]} · ${formatDayFull(toWall(added.startsAt))} ${formatClock(toWall(added.startsAt))}${added.contact?.name ? ` · ${added.contact.name}` : ''}`
    : '';

  return (
    <section className="kc-qa-section kb-rise kb-d1" aria-labelledby="kc-h-qa">
      <SectionRuler id="kc-h-qa" index="01" title="БЫСТРО ДОБАВИТЬ">
        {!isPhone && <span className="kb-m kb-ruler-meta">↵ добавить · микрофон — надиктовать</span>}
      </SectionRuler>
      <div className="kc-qa kb-bz">
        <PlusIcon size={18} strokeWidth={1.7} style={{ flex: 'none', color: 'var(--kb-signal)' }} />
        <label htmlFor="kc-qa-input" className="kb-sr">Быстро добавить событие обычной фразой</label>
        <input
          {...NO_AUTOFILL}
          autoCorrect="off"
          autoCapitalize="sentences"
          id="kc-qa-input"
          className="kc-qa-input"
          type="text"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setAdded(null);
            setError(null);
            setPickedType(null);
            setIsTypeMenuOpen(false);
          }}
          onKeyDown={handleKeyDown}
          placeholder={isPhone ? 'Завтра в 11 позвонить…' : 'Например: «завтра в 11 созвон про сайт»'}
          spellCheck={false}
          enterKeyHint="done"
        />
        <button type="button" className="kb-ib kc-mic" aria-label="Надиктовать событие" onClick={onVoice}>
          <MicIcon size={18} strokeWidth={1.7} />
        </button>
        <button type="button" className="kb-btn kb-pri kc-add" aria-disabled={!canAdd} aria-label="Добавить" onClick={() => void add()}>
          <span className="kc-add-label">Добавить</span>
          <span className="kb-m kc-add-key" aria-hidden="true">↵</span>
        </button>
      </div>
      <div className="kc-preview" aria-live="polite">
        {error && <span className="kc-error-line">{error}</span>}
        {!error && draft && current?.draft && (
          <>
            <span className="kb-m kc-tag-label">РАСПОЗНАНО</span>
            <span className="kc-typepick" ref={typeMenuRef}>
              <button
                type="button"
                className="kc-tag kc-tag-type"
                data-type=""
                data-guess={typeGuessed ? '' : undefined}
                aria-haspopup="menu"
                aria-expanded={isTypeMenuOpen}
                aria-label={`Тип: ${shortTypeLabel(draft.type)}${typeGuessed ? ' (угадан)' : ''} — сменить`}
                onClick={() => setIsTypeMenuOpen((open) => !open)}
              >
                <TypeIcon type={draft.type} size={13} strokeWidth={1.7} />
                {shortTypeLabel(draft.type)}
                {typeGuessed && <span className="kb-m kc-tag-hint">угадал</span>}
                <ChevronIcon direction="right" size={12} strokeWidth={1.8} className="kc-tag-chev" />
              </button>
              {isTypeMenuOpen && (
                <span className="kc-menu kc-menu-pop kc-typepick-menu kb-fadein" role="menu" aria-label="Тип события">
                  {PICKABLE.map((entry) => (
                    <button
                      key={entry.type}
                      type="button"
                      role="menuitemradio"
                      aria-checked={draft.type === entry.type}
                      className="kc-menu-item"
                      onClick={() => {
                        setPickedType(entry.type);
                        setIsTypeMenuOpen(false);
                      }}
                    >
                      <span className="kc-menu-label"><TypeIcon type={entry.type} size={14} strokeWidth={1.7} />{entry.label}</span>
                      {draft.type === entry.type && <CheckIcon size={14} strokeWidth={1.8} style={{ color: 'var(--kb-signal)' }} />}
                    </button>
                  ))}
                </span>
              )}
            </span>
            <span className="kb-m kc-tag kc-tag-time" data-strong="">
              {formatDayFull(toWall(draft.startsAt))} · {formatClock(toWall(draft.startsAt))}
            </span>
            {isPersonType(draft.type) && (
              <span className="kc-tag" data-strong={draft.contact?.name ? '' : undefined} data-guess={draft.contact?.name ? undefined : ''}>
                {draft.contact?.name ?? 'кто — не указано'}
              </span>
            )}
            <span className="kc-tag">{draft.projectName ?? 'без проекта'}</span>
            <span className="kc-tag">{draft.remindBeforeMin !== null ? `напомню ${formatRemind(draft.remindBeforeMin)}${telegramLinked ? ' · Telegram' : ''}` : 'без напоминания'}</span>
            {draft.recurrence && <span className="kc-tag">повторяется</span>}
            <span className="kc-muted">— {whereHint}</span>
          </>
        )}
        {!error && !draft && trimmed && current && !current.ok && (
          <span className="kb-pretty">
            {notFoundLine(current.missing)}
          </span>
        )}
        {!error && !draft && trimmed && !current && (
          <span>Нажми «Добавить» — разберу тип, дату, время и человека.</span>
        )}
        {!error && !trimmed && !added && (
          <span className="kc-muted kb-pretty">
            Пиши как говоришь: «в пятницу в 10 встреча с [имя]», «каждый день в 9 Claude: сводка по Сайт клиента».
          </span>
        )}
        {!error && !trimmed && added && (
          <>
            <span className="kb-fadein" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--kb-text)' }}>
              <CheckIcon size={14} strokeWidth={1.8} style={{ color: 'var(--kb-sage)' }} />
              Добавлено: {addedLine}
            </span>
            <span className="kc-muted">
              {googleEnabled && isPersonType(added.type) ? '— уйдёт в Google в течение минуты' : '— только в панели, в Google не уходит'}
            </span>
          </>
        )}
      </div>
    </section>
  );
}

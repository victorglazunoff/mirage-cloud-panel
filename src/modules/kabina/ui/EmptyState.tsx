import type { ReactNode } from 'react';

import '@/modules/kabina/kabinaStates.css';
import { Button } from '@/modules/kabina/ui/Button';
import { CalendarIcon, PlusIcon } from '@/modules/kabina/ui/KabinaIcons';
import { StatusShape } from '@/modules/kabina/ui/StatusShape';

/** DarkStates 06: Z1 проекты, Z2 диалоги, Z3 календарь, Z4 агенты. */
type EmptyStateVariant = 'projects' | 'chats' | 'calendar' | 'agents';

const DEFAULTS: Record<EmptyStateVariant, { title: string; text: string; actionLabel: string; primary: boolean; hint: ReactNode }> = {
  projects: {
    title: 'Проектов пока нет',
    text: 'Проект — это папка на сервере. Claude работает только внутри неё и видит только её файлы.',
    actionLabel: 'Добавить проект',
    primary: true,
    hint: 'например ~/projects/demo-site',
  },
  chats: {
    title: 'В проекте ещё нет диалогов',
    text: 'Напиши задачу или скажи голосом — первый диалог начнётся сам, с CLAUDE.md проекта.',
    actionLabel: 'Новый диалог',
    primary: true,
    hint: <>или удерживай <span className="kb-keys">⌥ Пробел</span><span className="kb-touch-only">микрофон</span></>,
  },
  calendar: {
    title: 'На сегодня ничего',
    text: 'Скажи «завтра в 11 позвонить [имя]» — событие появится с напоминанием в Telegram.',
    actionLabel: 'Событие',
    primary: false,
    hint: '',
  },
  agents: {
    title: 'Все агенты отдыхают',
    text: 'Ни одного хода и фонового агента ни в одном проекте.',
    actionLabel: 'Запустить воркфлоу',
    primary: false,
    hint: 'сценарии — в разделе «Агенты»',
  },
};

function NewFolderGlyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 10.5v5M9.5 13h5" />
    </svg>
  );
}

function ChatGlyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M4 5h16v11H8l-4 4z" />
      <path d="M8 9.5h8M8 12.5h5" />
    </svg>
  );
}

function Glyph({ variant }: { variant: EmptyStateVariant }) {
  switch (variant) {
    case 'projects':
      return <NewFolderGlyph />;
    case 'chats':
      return <ChatGlyph />;
    case 'calendar':
      return <CalendarIcon size={28} strokeWidth={1.3} />;
    default:
      return (
        <span className="kb-empty-leds">
          <StatusShape kind="idle" />
          <StatusShape kind="idle" />
          <StatusShape kind="idle" />
          <StatusShape kind="idle" />
        </span>
      );
  }
}

type EmptyStateProps = {
  /** Which DarkStates empty state: picks the glyph and the default texts. */
  variant: EmptyStateVariant;
  /** Heading; defaults to the mock-up text of the variant. */
  title?: string;
  /** One or two sentences under the heading; defaults to the mock-up text. */
  text?: ReactNode;
  /** The single next step. Omit `onAction` to render no button. */
  actionLabel?: string;
  onAction?: () => void;
  /** Orange primary button (Z1, Z2) or outlined (Z3, Z4); defaults per variant. */
  primary?: boolean;
  /** Mono hint under the button («например ~/projects/demo-site»); `''` hides it. */
  hint?: ReactNode;
  /** Heading level inside the page outline; h3 by default. */
  headingLevel?: 'h2' | 'h3';
  /** Smaller padding for blocks inside a section (no 300px minimum height). */
  compact?: boolean;
  className?: string;
};

/**
 * Used by the home screen and the project list (and later chat, calendar,
 * agents): a DarkStates 06 empty state — dashed glyph box with corner marks,
 * heading, short text and always exactly one next step.
 */
export function EmptyState({
  variant,
  title,
  text,
  actionLabel,
  onAction,
  primary,
  hint,
  headingLevel = 'h3',
  compact = false,
  className,
}: EmptyStateProps) {
  const defaults = DEFAULTS[variant];
  const Heading = headingLevel;
  const hintText = hint ?? defaults.hint;
  const isPrimary = primary ?? defaults.primary;
  return (
    <div className={`kb-empty${className ? ` ${className}` : ''}`} data-variant={variant} data-compact={compact ? '' : undefined}>
      <div className="kb-empty-glyph kb-bz" aria-hidden="true">
        <Glyph variant={variant} />
      </div>
      <div className="kb-empty-copy">
        <Heading className="kb-empty-title">{title ?? defaults.title}</Heading>
        <p className="kb-empty-text">{text ?? defaults.text}</p>
      </div>
      {onAction && (
        <Button variant={isPrimary ? 'pri' : 'ghost'} className="kb-empty-action" onClick={onAction}>
          <PlusIcon size={14} strokeWidth={2} />
          {actionLabel ?? defaults.actionLabel}
        </Button>
      )}
      {hintText && <span className="kb-m kb-empty-hint">{hintText}</span>}
    </div>
  );
}

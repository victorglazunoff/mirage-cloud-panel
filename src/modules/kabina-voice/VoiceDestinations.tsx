import { useMemo, useState } from 'react';

import { NO_AUTOFILL } from '@/modules/kabina';
import type { VoiceContext, VoiceDestination } from '@/modules/kabina-voice/utils/voiceActionPlan';
import type { KabinaProjectRef } from '@/shared/types';

type VoiceDestinationsProps = {
  variant: 'desktop' | 'phone';
  destination: VoiceDestination;
  onPick: (destination: VoiceDestination) => void;
  context: VoiceContext;
  projects: KabinaProjectRef[];
  newProjectId: string | null;
  onPickProject: (projectId: string) => void;
};

type DestinationRow = { id: VoiceDestination; title: string; tag: string; tagMain: boolean; sub: string; disabled: boolean };

function projectNameOf(projects: KabinaProjectRef[], projectId: string | null): string | null {
  if (!projectId) return null;
  return projects.find((project) => project.projectId === projectId)?.displayName ?? null;
}

function buildRows(context: VoiceContext, projects: KabinaProjectRef[], newProjectId: string | null, phone: boolean): DestinationRow[] {
  const chatProject = projectNameOf(projects, context.projectId);
  const hasChat = Boolean(context.sessionId);
  const newProject = projectNameOf(projects, newProjectId);
  const chat: DestinationRow = {
    id: 'chat',
    title: 'Текущий диалог',
    tag: hasChat ? `${(chatProject ?? 'ЧАТ').toUpperCase()} · ПО УМОЛЧАНИЮ` : '',
    tagMain: false,
    sub: hasChat
      ? (phone ? 'открытый чат · вклиню в идущий ход' : 'открытый чат; уйдёт вклиниванием, ход не прервётся')
      : 'сейчас чат не открыт — открой диалог проекта',
    disabled: !hasChat,
  };
  const fresh: DestinationRow = {
    id: 'new',
    title: newProject ? `Новый диалог · ${newProject}` : 'Новый диалог в проекте…',
    tag: '',
    tagMain: false,
    sub: phone ? 'проект выберешь ниже' : 'проект выберешь ниже — из избранного или поиском',
    disabled: projects.length === 0,
  };
  const main: DestinationRow = {
    id: 'main',
    title: 'Главный ассистент',
    tag: hasChat ? '' : 'ПО УМОЛЧАНИЮ',
    tagMain: true,
    sub: phone ? 'сам разложит по проектам и календарю' : 'сам разложит по проектам и календарю, ответит сводкой',
    disabled: false,
  };
  // Phone lists the default first (DarkPhoneVoice); desktop keeps chat · new · main.
  if (phone) return hasChat ? [chat, main, fresh] : [main, chat, fresh];
  return [chat, fresh, main];
}

function DestIcon({ id }: { id: VoiceDestination }) {
  if (id === 'chat') {
    return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 5h16v11H8l-4 4z" /></svg>;
  }
  if (id === 'new') {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <path d="M12 10v6M9 13h6" />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="13" cy="13" r="10.5" />
      <path d="M2.5 15.2h21" />
      <path d="M8 11.2l5-3.8 5 3.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Starred projects first, then the rest; the filter matches name and path. */
function ProjectPicker({ projects, selected, onPick }: { projects: KabinaProjectRef[]; selected: string | null; onPick: (id: string) => void }) {
  // Text typed into the project filter.
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const sorted = [...projects].sort((a, b) => Number(b.isStarred) - Number(a.isStarred));
    const matched = needle
      ? sorted.filter((project) => project.displayName.toLowerCase().includes(needle) || project.path.toLowerCase().includes(needle))
      : sorted;
    return matched.slice(0, 12);
  }, [projects, query]);

  return (
    <div className="kb-vo-projects kb-fadein">
      <span className="kb-m kb-vo-kicker">ПРОЕКТ НОВОГО ДИАЛОГА</span>
      <input
        {...NO_AUTOFILL}
        autoCorrect="off"
        autoCapitalize="off"
        enterKeyHint="search"
        className="kb-vo-projfilter"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Найти проект"
        aria-label="Найти проект"
      />
      <div className="kb-vo-projlist" role="group" aria-label="Проекты">
        {visible.map((project) => (
          <button
            key={project.projectId}
            type="button"
            className="kb-vo-proj"
            aria-pressed={project.projectId === selected}
            onClick={() => onPick(project.projectId)}
          >
            {project.isStarred && <span aria-hidden="true" style={{ color: 'var(--kb-signal)' }}>★</span>}
            {project.displayName}
          </button>
        ))}
        {visible.length === 0 && <span className="kb-vo-note">ничего не нашёл</span>}
      </div>
    </div>
  );
}

/**
 * Used by both voice layouts for «Куда отправить» / «Кому отправить»: the open chat,
 * a new dialog in a project (with the project picker) or the main assistant, which
 * sorts each action by itself.
 */
export function VoiceDestinations({ variant, destination, onPick, context, projects, newProjectId, onPickProject }: VoiceDestinationsProps) {
  const rows = buildRows(context, projects, newProjectId, variant === 'phone');
  const picker = destination === 'new'
    ? <ProjectPicker projects={projects} selected={newProjectId} onPick={onPickProject} />
    : null;

  if (variant === 'phone') {
    return (
      <>
        <div className="kb-vo-ph-dests" role="radiogroup" aria-label="Кому отправить">
          {rows.map((row) => (
            <button
              key={row.id}
              className="kb-vo-ph-dest"
              type="button"
              role="radio"
              aria-checked={destination === row.id}
              disabled={row.disabled}
              onClick={() => onPick(row.id)}
            >
              <span className="kb-vo-ph-dest-main">
                <span className="kb-vo-ph-dest-name">
                  <span className="kb-vo-ph-dest-title">{row.title}</span>
                  {row.tag && <span className="kb-m kb-vo-dest-tag" data-main={row.tagMain ? '' : undefined} style={{ flex: 'none', fontSize: 9.5 }}>{row.tag}</span>}
                </span>
                <span className="kb-vo-ph-dest-sub">{row.sub}</span>
              </span>
              <span className="kb-vo-radio" aria-hidden="true"><i /></span>
            </button>
          ))}
        </div>
        {picker}
      </>
    );
  }

  return (
    <>
      <div className="kb-vo-dests" role="radiogroup" aria-label="Адресат команды">
        {rows.map((row, index) => (
          <button
            key={row.id}
            className={`kb-vo-dest kb-bz kb-rise kb-d${index + 1}`}
            type="button"
            role="radio"
            aria-checked={destination === row.id}
            disabled={row.disabled}
            onClick={() => onPick(row.id)}
          >
            <span className="kb-vo-dest-top">
              <span className="kb-vo-dest-ic" aria-hidden="true"><DestIcon id={row.id} /></span>
              <span className="kb-vo-radio" aria-hidden="true"><i /></span>
            </span>
            <span className="kb-vo-dest-text">
              <span className="kb-vo-dest-name">
                <span className="kb-vo-dest-title">{row.title}</span>
                {row.tag && <span className="kb-m kb-vo-dest-tag" data-main={row.tagMain ? '' : undefined}>{row.tag}</span>}
              </span>
              <span className="kb-vo-dest-sub">{row.sub}</span>
            </span>
          </button>
        ))}
      </div>
      {picker}
    </>
  );
}

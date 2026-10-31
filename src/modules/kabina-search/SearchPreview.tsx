import type { ReactNode } from 'react';

import { Skeleton, StatusShape } from '@/modules/kabina';
import SearchHighlight from '@/modules/kabina-search/SearchHighlight';
import type { ProjectLive } from '@/modules/kabina-search/hooks/useProjectLiveStates';
import type { LoadedPreview } from '@/modules/kabina-search/hooks/useSearchPreview';
import type { SearchOrigin } from '@/modules/kabina-search/hooks/useSearchRunner';
import { ACTION_INFO, fileDisplayPath, shortWhen, shortenHome } from '@/modules/kabina-search/utils/searchModel';
import type { SearchRow } from '@/modules/kabina-search/utils/searchModel';
import { pluralRu, splitMatch } from '@/shared/utils';
import type { CommandCatalogEntry } from '@/shared/types';

type SearchPreviewProps = {
  row: SearchRow | null;
  query: string;
  preview: LoadedPreview | null;
  isLoading: boolean;
  live: ProjectLive;
  catalogEntry: CommandCatalogEntry | null;
  origin: SearchOrigin;
  originProjectName: string | null;
  projectPath: string | null;
  onOpen: () => void;
  onAsk: () => void;
  onAskExample: (question: string) => void;
  onShowCommands: () => void;
  onFiles: (projectId: string) => void;
  onNewInProject: (projectId: string) => void;
  onMention: (relativePath: string) => void;
};

const EXECUTION_NOTES: Record<CommandCatalogEntry['execution'], string> = {
  sdk: 'Уйдёт Claude как обычная команда — как в терминале.',
  panel: 'Панель выполнит сама: откроет нужное окно или поменяет настройку.',
  custom: 'Своя команда из .claude/commands: панель развернёт её текст и отправит Claude.',
  skill: 'Навык: Claude загрузит его инструкции и выполнит в этом диалоге.',
};

function minutesSince(epochMs: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - epochMs) / 60_000));
  return minutes < 1 ? 'сейчас' : `${minutes} мин`;
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

function Kicker({ children }: { children: ReactNode }) {
  return <span className="kb-m kbs-kicker">{children}</span>;
}

function PreviewSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} aria-hidden="true">
      <Skeleton width="70%" />
      <Skeleton width="92%" />
      <Skeleton width="56%" />
      <Skeleton width="84%" />
    </div>
  );
}

function PrimaryButton({ label, keyHint, onClick }: { label: string; keyHint: string; onClick: () => void }) {
  return (
    <button type="button" className="kbs-primary" onClick={onClick}>
      {label}
      <span className="kb-m kbs-primary-key kb-keys" aria-hidden="true">{keyHint}</span>
    </button>
  );
}

/**
 * Right half of the ⌘K screen: what the selected row is and what Enter will do —
 * project status and recent dialogs, the dialog lines around the match, the file's code
 * with line numbers, what a command or action does, or the ask-Claude explanation.
 */
export default function SearchPreview(props: SearchPreviewProps) {
  const { row, query, preview, isLoading, live } = props;
  if (!row) return null;
  const item = row.item;

  let kicker = '';
  let title: ReactNode = null;
  let sub = '';
  let body: ReactNode = null;
  let actions: ReactNode = null;

  if (row.kind === 'project' && item) {
    const projectId = item.projectId ?? item.id;
    const state = live.states.get(projectId) ?? 'idle';
    const busy = live.activity.get(projectId);
    const project = preview?.kind === 'project' ? preview : null;
    const status = state === 'wait'
      ? `Ждёт разрешения · ${busy ? minutesSince(busy.startedAt) : 'сейчас'}`
      : state === 'run'
        ? `Агент работает · ${busy ? minutesSince(busy.startedAt) : 'сейчас'}`
        : `Тихо${project?.lastActivity ? ` · ${shortWhen(project.lastActivity)}` : ''}`;
    kicker = 'ПРОЕКТ';
    title = item.title;
    sub = shortenHome(item.path);
    body = (
      <div className="kb-fadein" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="kbs-pv-status"><StatusShape kind={state} />{status}</div>
        {project ? (
          <>
            <div className="kbs-spark" aria-hidden="true">
              {project.activityByDay.map((count, index) => {
                const hot = state !== 'idle' && index >= project.activityByDay.length - 3;
                const color = hot ? 'var(--kb-signal)' : count ? 'rgba(237,230,218,0.30)' : 'rgba(237,230,218,0.10)';
                return <span key={index} style={{ height: 3 + Math.min(count, 9) * 2.4, background: color }} />;
              })}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div className="kbs-fact"><span className="kbs-fact-k">Диалогов</span><span className="kb-m kbs-fact-v">{project.sessionTotal ?? '—'}</span></div>
              <div className="kbs-fact"><span className="kbs-fact-k">Ветка</span><span className="kb-m kbs-fact-v">{project.branch ?? 'без git'}</span></div>
              <div className="kbs-fact"><span className="kbs-fact-k">Последний диалог</span><span className="kb-m kbs-fact-v">{shortWhen(project.lastActivity) || '—'}</span></div>
            </div>
            {project.recent.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Kicker>ПОСЛЕДНИЕ ДИАЛОГИ</Kicker>
                {project.recent.map((recent, index) => (
                  <span key={index} className="kbs-recent">
                    <span className="kb-m kbs-recent-t">{shortWhen(recent.when)}</span>
                    <span className="kbs-recent-title">{recent.title}</span>
                  </span>
                ))}
              </div>
            )}
          </>
        ) : isLoading ? <PreviewSkeleton /> : null}
      </div>
    );
    actions = (
      <>
        <PrimaryButton label="Открыть проект" keyHint="↵" onClick={props.onOpen} />
        <button type="button" className="kbs-secondary" onClick={() => props.onFiles(projectId)}>Файлы проекта</button>
      </>
    );
  } else if (row.kind === 'session' && item) {
    const dialog = preview?.kind === 'session' ? preview : null;
    kicker = `ДИАЛОГ · ${(item.projectName ?? item.subtitle ?? 'БЕЗ ПРОЕКТА').toUpperCase()}`;
    title = item.title;
    // The dialog's one date (last activity, as in the row and the chat list); the quoted
    // lines carry only who said them, so no second date competes with it.
    sub = `${shortWhen(item.lastActivity ?? item.timestamp)} · фрагмент с совпадением`;
    const fallback = item.snippet
      ? [{ who: item.role === 'user' ? 'ТЫ' as const : 'CLAUDE' as const, time: null, text: item.snippet.text, isHit: true }]
      : [];
    const lines = dialog && dialog.lines.length ? dialog.lines : fallback;
    body = (
      <div className="kb-fadein" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="kbs-lines">
          {lines.map((line, index) => (
            <div key={index} className="kbs-line" data-hit={line.isHit ? '' : undefined}>
              <span className="kb-m kbs-line-who" data-claude={line.who === 'CLAUDE' ? '' : undefined}>
                {line.who}
              </span>
              <span className="kbs-line-text">
                {line.isHit ? <SearchHighlight parts={splitMatch(line.text, query)} /> : line.text}
              </span>
            </div>
          ))}
        </div>
        {dialog ? (
          <span className="kb-m kbs-hits">
            {dialog.hitCount} {pluralRu(dialog.hitCount, ['совпадение', 'совпадения', 'совпадений'])} в диалоге · {dialog.messageCount} {pluralRu(dialog.messageCount, ['сообщение', 'сообщения', 'сообщений'])}
          </span>
        ) : null}
      </div>
    );
    actions = (
      <>
        <PrimaryButton label="Открыть диалог" keyHint="↵" onClick={props.onOpen} />
        {item.projectId && (
          <button type="button" className="kbs-secondary" onClick={() => props.onNewInProject(item.projectId as string)}>Новый диалог в проекте</button>
        )}
      </>
    );
  } else if (row.kind === 'file' && item) {
    const file = preview?.kind === 'file' ? preview : null;
    const display = fileDisplayPath(item, props.projectPath);
    const relative = display.includes('/') ? display.slice(display.indexOf('/') + 1) : display;
    kicker = file ? `ФАЙЛ · ${fileSize(file.bytes)}` : 'ФАЙЛ';
    title = (item.path ?? item.title).split('/').pop();
    sub = shortenHome(item.path);
    body = file ? (
      <div className="kb-fadein kbs-code" aria-label="Начало файла">
        {file.lines.map((line, index) => {
          const parts = splitMatch(line, query);
          return (
            <div key={index} className="kb-m kbs-code-line" data-hit={parts.match ? '' : undefined}>
              <span className="kbs-code-n">{file.firstLine + index}</span>
              <span className="kbs-code-x"><SearchHighlight parts={parts} /></span>
            </div>
          );
        })}
      </div>
    ) : preview?.kind === 'file-binary' ? (
      <p className="kbs-what">Двоичный файл — превью нет. Открой его в файлах.</p>
    ) : isLoading ? <PreviewSkeleton /> : <p className="kbs-what">Не удалось прочитать файл.</p>;
    actions = (
      <>
        <PrimaryButton label="Открыть в файлах" keyHint="↵" onClick={props.onOpen} />
        <button type="button" className="kbs-secondary" onClick={() => props.onMention(relative)}>Упомянуть @ в чате</button>
      </>
    );
  } else if (row.kind === 'command' && item) {
    const entry = props.catalogEntry;
    const name = item.commandName ?? item.title;
    kicker = entry?.execution === 'skill' ? 'НАВЫК' : 'КОМАНДА';
    title = name;
    sub = item.subtitle ?? '';
    const where = props.origin.sessionId
      ? `Выполнится в диалоге${props.originProjectName ? ` ${props.originProjectName}` : ''} после текущего шага — ход не прервётся`
      : 'Встанет в поле ввода чата — останется отправить';
    body = (
      <div className="kb-fadein" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p className="kbs-what">{entry ? `${entry.description}. ${EXECUTION_NOTES[entry.execution]}` : item.subtitle}</p>
        <code className="kb-m kbs-example">{entry?.args ? `${name} ${entry.args}` : name}</code>
        {entry?.path && <span className="kb-m kbs-pv-sub">{shortenHome(entry.path)}</span>}
        <span className="kbs-ok"><i aria-hidden="true" />{where}</span>
      </div>
    );
    actions = (
      <>
        <PrimaryButton label="Выполнить" keyHint="↵" onClick={props.onOpen} />
        <button type="button" className="kbs-secondary" onClick={props.onShowCommands}>Все команды</button>
      </>
    );
  } else if (row.kind === 'action' && item) {
    const info = item.actionId ? ACTION_INFO[item.actionId] : undefined;
    kicker = 'ДЕЙСТВИЕ';
    title = item.title;
    sub = info?.note ?? '';
    body = (
      <div className="kb-fadein" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {info && <p className="kbs-what">{info.what}</p>}
        {info?.steps.map((step, index) => (
          <span key={index} className="kbs-step"><span className="kb-m kbs-step-n">{String(index + 1).padStart(2, '0')}</span>{step}</span>
        ))}
      </div>
    );
    actions = <PrimaryButton label="Выполнить" keyHint="↵" onClick={props.onOpen} />;
  } else {
    const trimmed = query.trim();
    const count = live.projectCount;
    const examples = [
      trimmed ? `Где мы обсуждали «${trimmed}» и что решили?` : 'Что я решил по ценам на прошлой неделе?',
      'Что осталось по проектам на этой неделе?',
      'Какие проекты давно не трогали?',
    ];
    kicker = 'ГЛАВНЫЙ АССИСТЕНТ';
    title = row.title.before;
    sub = 'ответ придёт в чат главного ассистента';
    body = (
      <div className="kb-fadein" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p className="kbs-what">
          Главный ассистент поищет по смыслу во всех {count ? `${count} ${pluralRu(count, ['проекте', 'проектах', 'проектах'])}` : 'проектах'}, диалогах и файлах и ответит сводкой со ссылками — даже если нужных слов там нет.
        </p>
        <Kicker>МОЖНО СПРОСИТЬ ТАК</Kicker>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {examples.map((example) => (
            <button key={example} type="button" className="kbs-askq" onClick={() => props.onAskExample(example)}>{example}</button>
          ))}
        </div>
      </div>
    );
    actions = <PrimaryButton label="Спросить" keyHint="⌘↵" onClick={props.onAsk} />;
  }

  // What the row is scrolls; what Enter does stays pinned to the bottom of the preview.
  return (
    <>
      <div className="kbs-pv-main">
        <div key={row.key} className="kb-fadein" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Kicker>{kicker}</Kicker>
          <h2 className="kb-t kbs-pv-title">{title}</h2>
          {sub && <span className="kb-m kbs-pv-sub">{sub}</span>}
        </div>
        {body}
      </div>
      <div className="kbs-actions">{actions}</div>
    </>
  );
}

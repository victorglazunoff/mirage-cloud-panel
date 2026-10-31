import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button, IconButton, kabinaChatPath, Modal, NO_AUTOFILL } from '@/modules/kabina';
import {
  ArrowGlyph,
  CheckGlyph,
  CrossGlyph,
  FolderGlyph,
  InfoGlyph,
  ShieldGlyph,
  StarGlyph,
  TerminalGlyph,
} from '@/modules/kabina-projects/ProjectsIcons';
import { formatLastActivity, shortProjectPath } from '@/modules/kabina-projects/utils/projectsBoardView';
import { api, readApiJson } from '@/shared/api';
import { useMirageSettingsView } from '@/shared/hooks/useMirageSettingsView';
import type { HomeFolderSummary, HomeProjectsBoard, ProjectPathCheck } from '@/shared/types';
import { pluralRu, tildePath } from '@/shared/utils';

/** Typing pauses this long before the folder is checked on the server. */
const CHECK_DEBOUNCE_MS = 250;
const MAX_SUGGESTIONS = 6;

/** The step row; `short` is the phone's one-line label. */
const WIZARD_STEPS = [
  { label: 'Папка', short: 'Папка' },
  { label: 'Имя и звезда', short: 'Имя ★' },
  { label: 'Создать', short: 'Создать' },
];

type CheckKind = 'hint' | 'err' | 'dup' | 'ok' | 'new' | 'pending';

/** What step 1 says about the typed folder (the message box under the field). */
type FolderCheck = {
  kind: CheckKind;
  title: string;
  text: string;
  resolvedPath?: string;
  folder?: HomeFolderSummary | null;
  existing?: ProjectPathCheck['existingProject'];
};

type WizardProps = {
  board: HomeProjectsBoard | null;
  onClose: () => void;
  /** Refetches the board and the workspace project list; awaited before «Готово». */
  onCreated: () => Promise<void>;
  /** «К списку»: closes and tells the screen to toast «… добавлен в панель». */
  onFinish: (name: string, starred: boolean) => void;
  onRestoreArchived: (projectId: string, name: string) => void;
};

function fileCountText(folder: HomeFolderSummary): string {
  const count = `${folder.fileCount}${folder.fileCountCapped ? '+' : ''}`;
  return `${count} ${pluralRu(folder.fileCount, ['файл', 'файла', 'файлов'])}`;
}

function gitText(folder: HomeFolderSummary | null | undefined, isNew: boolean): string {
  if (isNew) return 'нет — новая папка';
  if (!folder || !folder.isGit) return 'без git';
  return folder.gitBranch ? `git · ветка ${folder.gitBranch}` : 'git';
}

/** 'сегодня', 'вчера', '22.10' for the recent terminal folders. */
function dayWord(iso: string): string {
  const text = formatLastActivity(iso, Date.now());
  return text.startsWith('сегодня') || text.startsWith('вчера') ? text.split(' ')[0] : text;
}

const MESSAGE_TONE: Record<CheckKind, { bg: string; border: string; color: string }> = {
  err: { bg: 'rgba(255,106,43,0.08)', border: 'rgba(255,106,43,0.45)', color: 'var(--kb-signal-text)' },
  dup: { bg: 'rgba(255,106,43,0.08)', border: 'rgba(255,106,43,0.45)', color: 'var(--kb-signal-text)' },
  ok: { bg: 'rgba(156,196,154,0.07)', border: 'rgba(156,196,154,0.35)', color: 'var(--kb-sage)' },
  new: { bg: 'rgba(217,163,91,0.07)', border: 'rgba(217,163,91,0.35)', color: 'var(--kb-sand)' },
  hint: { bg: '#171613', border: 'rgba(255,236,210,0.1)', color: 'var(--kb-text)' },
  pending: { bg: '#171613', border: 'rgba(255,236,210,0.1)', color: 'var(--kb-soft)' },
};

/**
 * Used by the projects screen: the three-step «Новый проект» wizard of
 * DarkProjects — folder (checked live by `validate-path`, suggestions from the
 * projects folder and recent terminal folders), name and star with a tile
 * preview, then «Создать» through the authors' create-project API.
 */
export default function NewProjectWizard({ board, onClose, onCreated, onFinish, onRestoreArchived }: WizardProps) {
  const projectsFolder = board?.projectsFolder?.path ?? null;
  const folderName = projectsFolder?.split('/').filter(Boolean).pop() ?? null;
  // The server user's home (null until the settings view arrived): the hints name it instead of guessing.
  const homeDir = useMirageSettingsView()?.server?.homeDir ?? null;
  // Where the example paths live: the projects folder, else `projects` in the home.
  const exampleBase = projectsFolder ?? (homeDir ? `${homeDir.replace(/\/+$/, '')}/projects` : '~/projects');
  // 1 folder, 2 name and star, 3 summary, 4 done.
  const [step, setStep] = useState(1);
  // The folder as typed; starts inside the projects folder so a name is all that is missing.
  const [rawPath, setRawPath] = useState(projectsFolder ? `${projectsFolder}/` : '~/');
  // Null until the user types a name, so going back to step 1 and picking another folder renames the default.
  const [name, setName] = useState<string | null>(null);
  // Starred projects show on the home screen; the mock-up starts with the star on.
  const [starred, setStarred] = useState(true);
  // The server's verdict on the typed folder.
  const [check, setCheck] = useState<FolderCheck>({ kind: 'hint', title: 'Укажи папку', text: '' });
  // «Создать проект» is in flight; blocks double submits.
  const [isCreating, setIsCreating] = useState(false);
  // Why creating failed, shown under the summary.
  const [createError, setCreateError] = useState<string | null>(null);
  // The new project's id once created, for «Открыть чат».
  const [createdId, setCreatedId] = useState<string | null>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // The board is re-polled every 10 s; the folder check reads its folder list through a ref
  // so a poll does not re-run `validate-path` (and abort a check in flight) for an unchanged path.
  const unaddedRef = useRef(board?.projectsFolder?.unadded ?? []);
  unaddedRef.current = board?.projectsFolder?.unadded ?? [];

  // Live folder check: local rules first (empty, relative, the projects folder itself), then the server.
  useEffect(() => {
    // `~` is expanded by the server.
    const typed = rawPath.trim();
    const normalized = typed.replace(/\/+$/, '') || typed;
    if (!typed) {
      setCheck({ kind: 'hint', title: 'Укажи папку', text: `Начни с ${homeDir ? `${homeDir.replace(/\/+$/, '')}/` : '/'} или ~/${folderName ? ` — ниже подсказки из папки ${folderName}` : ''}.` });
      return undefined;
    }
    if (!typed.startsWith('/') && !typed.startsWith('~')) {
      setCheck({ kind: 'err', title: 'Путь начинается с / или ~', text: `Например: ${exampleBase}/новый-проект` });
      return undefined;
    }
    if (projectsFolder && normalized === projectsFolder) {
      setCheck({ kind: 'hint', title: `Выбери папку внутри ${folderName}/`, text: 'Допиши имя или нажми подсказку ниже. Если такой папки нет — создам её.' });
      return undefined;
    }

    const controller = new AbortController();
    // The verdict belongs to the previous path: drop it at once, so «Далее» or Enter in the
    // debounce window cannot carry the old folder into the next steps.
    setCheck((previous) => ({ kind: 'pending', title: previous.title, text: previous.text }));
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const body = await readApiJson<{ data: ProjectPathCheck }>(await api.projectPathCheck(typed, { signal: controller.signal }));
          const result = body.data;
          if (!result.valid || !result.resolvedPath) {
            setCheck({ kind: 'err', title: result.title ?? 'Папка не подходит', text: result.reason ?? '' });
            return;
          }
          if (result.existingProject) {
            const existing = result.existingProject;
            setCheck({
              kind: 'dup',
              title: `Уже в панели — «${existing.displayName}»${existing.isArchived ? ', в архиве' : ''}`,
              text: existing.isArchived
                ? 'Верни его из архива — история чатов сохранилась.'
                : 'Второй проект на ту же папку не нужен — просто открой этот.',
              resolvedPath: result.resolvedPath,
              existing,
            });
            return;
          }
          if (!result.exists) {
            setCheck({
              kind: 'new',
              title: 'Такой папки нет — создам пустую',
              text: 'Внутри будет только CLAUDE.md с именем проекта. Git можно включить позже.',
              resolvedPath: result.resolvedPath,
              folder: null,
            });
            return;
          }
          const known = unaddedRef.current.find((folder) => folder.path === result.resolvedPath) ?? null;
          const folder = known ?? (await readApiJson<{ data: HomeFolderSummary | null }>(
            await api.home.folderInfo(result.resolvedPath, { signal: controller.signal }),
          )).data;
          setCheck({
            kind: 'ok',
            title: 'Папка есть',
            text: folder ? `${fileCountText(folder)} · ${gitText(folder, false)}` : 'Папка на сервере есть.',
            resolvedPath: result.resolvedPath,
            folder,
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          setCheck({ kind: 'err', title: 'Не удалось проверить папку', text: error instanceof Error ? error.message : 'Сервер не ответил.' });
        }
      })();
    }, CHECK_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [exampleBase, folderName, homeDir, projectsFolder, rawPath]);

  // Folders of the projects folder that are not in the panel, matching what is typed after the folder.
  const suggestions = useMemo(() => {
    if (!projectsFolder || !board?.projectsFolder) return [];
    const typed = rawPath.trim();
    let fragment: string | null = null;
    if (typed.startsWith(`${projectsFolder}/`)) fragment = typed.slice(projectsFolder.length + 1).toLowerCase();
    else if (projectsFolder.startsWith(typed) && typed.length > 1) fragment = '';
    if (fragment === null || fragment.includes('/')) return [];
    return board.projectsFolder.unadded
      .filter((folder) => {
        const lower = folder.name.toLowerCase();
        return lower.startsWith(fragment as string) && lower !== fragment;
      })
      .slice(0, MAX_SUGGESTIONS);
  }, [board, projectsFolder, rawPath]);

  const canLeaveStep1 = check.kind === 'ok' || check.kind === 'new';
  const defaultName = check.resolvedPath?.split('/').filter(Boolean).pop() ?? '';
  const effectiveName = name ?? defaultName;
  const nameOk = Boolean(effectiveName.trim());
  const shortPath = check.resolvedPath ? shortProjectPath(check.resolvedPath, projectsFolder) : '';
  const isDone = step === 4;
  const nextDisabled = (step === 1 && !canLeaveStep1) || (step === 2 && !nameOk) || (step === 3 && isCreating);

  useEffect(() => {
    if (step === 1) pathInputRef.current?.focus();
    if (step === 2) nameInputRef.current?.focus();
  }, [step]);

  const create = async () => {
    if (!check.resolvedPath || isCreating) return;
    setIsCreating(true);
    setCreateError(null);
    const finalName = effectiveName.trim();
    try {
      const body = await readApiJson<{ project: { projectId: string } }>(
        await api.createProject({ path: check.resolvedPath, customName: finalName }),
      );
      const projectId = body.project.projectId;
      if (starred) await readApiJson(await api.toggleProjectStar(projectId));
      // A folder the wizard created gets a CLAUDE.md with the project's name (DarkProjects «создам пустую»).
      if (check.kind === 'new') {
        try {
          await api.saveFile(projectId, 'CLAUDE.md', `# ${finalName}\n`);
        } catch {
          // The project exists either way; a missing CLAUDE.md is not worth failing the wizard.
        }
      }
      await onCreated();
      setCreatedId(projectId);
      setStep(4);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Не удалось создать проект');
    } finally {
      setIsCreating(false);
    }
  };

  const next = () => {
    if (nextDisabled) return;
    if (step === 1) setStep(2);
    else if (step === 2) setStep(3);
    else if (step === 3) void create();
  };

  const back = () => {
    if (step <= 1) onClose();
    else setStep(step - 1);
  };

  const title = isDone ? 'Готово' : step === 1 ? 'Где лежит проект' : step === 2 ? 'Как его назвать' : 'Проверь и создай';
  const tone = MESSAGE_TONE[check.kind];
  const pathTone = check.kind === 'err' || check.kind === 'dup'
    ? 'rgba(255,106,43,0.7)'
    : check.kind === 'ok' ? 'rgba(156,196,154,0.5)' : 'rgba(255,236,210,0.14)';

  return (
    <Modal
      open
      onClose={onClose}
      title={`Мастер · новый проект · ${title}`}
      maxWidth={680}
      initialFocusRef={pathInputRef}
      // Computer: hung from a fixed top (where DarkProjects centres it on a 900px screen) — a suggestion
      // that changes the body's height grows the plate downward. Phone: a sheet over the visible area,
      // the title and the steps pinned on top, «Назад / Далее» pinned at the bottom (kabina.css).
      className="kp-wiz"
      header={(
        <>
          <div className="kp-wiz-head">
            <div className="kp-wiz-titles">
              <span className="kb-m kp-eyebrow">МАСТЕР · НОВЫЙ ПРОЕКТ</span>
              <h2 className="kb-t kp-wiz-title">{title}</h2>
            </div>
            <IconButton className="kp-ib" aria-label="Закрыть мастер" onClick={onClose} style={{ width: 40, height: 40, color: 'var(--kb-soft)' }}>
              <CrossGlyph size={15} />
            </IconButton>
          </div>
          <ol className="kp-steps" aria-label="Шаги">
            {WIZARD_STEPS.map((entry, index) => {
              const number = index + 1;
              const state = step > number ? 'done' : step === number ? 'now' : 'todo';
              return (
                <li key={entry.label} aria-current={state === 'now' ? 'step' : undefined} data-state={state}>
                  <span className="kp-step-bar" aria-hidden="true" />
                  <span className="kp-step-line">
                    <span className="kb-m kp-step-n">{`0${number}`}</span>
                    <span className="kp-step-label">
                      <span className="kp-step-full">{entry.label}</span>
                      {/* A phone keeps the three steps on one line: «Имя и звезда» → «Имя ★». */}
                      <span className="kp-step-short" aria-hidden="true">{entry.short}</span>
                    </span>
                    {state === 'done' && (
                      <span role="img" aria-label="готово" className="kp-step-done"><CheckGlyph size={13} strokeWidth={2} /></span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      )}
      footer={(
        <div className="kp-wiz-foot">
          <span className="kb-m kp-help">{isDone ? 'проект создан' : `шаг ${step} из 3`}</span>
          <div className="kb-spacer" />
          {!isDone && (
            <>
              <button type="button" className="kp-btn kp-ghost" data-tone="soft" onClick={back}>{step <= 1 ? 'Отмена' : 'Назад'}</button>
              <Button variant="pri" className="kp-next" onClick={next} aria-disabled={nextDisabled}>
                {step === 3 ? (isCreating ? 'Создаю…' : 'Создать проект') : 'Далее'}
                <ArrowGlyph />
              </Button>
            </>
          )}
          {isDone && (
            <>
              <button type="button" className="kp-btn kp-ghost" data-tone="soft" onClick={() => onFinish(effectiveName.trim(), starred)}>К списку</button>
              {createdId && (
                <Link className="kb-btn kb-pri kp-next" to={kabinaChatPath(createdId)}>
                  Открыть чат
                  <ArrowGlyph />
                </Link>
              )}
            </>
          )}
        </div>
      )}
    >
      <div className="kp-wiz-body">
        {step === 1 && (
          <>
            <div className="kp-fieldset">
              <label htmlFor="wiz-path" className="kp-label">Папка на сервере</label>
              <div className="kp-field" style={{ borderColor: pathTone }}>
                <FolderGlyph color="var(--kb-soft)" />
                <input
                  {...NO_AUTOFILL}
                  autoCorrect="off"
                  autoCapitalize="off"
                  enterKeyHint="next"
                  ref={pathInputRef}
                  id="wiz-path"
                  className="kb-m"
                  type="text"
                  value={rawPath}
                  onChange={(event) => setRawPath(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') next(); }}
                  aria-invalid={check.kind === 'err' || check.kind === 'dup'}
                  aria-describedby="wiz-path-msg"
                  spellCheck={false}
                  placeholder={`${exampleBase}/имя-папки`}
                  style={{ fontSize: 13 }}
                />
              </div>
              <span className="kb-m kp-help">Любая папка внутри {homeDir ?? 'домашней папки'} · ~ тоже понимаю · системные (/tmp, /etc, /usr…) — нельзя</span>
            </div>

            <div id="wiz-path-msg" aria-live="polite" className="kp-msg" style={{ background: tone.bg, borderColor: tone.border }}>
              {(check.kind === 'err' || check.kind === 'dup') && <span className="kp-msg-diamond" aria-hidden="true" />}
              {check.kind === 'ok' && <span style={{ marginTop: 2, display: 'inline-flex' }}><CheckGlyph strokeWidth={2} /></span>}
              {check.kind === 'new' && <span style={{ marginTop: 2, display: 'inline-flex' }}><FolderGlyph size={15} plus color="var(--kb-sand)" /></span>}
              {(check.kind === 'hint' || check.kind === 'pending') && <InfoGlyph />}
              <span className="kp-msg-text">
                <span className="kp-msg-title" style={{ color: tone.color }}>{check.kind === 'pending' ? 'Проверяю папку…' : check.title}</span>
                {check.text && check.kind !== 'pending' && <span className="kp-msg-body">{check.text}</span>}
              </span>
              {check.kind === 'dup' && check.existing && !check.existing.isArchived && (
                <Link className="kb-btn kb-ghost kp-msg-action" to={kabinaChatPath(check.existing.projectId)}>Открыть</Link>
              )}
              {check.kind === 'dup' && check.existing?.isArchived && (
                <button
                  type="button"
                  className="kb-btn kb-ghost kp-msg-action"
                  onClick={() => check.existing && onRestoreArchived(check.existing.projectId, check.existing.displayName)}
                >
                  Вернуть
                </button>
              )}
            </div>

            {suggestions.length > 0 && (
              <div className="kp-sugg-block">
                <span className="kb-m kp-mini-head">{`В ${(folderName ?? '').toUpperCase()}/ — ЕЩЁ НЕ В ПАНЕЛИ`}</span>
                <div className="kp-sugg-list">
                  {suggestions.map((folder) => (
                    <button key={folder.path} type="button" className="kp-sugg" onClick={() => setRawPath(folder.path)}>
                      <span className="kb-m kp-sugg-label">{folder.name}/</span>
                      <span className="kb-m kp-sugg-meta">
                        {`${folder.fileCount}${folder.fileCountCapped ? '+' : ''} · ${folder.isGit ? 'git' : 'без git'}`}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {board && board.terminalRecent.length > 0 && (
              <div className="kp-recent">
                <span className="kb-m kp-mini-head">НЕДАВНИЕ В ТЕРМИНАЛЕ</span>
                {board.terminalRecent.map((recent) => (
                  <button key={recent.path} type="button" className="kp-menu-item kp-recent-item" onClick={() => setRawPath(recent.path)}>
                    <TerminalGlyph />
                    <span className="kb-m kp-recent-label">{tildePath(recent.path)}</span>
                    <span className="kb-m kp-recent-when">{dayWord(recent.lastActivity)}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {step === 2 && (
          <div className="kp-step2">
            <div className="kp-step2-form">
              <div className="kp-fieldset">
                <label htmlFor="wiz-title" className="kp-label">Как назвать</label>
                <div className="kp-field" style={{ borderColor: nameOk ? 'rgba(255,236,210,0.14)' : 'rgba(255,106,43,0.6)' }}>
                  <input
                    {...NO_AUTOFILL}
                    autoCapitalize="sentences"
                    enterKeyHint="next"
                    ref={nameInputRef}
                    id="wiz-title"
                    type="text"
                    value={effectiveName}
                    onChange={(event) => setName(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') next(); }}
                    placeholder="Например: Сайт клиента · SEO"
                    style={{ fontSize: 15 }}
                  />
                </div>
                <span className="kb-m kp-help">Только для панели — папка не переименуется</span>
              </div>
              <button
                type="button"
                className="kp-wstar kp-ghost"
                aria-pressed={starred}
                onClick={() => setStarred((value) => !value)}
              >
                <StarGlyph size={18} filled={starred} color={starred ? 'var(--kb-signal)' : 'var(--kb-soft)'} />
                <span className="kp-wstar-text">
                  <span style={{ fontSize: 14 }}>{starred ? 'В избранном — будет на главном экране' : 'Добавить в избранное'}</span>
                  <span style={{ fontSize: 12, color: 'var(--kb-mute)' }}>звёздочку можно снять в любой момент</span>
                </span>
              </button>
            </div>
            <div className="kp-preview-col">
              <span className="kb-m kp-mini-head">{starred ? 'ТАК ПОЯВИТСЯ НА ГЛАВНОМ' : 'ТАК ПОЯВИТСЯ В СПИСКЕ'}</span>
              <div className="kp-preview kb-bz">
                <div className="kp-preview-top">
                  <span className="kp-preview-id">
                    <span className="kp-preview-name" style={{ color: nameOk ? 'var(--kb-text)' : 'var(--kb-mute)' }}>
                      {nameOk ? effectiveName : 'Без имени'}
                    </span>
                    <span className="kb-m kp-path">{shortPath}</span>
                  </span>
                  {starred && <span style={{ marginTop: 4, display: 'inline-flex' }}><StarGlyph size={14} filled color="#EDE6DA" opacity={0.72} /></span>}
                </div>
                <div className="kp-preview-spark" aria-hidden="true">
                  {Array.from({ length: 14 }, (_, index) => <span key={index} />)}
                </div>
                <div className="kp-preview-foot">
                  <span className="kb-led kp-led-new" aria-hidden="true" />Новый · чат не начат
                </div>
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <>
            <dl className="kp-summary-list">
              {[
                { k: 'ПАПКА', v: check.resolvedPath ?? '', mono: true, size: 12 },
                { k: 'ИМЯ', v: effectiveName.trim(), mono: false, size: 15 },
                { k: 'ИЗБРАННОЕ', v: starred ? 'да — плитка на главном экране' : 'нет — только в этом списке', mono: false, size: 14 },
                { k: 'GIT', v: gitText(check.folder, check.kind === 'new'), mono: true, size: 12 },
              ].map((row) => (
                <div key={row.k} className="kp-summary-row">
                  <dt className="kb-m">{row.k}</dt>
                  <dd className={row.mono ? 'kb-m' : undefined} style={{ fontSize: row.size }}>{row.v}</dd>
                </div>
              ))}
            </dl>
            <p className="kp-safe">
              <ShieldGlyph />
              <span>
                {check.kind === 'new'
                  ? 'Создам папку и положу в неё CLAUDE.md — больше ничего. Чатов и агентов пока нет.'
                  : 'Панель только запоминает папку: файлы, git и CLAUDE.md не трогает.'}
              </span>
            </p>
            {createError && <p className="kp-error" role="alert" style={{ margin: 0 }}>{createError}</p>}
          </>
        )}

        {isDone && (
          <div className="kp-done kb-fadein">
            <span className="kp-done-mark">
              <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true" style={{ position: 'absolute', inset: 0 }}>
                <circle cx="32" cy="32" r="30" fill="none" stroke="rgba(156,196,154,0.55)" strokeWidth="2" strokeDasharray="1 4.2" />
              </svg>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--kb-sage)" strokeWidth="2" aria-hidden="true">
                <path className="kp-draw" d="M5 12.5l4.5 4.5L19 7" />
              </svg>
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="kp-done-title">«{effectiveName.trim()}» в панели</span>
              <span className="kb-m kp-done-line">
                {`${shortPath} · ${starred ? 'в избранном' : 'без звезды'} · чат пока пуст`}
              </span>
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}

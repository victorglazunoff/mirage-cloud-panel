import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { Button, NO_AUTOFILL } from '@/modules/kabina';
import {
  ArchiveGlyph,
  ArrowGlyph,
  BigFileGlyph,
  BigFolderGlyph,
  BigLockGlyph,
  ChatGlyph,
  CopyGlyph,
  DownloadGlyph,
  PencilGlyph,
} from '@/modules/kabina-files/FilesIcons';
import {
  TEXT_PREVIEW_MAX_BYTES,
  extensionOf,
  extensionTag,
  formatBytes,
  formatCount,
  formatModified,
  linesWord,
  markdownBlocks,
  previewKindOf,
  tokenizeLine,
} from '@/modules/kabina-files/utils/fileKinds';
import type { PreviewKind } from '@/modules/kabina-files/utils/fileKinds';
import { readSheetPreview } from '@/modules/kabina-files/utils/xlsxPreview';
import type { SheetPreview } from '@/modules/kabina-files/utils/xlsxPreview';
import { filesErrorSentence } from '@/modules/kabina-files/utils/filesErrors';
import { api, readApiJson } from '@/shared/api';
import type { KabinaFileEntry } from '@/shared/types';
import { pluralRu } from '@/shared/utils';

/** Code previews show this many lines; the fade hides the cut. */
const CODE_PREVIEW_LINES = 40;
/** Lines shown above the one a `:line` link points at. */
const FOCUS_LINES_ABOVE = 8;

/** «~/a/b/c.txt» with a line-break opportunity after every «/»: a long path wraps between folders. */
function pathWithBreaks(path: string): ReactNode[] {
  return path.split('/').flatMap((part, index, parts) => (index < parts.length - 1 ? [part, '/', <wbr key={index} />] : [part]));
}

const ASK_PLACEHOLDER: Record<PreviewKind, string> = {
  md: 'Что поменялось со вчера?',
  code: 'Что делает этот файл?',
  img: 'Опиши, что на картинке',
  sheet: 'Где просела конверсия?',
  pdf: 'Выжимка в 5 пунктов',
  none: 'Спроси про этот файл',
  secret: 'Каких переменных не хватает? Значения Claude не покажет',
  folder: 'Что лежит в этой папке?',
};

type LoadedContent =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'text'; text: string }
  | { state: 'blob'; url: string; blob: Blob }
  | { state: 'sheet'; sheet: SheetPreview };

type FilePreviewProps = {
  entry: KabinaFileEntry | null;
  /** Project whose file API reads the file (any project can read under the workspace root). */
  readProjectId: string | null;
  /** The entry is inside the open project: rename and archive are allowed. */
  canEdit: boolean;
  isChanged: boolean;
  /** Objects in the tree's current folder, for «ПАПКА · N объектов» while nothing is picked; null until loaded. */
  folderCount: number | null;
  displayPath: string;
  nowMs: number;
  onOpenInChat: (question: string) => void;
  onRename: (newName: string) => Promise<void>;
  onArchive: () => void;
  /** The line a `path:line` link from the chat points at: the code preview opens around it. */
  focusLine?: number | null;
};

function useFileContent(entry: KabinaFileEntry | null, kind: PreviewKind, projectId: string | null): LoadedContent {
  // What the preview body shows: nothing yet, loading, the text, a blob or a parsed sheet.
  const [content, setContent] = useState<LoadedContent>({ state: 'idle' });

  useEffect(() => {
    if (!entry || !projectId || kind === 'folder' || kind === 'secret' || kind === 'none') {
      setContent({ state: 'idle' });
      return undefined;
    }
    if ((kind === 'md' || kind === 'code') && entry.size > TEXT_PREVIEW_MAX_BYTES) {
      setContent({ state: 'error', message: `Файл большой (${formatBytes(entry.size)}) — превью не грузю, открой в чате или скачай.` });
      return undefined;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setContent({ state: 'loading' });
    void (async () => {
      try {
        if (kind === 'md' || kind === 'code') {
          const body = await readApiJson<{ content: string }>(await api.readFile(projectId, entry.path));
          if (!controller.signal.aborted) setContent({ state: 'text', text: body.content });
          return;
        }
        const response = await api.readFileBlob(projectId, entry.path, { signal: controller.signal });
        if (!response.ok) throw new Error('Файл не открылся');
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        if (kind === 'sheet') {
          setContent({ state: 'sheet', sheet: await readSheetPreview(blob) });
          return;
        }
        objectUrl = URL.createObjectURL(kind === 'pdf' ? new Blob([blob], { type: 'application/pdf' }) : blob);
        setContent({ state: 'blob', url: objectUrl, blob });
      } catch (error) {
        if (!controller.signal.aborted) {
          setContent({ state: 'error', message: filesErrorSentence(error, 'Не удалось открыть файл') });
        }
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [entry, kind, projectId]);

  return content;
}

/** Pages of a PDF, counted from its `/Type /Page` objects (good enough for «стр. 1 из 12»). */
function usePdfPages(content: LoadedContent): number | null {
  // The counted page total, null until the blob is read.
  const [pages, setPages] = useState<number | null>(null);
  useEffect(() => {
    setPages(null);
    if (content.state !== 'blob') return undefined;
    let cancelled = false;
    void content.blob.slice(0, 20 * 1024 * 1024).text().then((text) => {
      if (cancelled) return;
      const count = (text.match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
      setPages(count || null);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [content]);
  return pages;
}

/**
 * Used by the files screen: the right column of DarkFiles — preview by type
 * (Markdown, code with highlighting, picture, spreadsheet, PDF; no preview
 * for secrets), facts, «Открыть в чате», «Скачать», «Спросить Claude про
 * файл», rename, copy path and «В архив».
 */
export default function FilePreview(props: FilePreviewProps) {
  const { entry } = props;
  const isDirectory = entry?.type === 'directory';
  const kind = entry ? previewKindOf(entry.name, Boolean(isDirectory)) : 'folder';
  const content = useFileContent(entry, kind, props.readProjectId);
  const pdfPages = usePdfPages(kind === 'pdf' ? content : { state: 'idle' });
  // The marked line of a `path:line` link, scrolled to once its text is on screen.
  const focusLineRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const line = focusLineRef.current;
    if (!props.focusLine || content.state !== 'text' || !line) return;
    // Only the preview's own scroll box moves, so the page (and its header) stays where it is.
    let box = line.parentElement;
    while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    if (box && box !== document.scrollingElement && box !== document.body) {
      box.scrollTop += line.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 2;
    }
  }, [content.state, entry?.path, props.focusLine]);
  // The picture's natural size, once it has loaded.
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  // The question typed into «Спросить Claude про файл».
  const [question, setQuestion] = useState('');
  // Inline rename of the selected entry, and the name being typed.
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  // «Путь скопирован» feedback; resets when another entry is picked.
  const [copied, setCopied] = useState(false);
  // Why «Скачать» failed (file gone, no access, no network); resets when another entry is picked.
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setImageSize(null);
    setQuestion('');
    setIsRenaming(false);
    setCopied(false);
    setDownloadError(null);
  }, [entry?.path]);

  useEffect(() => {
    if (isRenaming) renameRef.current?.select();
  }, [isRenaming]);

  const text = content.state === 'text' ? content.text : '';
  const lineCount = text ? text.split(/\r?\n/).length : 0;
  const extension = entry ? extensionOf(entry.name) : '';
  const tag = entry ? extensionTag(entry.name, Boolean(isDirectory)) : 'DIR';

  let label = tag;
  if (kind === 'md') label = `MARKDOWN${lineCount ? ` · ${linesWord(lineCount)}` : ''}`;
  else if (kind === 'code') label = `${tag} · КОД${lineCount ? ` · ${linesWord(lineCount)}` : ''}`;
  else if (kind === 'img') label = `${tag} · КАРТИНКА`;
  else if (kind === 'sheet') {
    const sheets = content.state === 'sheet' ? content.sheet.sheetNames.length : 0;
    label = sheets ? `XLSX · ${sheets} ${pluralRu(sheets, ['лист', 'листа', 'листов'])}` : 'XLSX';
  } else if (kind === 'pdf') label = pdfPages ? `PDF · ${pdfPages} стр.` : 'PDF';
  else if (kind === 'secret') label = 'ДОСТУПЫ · СКРЫТЫЙ';
  else if (kind === 'folder') {
    // Nothing picked: the preview speaks about the folder open in the tree.
    const count = entry ? entry.childCount ?? 0 : props.folderCount;
    label = count === null ? 'ПАПКА' : `ПАПКА · ${formatCount(count)} ${pluralRu(count, ['объект', 'объекта', 'объектов'])}`;
  }

  const download = async () => {
    if (!entry || !props.readProjectId || isDirectory) return;
    setDownloadError(null);
    let blob: Blob;
    try {
      if (content.state === 'blob') {
        blob = content.blob;
      } else {
        const response = await api.readFileBlob(props.readProjectId, entry.path);
        // An error answer must not be saved under the file's name.
        if (!response.ok) {
          setDownloadError(response.status === 404 ? 'Файла больше нет на сервере.' : `Сервер не отдал файл (${response.status}).`);
          return;
        }
        blob = await response.blob();
      }
    } catch {
      setDownloadError('Не скачалось: сервер не ответил.');
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = entry.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const copyPath = async () => {
    if (!entry) return;
    try {
      await navigator.clipboard.writeText(entry.path);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const saveRename = async () => {
    const value = renameValue.trim();
    if (!value || !entry || value === entry.name) {
      setIsRenaming(false);
      return;
    }
    await props.onRename(value);
    setIsRenaming(false);
  };

  const body = (() => {
    if (!entry || kind === 'folder' || kind === 'secret' || kind === 'none') {
      const tagText = kind === 'secret' ? 'БЕЗ ПРЕВЬЮ · СЕКРЕТЫ' : kind === 'folder' ? 'ПАПКА' : 'БЕЗ ПРЕВЬЮ';
      const message = kind === 'secret'
        ? 'Файл с доступами — содержимое не показываю, чтобы ключи не попали на экран и в скриншоты.'
        : kind === 'folder' ? 'Выбери файл в дереве — превью появится здесь.' : 'Для этого типа превью нет — открой в чате или скачай.';
      return (
        <div className="kf-none">
          {/* The lock is for secrets only; a folder or an unknown type gets its own sign. */}
          <span className="kf-none-icon" data-kind={kind}>
            {kind === 'secret' ? <BigLockGlyph /> : kind === 'folder' ? <BigFolderGlyph /> : <BigFileGlyph />}
          </span>
          <span className="kb-m kf-none-tag">{tagText}</span>
          <span className="kf-none-text">{message}</span>
        </div>
      );
    }
    if (content.state === 'loading' || content.state === 'idle') {
      return <div className="kf-none"><span className="kb-m kf-none-tag">ГРУЖУ…</span></div>;
    }
    if (content.state === 'error') {
      return (
        <div className="kf-none">
          <span className="kb-m kf-none-tag">НЕ ОТКРЫЛСЯ</span>
          <span className="kf-none-text">{content.message}</span>
        </div>
      );
    }
    if (kind === 'md' && content.state === 'text') {
      const blocks = markdownBlocks(content.text);
      return (
        <div className="kf-md">
          {blocks.length === 0 && <p>Пустой файл.</p>}
          {blocks.map((block, index) => {
            if (block.kind === 'h1') return <h3 key={index} className="kb-t">{block.text}</h3>;
            if (block.kind === 'h2') return <h4 key={index} className="kb-m">{block.text}</h4>;
            if (block.kind === 'li') return <div key={index} className="kf-md-li"><span className="kb-m" aria-hidden="true">—</span><span className="kb-pretty">{block.text}</span></div>;
            return <p key={index}>{block.text}</p>;
          })}
        </div>
      );
    }
    if (kind === 'code' && content.state === 'text') {
      const lines = content.text.split(/\r?\n/);
      // A `:line` link from the chat shows the window around that line, marked.
      const focusLine = props.focusLine && props.focusLine <= lines.length ? props.focusLine : null;
      const first = focusLine ? Math.max(0, Math.min(focusLine - 1 - FOCUS_LINES_ABOVE, lines.length - CODE_PREVIEW_LINES)) : 0;
      return (
        <div className="kb-m kf-code">
          {lines.slice(first, first + CODE_PREVIEW_LINES).map((line, offset) => {
            const index = first + offset;
            const isFocus = focusLine === index + 1;
            return (
            <div
              key={index}
              className="kf-code-line"
              data-focus={isFocus ? '' : undefined}
              ref={isFocus ? focusLineRef : undefined}
            >
              <span className="kf-code-no" aria-hidden="true">{index + 1}</span>
              <span className="kf-code-text">
                {line
                  ? tokenizeLine(line, extension).map((token, tokenIndex) => <span key={tokenIndex} className={`kf-tok-${token.kind}`}>{token.text}</span>)
                  : ' '}
              </span>
            </div>
            );
          })}
        </div>
      );
    }
    if (kind === 'img' && content.state === 'blob') {
      return (
        <div className="kf-img">
          <img
            src={content.url}
            alt={entry.name}
            onLoad={(event) => setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          />
          <span className="kb-m kf-pv-label">
            {imageSize ? `${tag} · ${imageSize.width} × ${imageSize.height}` : tag}
          </span>
        </div>
      );
    }
    if (kind === 'sheet' && content.state === 'sheet') {
      const { sheet } = content;
      const columns = sheet.rows[0]?.length ?? 1;
      return (
        <div className="kf-sheet">
          <div className="kb-m kf-sheet-tabs">
            {sheet.sheetNames.slice(0, 5).map((name, index) => (
              <span key={name || index} className="kf-sheet-tab" data-on={index === 0 ? '' : undefined}>{name}</span>
            ))}
          </div>
          <div className="kf-sheet-table" role="table" aria-label={`Лист «${sheet.sheetNames[0] ?? ''}»`}>
            {sheet.rows.slice(0, 6).map((row, rowIndex) => (
              <div key={rowIndex} className="kf-sheet-row" role="row" style={{ gridTemplateColumns: `1.6fr repeat(${Math.max(0, columns - 1)}, 1fr)` }}>
                {row.map((value, cellIndex) => <span key={cellIndex} role="cell">{value}</span>)}
              </div>
            ))}
          </div>
          <span className="kb-m kf-pv-label">
            {`лист «${sheet.sheetNames[0] ?? ''}» · 1 из ${sheet.sheetNames.length} · строк ${formatCount(sheet.totalRows)}`}
          </span>
        </div>
      );
    }
    if (kind === 'pdf' && content.state === 'blob') {
      return (
        <div className="kf-pdf">
          <div className="kf-pdf-page" aria-hidden="true">
            <iframe src={`${content.url}#toolbar=0&navpanes=0&view=Fit`} title={entry.name} tabIndex={-1} />
          </div>
          <div className="kf-pdf-text">
            <span style={{ fontSize: 14, fontWeight: 500, overflowWrap: 'anywhere' }}>{entry.name.replace(/\.pdf$/i, '')}</span>
            <span className="kb-m kf-pv-label">{pdfPages ? `стр. 1 из ${pdfPages}` : 'PDF'}</span>
            <span style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--kb-soft)' }} className="kb-pretty">Листать — в чате по кнопке ниже или скачай файл.</span>
          </div>
        </div>
      );
    }
    return null;
  })();

  const tagTone = kind === 'secret' || kind === 'folder' ? 'sand' : undefined;
  const meta = entry ? [
    { k: 'РАЗМЕР', v: isDirectory ? `${formatCount(entry.childCount ?? 0)} ${pluralRu(entry.childCount ?? 0, ['объект', 'объекта', 'объектов'])}` : formatBytes(entry.size), mono: true, size: 12, color: 'var(--kb-text)' },
    { k: 'ПУТЬ', v: props.displayPath, mono: true, size: 11.5, color: 'var(--kb-soft)' },
    { k: 'ИЗМЕНЁН', v: formatModified(entry.modified, props.nowMs), mono: false, size: 13, color: 'var(--kb-text)' },
    { k: 'GIT', v: props.isChanged ? 'изменён · не закоммичен' : 'без изменений', mono: false, size: 13, color: props.isChanged ? 'var(--kb-sand)' : 'var(--kb-mute)', dot: props.isChanged },
  ] : [];

  const askDisabled = !entry || !props.readProjectId;
  const sendQuestion = () => {
    if (askDisabled) return;
    props.onOpenInChat(question.trim());
  };

  return (
    <>
      <div className="kf-pv kb-bz">
        <div className="kf-pv-head">
          <span className="kb-m kf-pv-tag" data-tone={tagTone} aria-hidden="true">{tag}</span>
          <span className="kf-pv-title">
            {isRenaming ? (
              <span className="kf-pv-rename">
                <label htmlFor="kf-rename" className="kb-sr">Новое имя</label>
                <input
                  {...NO_AUTOFILL}
                  type="text"
                  autoCorrect="off"
                  autoCapitalize="off"
                  enterKeyHint="done"
                  ref={renameRef}
                  id="kf-rename"
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void saveRename();
                    if (event.key === 'Escape') {
                      event.stopPropagation();
                      setIsRenaming(false);
                    }
                  }}
                  spellCheck={false}
                />
                <Button variant="pri" onClick={() => void saveRename()}>Сохранить</Button>
              </span>
            ) : (
              <span className="kf-pv-name">{entry?.name ?? 'Ничего не выбрано'}</span>
            )}
            <span className="kb-m kf-pv-label">{label}</span>
          </span>
        </div>

        <div className="kf-pv-body">
          {body}
          <div className="kf-pv-fade" aria-hidden="true" />
        </div>

        {entry && (
          <dl className="kf-meta">
            {meta.map((row) => (
              <div key={row.k}>
                <dt className="kb-m">{row.k}</dt>
                <dd>
                  {row.dot && <span className="kf-git-dot" aria-hidden="true" />}
                  <span className={row.mono ? 'kb-m' : undefined} style={{ fontSize: row.size, color: row.color }}>
                    {row.k === 'ПУТЬ' ? pathWithBreaks(row.v) : row.v}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <div className="kf-actions">
        <Button variant="pri" disabled={askDisabled} onClick={() => props.onOpenInChat('')}>
          <ChatGlyph />Открыть в чате
        </Button>
        <Button variant="ghost" disabled={!entry || isDirectory || !props.readProjectId} onClick={() => void download()}>
          <DownloadGlyph />Скачать
        </Button>
        {downloadError && (
          <span className="kf-ask-note" role="alert" style={{ flexBasis: '100%', color: 'var(--kb-signal-text)' }}>{downloadError}</span>
        )}
      </div>

      <div className="kf-ask">
        <label htmlFor="ask-file" className="kb-m">СПРОСИТЬ CLAUDE ПРО ФАЙЛ</label>
        <div className="kf-ask-field">
          <input
            {...NO_AUTOFILL}
            autoCapitalize="sentences"
            enterKeyHint="send"
            id="ask-file"
            type="text"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && question.trim()) sendQuestion(); }}
            placeholder={ASK_PLACEHOLDER[kind]}
            disabled={askDisabled}
          />
          <button type="button" className="kf-send" aria-label="Отправить вопрос Claude" disabled={askDisabled || !question.trim()} onClick={sendQuestion}>
            <ArrowGlyph />
          </button>
        </div>
        <span className="kf-ask-note">Вопрос откроется в чате проекта, ссылка на файл уже вставлена — останется нажать «Отправить».</span>
      </div>

      <div className="kf-quiet-bar">
        <button
          type="button"
          className="kf-quiet"
          disabled={!entry || !props.canEdit}
          title={props.canEdit ? undefined : 'Переименовать можно только внутри открытого проекта'}
          onClick={() => {
            setRenameValue(entry?.name ?? '');
            setIsRenaming(true);
          }}
        >
          <PencilGlyph />Переименовать
        </button>
        <button type="button" className="kf-quiet" data-done={copied ? '' : undefined} disabled={!entry} onClick={() => void copyPath()}>
          <CopyGlyph />{copied ? 'Путь скопирован' : 'Копировать путь'}
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="kf-quiet"
          data-danger=""
          disabled={!entry || !props.canEdit}
          title={props.canEdit ? 'Переносит в ~/.claude/archive — вернуть можно в любой момент' : 'В архив можно убрать только то, что внутри открытого проекта'}
          onClick={props.onArchive}
        >
          <ArchiveGlyph size={14} />В архив
        </button>
      </div>
    </>
  );
}

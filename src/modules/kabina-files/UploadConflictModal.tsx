import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { Button, Modal, NO_AUTOFILL } from '@/modules/kabina';
import { extensionTag } from '@/modules/kabina-files/utils/fileKinds';
import type { KabinaUploadConflict } from '@/shared/types';
import { pluralRu } from '@/shared/utils';

/** Linux allows 255 bytes per name; a longer one fails on write, so it is caught here. */
const MAX_NAME_BYTES = 255;

/** «README (2).md» → the length of «README (2)», the part the user is most likely to change. */
function stemLength(name: string): number {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? dot : name.length;
}

/** Why `name` cannot be used, or null when it can. `taken` — names already in the folder or claimed by the upload. */
function nameProblem(name: string, taken: Set<string>): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Впиши имя';
  if (/[/\\\x00-\x1f]/.test(trimmed)) return 'Только имя файла — без / и \\';
  if (/^\.+$/.test(trimmed)) return 'Имя из одних точек нельзя';
  if (new TextEncoder().encode(trimmed).length > MAX_NAME_BYTES) return 'Слишком длинное имя';
  if (taken.has(trimmed)) return 'Это имя тоже занято';
  return null;
}

type UploadConflictModalProps = {
  /** The refused names; the window is open while there are any. */
  conflicts: KabinaUploadConflict[];
  /** Names the upload sends, by file index (the files without a conflict keep theirs). */
  uploadNames: string[];
  /** The folder's name for the text («proj»). */
  folderName: string;
  /** Names known to be in the folder (loaded pages and hidden names); the server checks again. */
  folderNames: string[];
  /** New names by file index. */
  onSubmit: (renames: Map<number, string>) => void;
  onCancel: () => void;
};

/**
 * Used by FilesScreen when the server refuses an upload because a name is taken: the old file
 * stays, the window offers the server's free name («README (2).md») — selected for editing —
 * and sends the upload again under the names given. Enter uploads, Esc cancels.
 */
export function UploadConflictModal({ conflicts, uploadNames, folderName, folderNames, onSubmit, onCancel }: UploadConflictModalProps) {
  const idPrefix = useId();
  const firstInputRef = useRef<HTMLInputElement>(null);
  // The names typed into the fields, one per conflict; start as the server's free names.
  const [names, setNames] = useState<string[]>(() => conflicts.map((conflict) => conflict.suggestedName));
  // Problems are shown once the user has tried to upload, or right away for a field they edited.
  const [shownProblems, setShownProblems] = useState<Set<number>>(() => new Set());

  // The field opens with the name without its extension selected: typing replaces «README (2)», «.md» stays.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const input = firstInputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(0, stemLength(input.value));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const conflictIndexes = new Set(conflicts.map((conflict) => conflict.index));
  // Taken for every field: what is in the folder, the refused names, and the names of the other files of the upload.
  const baseTaken = new Set<string>([
    ...folderNames,
    ...conflicts.map((conflict) => conflict.name),
    ...uploadNames.filter((_, index) => !conflictIndexes.has(index)),
  ]);
  const problems = names.map((name, row) => {
    const taken = new Set(baseTaken);
    names.forEach((other, otherRow) => {
      if (otherRow !== row) taken.add(other.trim());
    });
    return nameProblem(name, taken);
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const firstBad = problems.findIndex(Boolean);
    if (firstBad >= 0) {
      setShownProblems(new Set(problems.map((_, row) => row)));
      document.getElementById(`${idPrefix}-name-${firstBad}`)?.focus();
      return;
    }
    onSubmit(new Map(conflicts.map((conflict, row) => [conflict.index, names[row].trim()])));
  };

  const isSingle = conflicts.length === 1;
  const otherCount = uploadNames.length - conflicts.length;
  const formId = `${idPrefix}-form`;

  return (
    <Modal
      open
      onClose={onCancel}
      title={isSingle ? 'ФАЙЛ УЖЕ ЕСТЬ' : 'ФАЙЛЫ УЖЕ ЕСТЬ'}
      maxWidth={520}
      phone="fit"
      initialFocusRef={firstInputRef}
      footer={(
        <div className="kf-clash-actions">
          <Button variant="ghost" onClick={onCancel}>Отмена</Button>
          <Button variant="pri" type="submit" form={formId}>
            {isSingle ? 'Загрузить под этим именем' : 'Загрузить под этими именами'}
          </Button>
        </div>
      )}
    >
      <form id={formId} className="kf-clash" onSubmit={submit} noValidate>
        <p className="kf-clash-lead">
          {isSingle ? (
            <>Файл <span className="kf-clash-name">{conflicts[0].name}</span> уже есть в папке <span className="kf-clash-name">{folderName}/</span>.
              {' '}Старый не трогаю — новый загружу под другим именем.</>
          ) : (
            <>{conflicts.length} {pluralRu(conflicts.length, ['файл', 'файла', 'файлов'])} с такими именами уже есть в папке <span className="kf-clash-name">{folderName}/</span>.
              {' '}Старые не трогаю — новые загружу под другими именами.</>
          )}
        </p>
        <ul className="kf-clash-list">
          {conflicts.map((conflict, row) => {
            const inputId = `${idPrefix}-name-${row}`;
            const problemId = `${inputId}-problem`;
            const problem = shownProblems.has(row) ? problems[row] : null;
            return (
              <li key={conflict.index} className="kf-clash-row">
                <label className="kf-clash-label" htmlFor={inputId}>
                  {isSingle ? (
                    <span className="kb-label">НОВОЕ ИМЯ</span>
                  ) : (
                    <>
                      <span className="kb-m kf-ext-chip" aria-hidden="true">{extensionTag(conflict.name, false).slice(0, 4)}</span>
                      <span className="kf-clash-was">{conflict.name}</span>
                      <span className="kb-m kf-clash-arrow" aria-hidden="true">→</span>
                      <span className="kb-sr">новое имя</span>
                    </>
                  )}
                </label>
                <input
                  id={inputId}
                  ref={row === 0 ? firstInputRef : undefined}
                  className="kb-field kb-m kf-clash-input"
                  data-size="md"
                  type="text"
                  value={names[row]}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  enterKeyHint="done"
                  aria-invalid={problem ? true : undefined}
                  aria-describedby={problem ? problemId : undefined}
                  onChange={(event) => {
                    const value = event.target.value;
                    setNames((current) => current.map((name, index) => (index === row ? value : name)));
                    setShownProblems((current) => new Set(current).add(row));
                  }}
                  {...NO_AUTOFILL}
                />
                {problem && <p id={problemId} className="kf-clash-problem" role="alert">{problem}</p>}
              </li>
            );
          })}
        </ul>
        {otherCount > 0 && (
          <p className="kb-m kf-clash-note">
            {`ещё ${otherCount} ${pluralRu(otherCount, ['файл', 'файла', 'файлов'])} без совпадений ${otherCount === 1 ? 'загрузится' : 'загрузятся'} вместе с ${isSingle ? 'ним' : 'ними'}`}
          </p>
        )}
        <p className="kb-m kf-clash-note kf-clash-keys" aria-hidden="true">Enter — загрузить · Esc — отмена</p>
      </form>
    </Modal>
  );
}

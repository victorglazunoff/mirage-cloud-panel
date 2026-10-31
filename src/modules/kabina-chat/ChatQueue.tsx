import { useState } from 'react';
import type { DragEvent, PointerEvent as ReactPointerEvent } from 'react';

import { CheckIcon, CloseIcon, GripIcon, PencilIcon } from '@/modules/kabina-chat/ChatIcons';
import { NO_AUTOFILL } from '@/modules/kabina';

type ChatQueueProps = {
  items: string[];
  isPhone: boolean;
  onEdit: (index: number, text: string) => void;
  onRemove: (index: number) => void;
  onMove: (from: number, to: number) => void;
  /** Folds the list back into the status line's «очередь · N» chip. */
  onClose: () => void;
};

/**
 * Rendered by the chat status line above the composer, unfolded from its
 * «очередь · N» chip: «ОЧЕРЕДЬ · ПОСЛЕ ХОДА · N» — the follow-ups that leave
 * when the turn ends, in order. Rows can be edited in place, removed, and
 * dragged by the grip (mouse drag-and-drop, or a touch drag on the phone).
 */
export default function ChatQueue({ items, isPhone, onEdit, onRemove, onMove, onClose }: ChatQueueProps) {
  // Row being edited in place and its draft text.
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);
  // Row being dragged and the row it would land on.
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);

  const saveEdit = () => {
    if (editing) onEdit(editing.index, editing.text);
    setEditing(null);
  };

  const finishDrag = () => {
    if (drag && drag.from !== drag.over) onMove(drag.from, drag.over);
    setDrag(null);
  };

  // Touch / pen drag by the grip: find the row under the finger.
  const onGripPointerDown = (index: number) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse') return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({ from: index, over: index });
  };
  const onGripPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag || event.pointerType === 'mouse') return;
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-qindex]');
    const over = row ? Number(row.dataset.qindex) : drag.over;
    if (over !== drag.over) setDrag({ ...drag, over });
  };

  const count = items.length;

  return (
    <section aria-label="Очередь после хода" className="kbc-queue" data-phone={isPhone ? '' : undefined}>
      <div className="kbc-queue-head">
        <h2 className="kbc-queue-cap kb-m">ОЧЕРЕДЬ · ПОСЛЕ ХОДА · {count}</h2>
        {/* The phone header has no room for the note: the numbered rows say the order. */}
        {!isPhone && <span className="kbc-queue-note">уйдут по порядку, тяни за ручку</span>}
        <button type="button" className="kbc-ib kbc-queue-close" aria-label="Свернуть очередь" onClick={onClose}>
          <CloseIcon size={14} strokeWidth={1.7} />
        </button>
      </div>
      <div className="kbc-queue-list">
        {count === 0 && (
          <div className="kbc-qempty">Пусто. Сообщения «после хода» встанут сюда и уйдут, когда Claude закончит.</div>
        )}
        {items.map((text, index) => {
          const isEditing = editing?.index === index;
          return (
            <div
              key={`${index}-${text.slice(0, 24)}`}
              className="kbc-qrow"
              data-qindex={index}
              data-drop={drag && drag.over === index && drag.from !== index ? '' : undefined}
              draggable={!isEditing && !isPhone}
              onDragStart={(event: DragEvent<HTMLDivElement>) => {
                event.dataTransfer.effectAllowed = 'move';
                setDrag({ from: index, over: index });
              }}
              onDragOver={(event) => {
                if (!drag) return;
                event.preventDefault();
                if (drag.over !== index) setDrag({ ...drag, over: index });
              }}
              onDrop={(event) => {
                event.preventDefault();
                finishDrag();
              }}
              onDragEnd={() => setDrag(null)}
            >
              <button
                type="button"
                className="kbc-grip"
                aria-label="Перетащить, чтобы поменять порядок"
                title="Тяни, чтобы поменять порядок (или ↑ ↓)"
                onPointerDown={onGripPointerDown(index)}
                onPointerMove={onGripPointerMove}
                onPointerUp={finishDrag}
                onPointerCancel={() => setDrag(null)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    onMove(index, index + (event.key === 'ArrowUp' ? -1 : 1));
                  }
                }}
              >
                <GripIcon />
              </button>
              <span className="kbc-qn kb-m">{String(index + 1).padStart(2, '0')}</span>
              {isEditing ? (
                <>
                  <label htmlFor={`kbc-qe-${index}`} className="kb-sr">Править сообщение {index + 1}</label>
                  <input
                    id={`kbc-qe-${index}`}
                    className="kbc-qedit"
                    type="text"
                    {...NO_AUTOFILL}
                    autoCapitalize="sentences"
                    enterKeyHint="done"
                    autoFocus
                    value={editing.text}
                    onChange={(event) => setEditing({ index, text: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') saveEdit();
                      if (event.key === 'Escape') {
                        // Esc leaves the edit only; the list stays open.
                        event.stopPropagation();
                        setEditing(null);
                      }
                    }}
                  />
                </>
              ) : (
                <span
                  className="kbc-qtext"
                  title={text}
                  // The phone row has no pencil (DarkPhoneChat): a tap on the text edits it.
                  onClick={isPhone ? () => setEditing({ index, text }) : undefined}
                >
                  {text}
                </span>
              )}
              {(!isPhone || isEditing) && (
                <button
                  type="button"
                  className="kbc-ib"
                  aria-label={isEditing ? 'Сохранить правку' : 'Править сообщение'}
                  style={isEditing ? { color: 'var(--kb-signal)' } : undefined}
                  onClick={() => (isEditing ? saveEdit() : setEditing({ index, text }))}
                >
                  {isEditing ? <CheckIcon size={14} /> : <PencilIcon size={14} />}
                </button>
              )}
              <button type="button" className="kbc-ib" data-danger="" aria-label="Убрать из очереди" onClick={() => onRemove(index)}>
                <CloseIcon size={isPhone ? 15 : 14} strokeWidth={1.7} />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

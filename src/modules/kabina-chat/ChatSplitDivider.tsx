import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

import { ChevronLeft, ChevronRight } from '@/modules/kabina-chat/ChatIcons';

/** The feed's share of the chat when an artifact stands beside it, in percent. */
const SPLIT_MIN = 30;
const SPLIT_MAX = 70;
const SPLIT_DEFAULT = 50;
const SPLIT_STORAGE_KEY = 'kabina.chat.split.v1';
const KEY_STEP = 5;
const BUTTON_STEP = 10;

/** Keeps a share inside 30–70 % and whole (also used by the divider's tests). */
export function clampSplit(value: number): number {
  if (!Number.isFinite(value)) return SPLIT_DEFAULT;
  return Math.round(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value)));
}

function readStoredSplit(): number {
  try {
    const raw = window.localStorage.getItem(SPLIT_STORAGE_KEY);
    return raw === null ? SPLIT_DEFAULT : clampSplit(Number(raw));
  } catch {
    return SPLIT_DEFAULT;
  }
}

/**
 * Used by the kabina-chat screen: the feed's share beside an artifact, remembered in this
 * browser (the next artifact opens at the same split).
 */
export function useChatSplit(): [number, (next: number) => void] {
  // The feed's share in percent (30–70); starts from the remembered one.
  const [share, setShare] = useState(readStoredSplit);
  const update = useCallback((next: number) => setShare(clampSplit(next)), []);
  useEffect(() => {
    try {
      window.localStorage.setItem(SPLIT_STORAGE_KEY, String(share));
    } catch {
      // Private mode: the split simply is not remembered.
    }
  }, [share]);
  return [share, update];
}

type ChatSplitDividerProps = {
  /** The feed's share now, percent. */
  share: number;
  onChange: (share: number) => void;
  /** Dragging started / ended: the screen stops the artifact frame from eating the pointer. */
  onDragChange: (dragging: boolean) => void;
};

/**
 * Rendered by the kabina-chat screen between the feed and the artifact (ChatLayoutC «рядом»):
 * a real separator — drag it with a mouse or a finger, move it with ←/→ (Shift — by 10),
 * Home/End for the edges, Enter or a double click for 50/50; the arrows step by 10 %.
 */
export default function ChatSplitDivider({ share, onChange, onDragChange }: ChatSplitDividerProps) {
  const handleRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ left: number; width: number } | null>(null);
  // A drag is in progress (the handle lights up).
  const [isDragging, setIsDragging] = useState(false);

  const shareAt = (clientX: number) => {
    const box = dragRef.current;
    if (!box || box.width <= 0) return share;
    return ((clientX - box.left) / box.width) * 100;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // The row of feed | divider | artifact the share is measured against.
    const container = handleRef.current?.closest('.kbc-stage');
    if (!container) return;
    const rect = container.getBoundingClientRect();
    dragRef.current = { left: rect.left, width: rect.width };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    setIsDragging(true);
    onDragChange(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    onChange(shareAt(event.clientX));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setIsDragging(false);
    onDragChange(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? BUTTON_STEP : KEY_STEP;
    let next: number | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = share - step;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = share + step;
    else if (event.key === 'Home') next = SPLIT_MIN;
    else if (event.key === 'End') next = SPLIT_MAX;
    else if (event.key === 'Enter') next = SPLIT_DEFAULT;
    if (next === null) return;
    event.preventDefault();
    onChange(next);
  };

  const label = `${share}/${100 - share}`;

  return (
    <div className="kbc-split" data-dragging={isDragging ? '' : undefined}>
      <button
        type="button"
        className="kbc-split-step"
        aria-label="Шире лента"
        title="Шире лента"
        disabled={share >= SPLIT_MAX}
        onClick={() => onChange(share + BUTTON_STEP)}
      >
        <ChevronRight size={13} />
      </button>
      <div
        ref={handleRef}
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Граница ленты и артефакта"
        aria-valuemin={SPLIT_MIN}
        aria-valuemax={SPLIT_MAX}
        aria-valuenow={share}
        aria-valuetext={`лента ${share} %, артефакт ${100 - share} %`}
        className="kbc-split-handle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        onDoubleClick={() => onChange(SPLIT_DEFAULT)}
      >
        <span className="kbc-split-grip" aria-hidden="true" />
        <span className="kbc-split-share kb-m" aria-hidden="true">{label}</span>
      </div>
      <button
        type="button"
        className="kbc-split-step"
        aria-label="Шире артефакт"
        title="Шире артефакт"
        disabled={share <= SPLIT_MIN}
        onClick={() => onChange(share - BUTTON_STEP)}
      >
        <ChevronLeft size={13} />
      </button>
    </div>
  );
}

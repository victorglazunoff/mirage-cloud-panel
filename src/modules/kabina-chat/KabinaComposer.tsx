import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ChangeEvent, FormEvent, KeyboardEvent, RefObject } from 'react';

import type { useChatController } from '@/modules/chat';
import { BypassRootCard, Modal, NO_AUTOFILL, primeMicrophone, useKabinaVoiceControl, usePressOrHold } from '@/modules/kabina';
import { PREFIX_HINTS, SlashCommandMenu, SlashPrefixBar } from '@/modules/kabina-commands';
import type { ComposerPrefix } from '@/modules/kabina-commands';
import {
  ChevronDown,
  ClipIcon,
  CloseIcon,
  MicIcon,
  QueueLines,
  SteerArrow,
} from '@/modules/kabina-chat/ChatIcons';
import ChatStatusLine from '@/modules/kabina-chat/ChatStatusLine';
import type { QueueView, TurnView, TurnWork } from '@/modules/kabina-chat/ChatStatusLine';
import { rememberQueuedPart } from '@/modules/kabina-chat/hooks/useQueueItems';
import { useMirageSettingsView, useVoiceHotkey } from '@/shared/hooks/useMirageSettingsView';
import type { PermissionMode, SlashCommandPick } from '@/shared/types';
import { readQueuedMessage } from '@/shared/chatDrafts';
import { useEscapeLayer } from '@/shared/hooks/useEscapeLayer';

type ChatController = ReturnType<typeof useChatController>;

/** The four modes of the DarkChat «ПРАВА» segment, in the mock-up's order and words. */
const PERMISSION_SEGMENTS: Array<{ id: PermissionMode; label: string; hint: string }> = [
  { id: 'default', label: 'Default', hint: 'спрашивать перед правками и командами' },
  { id: 'auto', label: 'Auto', hint: 'рискованное решает классификатор и спрашивает тебя' },
  { id: 'plan', label: 'Plan', hint: 'только план, без правок' },
  { id: 'acceptEdits', label: 'Принимать правки', hint: 'правки без вопросов, команды — спрашивать' },
];
const BYPASS_SEGMENT = { id: 'bypassPermissions' as PermissionMode, label: 'Без вопросов', hint: 'всё без вопросов — осторожно' };

/**
 * The authors describe background work in the classic UI's language («Command npm test»);
 * the Kabina dialog is Russian, so an English kind word is translated here.
 */
export function russianWorkLabel(label: string): string {
  const match = /^(Command|Agent|Workflow)\s+(.+)$/s.exec(label);
  if (!match) return label;
  const [, kind, rest] = match;
  if (kind === 'Workflow') return `Воркфлоу «${rest}»`;
  return `${kind === 'Command' ? 'Команда' : 'Агент'}: ${rest}`;
}

/** «Opus 4.7 (1M)» → «Opus»: the short model name of the composer button. */
export function shortModelName(label: string | undefined, value: string, description?: string): string {
  const source = `${label || value} ${description ?? ''}`;
  const family = /(opus|sonnet|haiku|fable)/i.exec(source);
  if (family) return family[1][0].toUpperCase() + family[1].slice(1).toLowerCase();
  if (/^default/i.test(value) || /^default/i.test(label ?? '')) return 'По умолчанию';
  const name = label || value;
  return name.length > 18 ? `${name.slice(0, 17)}…` : name;
}

const fakeSubmit = () => ({ preventDefault: () => undefined }) as unknown as FormEvent<HTMLFormElement>;

type SlashRoom = { room: number; width: number; side: number } | null;

/**
 * Room for the «/» menu above the composer: up to the top of the chat screen, and across
 * the right column, where the command preview stands (DarkCommands: menu left, preview right).
 */
function useSlashRoom(isOpen: boolean, anchorRef: RefObject<HTMLDivElement>): SlashRoom {
  const [room, setRoom] = useState<SlashRoom>(null);
  useLayoutEffect(() => {
    if (!isOpen) return undefined;
    const measure = () => {
      const composer = anchorRef.current?.parentElement;
      const screen = composer?.closest('.kbc-screen, .kbc-phone') ?? null;
      if (!composer || !screen) return;
      const box = composer.getBoundingClientRect();
      const area = screen.getBoundingClientRect();
      const top = Math.max(area.top, 0);
      setRoom({
        room: Math.max(220, Math.round(box.top - top - 12)),
        width: Math.round(Math.min(area.right, window.innerWidth) - box.left),
        side: Math.round(Math.min(area.right, window.innerWidth) - box.right - 16),
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [anchorRef, isOpen]);
  return isOpen ? room : null;
}

/** Below this width of the composer's top row the mode hint and the word «effort» hide, so
 *  «ПРАВА», every mode and the model button stay on one row (Bypass under root included). */
const TIGHT_TOP_ROW_PX = 820;

/** Width of an element, followed with a ResizeObserver (0 until measured or where it is missing). */
function useElementWidth(ref: RefObject<HTMLElement>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setWidth(box.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

type KabinaComposerProps = {
  chat: ChatController;
  isPhone: boolean;
  /** Narrow composer (artifact open beside it): hints hide, as in the mock-up. */
  compact: boolean;
  projectId: string | null;
  /** Opens the voice overlay (`?voice`). */
  onVoice: () => void;
  /** Handles a «/» command the panel runs itself; returns false to fall back to inserting the text. */
  onPanelAction: (action: string, pick: SlashCommandPick) => boolean;
  /** Mono «ХОД 06:12 · ШАГ 27» data. */
  turn: TurnView;
  /** The «после хода» follow-ups: the status line's «очередь · N» chip and list. */
  queue: QueueView;
  /** Running subagents, for the phone's status line. */
  agentsCount: number;
  /** The turn's plan and background jobs (the status line's «план / фон» chip). */
  work?: TurnWork;
};

/**
 * The microphone of the phone composer (DarkPhoneChat). A tap opens voice recording
 * (tap the big mic there to stop); held, it records until the finger is lifted and then
 * sends — the floating button's semantics, through the shell (KabinaVoiceContext). The
 * microphone is requested inside the press, as iOS Safari requires.
 */
function PhoneComposerMic({ onVoice }: { onVoice: () => void }) {
  const voice = useKabinaVoiceControl();
  const press = usePressOrHold({
    onTap: voice?.press ?? onVoice,
    onHoldStart: voice?.holdStart,
    onHoldEnd: voice?.holdEnd,
    onPressStart: primeMicrophone,
  });
  return (
    <button type="button" className="kbc-pmic kb-press" aria-label="Сказать Claude голосом — нажми или удерживай кнопку" {...press}>
      <MicIcon size={19} strokeWidth={1.8} />
    </button>
  );
}

/**
 * Rendered by the kabina-chat screen: the DarkChat composer — permission
 * segment, model / effort, the message box, attachments, voice, «сейчас |
 * после хода» and «Вклинить ⏎» — plus the one status line above it (turn,
 * hold-to-stop, «сейчас | после хода», the queue chip; nothing when idle). On
 * the phone it is one compact line (clip · field · mic · round send). Every
 * action goes through the authors' composer state, so steering, the queue and
 * stopping behave exactly as in the classic chat.
 */
export function KabinaComposer({ chat, isPhone, compact, projectId, onVoice, onPanelAction, turn, queue, agentsCount, work }: KabinaComposerProps) {
  const { composer, provider, session } = chat;
  const {
    input,
    setInput,
    textareaRef,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    handleInputFocusChange,
    handleSubmit,
    handleAbortSession,
    stopUnavailableReason,
    steerMode,
    setSteerMode,
    steerNotice,
    attachedFiles,
    setAttachedFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker,
    showFileDropdown,
    fileListTruncated,
    filteredFiles,
    selectedFileIndex,
    selectFile,
    showCommandMenu,
    resetCommandMenuState,
    backgroundSendPrompt,
    resolveBackgroundSendPrompt,
    editingAnchorId,
    cancelEditMessage,
  } = composer;
  const isProcessing = session.isProcessing;
  const canSteer = provider.provider === 'claude';
  const isNow = steerMode === 'now' && canSteer;
  const { label: hotkeyLabel } = useVoiceHotkey();
  // The server runs as root, where Claude Code refuses Bypass (DarkStates E2).
  const runsAsRoot = useMirageSettingsView()?.server?.isRoot ?? false;

  // The «/» menu was closed with Esc for this token; reopens once the text no longer starts with it.
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  // Model / effort popover.
  const [isModelOpen, setIsModelOpen] = useState(false);
  // The button that toggles it: a press on it is the toggle's, not an outside press.
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  // The locked Bypass segment's explanation (DarkStates E2), opened in place.
  const [isBypassOpen, setIsBypassOpen] = useState(false);

  // The menu opens only from typing (or a prefix chip): a draft restored with «/» after a
  // reload or a session switch stays a plain line until the user touches it.
  const [isSlashTyped, setIsSlashTyped] = useState(false);
  // The command highlighted in the menu, for the «Tab → /команда» ghost in the input.
  const [slashSelected, setSlashSelected] = useState<string | null>(null);

  const slashAnchorRef = useRef<HTMLDivElement>(null);
  // Top row width: a narrow composer (the Context column or an artifact beside it) drops
  // the mode hint and «effort» instead of wrapping the model button onto a second row.
  const topRowRef = useRef<HTMLDivElement>(null);
  const topRowWidth = useElementWidth(topRowRef);
  const isTight = compact || (topRowWidth > 0 && topRowWidth < TIGHT_TOP_ROW_PX);

  const slashMatch = /^\/(\S*)$/.exec(input);
  const slashQuery = slashMatch ? slashMatch[1] : null;
  const isSlashOpen = slashQuery !== null && isSlashTyped && slashDismissed !== input;
  const slashRoom = useSlashRoom(isSlashOpen, slashAnchorRef);
  // Preview beside the menu only when the right column leaves it room; otherwise under it.
  const isSlashSideBySide = !isPhone && slashRoom !== null && slashRoom.side >= 280;
  const slashStyle = slashRoom
    ? ({
      '--kbc-slash-room': `${slashRoom.room}px`,
      '--kbc-slash-width': `${isSlashSideBySide ? slashRoom.width : slashRoom.width - Math.max(0, slashRoom.side + 16)}px`,
      '--kbc-slash-side': `${Math.max(0, slashRoom.side)}px`,
    } as CSSProperties)
    : undefined;

  // The authors' own command menu would catch Enter; the «/» slot replaces it.
  useEffect(() => {
    if (showCommandMenu) resetCommandMenuState();
  }, [resetCommandMenuState, showCommandMenu]);

  const sessionKey = chat.activeSessionId;

  useEffect(() => {
    setIsSlashTyped(false);
    setSlashDismissed(null);
  }, [sessionKey]);

  // A follow-up typed during a turn in "после хода" mode (or one that cannot
  // steer) goes to the queue: remember it as its own row of the queue list.
  const noteQueuedFollowUp = useCallback(() => {
    const text = input.trim();
    if (isProcessing && text && !(isNow && !text.startsWith('/'))) {
      rememberQueuedPart(sessionKey, text, sessionKey ? readQueuedMessage(sessionKey)?.content ?? null : null);
    }
  }, [input, isNow, isProcessing, sessionKey]);

  const submit = useCallback(() => {
    noteQueuedFollowUp();
    void handleSubmit(fakeSubmit());
  }, [handleSubmit, noteQueuedFollowUp]);

  // Enter is still the authors' handler (IME guard, file mentions, history,
  // Ctrl+Enter preference); this only notes a queued follow-up first.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !showFileDropdown && !event.nativeEvent.isComposing) {
      noteQueuedFollowUp();
    }
    handleKeyDown(event);
  };

  const focusInputEnd = useCallback((text: string) => {
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(text.length, text.length);
    });
  }, [textareaRef]);

  // «Дополнить» (Tab): the command goes into the input and the menu stays on it.
  const completeCommand = useCallback((text: string) => {
    setSlashDismissed(null);
    setIsSlashTyped(true);
    setInput(text);
    focusInputEnd(text);
  }, [focusInputEnd, setInput]);

  // A prefix chip: «/» starts a command, the others are put in front of the text.
  const pickPrefix = useCallback((prefix: ComposerPrefix) => {
    const rest = input.replace(/^[/@!#]\S*\s?/, '');
    const text = prefix === '/' ? '/' : `${prefix}${rest}`;
    setSlashDismissed(null);
    setIsSlashTyped(true);
    setInput(text);
    focusInputEnd(text);
  }, [focusInputEnd, input, setInput]);

  const pickCommand = useCallback((pick: SlashCommandPick) => {
    setSlashDismissed(null);
    if (pick.execution === 'panel' && pick.panelAction && onPanelAction(pick.panelAction, pick)) {
      setInput('');
      return;
    }
    setInput(pick.insertText);
    focusInputEnd(pick.insertText);
  }, [focusInputEnd, onPanelAction, setInput]);

  const modeSegments = useMemo(() => {
    const available = new Set(provider.availablePermissionModes as PermissionMode[]);
    const segments = PERMISSION_SEGMENTS.filter((segment) => available.has(segment.id));
    if (provider.permissionMode === 'bypassPermissions') segments.push(BYPASS_SEGMENT);
    return segments;
  }, [provider.availablePermissionModes, provider.permissionMode]);
  const modeHint = modeSegments.find((segment) => segment.id === provider.permissionMode)?.hint ?? '';

  const modelOption = provider.currentProviderModelOptions.find((option) => option.value === provider.currentProviderModel);
  const modelLabel = shortModelName(modelOption?.label, provider.currentProviderModel || 'модель', modelOption?.description);
  const effort = provider.currentProviderEffort;

  const sendLabel = !isProcessing ? 'Отправить' : isNow ? 'Вклинить' : 'В очередь';
  const sendHint = !isProcessing
    ? (isPhone ? 'начнёт новый ход' : 'Enter — отправить, Shift+Enter — новая строка')
    : isNow
      ? (isPhone ? 'уйдёт на ближайшем шаге' : 'уйдёт агенту на ближайшем шаге — ход не прерывается')
      : (isPhone ? 'уйдёт, когда ход закончится' : 'встанет в очередь и уйдёт, когда ход закончится');
  const placeholder = editingAnchorId
    ? (isPhone ? 'Правка сообщения' : 'Исправь сообщение — оно заменит отправленное')
    : isPhone
      // One line on the phone: short enough never to wrap.
      ? (!isProcessing ? 'Сообщение Claude' : isNow ? 'Вклинится в ход' : 'Уйдёт после хода')
      : !isProcessing
        ? 'Напиши Claude — «/» откроет команды'
        : isNow
          ? 'Напиши — сообщение вклинится в ход без остановки'
          : 'Напиши — отправится после хода';

  const canSend = Boolean(input.trim()) || attachedFiles.length > 0;
  const rootProps = getRootProps() as Record<string, unknown>;
  const inputProps = getInputProps() as Record<string, unknown>;

  const whenSegment = (
    <div className="kbc-seg" data-size="when" role="group" aria-label="Когда отправить">
      <button
        type="button"
        aria-pressed={isNow}
        disabled={!canSteer}
        title="уйдёт агенту на ближайшем шаге — ход не прерывается"
        onClick={() => setSteerMode('now')}
      >
        сейчас
      </button>
      <button
        type="button"
        aria-pressed={!isNow}
        title="встанет в очередь и уйдёт, когда ход закончится"
        onClick={() => setSteerMode('after')}
      >
        {isPhone ? 'после' : 'после хода'}
      </button>
    </div>
  );

  const textarea = (
    <div className="kbc-input-wrap">
      <label htmlFor="kbc-msg" className="kb-sr">Сообщение Claude</label>
      <textarea
        id="kbc-msg"
        ref={textareaRef}
        className="kbc-textarea"
        name="kbc-message"
        rows={isPhone ? 1 : 2}
        {...NO_AUTOFILL}
        autoCorrect="on"
        autoCapitalize="sentences"
        spellCheck
        inputMode="text"
        enterKeyHint="send"
        value={input}
        placeholder={placeholder}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
          const { value } = event.target;
          if (slashDismissed && !value.startsWith('/')) setSlashDismissed(null);
          setIsSlashTyped(/^\/\S*$/.test(value));
          handleInputChange(event);
        }}
        onKeyDown={onKeyDown}
        onPaste={handlePaste}
        onClick={handleTextareaClick}
        onInput={handleTextareaInput}
        onFocus={() => handleInputFocusChange(true)}
        onBlur={() => handleInputFocusChange(false)}
      />
      {isSlashOpen && slashSelected && !compact && !isPhone && (
        <span className="kbc-tab-ghost kb-m kb-keys" aria-hidden="true">
          Tab → <span>{slashSelected}</span>
        </span>
      )}
    </div>
  );

  const attachmentsRow = attachedFiles.length > 0 && (
    <div className="kbc-attachments">
      {attachedFiles.map((file, index) => {
        const error = fileErrors.get(file.name);
        return (
          <span key={`${file.name}-${index}`} className="kbc-attach kb-m" data-error={error ? '' : undefined} title={error ?? file.name}>
            <span>{file.name}</span>
            <button
              type="button"
              aria-label={`Убрать ${file.name}`}
              onClick={() => setAttachedFiles((previous) => previous.filter((_, current) => current !== index))}
            >
              <CloseIcon size={12} />
            </button>
          </span>
        );
      })}
    </div>
  );

  const popovers = (
    <>
      {isSlashOpen && (
        <div
          ref={slashAnchorRef}
          className="kbc-slashpop"
          data-layout={isSlashSideBySide ? 'side' : 'stack'}
          style={slashStyle}
        >
        <SlashCommandMenu
          query={slashQuery ?? ''}
          projectId={projectId}
          sessionId={sessionKey}
          onPick={pickCommand}
          onComplete={completeCommand}
          onSelectedChange={setSlashSelected}
          onClose={() => setSlashDismissed(input)}
        />
        </div>
      )}
      {showFileDropdown && filteredFiles.length > 0 && (
        <div className="kbc-mentions kb-pop" role="listbox" aria-label="Файлы проекта">
          <span className="kbc-pop-cap kb-m">ФАЙЛЫ<span className="kb-keys"> · ↑↓ ⏎</span></span>
          {filteredFiles.slice(0, 12).map((file, index) => (
            <button
              key={file.path}
              type="button"
              role="option"
              aria-selected={index === selectedFileIndex}
              data-active={index === selectedFileIndex ? '' : undefined}
              className="kbc-slash-row"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectFile(file)}
            >
              <span className="kbc-slash-name kb-m">{file.name}</span>
              <span className="kbc-slash-desc kb-m" style={{ fontSize: 11, color: 'var(--kb-mute)' }}>{file.path}</span>
            </button>
          ))}
          {fileListTruncated && (
            <span className="kbc-mentions-note" role="note">
              Проект большой — в списке не все файлы, глубокие папки срезаны. Нет нужного — впиши путь целиком.
            </span>
          )}
        </div>
      )}
    </>
  );

  const backgroundDialog = (
    <Modal
      open={backgroundSendPrompt !== null}
      onClose={() => resolveBackgroundSendPrompt('cancel')}
      title="В ФОНЕ ЕЩЁ ИДЁТ РАБОТА"
      maxWidth={520}
      phone="fit"
      footer={(
        <div className="kbc-actions kbc-bgwork-actions">
          <button type="button" className="kb-btn kb-ghost" onClick={() => resolveBackgroundSendPrompt('cancel')}>Отмена</button>
          <button type="button" className="kb-btn kb-pri" onClick={() => resolveBackgroundSendPrompt('queue')}>В очередь</button>
          <button type="button" className="kb-btn kb-out" onClick={() => resolveBackgroundSendPrompt('send')}>Всё равно отправить</button>
        </div>
      )}
    >
      <div className="kbc-bgwork">
        {backgroundSendPrompt && backgroundSendPrompt.work.length > 0 && (
          <ul className="kbc-bgwork-list kb-m">
            {backgroundSendPrompt.work.map((item, index) => <li key={`${index}-${item}`}>{russianWorkLabel(item)}</li>)}
          </ul>
        )}
        <p className="kbc-bgwork-text">
          Новое сообщение начнёт новый ход и остановит фоновую работу — всё, о чём она ещё не отчиталась, пропадёт.
          Поставь сообщение в очередь, чтобы оно ушло, когда работа закончится.
        </p>
      </div>
    </Modal>
  );

  const modelMenu = isModelOpen && (
    <ModelMenu
      chat={chat}
      toggleRef={modelButtonRef}
      onClose={() => setIsModelOpen(false)}
    />
  );

  const editingBar = editingAnchorId && (
    <div className="kbc-runbar" style={{ minHeight: 24 }}>
      <span className="kbc-notice">Правишь отправленное сообщение — оно и всё после него заменятся.</span>
      <button type="button" className="kbc-btn-sm" onClick={cancelEditMessage}>Отменить правку</button>
    </div>
  );

  const statusLine = (
    <ChatStatusLine
      isPhone={isPhone}
      compact={compact}
      turn={turn}
      queue={queue}
      onStop={handleAbortSession}
      stopUnavailable={stopUnavailableReason}
      when={whenSegment}
      notice={steerNotice}
      // One line has no room for «Esc ничего не обрывает»: the send hint already says the
      // turn goes on. A «/» typed during the turn still explains what a command does then.
      hint={isSlashOpen && !isPhone ? <span className="kbc-runbar-cmd">{PREFIX_HINTS['/']}</span> : null}
      agentsCount={agentsCount}
      clockInHud
      work={work}
    />
  );

  if (isPhone) {
    // One line: clip · field (1 line, grows to ~5) · mic · round send. The status line above
    // (turn, «Стоп» by hold, «сейчас | после», queue chip) shows only when there is something. Mode and model live in
    // the «Контекст» sheet — the feed keeps the height.
    return (
      <div className="kbc-pcomposer">
        {editingBar}
        {statusLine}
        <div className="kbc-composer" data-drag={isDragActive ? '' : undefined} {...rootProps}>
          <input {...inputProps} aria-hidden="true" tabIndex={-1} title="Прикрепить файл" />
          {popovers}
          {isSlashOpen && (
            <div className="kbc-ctop">
              <SlashPrefixBar value={input} onPick={pickPrefix} />
            </div>
          )}
          {attachmentsRow}
          <div className="kbc-pline">
            <button type="button" className="kbc-ib kbc-pclip" aria-label="Прикрепить файл" title="Прикрепить файл" onClick={openAttachmentPicker}>
              <ClipIcon size={18} />
            </button>
            {textarea}
            <PhoneComposerMic onVoice={onVoice} />
            <button
              type="button"
              className="kbc-send kbc-psend"
              onClick={submit}
              aria-disabled={!canSend}
              aria-label={`${sendLabel} — ${sendHint}`}
              title={sendLabel}
            >
              {isProcessing && !isNow ? <QueueLines size={18} /> : <SteerArrow size={18} />}
            </button>
          </div>
        </div>
        {backgroundDialog}
      </div>
    );
  }

  return (
    <>
      {editingBar}
      {statusLine}

      <div className="kbc-composer" data-drag={isDragActive ? '' : undefined} data-compact={compact ? '' : undefined} {...rootProps}>
        <input {...inputProps} aria-hidden="true" tabIndex={-1} title="Прикрепить файл" />
        {popovers}
        <div ref={topRowRef} className="kbc-ctop" data-row={isSlashOpen ? undefined : ''}>
          {isSlashOpen ? (
            <>
              <SlashPrefixBar value={input} onPick={pickPrefix} />
              <div style={{ flex: '1 1 0' }} />
            </>
          ) : (
            <>
              <span id="kbc-perm-label" className="kbc-cap kb-m">ПРАВА</span>
              <div className="kbc-seg" role="group" aria-labelledby="kbc-perm-label">
                {modeSegments.map((segment) => (
                  <button
                    key={segment.id}
                    type="button"
                    aria-pressed={segment.id === provider.permissionMode}
                    title={segment.hint}
                    onClick={() => provider.selectPermissionMode(segment.id)}
                  >
                    {segment.label}
                  </button>
                ))}
                {runsAsRoot && provider.provider === 'claude' && provider.permissionMode !== 'bypassPermissions' && (
                  <button
                    type="button"
                    className="kbc-seg-locked"
                    aria-disabled="true"
                    aria-expanded={isBypassOpen}
                    aria-label="Bypass недоступен под root — почему"
                    title="Bypass недоступен под root"
                    onClick={() => setIsBypassOpen((open) => !open)}
                  >
                    <LockGlyph />
                    <span>Bypass</span>
                  </button>
                )}
              </div>
              {isBypassOpen && (
                <BypassPopover mode={provider.permissionMode} onClose={() => setIsBypassOpen(false)} />
              )}
              {!isTight && <span className="kbc-hint kbc-mode-hint">{modeHint}</span>}
              <div style={{ flex: '1 1 0' }} />
            </>
          )}
          <button
            ref={modelButtonRef}
            type="button"
            className="kbc-model"
            aria-label="Модель и effort"
            aria-expanded={isModelOpen}
            onClick={() => setIsModelOpen((open) => !open)}
          >
            <span>{modelLabel}</span>
            {effort && (
              <span className="kb-m" style={{ fontSize: 10, color: 'var(--kb-mute)' }}>
                {isTight ? '' : 'effort '}{effort === 'default' ? 'авто' : effort}
              </span>
            )}
            <ChevronDown size={12} />
          </button>
          {modelMenu}
        </div>
        {attachmentsRow}
        {textarea}
        <div className="kbc-cbottom">
          <button type="button" className="kbc-ib" aria-label="Прикрепить файл" title="Прикрепить файл" onClick={openAttachmentPicker}>
            <ClipIcon size={17} />
          </button>
          <button type="button" className="kbc-ib" aria-label={`Надиктовать сообщение — или удерживай ${hotkeyLabel}`} onClick={onVoice}>
            <MicIcon size={17} />
          </button>
          {!compact && <span className={`kbc-hint kbc-send-hint${isProcessing ? '' : ' kb-keys'}`}>{sendHint}</span>}
          <div style={{ flex: '1 1 0' }} />
          <button type="button" className="kbc-send" onClick={submit} aria-disabled={!canSend}>
            <span>{sendLabel}</span>
            <span className="kbc-send-kbd kb-m kb-keys" aria-hidden="true">⏎</span>
          </button>
        </div>
      </div>
      {backgroundDialog}
    </>
  );
}

function LockGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

type BypassPopoverProps = {
  mode: string;
  onClose: () => void;
};

/** DarkStates E2 under the composer's «ПРАВА»: why Bypass is locked under root and how to unlock it. */
function BypassPopover({ mode, onClose }: BypassPopoverProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  // Esc closes it only when it is the newest layer.
  const isTopLayer = useEscapeLayer(true);
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (boxRef.current?.contains(target) || target?.closest('.kbc-seg-locked')) return;
      onClose();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && isTopLayer()) {
        event.preventDefault();
        onClose();
      }
    };
    const timer = window.setTimeout(() => document.addEventListener('pointerdown', onPointer), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [isTopLayer, onClose]);
  return (
    <div ref={boxRef} className="kbc-bypass-pop kb-pop" role="dialog" aria-label="Bypass недоступен под root">
      <BypassRootCard mode={mode} />
    </div>
  );
}

/** The Claude catalogue's English model names and descriptions, in the dialog's Russian. */
const MODEL_LABELS_RU: Record<string, string> = {
  'Default (recommended)': 'По умолчанию (рекомендуется)',
  'Best available': 'Лучшая доступная',
};
const MODEL_PHRASES_RU: Array<[RegExp, string]> = [
  [/^use the recommended model for your claude account.*$/i, 'рекомендованная для твоего аккаунта'],
  [/^use fable 5 when available, otherwise the latest opus model\.?$/i, 'Fable 5, если доступна, иначе свежий Opus'],
  [/^most capable claude model for the hardest, longest-running tasks\.?$/i, 'самая сильная — для сложных и долгих задач'],
  [/^latest sonnet model for everyday coding tasks\.?$/i, 'свежий Sonnet — код на каждый день'],
  [/^latest sonnet model with a 1m context window\.?$/i, 'свежий Sonnet, окно 1M'],
  [/^latest opus model for complex reasoning and coding tasks\.?$/i, 'свежий Opus — сложные рассуждения и код'],
  [/^latest opus model with a 1m context window\.?$/i, 'свежий Opus, окно 1M'],
  [/^fast and efficient claude model for simple tasks\.?$/i, 'быстрая и экономная — простые задачи'],
  [/^use opus while planning, then switch to sonnet for execution\.?$/i, 'план — Opus, исполнение — Sonnet'],
  [/^most capable.*$/i, 'самая сильная'],
  [/^best for everyday.*$/i, 'на каждый день'],
  [/^fastest.*$/i, 'самая быстрая'],
];

/** «Sonnet (1M context)» → «Sonnet (1M контекст)», «Default (recommended)» → «По умолчанию (рекомендуется)». */
export function russianModelLabel(label: string): string {
  return MODEL_LABELS_RU[label] ?? label.replace(/\(1M context\)/i, '(1M контекст)');
}

/**
 * A short Russian line for a model: known catalogue phrases are translated; a version part
 * («Opus 4.7») stays; any other English sentence is dropped rather than shown untranslated.
 */
export function russianModelDescription(description: string | undefined): string {
  if (!description) return '';
  return description
    .split(/\s+·\s+/)
    .map((part) => part.trim())
    .map((part) => MODEL_PHRASES_RU.find(([pattern]) => pattern.test(part))?.[1] ?? part)
    .filter((part) => /[а-яё]/i.test(part) || part.split(/\s+/).length <= 2)
    .join(' · ');
}

/** What each effort level means, for its tooltip. */
const EFFORT_HINTS: Record<string, string> = {
  default: 'как решит модель',
  low: 'быстро и дёшево',
  medium: 'сбалансированно',
  high: 'думает глубже',
  xhigh: 'ещё глубже',
  max: 'максимум размышлений',
  ultracode: 'максимум и воркфлоу на весь ход',
};

/**
 * «Модель и effort» of the composer: the chosen model's effort levels as a grid and the
 * provider's models as a compact list. Opens UP from the composer (it sits at the bottom),
 * no taller than the room above it, scrolling inside; `inline` — inside the phone context sheet.
 */
export function ModelMenu({ chat, onClose, inline = false, toggleRef }: {
  chat: ChatController;
  onClose: () => void;
  inline?: boolean;
  /** The button that opens the menu: pressing it again closes the menu through the button alone. */
  toggleRef?: RefObject<HTMLElement>;
}) {
  const { provider } = chat;
  const menuRef = useRef<HTMLDivElement>(null);
  // The room above the composer (px) the drop-up may take; null until measured.
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  // The drop-up is an Esc layer (inline inside the phone sheet it is not: the sheet closes).
  const isTopLayer = useEscapeLayer(!inline);

  useEffect(() => {
    if (inline) return undefined;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      // The toggle's own press: closing here would let its click open the menu again.
      if (toggleRef?.current?.contains(target)) return;
      if (menuRef.current && !menuRef.current.contains(target)) onClose();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && isTopLayer()) {
        event.preventDefault();
        onClose();
      }
    };
    const timer = window.setTimeout(() => document.addEventListener('pointerdown', onPointer), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [inline, isTopLayer, onClose, toggleRef]);

  // Phone: the list unfolds under «Модель» near the bottom of the context sheet, below its
  // fold — the tap seemed to do nothing. Scroll the sheet (only it: scrollIntoView could pan the
  // iOS page under the fixed layers) so the list shows, keeping the «Модель» button on top.
  useEffect(() => {
    if (!inline) return;
    const menu = menuRef.current;
    let scroller = menu?.parentElement ?? null;
    while (scroller && !/(auto|scroll)/.test(window.getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!menu || !scroller) return;
    const box = scroller.getBoundingClientRect();
    const anchor = (menu.previousElementSibling as HTMLElement | null) ?? menu;
    const hiddenBelow = menu.getBoundingClientRect().bottom - box.bottom;
    const delta = Math.min(hiddenBelow + 12, anchor.getBoundingClientRect().top - box.top);
    if (delta > 0) scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: 'smooth' });
  }, [inline]);

  useLayoutEffect(() => {
    if (inline) return undefined;
    const measure = () => {
      const composer = menuRef.current?.offsetParent as HTMLElement | null;
      if (!composer) return;
      const viewportTop = window.visualViewport?.offsetTop ?? 0;
      const room = composer.getBoundingClientRect().top - viewportTop - 16;
      setMaxHeight(Math.max(180, Math.min(560, Math.floor(room))));
    };
    measure();
    window.visualViewport?.addEventListener('resize', measure);
    window.addEventListener('resize', measure);
    return () => {
      window.visualViewport?.removeEventListener('resize', measure);
      window.removeEventListener('resize', measure);
    };
  }, [inline]);

  const efforts = provider.currentProviderEffortOptions;
  return (
    <div
      ref={menuRef}
      className={inline ? 'kbc-menu kbc-model-menu' : 'kbc-menu kbc-model-menu kbc-model-pop kb-pop'}
      role="menu"
      aria-label="Модель и effort"
      data-inline={inline ? '' : undefined}
      style={!inline && maxHeight !== null ? { maxHeight } : undefined}
    >
      {efforts.length > 0 && (
        <>
          <span className="kbc-pop-cap kb-m">EFFORT</span>
          <div className="kbc-effort" role="group" aria-label="Effort">
            {[{ value: 'default' }, ...efforts].map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={provider.currentProviderEffort === option.value}
                title={EFFORT_HINTS[option.value]}
                onClick={() => void chat.selectEffort(option.value)}
              >
                {option.value === 'default' ? 'авто' : option.value}
              </button>
            ))}
          </div>
        </>
      )}
      <span className="kbc-pop-cap kb-m">МОДЕЛЬ{provider.providerModelsLoading ? ' · гружу…' : ''}</span>
      {provider.currentProviderModelOptions.map((option) => {
        const description = russianModelDescription(option.description);
        return (
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            aria-checked={option.value === provider.currentProviderModel}
            className="kbc-menu-item kbc-model-item"
            data-active={option.value === provider.currentProviderModel ? '' : undefined}
            title={option.description}
            onClick={() => {
              void chat.selectModel(option.value);
              if (!inline) onClose();
            }}
          >
            <span className="kbc-model-name">{russianModelLabel(option.label)}</span>
            {description && <span className="kbc-model-desc kb-m">{description}</span>}
          </button>
        );
      })}
    </div>
  );
}

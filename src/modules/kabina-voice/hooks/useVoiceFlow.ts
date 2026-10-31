import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { discardPrimedMicrophone } from '@/modules/kabina';
import { useVoiceDelivery } from '@/modules/kabina-voice/hooks/useVoiceDelivery';
import type { VoiceResult } from '@/modules/kabina-voice/hooks/useVoiceDelivery';
import { useVoiceRecorder } from '@/modules/kabina-voice/hooks/useVoiceRecorder';
import type { VoiceMicError, VoiceRecording } from '@/modules/kabina-voice/hooks/useVoiceRecorder';
import { buildCardView, defaultDestination } from '@/modules/kabina-voice/utils/voiceActionPlan';
import type { VoiceContext, VoiceDestination } from '@/modules/kabina-voice/utils/voiceActionPlan';
import { api } from '@/shared/api';
import { useVoiceHotkey } from '@/shared/hooks/useMirageSettingsView';
import type { KabinaProjectRef, VoiceIntentAction, VoiceIntentResponse } from '@/shared/types';

/**
 * Where the overlay is in its cycle:
 * starting → listening → transcribing → parsing → parsed → executing → done,
 * or error / cancelled on the way.
 */
export type VoicePhase = 'starting' | 'listening' | 'transcribing' | 'parsing' | 'parsed' | 'executing' | 'done' | 'error' | 'cancelled';

/** Desktop screen (footer tabs 01–03); the phone folds «Куда отправить» into «Понял». */
export type VoiceView = 'listen' | 'parsed' | 'dest';

/** An error card: machine code, title, explanation and what the main button does. */
export type VoiceFailure = {
  code: string;
  title: string;
  text: string;
  /** `record` — record again; `parse` — retry the parse; `none` — only close. */
  retry: 'record' | 'parse' | 'none';
};

/** Shortest recording worth sending; anything shorter is «ничего не записалось». */
const MIN_RECORDING_MS = 600;
/** After the parse arrives the transcript stays on screen this long, then «Понял» opens. */
const REVEAL_MS = 1_300;

const MIC_FAILURES: Record<VoiceMicError, VoiceFailure> = {
  'mic-denied': {
    code: 'MIC_DENIED', title: 'Нет доступа к микрофону', retry: 'record',
    text: 'Браузер не дал микрофон панели. Нажми на значок замка слева от адреса → «Микрофон» → «Разрешить», и запиши заново.',
  },
  'mic-missing': {
    code: 'MIC_MISSING', title: 'Микрофон не найден', retry: 'record',
    text: 'Устройство не видит ни одного микрофона. Подключи гарнитуру или выбери вход в настройках системы.',
  },
  'mic-busy': {
    code: 'MIC_BUSY', title: 'Микрофон занят', retry: 'record',
    text: 'Микрофон держит другая программа (созвон, запись). Закрой её и запиши заново.',
  },
  'mic-insecure': {
    code: 'MIC_INSECURE', title: 'Микрофон только по https', retry: 'none',
    text: 'Браузер включает микрофон только на защищённом адресе. Открой панель по её https-адресу.',
  },
  'mic-failed': {
    code: 'MIC_FAILED', title: 'Микрофон не включился', retry: 'record',
    text: 'Браузер не смог открыть микрофон. Проверь, что он подключён и разрешён панели, и запиши заново.',
  },
  'mic-unsupported': {
    code: 'MIC_UNSUPPORTED', title: 'Браузер не умеет записывать', retry: 'none',
    text: 'В этом браузере нет записи звука (MediaRecorder). Открой панель в свежем Chrome, Safari или Firefox.',
  },
};

const NOT_CONFIGURED: VoiceFailure = {
  code: 'VOICE_NOT_CONFIGURED', title: 'Распознавание не подключено', retry: 'none',
  text: 'Голосовой ввод выключен: на сервере не задан ключ Yandex SpeechKit. Впиши YANDEX_SPEECHKIT_API_KEY (или путь к файлу с ключом в YANDEX_SPEECHKIT_API_KEY_FILE) в .env панели и перезапусти её.',
};

/** «Ничего не расслышал», naming the push-to-talk combination from settings. */
function emptyRecording(hotkeyLabel: string): VoiceFailure {
  return {
    code: 'VOICE_EMPTY', title: 'Ничего не расслышал', retry: 'record',
    text: `Запись пустая или слишком тихая. Говори ближе к микрофону — и держи ${hotkeyLabel}, пока говоришь.`,
  };
}

function failureFromServer(status: number, code: string | undefined, message: string | undefined): VoiceFailure {
  if (code === 'VOICE_NOT_CONFIGURED') return NOT_CONFIGURED;
  if (code === 'VOICE_KEY_REJECTED') {
    return { code, title: 'SpeechKit отклонил ключ', retry: 'none', text: message || 'Проверь роль ai.speechkit-stt.user у сервисного аккаунта.' };
  }
  if (code === 'VOICE_BAD_AUDIO') {
    return { code, title: 'Не смог прочитать запись', retry: 'record', text: 'Аудио пришло битым. Запиши ещё раз — обычно помогает.' };
  }
  return {
    code: code || `HTTP_${status}`,
    title: 'Распознавание не ответило',
    retry: 'parse',
    text: message || 'SpeechKit сейчас недоступен. Запись сохранена — попробуй ещё раз через минуту.',
  };
}

/** The parse found nothing to do: the whole phrase becomes one message card. */
function withFallbackAction(intent: VoiceIntentResponse): VoiceIntentResponse {
  if (intent.actions.length > 0) return intent;
  const summary = intent.text.length > 60 ? `${intent.text.slice(0, 59)}…` : intent.text;
  return { ...intent, actions: [{ id: 'a1', kind: 'message', summary, confidence: 0.5, text: intent.text }] };
}

/** A short «go» said over the «Понял» cards runs them (DarkPhoneVoice «или скажи «выполняй»»). */
const CONFIRM_PHRASE = /^(выполня\S*|выполни\S*|давай|да|поехали|делай|запускай)[.!]?$/i;

/** The browser's IANA zone (the user's), or undefined when the runtime does not say. */
function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** Health is asked once per page: the key does not come and go while the panel is open. */
let voiceConfiguredCache: boolean | null = null;

async function isVoiceConfigured(): Promise<boolean> {
  if (voiceConfiguredCache === true) return true;
  try {
    const response = await api.voice.health();
    const body = await response.json() as { configured?: boolean };
    voiceConfiguredCache = Boolean(body.configured);
  } catch {
    // Unknown — let the recording go; transcribe will say what is wrong.
    return true;
  }
  return voiceConfiguredCache;
}

type VoiceFlowOptions = {
  context: VoiceContext;
  projects: KabinaProjectRef[];
};

/**
 * Used by the voice overlay: the whole «Слушаю → Понял → Куда отправить → Готово»
 * cycle — recording, `POST /api/voice/transcribe`, `POST /api/voice/intent`, the
 * checked cards, the addressee and «Выполнить». Screens only render what it returns.
 */
export function useVoiceFlow({ context, projects }: VoiceFlowOptions) {
  // Read through a ref so the recording callbacks keep their identity when settings arrive.
  const hotkeyLabelRef = useRef('');
  hotkeyLabelRef.current = useVoiceHotkey().label;
  // Current step of the cycle; the overlay picks its layout from it.
  const [phase, setPhase] = useState<VoicePhase>('starting');
  // Desktop tab: the transcript, the cards or the addressee picker.
  const [view, setView] = useState<VoiceView>('listen');
  // The error card, set together with phase 'error'.
  const [failure, setFailure] = useState<VoiceFailure | null>(null);
  // What the server heard (also the editable text of «Править текстом»).
  const [transcript, setTranscript] = useState('');
  // The parse being shown as cards.
  const [intent, setIntent] = useState<VoiceIntentResponse | null>(null);
  // Ids of the cards that are unticked (all start ticked, as in the mock-ups).
  const [unchecked, setUnchecked] = useState<Set<string>>(() => new Set());
  // Chosen addressee; starts from the rule «открыт чат → туда».
  const [destination, setDestination] = useState<VoiceDestination>(() => defaultDestination(context));
  // Project of «Новый диалог в проекте…», picked in the addressee step.
  const [newProjectId, setNewProjectId] = useState<string | null>(context.projectId);
  // Lines of «Готово».
  const [results, setResults] = useState<VoiceResult[]>([]);
  // Length of the last recording, kept for the phone «ТЫ СКАЗАЛ 0:07» caption.
  const [spokenMs, setSpokenMs] = useState(0);
  // When «Выполнить» finished, for the phone «ВЫПОЛНЕНО · 14:33».
  const [finishedAt, setFinishedAt] = useState<Date | null>(null);
  // Set when a spoken «выполняй» confirmed the cards; an effect then runs them.
  const [confirmRequested, setConfirmRequested] = useState(false);
  /** Cards on screen when «Сказать заново» started — a «выполняй» runs them instead of replacing them. */
  const confirmableRef = useRef<{ intent: VoiceIntentResponse; unchecked: Set<string>; transcript: string; spokenMs: number } | null>(null);
  const lastRecordingRef = useRef<VoiceRecording | null>(null);
  const revealTimerRef = useRef<number | null>(null);
  const generationRef = useRef(0);

  const delivery = useVoiceDelivery(projects);

  const fail = useCallback((next: VoiceFailure) => {
    setFailure(next);
    setPhase('error');
    setView('listen');
  }, []);

  const parse = useCallback(async (text: string, generation: number, reveal: boolean) => {
    setPhase('parsing');
    try {
      const response = await api.voice.intent(text, browserTimeZone());
      const body = await response.json() as VoiceIntentResponse & { error?: string };
      if (generation !== generationRef.current) return;
      if (!response.ok) {
        fail({ code: `HTTP_${response.status}`, title: 'Не смог разобрать фразу', retry: 'parse', text: body.error || 'Сервер не ответил на разбор. Попробуй ещё раз.' });
        return;
      }
      const parsed = withFallbackAction(body);
      setIntent(parsed);
      setUnchecked(new Set());
      setPhase('parsed');
      if (reveal) {
        revealTimerRef.current = window.setTimeout(() => {
          // Someone already on «Куда отправить» stays there.
          if (generation === generationRef.current) setView((current) => (current === 'listen' ? 'parsed' : current));
        }, REVEAL_MS);
      } else {
        setView('parsed');
      }
    } catch {
      if (generation !== generationRef.current) return;
      fail({ code: 'NETWORK', title: 'Нет связи с панелью', retry: 'parse', text: 'Разбор не дошёл до сервера. Проверь связь и нажми «Ещё раз».' });
    }
  }, [fail]);

  const transcribe = useCallback(async (recording: VoiceRecording, generation: number) => {
    setPhase('transcribing');
    const form = new FormData();
    form.append('audio', recording.blob, recording.fileName);
    try {
      const response = await api.voice.transcribe(form);
      const body = await response.json().catch(() => ({})) as { text?: string; error?: string; code?: string };
      if (generation !== generationRef.current) return;
      if (!response.ok) {
        fail(failureFromServer(response.status, body.code, body.error));
        return;
      }
      const text = (body.text ?? '').trim();
      const confirmable = confirmableRef.current;
      confirmableRef.current = null;
      if (confirmable && CONFIRM_PHRASE.test(text)) {
        setIntent(confirmable.intent);
        setUnchecked(confirmable.unchecked);
        setTranscript(confirmable.transcript);
        setSpokenMs(confirmable.spokenMs);
        setPhase('parsed');
        setView('parsed');
        setConfirmRequested(true);
        return;
      }
      if (!text) {
        fail(emptyRecording(hotkeyLabelRef.current));
        return;
      }
      setTranscript(text);
      await parse(text, generation, true);
    } catch {
      if (generation !== generationRef.current) return;
      fail({ code: 'NETWORK', title: 'Нет связи с панелью', retry: 'parse', text: 'Запись не дошла до сервера. Она сохранена — нажми «Ещё раз».' });
    }
  }, [fail, parse]);

  const handleRecording = useCallback((recording: VoiceRecording | null) => {
    const generation = generationRef.current;
    if (!recording || recording.durationMs < MIN_RECORDING_MS || recording.blob.size < 400) {
      fail(emptyRecording(hotkeyLabelRef.current));
      return;
    }
    lastRecordingRef.current = recording;
    if (!confirmableRef.current) setSpokenMs(recording.durationMs);
    void transcribe(recording, generation);
  }, [fail, transcribe]);

  const recorder = useVoiceRecorder(handleRecording);
  const { start: startRecorder, stop: stopRecorder, cancel: cancelRecorder, isRecording } = recorder;

  /**
   * Starts (or restarts) listening. `confirmable` keeps the cards on screen so a spoken
   * «выполняй» runs them; anything else replaces them with the new phrase.
   */
  const listen = useCallback(async (options: { confirmable?: boolean } = {}) => {
    confirmableRef.current = options.confirmable && intent ? { intent, unchecked, transcript, spokenMs } : null;
    generationRef.current += 1;
    const generation = generationRef.current;
    if (revealTimerRef.current !== null) window.clearTimeout(revealTimerRef.current);
    setFailure(null);
    setIntent(null);
    setTranscript('');
    setResults([]);
    setView((current) => (current === 'dest' ? 'dest' : 'listen'));
    setPhase('starting');
    if (!(await isVoiceConfigured())) {
      // A voice button may have opened the microphone in its tap: nothing will record.
      discardPrimedMicrophone();
      if (generation === generationRef.current) fail(NOT_CONFIGURED);
      return;
    }
    const micError = await startRecorder();
    // Esc (or a newer phrase) while the microphone was opening: the recorder already dropped it.
    if (generation !== generationRef.current) return;
    if (micError) {
      fail(MIC_FAILURES[micError]);
      return;
    }
    setPhase('listening');
  }, [fail, intent, spokenMs, startRecorder, transcript, unchecked]);

  /** «Готово, разобрать» / released ⌥ Пробел: stop and send. */
  const finish = useCallback(async () => {
    if (!isRecording) return;
    setPhase('transcribing');
    handleRecording(await stopRecorder());
  }, [handleRecording, isRecording, stopRecorder]);

  /** Esc while listening: drop the audio, show «Запись отменена». */
  const cancel = useCallback(() => {
    generationRef.current += 1;
    cancelRecorder();
    setPhase('cancelled');
  }, [cancelRecorder]);

  /** Main button of an error card. */
  const retry = useCallback(() => {
    if (failure?.retry === 'parse') {
      generationRef.current += 1;
      const generation = generationRef.current;
      setFailure(null);
      if (transcript) void parse(transcript, generation, false);
      else if (lastRecordingRef.current) void transcribe(lastRecordingRef.current, generation);
      else void listen();
      return;
    }
    void listen();
  }, [failure, listen, parse, transcribe, transcript]);

  /** «Разобрать заново» after «Править текстом». */
  const reparse = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    generationRef.current += 1;
    setTranscript(trimmed);
    void parse(trimmed, generationRef.current, false);
  }, [parse]);

  const toggleCard = useCallback((id: string) => {
    setUnchecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const cards = useMemo(() => (intent?.actions ?? []).map((action) => buildCardView(action, destination, context, newProjectId, projects)), [context, destination, intent, newProjectId, projects]);
  const checkedCards = cards.filter((card) => !unchecked.has(card.id) && card.runnable);

  const execute = useCallback(async () => {
    if (!intent || checkedCards.length === 0 || phase === 'executing') return;
    setPhase('executing');
    const done = await delivery.run(checkedCards, intent.actions);
    setResults(done);
    setFinishedAt(new Date());
    setPhase('done');
  }, [checkedCards, delivery, intent, phase]);

  const undo = useCallback(async () => {
    await delivery.undoCalendar(results);
    setResults([]);
    setPhase('parsed');
    setView('parsed');
  }, [delivery, results]);

  useEffect(() => {
    if (!confirmRequested) return;
    setConfirmRequested(false);
    void execute();
  }, [confirmRequested, execute]);

  useEffect(() => () => {
    if (revealTimerRef.current !== null) window.clearTimeout(revealTimerRef.current);
  }, []);

  const actions: VoiceIntentAction[] = intent?.actions ?? [];

  return {
    phase, view, setView, failure, transcript, intent, actions, cards, unchecked, checkedCards,
    destination, setDestination, newProjectId, setNewProjectId, results, spokenMs, finishedAt,
    elapsedMs: recorder.elapsedMs, levels: recorder.levels, isRecording,
    listen, finish, cancel, retry, reparse, toggleCard, execute, undo,
  };
}

/** Everything the overlay layouts read from the flow. */
export type VoiceFlow = ReturnType<typeof useVoiceFlow>;

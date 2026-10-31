import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { VoiceAlert } from '@/modules/kabina-voice/VoiceAlert';
import { VoiceCards } from '@/modules/kabina-voice/VoiceCards';
import { VoiceDestinations } from '@/modules/kabina-voice/VoiceDestinations';
import { VoiceDial, dialStateOf } from '@/modules/kabina-voice/VoiceDial';
import { VoiceTranscript } from '@/modules/kabina-voice/VoiceTranscript';
import type { VoiceFlow, VoiceView } from '@/modules/kabina-voice/hooks/useVoiceFlow';
import { VOICE_MAX_MS } from '@/modules/kabina-voice/hooks/useVoiceRecorder';
import { destinationLabel, markedWordIndexes, recognizedEntities } from '@/modules/kabina-voice/utils/voiceActionPlan';
import type { VoiceContext } from '@/modules/kabina-voice/utils/voiceActionPlan';
import { desktopVoiceSteps } from '@/modules/kabina-voice/utils/voiceSteps';
import { Button, NO_AUTOFILL } from '@/modules/kabina';
import { useVoiceHotkey } from '@/shared/hooks/useMirageSettingsView';
import type { KabinaProjectRef } from '@/shared/types';

type VoiceDesktopProps = {
  flow: VoiceFlow;
  context: VoiceContext;
  projects: KabinaProjectRef[];
  onClose: () => void;
};

const ENTITY_PLACEHOLDERS = ['КОГДА', 'ВРЕМЯ', 'ДЕЛО', 'ЗАДАЧА'];

function actionsWord(count: number): string {
  const tail = count % 10;
  const tens = count % 100;
  if (tail === 1 && tens !== 11) return 'ДЕЙСТВИЕ';
  if (tail >= 2 && tail <= 4 && (tens < 12 || tens > 14)) return 'ДЕЙСТВИЯ';
  return 'ДЕЙСТВИЙ';
}

/** Header status: label, LED shape and colour for the current phase. */
function statusOf(flow: VoiceFlow): { label: string; led: string; tone?: 'signal' | 'ok' | 'warn' } {
  switch (flow.phase) {
    case 'starting':
      return { label: 'ВКЛЮЧАЮ МИКРОФОН', led: 'kb-led kb-led-idle' };
    case 'listening':
      return { label: 'СЛУШАЮ', led: 'kb-led kb-led-run' };
    case 'transcribing':
    case 'parsing':
      return { label: 'РАЗБИРАЮ', led: 'kb-led kb-led-wait', tone: 'signal' };
    case 'executing':
      return { label: 'ВЫПОЛНЯЮ', led: 'kb-led kb-led-run', tone: 'signal' };
    case 'done':
      return { label: 'ВЫПОЛНЕНО', led: 'kb-led kb-led-ok', tone: 'ok' };
    case 'error':
      return { label: 'НЕ ВЫШЛО', led: 'kb-led kb-led-warn', tone: 'warn' };
    default:
      if (flow.view === 'dest') return { label: 'КУДА ОТПРАВИТЬ', led: 'kb-led kb-led-wait', tone: 'signal' };
      return { label: flow.view === 'listen' ? 'ПОНЯЛ' : 'ПОНЯЛ · ЖДУ ТЕБЯ', led: 'kb-led kb-led-wait', tone: 'signal' };
  }
}

/**
 * Used by KabinaVoiceOverlay on desktop (DarkVoice): the 1040 px plate over the dimmed
 * screen with three steps — 01 «Слушаю» (dial + transcript), 02 «Понял» (action cards),
 * 03 «Куда отправить» (addressee) — and the step tabs in the footer.
 */
export function VoiceDesktop({ flow, context, projects, onClose }: VoiceDesktopProps) {
  const status = statusOf(flow);
  const { label: hotkeyLabel } = useVoiceHotkey();
  const destName = destinationLabel(flow.destination, context, flow.newProjectId, projects);
  const marked = markedWordIndexes(flow.transcript, flow.actions);
  const entities = recognizedEntities(flow.actions);
  // «Править текстом»: the textarea replaces «ТЫ СКАЗАЛ».
  const [editing, setEditing] = useState(false);
  // Draft of the edited phrase.
  const [draft, setDraft] = useState('');
  const editRef = useRef<HTMLTextAreaElement>(null);
  const execRef = useRef<HTMLButtonElement>(null);

  // While listening the addressee may already be picked (DarkVoice: «Кому» works during the recording).
  const isListenBusy = flow.phase === 'starting' || flow.phase === 'listening' || flow.phase === 'transcribing';
  const showListen = flow.view === 'listen' || flow.phase === 'error' || (isListenBusy && flow.view !== 'dest');
  const view: VoiceView = showListen ? 'listen' : flow.view;
  const checkedCount = flow.checkedCards.length;
  const done = flow.phase === 'done';
  const executing = flow.phase === 'executing';

  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (view === 'parsed' && !editing) execRef.current?.focus({ preventScroll: true });
  }, [editing, view]);

  const toggleEdit = () => {
    if (editing) {
      setEditing(false);
      if (draft.trim() && draft.trim() !== flow.transcript) flow.reparse(draft);
      return;
    }
    setDraft(flow.transcript);
    setEditing(true);
  };

  const okResults = flow.results.filter((result) => result.ok);
  const failedResults = flow.results.filter((result) => !result.ok);
  const doneText = okResults.length > 0
    ? `Готово: ${okResults.map((result) => result.title.charAt(0).toLowerCase() + result.title.slice(1)).join(', ')}. Адресат — ${destName.toLowerCase()}.`
    : 'Ничего не выполнено.';
  const calendarDone = okResults.some((result) => result.calendarEventId);
  const sessionHref = okResults.find((result) => result.href && result.href !== '/calendar')?.href;

  const recordProgress = flow.phase === 'listening' ? `${Math.round((flow.elapsedMs / VOICE_MAX_MS) * 100)}%` : '100%';
  const tabs = desktopVoiceSteps({ view, hasIntent: Boolean(flow.intent), done, executing });

  const footNote = flow.phase === 'listening'
    ? `отпусти ${hotkeyLabel} или «Готово» — разберу`
    : view === 'parsed' && !done ? '↵ — выполнить · Esc — закрыть' : 'Esc — закрыть';

  return (
    <>
      <header className="kb-vo-head">
        <span className={status.led} aria-hidden="true" />
        <h2 id="kb-voice-title" className="kb-m kb-vo-status" data-tone={status.tone}>{status.label}</h2>
        <span className="kb-vo-ruler" aria-hidden="true" />
        <button
          className="kb-vo-to"
          type="button"
          onClick={() => flow.setView('dest')}
          disabled={done || executing}
          aria-label={`Кому: ${destName}. Сменить адресата`}
        >
          <span className="kb-m kb-vo-to-k">КОМУ</span>
          <span className="kb-vo-to-v">{destName}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#B3AA9B" strokeWidth="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </button>
        <span className="kb-m kb-vo-keycap">{hotkeyLabel}</span>
        <button className="kb-ib" type="button" onClick={onClose} aria-label="Закрыть голосовой ввод (Esc)" style={{ display: 'grid', placeItems: 'center', border: '1px solid rgba(255,236,210,0.1)', borderRadius: 6, background: 'transparent', color: 'var(--kb-text)', cursor: 'pointer' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>

      <div className="kb-vo-body">
        {view === 'listen' && (
          <div className="kb-vo-listen">
            <VoiceDial
              elapsedMs={flow.phase === 'listening' || flow.phase === 'starting' ? flow.elapsedMs : flow.spokenMs}
              levels={flow.levels}
              state={dialStateOf(flow.phase, Boolean(flow.intent))}
            />
            <div className="kb-vo-textcol">
              {flow.phase === 'error' && flow.failure ? (
                <VoiceAlert failure={flow.failure} onRetry={flow.retry} onClose={onClose} />
              ) : (
                <>
                  <div className="kb-vo-sec">
                    <span className="kb-m kb-vo-sec-n" aria-hidden="true">01</span>
                    <span className="kb-m kb-vo-sec-t">РАСШИФРОВКА</span>
                    <span className="kb-vo-ruler" data-fine="" aria-hidden="true" style={{ flex: 1 }} />
                    <span className="kb-m kb-vo-sec-meta">ru · по словам</span>
                  </div>
                  <VoiceTranscript
                    className="kb-vo-words"
                    text={flow.transcript}
                    marked={marked}
                    placeholder={flow.phase === 'starting' ? 'Включаю микрофон…' : flow.phase === 'listening' ? 'Говори — разберу, как только отпустишь' : 'Расшифровываю…'}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <span className="kb-m kb-vo-eyebrow" style={{ fontSize: 9.5, letterSpacing: '0.2em' }}>УЖЕ РАСПОЗНАЛ</span>
                    <div className="kb-vo-ents">
                      {entities.length > 0
                        ? entities.map((entity) => (
                            <span key={entity.key} className="kb-m kb-vo-ent" data-on="">
                              <span className="kb-vo-ent-k">{entity.label}</span>
                              {entity.value}
                            </span>
                          ))
                        : ENTITY_PLACEHOLDERS.map((label) => (
                            <span key={label} className="kb-m kb-vo-ent">
                              <span className="kb-vo-ent-k">{label}</span>—
                            </span>
                          ))}
                    </div>
                  </div>
                  <div className="kb-vo-hintrow">
                    {flow.intent ? (
                      <span>Разобрал — проверь действия и адресата.</span>
                    ) : (
                      <>
                        <span>Отпусти <span className="kb-m kb-vo-key">{hotkeyLabel}</span> — отправлю на разбор</span>
                        <span className="kb-vo-dot" aria-hidden="true">·</span>
                        <span><span className="kb-m kb-vo-key">Esc</span> — отменить запись</span>
                      </>
                    )}
                    <span style={{ flex: 1 }} />
                    {flow.intent ? (
                      <Button variant="ghost" onClick={() => flow.setView('parsed')}>К действиям</Button>
                    ) : (
                      <Button variant="ghost" onClick={() => void flow.finish()} disabled={flow.phase !== 'listening'}>Готово, разобрать</Button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {view === 'parsed' && flow.intent && (
          <div className="kb-vo-col">
            <div className="kb-vo-titlerow kb-rise">
              <div className="kb-vo-titleblock">
                <span className="kb-m kb-vo-eyebrow">РАЗОБРАЛ · {flow.cards.length} {actionsWord(flow.cards.length)}</span>
                <h3 className="kb-t kb-vo-h">{done ? 'Сделано.' : 'Понял. Делаю так?'}</h3>
              </div>
              <button className="kb-btn kb-ghost" type="button" onClick={() => flow.setView('dest')} disabled={done || executing}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FF6A2B" strokeWidth="1.6" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                {destName}
              </button>
            </div>

            {editing ? (
              <div className="kb-rise" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label htmlFor="kb-voice-edit" className="kb-m kb-vo-kicker">ПРАВЬ ТЕКСТ — РАЗБЕРУ ЗАНОВО</label>
                <textarea
                  {...NO_AUTOFILL}
                  autoCapitalize="sentences"
                  id="kb-voice-edit"
                  ref={editRef}
                  className="kb-vo-edit"
                  rows={2}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      toggleEdit();
                    }
                  }}
                />
              </div>
            ) : (
              <p className="kb-vo-said kb-rise kb-d1">
                <span className="kb-m kb-vo-said-k">ТЫ СКАЗАЛ</span>«{flow.transcript}»
              </p>
            )}

            <VoiceCards cards={flow.cards} unchecked={flow.unchecked} onToggle={flow.toggleCard} variant="desktop" locked={done || executing} />

            {done ? (
              <div className="kb-vo-done kb-rise" role="status">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9CC49A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                <span className="kb-vo-done-text">{doneText}</span>
                {calendarDone && <Link className="kb-btn kb-ghost" to="/calendar" onClick={onClose}>Открыть календарь →</Link>}
                {sessionHref && <Link className="kb-btn kb-ghost" to={sessionHref} onClick={onClose}>Открыть диалог →</Link>}
                {failedResults.map((result) => (
                  <p key={result.id} className="kb-vo-done-fail">{result.title}: {result.sub}</p>
                ))}
              </div>
            ) : (
              <div className="kb-vo-actions kb-rise kb-d3">
                <button
                  ref={execRef}
                  className="kb-btn kb-pri"
                  type="button"
                  data-size="lg"
                  style={{ minHeight: 44, padding: '0 12px 0 18px', fontSize: 14, borderRadius: 5 }}
                  aria-disabled={checkedCount === 0 || executing}
                  onClick={() => void flow.execute()}
                >
                  {executing ? 'Выполняю…' : checkedCount ? `Выполнить · ${checkedCount}` : 'Нечего выполнять'}
                  <span className="kb-m kb-vo-enter">↵</span>
                </button>
                <button className="kb-btn kb-ghost" type="button" style={{ minHeight: 44, fontSize: 14, padding: '0 16px' }} aria-pressed={editing} onClick={toggleEdit}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></svg>
                  {editing ? 'Разобрать заново' : 'Править текстом'}
                </button>
                <button className="kb-btn kb-ghost" type="button" style={{ minHeight: 44, fontSize: 14, borderColor: 'transparent', color: 'var(--kb-soft)' }} onClick={() => void flow.listen()}>
                  Перезаписать
                </button>
                <span style={{ flex: 1 }} />
                <span className="kb-m kb-vo-note">пробел — переключить пункт</span>
              </div>
            )}
          </div>
        )}

        {view === 'dest' && (
          <div className="kb-vo-col">
            <div className="kb-rise" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span className="kb-m kb-vo-eyebrow">АДРЕСАТ КОМАНДЫ</span>
              <h3 className="kb-t kb-vo-h">Куда отправить?</h3>
              <p className="kb-vo-lead">
                {context.sessionId
                  ? 'Открыт чат — по умолчанию команда уйдёт туда, вклиниванием в идущий ход.'
                  : 'Ты на главном экране — по умолчанию команда уйдёт главному ассистенту.'}
              </p>
            </div>
            <VoiceDestinations
              variant="desktop"
              destination={flow.destination}
              onPick={flow.setDestination}
              context={context}
              projects={projects}
              newProjectId={flow.newProjectId}
              onPickProject={flow.setNewProjectId}
            />
            <p className="kb-vo-rule kb-rise kb-d4">
              <span className="kb-m kb-vo-rule-k">ПРАВИЛО</span>
              <span style={{ flex: '1 1 320px', textWrap: 'pretty' }}>
                Открыт чат — команда уходит туда. С главного экрана — главному ассистенту: он сам раскладывает по проектам и календарю.
              </span>
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              <button className="kb-btn kb-pri" type="button" style={{ minHeight: 44, padding: '0 22px', fontSize: 14 }} onClick={() => flow.setView(flow.intent ? 'parsed' : 'listen')}>Готово</button>
              <button className="kb-btn kb-ghost" type="button" style={{ minHeight: 44, padding: '0 16px', fontSize: 14 }} onClick={() => flow.setView('listen')}>Назад к записи</button>
            </div>
          </div>
        )}
      </div>

      <footer className="kb-vo-foot">
        <div role="tablist" aria-label="Шаги голосового ввода" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className="kb-vo-tab"
              type="button"
              role="tab"
              aria-selected={tab.state === 'current'}
              data-state={tab.state}
              disabled={tab.disabled}
              onClick={() => flow.setView(tab.id)}
            >
              <span className="kb-m kb-vo-tab-n">{tab.n}</span>
              {tab.label}
              <span className="kb-vo-tab-prog" aria-hidden="true" style={{ width: tab.state === 'current' ? (tab.id === 'listen' ? recordProgress : '100%') : tab.state === 'passed' ? '100%' : '0%' }} />
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <span className="kb-m kb-vo-note">{footNote}</span>
      </footer>
    </>
  );
}

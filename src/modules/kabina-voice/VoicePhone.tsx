import { Link } from 'react-router-dom';

import { primeMicrophone, usePressOrHold } from '@/modules/kabina';

import { VoiceAlert } from '@/modules/kabina-voice/VoiceAlert';
import { VoiceCards } from '@/modules/kabina-voice/VoiceCards';
import { PhoneVoiceDial, dialStateOf } from '@/modules/kabina-voice/VoiceDial';
import { VoiceDestinations } from '@/modules/kabina-voice/VoiceDestinations';
import { VoiceTranscript } from '@/modules/kabina-voice/VoiceTranscript';
import type { VoiceFlow } from '@/modules/kabina-voice/hooks/useVoiceFlow';
import { destinationLabel, formatClock, formatTimer, markedWordIndexes } from '@/modules/kabina-voice/utils/voiceActionPlan';
import type { VoiceContext } from '@/modules/kabina-voice/utils/voiceActionPlan';
import { phoneVoiceSteps } from '@/modules/kabina-voice/utils/voiceSteps';
import type { PhoneVoiceStep } from '@/modules/kabina-voice/utils/voiceSteps';
import { useVoiceHotkey } from '@/shared/hooks/useMirageSettingsView';
import type { KabinaProjectRef } from '@/shared/types';

type VoicePhoneProps = {
  flow: VoiceFlow;
  context: VoiceContext;
  projects: KabinaProjectRef[];
  onClose: () => void;
};

function MicGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

/** The small mic of the phone footers (56 px in a 72 px tick ring). */
function MiniMic({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <span className="kb-vo-ph-minimic">
      <svg className="kb-voice-ring" width="72" height="72" viewBox="0 0 72 72" aria-hidden="true">
        <circle cx="36" cy="36" r="34" fill="none" stroke="rgba(255,106,43,0.6)" strokeWidth="3" strokeDasharray="1 5.1" />
      </svg>
      <button className="kb-voice kb-press" type="button" aria-label={label} onPointerDown={primeMicrophone} onClick={onClick}>
        <MicGlyph size={23} />
      </button>
    </span>
  );
}

/**
 * Used by KabinaVoiceOverlay on the phone (DarkPhoneVoice): a full screen with the
 * addressee and timer on top, three steps — «Слушаю» (dial, transcript, big mic),
 * «Понял» (cards plus «Кому отправить» in one scroll, «Выполнить» at the thumb) and
 * «Готово» (what was done, undo for calendar events).
 */
export function VoicePhone({ flow, context, projects, onClose }: VoicePhoneProps) {
  const step: PhoneVoiceStep = flow.phase === 'done' ? 'done' : flow.intent && flow.phase !== 'error' && flow.view !== 'listen' ? 'got' : 'listen';
  const listening = flow.phase === 'listening';
  const { label: hotkeyLabel } = useVoiceHotkey();
  const destTitle = destinationLabel(flow.destination, context, flow.newProjectId, projects);
  const marked = markedWordIndexes(flow.transcript, flow.actions);
  const checkedCount = flow.checkedCards.length;
  const executing = flow.phase === 'executing';
  const timerMs = listening || flow.phase === 'starting' ? flow.elapsedMs : flow.spokenMs;
  const words = flow.transcript ? flow.transcript.split(/\s+/) : [];
  const failure = flow.phase === 'error' ? flow.failure : null;
  const micBusy = flow.phase === 'starting' || flow.phase === 'transcribing' || flow.phase === 'parsing';
  // The big mic: a tap toggles listening; held, it listens until the finger is lifted.
  const bigMicPress = usePressOrHold({
    disabled: micBusy,
    onPressStart: listening ? undefined : primeMicrophone,
    onTap: () => (listening ? void flow.finish() : void flow.listen()),
    onHoldStart: () => {
      if (!listening) void flow.listen();
    },
    onHoldEnd: () => void flow.finish(),
  });

  const steps = phoneVoiceSteps({ step, hasIntent: Boolean(flow.intent), executing });
  const goTo = (id: PhoneVoiceStep) => {
    if (id === 'listen') void flow.listen();
    else if (id === 'got') flow.setView('parsed');
  };

  const okResults = flow.results.filter((result) => result.ok);
  const undoable = okResults.length > 0 && okResults.every((result) => result.calendarEventId);
  const calendarHref = okResults.some((result) => result.calendarEventId) ? '/calendar' : null;
  const sessionHref = okResults.find((result) => result.href && result.href !== '/calendar')?.href ?? null;

  return (
    <div className="kb-vo-phone" data-live={listening ? '' : undefined} role="dialog" aria-modal="true" aria-labelledby="kb-voice-ph-title">
      <header className="kb-vo-ph-head">
        <button className="kb-vo-ph-close kb-ib" type="button" onClick={onClose} aria-label="Закрыть голос">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
        <div className="kb-vo-ph-to">
          <span id="kb-voice-ph-title" className="kb-m kb-vo-to-k">ГОЛОС · КОМУ</span>
          <span className="kb-vo-ph-to-v">{destTitle}</span>
        </div>
        <span className="kb-m kb-vo-ph-timer" data-live={listening ? '' : undefined} aria-label={`Запись ${formatTimer(timerMs)} из минуты`}>
          {listening && <span className="kb-led kb-led-run" style={{ width: 6, height: 6 }} />}
          <span>{formatTimer(timerMs)}</span>
          <span style={{ color: 'var(--kb-mute)' }}>/ 1:00</span>
        </span>
      </header>

      <div className="kb-vo-ph-steps" role="group" aria-label="Шаги">
        {steps.map((item) => (
          <button
            key={item.id}
            className="kb-vo-ph-step"
            type="button"
            aria-pressed={item.state === 'current'}
            data-state={item.state}
            disabled={item.disabled}
            onClick={() => goTo(item.id)}
          >
            <span className="kb-m kb-vo-ph-step-n">{item.n}</span>
            <span className="kb-vo-ph-step-l">{item.label}</span>
          </button>
        ))}
      </div>

      {step === 'listen' && (
        // An error keeps the whole screen (dial, mic, «Отмена / Готово»): the card takes the transcript's place.
        <div className="kb-vo-ph-listen" data-error={failure ? '' : undefined}>
          <PhoneVoiceDial
            elapsedMs={timerMs}
            levels={flow.levels}
            state={listening ? 'live' : dialStateOf(flow.phase, Boolean(flow.intent))}
          />
          {failure ? (
            <div className="kb-vo-ph-alert">
              <VoiceAlert failure={failure} onRetry={flow.retry} onClose={onClose} />
            </div>
          ) : (
            <section aria-label="Расшифровка" className="kb-vo-ph-trans kb-rise kb-d1">
              <div className="kb-vo-sec">
                <span className="kb-m kb-vo-sec-t" style={{ fontSize: 10 }}>РАСШИФРОВКА</span>
                <span className="kb-vo-ruler" aria-hidden="true" style={{ flex: 1, height: 6 }} />
                <span className="kb-m kb-vo-sec-meta" style={{ fontSize: 10 }}>{words.length} сл.</span>
              </div>
              <VoiceTranscript
                className="kb-vo-ph-words"
                text={flow.transcript}
                marked={marked}
                placeholder={flow.phase === 'starting' ? 'Включаю микрофон…' : listening ? 'Говори — разберу, когда закончишь' : 'Расшифровываю…'}
              />
            </section>
          )}
          <div className="kb-vo-ph-ctrl">
            <div className="kb-vo-ph-ctrlrow">
              <button className="kb-vo-ph-side" type="button" onClick={onClose}>Отмена</button>
              <span className="kb-vo-ph-mic">
                <svg className="kb-voice-ring" width="108" height="108" viewBox="0 0 108 108" aria-hidden="true">
                  <circle cx="54" cy="54" r="52" fill="none" stroke="rgba(255,106,43,0.7)" strokeWidth="3.5" strokeDasharray="1 7.17" />
                </svg>
                <button
                  className="kb-voice kb-press"
                  type="button"
                  data-live={listening ? '' : undefined}
                  aria-pressed={listening}
                  aria-label={listening ? 'Микрофон включён — нажми, чтобы закончить' : 'Записать заново — нажми или удерживай'}
                  disabled={micBusy}
                  {...bigMicPress}
                >
                  <MicGlyph size={30} />
                </button>
              </span>
              <button className="kb-vo-ph-side" data-accent="" type="button" disabled={!listening} onClick={() => void flow.finish()}>
                Готово
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </button>
            </div>
            <span className="kb-m kb-vo-ph-hint">
              {failure ? 'нажми — запишу заново' : 'отпусти — и я разберу'}<span className="kb-keys"> · на клавиатуре {hotkeyLabel}</span>
            </span>
          </div>
        </div>
      )}

      {step === 'got' && (
        <>
          <div className="kb-vo-ph-scroll">
            <figure className="kb-vo-ph-quote kb-bz kb-rise">
              <figcaption className="kb-m"><span style={{ color: 'var(--kb-head)' }}>ТЫ СКАЗАЛ</span><span>{formatTimer(flow.spokenMs)}</span></figcaption>
              <blockquote>
                {words.map((word, index) => (
                  <span key={index} data-mark={marked.has(index) ? '' : undefined}>{word}{' '}</span>
                ))}
              </blockquote>
              <button className="kb-btn kb-ghost" type="button" style={{ alignSelf: 'flex-end', minHeight: 44, fontSize: 14, borderColor: 'transparent', color: 'var(--kb-soft)' }} onClick={() => void flow.listen({ confirmable: true })}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4" /></svg>
                Сказать заново
              </button>
            </figure>

            <section aria-labelledby="kb-vo-ph-acts" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="kb-vo-sec" style={{ minHeight: 28 }}>
                <span className="kb-m kb-vo-sec-n" aria-hidden="true">01</span>
                <h2 id="kb-vo-ph-acts" className="kb-m kb-vo-sec-t">ПОНЯЛ · ДЕЙСТВИЯ</h2>
                <span className="kb-vo-ruler" aria-hidden="true" style={{ flex: 1 }} />
                <span className="kb-m kb-vo-sec-meta" style={{ color: 'var(--kb-soft)' }}>{checkedCount} из {flow.cards.length}</span>
              </div>
              <VoiceCards cards={flow.cards} unchecked={flow.unchecked} onToggle={flow.toggleCard} variant="phone" locked={executing} />
            </section>

            <section aria-labelledby="kb-vo-ph-dest" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="kb-vo-sec" style={{ minHeight: 28 }}>
                <span className="kb-m kb-vo-sec-n" aria-hidden="true">02</span>
                <h2 id="kb-vo-ph-dest" className="kb-m kb-vo-sec-t">КОМУ ОТПРАВИТЬ</h2>
                <span className="kb-vo-ruler" data-fine="" aria-hidden="true" style={{ flex: 1 }} />
              </div>
              <VoiceDestinations
                variant="phone"
                destination={flow.destination}
                onPick={flow.setDestination}
                context={context}
                projects={projects}
                newProjectId={flow.newProjectId}
                onPickProject={flow.setNewProjectId}
              />
            </section>
          </div>

          <div className="kb-vo-ph-foot">
            <div className="kb-vo-ph-footrow">
              <button className="kb-vo-ph-run" type="button" aria-disabled={checkedCount === 0 || executing} onClick={() => void flow.execute()}>
                <span>{executing ? 'Выполняю…' : checkedCount ? 'Выполнить' : 'Ничего не выбрано'}</span>
                <span className="kb-m kb-vo-ph-run-n">{checkedCount}</span>
              </button>
              <MiniMic label="Добавить голосом — или скажи «выполняй»" onClick={() => void flow.listen({ confirmable: true })} />
            </div>
            <div className="kb-m kb-vo-ph-foothint">
              <span>или скажи «выполняй»</span>
              <span>удерживай<span className="kb-keys"> · {hotkeyLabel}</span></span>
            </div>
          </div>
        </>
      )}

      {step === 'done' && (
        <>
          <div className="kb-vo-ph-scroll" style={{ gap: 22, paddingTop: 28 }}>
            <div className="kb-vo-ph-done-hero">
              <div className="kb-vo-ph-check">
                <svg width="128" height="128" viewBox="0 0 128 128" aria-hidden="true">
                  <circle cx="64" cy="64" r="60" fill="none" stroke="rgba(156,196,154,0.5)" strokeWidth="3" strokeDasharray="1 5.28" />
                  <circle cx="64" cy="64" r="46" fill="#161512" stroke="rgba(156,196,154,0.45)" strokeWidth="1.5" />
                  <path className="kb-vo-draw" d="M46 65l12 12 24-26" fill="none" stroke="#9CC49A" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span className="kb-m" style={{ fontSize: 10, letterSpacing: '0.22em', color: 'var(--kb-sage)' }}>ВЫПОЛНЕНО · {formatClock(flow.finishedAt ?? new Date())}</span>
                <h2 className="kb-t" style={{ margin: 0, fontSize: 28, fontWeight: 500, lineHeight: 1.05 }}>{okResults.length > 0 ? 'Готово' : 'Не вышло'}</h2>
                <p className="kb-balance" style={{ margin: '0 auto', maxWidth: '30ch', fontSize: 14, lineHeight: 1.5, color: 'var(--kb-soft)' }}>Адресат — {destTitle}</p>
              </div>
            </div>

            <ul className="kb-vo-ph-results">
              {flow.results.map((result, index) => (
                <li key={result.id} className={`kb-vo-ph-result kb-rise kb-d${Math.min(index + 1, 5)}`}>
                  <span className={`kb-led ${result.state === 'ok' ? 'kb-led-ok' : result.state === 'run' ? 'kb-led-run' : 'kb-led-warn'}`} />
                  <span className="kb-vo-ph-result-main">
                    <span className="kb-vo-ph-result-title">{result.title}</span>
                    <span className="kb-m kb-vo-ph-result-sub" data-state={result.state}>{result.sub}</span>
                  </span>
                </li>
              ))}
              {flow.results.length === 0 && <li style={{ padding: '14px 2px', fontSize: 14, color: 'var(--kb-mute)' }}>Ничего не выбрано — ничего не сделано.</li>}
            </ul>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 'auto' }}>
              {calendarHref && (
                <Link className="kb-btn kb-out" data-size="lg" to={calendarHref} onClick={onClose}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
                  Открыть в календаре
                </Link>
              )}
              {sessionHref && (
                <Link className="kb-btn kb-out" data-size="lg" to={sessionHref} onClick={onClose}>Открыть диалог</Link>
              )}
              {undoable && (
                <button className="kb-btn kb-ghost" type="button" style={{ minHeight: 48, fontSize: 14, borderColor: 'transparent', color: 'var(--kb-soft)' }} onClick={() => void flow.undo()}>
                  Отменить всё
                </button>
              )}
            </div>
          </div>

          <div className="kb-vo-ph-foot" style={{ flexDirection: 'row', alignItems: 'center', padding: '10px 12px 14px' }}>
            <Link className="kb-vo-ph-run" to="/" onClick={onClose}>На главный</Link>
            <MiniMic label={`Сказать ещё — удерживай кнопку или ${hotkeyLabel}`} onClick={() => void flow.listen()} />
          </div>
        </>
      )}
    </div>
  );
}

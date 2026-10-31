import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import '@/modules/kabina/kabinaStates.css';
import type { KabinaNotification } from '@/modules/kabina/context/KabinaToastContext';
import ConnectionBanner from '@/modules/kabina/shell/ConnectionBanner';
import { NotificationList } from '@/modules/kabina/shell/NotificationCenter';
import { BigSessionNotice } from '@/modules/kabina/ui/BigSessionNotice';
import { Button } from '@/modules/kabina/ui/Button';
import { BypassRootCard } from '@/modules/kabina/ui/BypassRootCard';
import { Kbd } from '@/modules/kabina/ui/Chip';
import { BellIcon } from '@/modules/kabina/ui/KabinaIcons';
import { ClaudeErrorCard } from '@/modules/kabina/ui/ClaudeErrorCard';
import { EmptyState } from '@/modules/kabina/ui/EmptyState';
import { LimitWarningCard } from '@/modules/kabina/ui/LimitWarningCard';
import { FeedSkeleton, ListSkeleton } from '@/modules/kabina/ui/LoadingSkeletons';
import { PermissionRequestCard } from '@/modules/kabina/ui/PermissionRequestCard';
import { SectionRuler } from '@/modules/kabina/ui/SectionRuler';
import { Segmented } from '@/modules/kabina/ui/Segmented';
import { StatusShape } from '@/modules/kabina/ui/StatusShape';
import { TurnStoppedMark } from '@/modules/kabina/ui/TurnStoppedMark';
import { computeLimitWarnings } from '@/modules/kabina/utils/limitWarnings';
import type { KabinaStatusKind, KabinaToastInput, SubscriptionLimits } from '@/shared/types';

const MB = 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;

const LEGEND: Array<{ kind: KabinaStatusKind; name: string; mean: string }> = [
  { kind: 'run', name: 'Круг-пульс', mean: 'работает' },
  { kind: 'wait', name: 'Ромб мигает', mean: 'ждёт тебя' },
  { kind: 'ok', name: 'Шалфей', mean: 'готово, всё хорошо' },
  { kind: 'warn', name: 'Песок', mean: 'предупреждение' },
  { kind: 'idle', name: 'Тёмный', mean: 'тихо' },
];

const TOC: Array<[string, string, string]> = [
  ['01', 'Уведомления', 's-toasts'],
  ['02', 'Связь и ход', 's-flow'],
  ['03', 'Разрешения', 's-perm'],
  ['04', 'Лимиты', 's-limits'],
  ['05', 'Ошибки', 's-errors'],
  ['06', 'Пустые', 's-empty'],
  ['07', 'Загрузка', 's-load'],
];

type ToastSpec = { code: string; name: string; hide: string; when: string; toast: KabinaToastInput };

const TOAST_SPECS: ToastSpec[] = [
  {
    code: 'T1', name: 'Ход закончен', hide: 'в список',
    when: 'Ход закончился, а ты на другом экране. Если ты в этом чате — записи нет, итог виден в ленте.',
    toast: { kind: 'ok', project: 'САЙТ КЛИЕНТА', title: 'Ход закончен', sub: '6:12 · 27 шагов · 48 тестов ✓', actions: [{ label: 'Открыть', onClick: () => undefined }] },
  },
  {
    code: 'T2', name: 'Фоновая работа завершена', hide: 'в список',
    when: 'Фоновый агент или воркфлоу закончил. Несколько в одном ходе — одна запись «3 агента закончили».',
    toast: { kind: 'bg', project: 'КАРТА УЧАСТКОВ', title: 'Фоновый агент сдал работу', sub: 'SEO-тексты · 14 из 14 · 23 мин', actions: [{ label: 'Посмотреть итог', onClick: () => undefined }] },
  },
  {
    code: 'T3', name: 'Нужно подтверждение', hide: 'колокольчик дышит',
    when: 'Claude ждёт разрешения или ответа. Колокольчик мягко пульсирует, пока запись не прочитана; ответил — запись уходит сама.',
    toast: {
      kind: 'wait', project: 'САЙТ КЛИЕНТА', title: 'Нужно твоё решение', sub: 'Bash · deploy.sh --prod · ждёт 2 мин',
      actions: [{ label: 'Ответить', variant: 'pri', onClick: () => undefined }],
    },
  },
  {
    code: 'T4', name: 'Сообщение в очереди', hide: 'в список',
    when: 'Ты отправил сообщение «после хода», пока Claude работает: оно не потерялось и стоит в очереди.',
    toast: {
      kind: 'queue', project: 'DEMO-SITE', title: 'Встало в очередь · №2', sub: 'уйдёт, когда ход закончится',
      actions: [{ label: 'Отменить', onClick: () => undefined }, { label: 'Отправить сейчас', onClick: () => undefined }],
    },
  },
  {
    code: 'T5', name: 'Связь потеряна', hide: 'плашка C1 + запись',
    when: 'Оборвался канал браузера с сервером: тонкая плашка под шапкой на любом экране и одна запись в списке. Ход на сервере не останавливается.',
    toast: { kind: 'lost', project: 'ПАНЕЛЬ', title: 'Связь потеряна', sub: 'переподключаюсь · попытка 3 · через 2 с', actions: [{ label: 'Сейчас', onClick: () => undefined }] },
  },
  {
    code: 'T6', name: 'Связь восстановлена', hide: 'заменяет T5',
    when: 'Канал вернулся после T5: запись T5 сменяется этой. Панель уже догрузила всё, что случилось без тебя.',
    toast: { kind: 'ok', project: 'ПАНЕЛЬ', title: 'Связь восстановлена', sub: 'не было 38 с · догрузил пропущенное', durationMs: 4_000 },
  },
  {
    code: 'T7', name: 'Предупреждение о лимитах', hide: 'один раз',
    when: 'Сработало правило L1 или L3 (ниже). Запись появляется один раз на порог или окно — дальше висит только плашка на главном.',
    toast: { kind: 'warn', project: 'ЛИМИТЫ · НЕДЕЛЯ', title: 'Израсходовано 80 % недели', sub: 'сброс чт 5:00 · через 2 дн 14 ч', actions: [{ label: 'Подробнее', onClick: () => undefined }] },
  },
];

const DIFF_OLD = "export function formatPrice(rub: number) {\n  return rub.toLocaleString('ru-RU') + ' ₽';\n}\n";
const DIFF_NEW = "export function formatPrice(rub: number) {\n  if (!rub) return 'цена по запросу';\n  return rub.toLocaleString('ru-RU') + ' ₽';\n}\n";

const API_LOG = '14:30:12  POST /v1/messages  →  529 overloaded_error\nrequest_id  req_011CVx…f3a  ·  модель opus  ·  шаг 14\n14:30:32  повтор 1  →  529\n14:30:52  повтор 2  →  ждёт';

/** Demo limits that trip both rules, relative to now. */
function demoLimits(nowMs: number): SubscriptionLimits {
  return {
    status: 'ok',
    reason: null,
    plan: 'MAX 20×',
    fetchedAt: new Date(nowMs).toISOString(),
    session: null,
    weekly: { percent: 80, resetsAt: new Date(nowMs + (2 * 24 + 14) * HOUR_MS).toISOString() },
    weeklyByModel: [],
    credits: { percent: 19, resetsAt: new Date(nowMs + 46 * HOUR_MS).toISOString(), limitDollars: 250, remainingDollars: 202 },
  };
}

type SpecProps = {
  code: string;
  name: string;
  /** Right-hand tag of the footer («сам · 6 с»). */
  hide?: string;
  when: string;
  /** Stage layout: centred (toasts), bottom-aligned (composer) or the default column. */
  stage?: 'center' | 'end' | 'column';
  /** flex-basis of the card in the row. */
  basis?: string;
  grow?: number;
  pad20?: boolean;
  stageLabel?: string;
  children: ReactNode;
  footExtra?: ReactNode;
};

/** A DarkStates spec card: the live component on a fine grid, and «КОГДА» under it. */
function Spec({ code, name, hide, when, stage = 'column', basis = '380px', grow = 1, pad20 = false, stageLabel, children, footExtra }: SpecProps) {
  return (
    <article className="kb-spec kb-bz" style={{ flex: `${grow} 1 ${basis}` }}>
      <div
        className="kb-spec-stage"
        data-center={stage === 'center' ? '' : undefined}
        data-end={stage === 'end' ? '' : undefined}
        data-pad={pad20 ? '20' : undefined}
        role={stageLabel ? 'group' : undefined}
        aria-label={stageLabel}
      >
        {children}
      </div>
      <div className="kb-spec-foot">
        <div className="kb-spec-titlebar" data-wrap={footExtra ? '' : undefined}>
          <span className="kb-m kb-spec-code">{code}</span>
          <h3 className="kb-spec-name">{name}</h3>
          <span className="kb-spacer" />
          {footExtra}
          {hide && <span className="kb-m kb-spec-hide">{hide}</span>}
        </div>
        <p className="kb-spec-when"><span className="kb-m">КОГДА</span>{when}</p>
      </div>
    </article>
  );
}

/** Minutes ago each demo entry was raised (T1…T7). */
const DEMO_AGES_MIN = [2, 6, 1, 9, 40, 38, 180];

function demoNotifications(now: number): KabinaNotification[] {
  return TOAST_SPECS.map((spec, index) => ({
    id: spec.code,
    kind: spec.toast.kind,
    project: spec.toast.project,
    title: spec.toast.title,
    sub: spec.toast.sub,
    actions: spec.toast.actions ?? [],
    createdAt: now - DEMO_AGES_MIN[index] * 60_000,
    // T1–T3 are fresh; the rest were already looked at.
    read: index > 2,
  })).sort((left, right) => right.createdAt - left.createdAt);
}

/** 01: the bell and its list, live — an action marks an entry read, × removes it, «Прочитать все». */
function NotificationsSpec() {
  // The demo list (the live centre's shape); «Вернуть всё» refills it.
  const [items, setItems] = useState<KabinaNotification[]>(() => demoNotifications(Date.now()));
  const now = Date.now();
  const unread = items.filter((item) => !item.read).length;
  const attention = items.some((item) => !item.read && item.kind === 'wait');
  return (
    <Spec
      code="N1"
      name="Колокольчик и список"
      hide="ничего не всплывает"
      when="Всё, что раньше было тостом, ложится в список под колокольчиком в шапке (на телефоне — шторка сверху). Счётчик — непрочитанные; «Нужно твоё решение» заставляет колокольчик дышать. Прочитанное помнится в браузере."
      basis="560px"
      grow={2}
      stage="center"
      stageLabel="Колокольчик и список уведомлений"
      footExtra={<Button size="sm" variant="ghost" onClick={() => setItems(demoNotifications(Date.now()))}>Вернуть всё</Button>}
    >
      <div className="kb-spec-notes">
        <div className="kb-spec-notes-bar">
          <span className="kb-m kb-spec-notes-cap">ШАПКА</span>
          <span className="kb-spacer" />
          <span className="kb-ib kb-bell" data-attention={attention ? '' : undefined} aria-hidden="true">
            <BellIcon />
            {unread > 0 && <span className="kb-m kb-bell-badge">{unread}</span>}
          </span>
        </div>
        <section className="kb-notes kb-spec-notes-panel" aria-label="Уведомления (пример)">
          <header className="kb-notes-head">
            <h3 className="kb-m kb-notes-title">УВЕДОМЛЕНИЯ</h3>
            {unread > 0 && <span className="kb-m kb-notes-count">{unread} новых</span>}
            <span className="kb-spacer" />
            <Button
              size="sm"
              variant="ghost"
              disabled={unread === 0}
              onClick={() => setItems((list) => list.map((item) => ({ ...item, read: true })))}
            >
              Прочитать все
            </Button>
          </header>
          <div className="kb-notes-scroll">
            <NotificationList
              items={items}
              now={now}
              onAction={(entry) => setItems((list) => list.map((item) => (item.id === entry.id ? { ...item, read: true } : item)))}
              onRemove={(id) => setItems((list) => list.filter((item) => item.id !== id))}
            />
          </div>
        </section>
      </div>
    </Spec>
  );
}

/** 01: what each entry means (the former toast codes T1–T7). */
function NotificationKindsSpec() {
  return (
    <Spec code="T1–T7" name="Что попадает в список" when="Те же события, что были тостами; ни одно не перекрывает экран и поле ввода." basis="380px">
      <dl className="kb-spec-kinds">
        {TOAST_SPECS.map((spec) => (
          <div key={spec.code}>
            <dt><span className="kb-m kb-spec-code">{spec.code}</span><span>{spec.name}</span><span className="kb-m kb-spec-hide">{spec.hide}</span></dt>
            <dd>{spec.when}</dd>
          </div>
        ))}
      </dl>
    </Spec>
  );
}

/** C1: the real ConnectionBanner over a composer mock, with a switch between «нет связи» and «вернулась». */
function ConnectionSpec() {
  // Which banner state the demo shows.
  const [net, setNet] = useState<'lost' | 'back'>('lost');
  // Demo clock for the retry countdown (5-second cycle as in the mock-up).
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const cycle = tick % 5;
  const isLost = net === 'lost';
  return (
    <Spec
      code="C1"
      name="Плашка «нет связи» над композером"
      when="Канал браузера с сервером оборвался дольше чем на 2 с. Композер не блокируется: кнопка меняется на «В очередь», напечатанное уйдёт само. Повторы через 5 с, потом реже. Зелёная плашка висит 4 с и уходит."
      stage="end"
      basis="560px"
      grow={3}
      footExtra={(
        <Segmented
          ariaLabel="Показать состояние связи"
          size="sm"
          value={net}
          onChange={setNet}
          options={[{ value: 'lost', label: 'нет связи' }, { value: 'back', label: 'вернулась' }]}
        />
      )}
    >
      {isLost ? (
        <ConnectionBanner state="lost" attempt={3 + (Math.floor(tick / 5) % 4)} secondsToRetry={5 - cycle} retryShare={cycle / 5} onRetry={() => setTick(0)} />
      ) : (
        <ConnectionBanner state="back" downForSeconds={38} />
      )}
      <div className="kb-states-composer">
        <label htmlFor="kb-states-msg" className="kb-sr">Сообщение Claude</label>
        <textarea id="kb-states-msg" rows={2} defaultValue="Как закончишь выкладку — сними экраны карточек на 390 px" />
        <div className="kb-states-composer-bar">
          <span>{isLost ? 'напечатанное не пропадёт · уйдёт, когда связь вернётся' : 'сообщение из очереди отправлено · 14:33'}</span>
          <span className="kb-spacer" />
          <Button variant="pri" className="kb-states-send" data-queued={isLost ? '' : undefined}>
            <span>{isLost ? 'В очередь' : 'Отправить'}</span>
            <Kbd>⏎</Kbd>
          </Button>
        </div>
      </div>
    </Spec>
  );
}

function StoppedSpec() {
  // Whether «Продолжить с шага 22» was pressed in the demo.
  const [isResumed, setIsResumed] = useState(false);
  return (
    <Spec
      code="C2"
      name="Отметка «■ остановлено»"
      hide="в ленте навсегда"
      when="Ты удержал «Стоп» 1,5 с — только так ход обрывается; Esc и закрытие вкладки его не трогают. Отметка остаётся в истории, чтобы было видно, где прервалось."
      basis="400px"
      grow={2}
    >
      <div className="kb-m kb-claude-line">
        <svg width="13" height="13" viewBox="0 0 26 26" fill="none" aria-hidden="true"><circle cx="13" cy="13" r="11" stroke="#FF6A2B" strokeWidth="2" /><path d="M2 15h22" stroke="#FF6A2B" strokeWidth="2.4" /></svg>
        <b>CLAUDE</b><span>14:29</span>
      </div>
      <p className="kb-stopped-text" style={{ fontSize: 14, lineHeight: 1.6 }}>Снимаю экраны карточек и сверяю цены с таблицей — осталось 11 посёлков из 14…</p>
      <TurnStoppedMark
        at={new Date(2026, 9, 26, 14, 31)}
        step={22}
        summary={<>Правки до шага 22 сохранены — 3 файла. Начатый <code>npm run shots</code> прерван, фоновые агенты не тронуты.</>}
        onResume={() => setIsResumed(true)}
        onRollback={() => undefined}
        resumed={isResumed}
        onUndoResume={() => setIsResumed(false)}
      />
    </Spec>
  );
}

function PermissionSpecs() {
  // Bumped by «показать запрос снова» so the card starts fresh.
  const [bashRound, setBashRound] = useState(0);
  const [diffRound, setDiffRound] = useState(0);
  const [openedAt] = useState(() => Date.now());
  return (
    <>
      <Spec
        code="P1"
        name="Bash — команда на сервере"
        hide="только по ответу"
        when="Режим Default или Auto, и Claude хочет выполнить команду, которой нет в разрешённых. На паузе только этот шаг — фоновые агенты идут дальше."
        basis="520px"
      >
        <PermissionRequestCard
          key={`bash-${bashRound}`}
          toolName="Bash"
          waitingSince={openedAt - 2 * 60_000}
          reason="Классификатор остановил выкладку на прод: команда меняет живой сайт, а в этой сессии такое ещё не разрешалось."
          command="bash deploy.sh --prod demo-site.example"
          commandNote="40 цен, 3 посёлка"
          onAllowOnce={() => undefined}
          onAllowSession={() => undefined}
          onDeny={() => undefined}
          onShowAgain={() => setBashRound((value) => value + 1)}
          hotkeys
        />
      </Spec>
      <Spec
        code="P2"
        name="Edit / Write — правка файла с диффом"
        hide="только по ответу"
        when="Режим Default: каждая правка файла показывает дифф до записи. Длинный дифф сворачивается до 12 строк, остальное — по клику."
        basis="520px"
      >
        <PermissionRequestCard
          key={`diff-${diffRound}`}
          toolName="Edit"
          waitingSince={openedAt - 40_000}
          reason="Хочу поправить вывод цены: пустая цена сейчас показывается как «0 ₽», будет «цена по запросу»."
          diff={{ filePath: 'src/lib/price-format.ts', oldText: DIFF_OLD, newText: DIFF_NEW, startLine: 12 }}
          sessionScope="правки в src/lib"
          onAllowOnce={() => undefined}
          onAllowSession={() => undefined}
          onDeny={() => undefined}
          onShowAgain={() => setDiffRound((value) => value + 1)}
        />
      </Spec>
    </>
  );
}

const LIMIT_SPECS: Record<'L1' | 'L3', { name: string; hide: string; when: string; primary: string; secondary: string }> = {
  L1: {
    name: '80 % недели', hide: 'до 90 % или сброса', primary: 'Понятно', secondary: 'Подробнее',
    when: 'Недельный лимит пересёк 80 %. Один раз тостом, плашкой на главном — до «Понятно», повтор — на 90 %. Шкала та же, что в приборах «Лимиты».',
  },
  L3: {
    name: 'Кредиты сгорают', hide: 'до завтра', primary: 'Напомнить завтра', secondary: 'Подробнее',
    when: 'До сгорания облачных кредитов меньше 48 часов, а не потрачено больше 20 %. Раз в день.',
  },
};

function LimitsSpecs() {
  const [nowMs] = useState(() => Date.now());
  const warnings = useMemo(() => computeLimitWarnings(demoLimits(nowMs), nowMs), [nowMs]);
  // L4 demo answer: null shows the buttons.
  const [sessionOutcome, setSessionOutcome] = useState<'new' | 'stay' | null>(null);
  const ordered = ['L1', 'L3'].map((code) => warnings.find((warning) => warning.code === code)).filter(Boolean);
  return (
    <>
      {ordered.map((warning) => {
        if (!warning) return null;
        const spec = LIMIT_SPECS[warning.code];
        return (
          <Spec key={warning.code} code={warning.code} name={spec.name} hide={spec.hide} when={spec.when} basis="300px" pad20>
            <LimitWarningCard
              warning={warning}
              primaryAction={{ label: spec.primary, onClick: () => undefined }}
              secondaryAction={{ label: spec.secondary, onClick: () => undefined }}
            />
          </Spec>
        );
      })}
      <Spec
        code="L4"
        name="Большая сессия"
        hide="до решения"
        when="Файл сессии больше 250 МБ или лента открывается дольше 5 с. Показывается над композером; «Остаться» прячет до 400 МБ."
        basis="300px"
        pad20
      >
        <BigSessionNotice
          sizeBytes={340 * MB}
          sessionTitle="Выкладка цен"
          loadSeconds={9}
          filesCount={12}
          outcome={sessionOutcome}
          onNewWithSummary={() => setSessionOutcome('new')}
          onStay={() => setSessionOutcome('stay')}
          onUndo={() => setSessionOutcome(null)}
        />
      </Spec>
    </>
  );
}

function ErrorSpecs() {
  // Demo retry schedule: a new 20-second pause each time the previous one runs out.
  const [retryAt, setRetryAt] = useState(() => Date.now() + 20_000);
  useEffect(() => {
    const timer = window.setTimeout(() => setRetryAt(Date.now() + 20_000), Math.max(0, retryAt - Date.now()) + 300);
    return () => window.clearTimeout(timer);
  }, [retryAt]);
  // Selected mode in the E2 demo.
  const [mode, setMode] = useState('auto');
  return (
    <>
      <Spec
        code="E1"
        name="Ошибка API"
        hide="уходит после успеха"
        when="API вернул 429, 500 или 529 либо оборвался поток. Три автоповтора с паузой 20 с, дальше — только кнопкой. Сырой ответ спрятан под «Подробности»."
        basis="520px"
      >
        <ClaudeErrorCard
          kind={529}
          savedStep={14}
          retryAt={retryAt}
          attempt={2}
          maxAttempts={3}
          onRetryNow={() => setRetryAt(Date.now() + 20_000)}
          altAction={{ label: 'Сменить модель на Sonnet', onClick: () => undefined }}
          details={API_LOG}
        />
      </Spec>
      <Spec
        code="E2"
        name="Режим Bypass под root"
        hide="пока условие верно"
        when="Служба запущена от root, а ты наводишь или жмёшь на Bypass в правах — в композере и в Настройках. Объяснение раскрывается по месту, без модального окна."
        basis="520px"
      >
        <BypassRootCard mode={mode} onModeChange={setMode} />
      </Spec>
    </>
  );
}

const EMPTY_SPECS: Array<{ code: string; name: string; variant: 'projects' | 'chats' | 'calendar' | 'agents'; when: string; text?: string; hint?: string }> = [
  { code: 'Z1', name: 'Нет проектов', variant: 'projects', when: 'Первый запуск панели или все проекты убраны в архив. Главный экран показывает только этот блок.' },
  { code: 'Z2', name: 'Нет диалогов', variant: 'chats', when: 'Проект только добавлен. Ниже — подсказка «Разобрать проект и составить CLAUDE.md» для старта.' },
  { code: 'Z3', name: 'Пустой календарь', variant: 'calendar', hint: 'ближайшее — чт 30.10, 12:00', when: 'В выбранный день нет звонков, встреч и сообщений. Показываем ближайшее будущее событие, если оно есть.' },
  {
    code: 'Z4', name: 'Нет агентов в работе', variant: 'agents', text: 'Последний закончил в 13:58 — Карта участков, SEO-тексты, 14 из 14.',
    when: 'Ни одного хода и фонового агента ни в одном проекте. Блок «В работе» на главном сворачивается до этой строки.',
  },
];

type KabinaStatesShowcaseProps = { isPhone: boolean };

/**
 * Rendered by KabinaApp at `/states`: the service page of DarkStates — every
 * state component of the Kabina layer live on demo data, with the mock-up's
 * «КОГДА» notes, to check them by eye next to the mock-up. The Telegram
 * section (08) belongs to the notifications screen.
 */
export default function KabinaStatesShowcase({ isPhone }: KabinaStatesShowcaseProps) {
  const ruler = (id: string, index: string, title: string, meta: string) => (
    <SectionRuler id={id} index={index} title={title}>
      {!isPhone && <span className="kb-m kb-ruler-meta">{meta}</span>}
    </SectionRuler>
  );

  return (
    <div className="kb-states">
      <section className="kb-states-intro kb-rise" aria-labelledby="kb-states-h">
        <div className="kb-states-intro-copy">
          <span className="kb-m kb-states-eyebrow">СПЕЦИФИКАЦИЯ · ЖИВЫЕ КОМПОНЕНТЫ</span>
          <h1 id="kb-states-h" className="kb-t kb-states-h1">Состояния и уведомления</h1>
          <p className="kb-states-lead">
            Как кабина говорит с тобой, когда что-то случилось. Каждый блок — настоящий компонент: кнопки нажимаются, счётчики идут. Под ним —
            когда показывается и как уходит.
          </p>
        </div>
        <div className="kb-states-legend">
          <span className="kb-m kb-states-legend-title">ЯЗЫК СИГНАЛОВ</span>
          <ul>
            {LEGEND.map((item) => (
              <li key={item.kind}>
                <StatusShape kind={item.kind} />
                <b>{item.name}</b>
                <span>· {item.mean}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <nav aria-label="Разделы листа" className="kb-states-toc kb-rise kb-d1">
        {TOC.map(([index, name, id]) => (
          <a key={id} className="kb-chip kb-m" href={`#${id}`}><span className="kb-chip-n">{index}</span>{name}</a>
        ))}
      </nav>

      <section id="s-toasts" className="kb-states-section kb-rise kb-d2" aria-labelledby="h-toasts">
        {ruler('h-toasts', '01', 'УВЕДОМЛЕНИЯ', 'колокольчик в шапке · без всплывающих тостов')}
        <div className="kb-states-grid">
          <NotificationsSpec />
          <NotificationKindsSpec />
        </div>
      </section>

      <section id="s-flow" className="kb-states-section" aria-labelledby="h-flow">
        {ruler('h-flow', '02', 'СВЯЗЬ И ХОД', 'внутри чата')}
        <div className="kb-states-grid">
          <ConnectionSpec />
          <StoppedSpec />
        </div>
      </section>

      <section id="s-perm" className="kb-states-section" aria-labelledby="h-perm">
        {ruler('h-perm', '03', 'ЗАПРОС РАЗРЕШЕНИЯ', 'в ленте, на паузе только этот шаг')}
        <div className="kb-states-grid">
          <PermissionSpecs />
        </div>
      </section>

      <section id="s-limits" className="kb-states-section" aria-labelledby="h-limits">
        {ruler('h-limits', '04', 'ЛИМИТЫ И ТЯЖЁЛЫЕ СЕССИИ', 'плашка на главном и в чате · Max 20×')}
        <div className="kb-states-grid" data-aligned="">
          <LimitsSpecs />
        </div>
      </section>

      <section id="s-errors" className="kb-states-section" aria-labelledby="h-errors">
        {ruler('h-errors', '05', 'ОШИБКИ CLAUDE', 'всегда — что случилось и что делать')}
        <div className="kb-states-grid">
          <ErrorSpecs />
        </div>
      </section>

      <section id="s-empty" className="kb-states-section" aria-labelledby="h-empty">
        {ruler('h-empty', '06', 'ПУСТЫЕ СОСТОЯНИЯ', 'всегда с одним следующим шагом')}
        <div className="kb-states-grid">
          {EMPTY_SPECS.map((spec) => (
            <Spec key={spec.code} code={spec.code} name={spec.name} when={spec.when} basis="300px">
              <EmptyState variant={spec.variant} text={spec.text} hint={spec.hint} onAction={() => undefined} />
            </Spec>
          ))}
        </div>
      </section>

      <section id="s-load" className="kb-states-section" aria-labelledby="h-load">
        {ruler('h-load', '07', 'ЗАГРУЗКА', 'скелетон держит форму — ничего не прыгает')}
        <div className="kb-states-grid">
          <Spec
            code="S1"
            name="Скелетон ленты"
            hide="с 200 мс"
            when="Открываешь диалог, а история ещё едет с сервера. До 200 мс — ничего, чтобы не мигало. Дольше 5 с — подпись меняется на «сессия большая» и предлагает L4."
            basis="560px"
            grow={3}
          >
            <FeedSkeleton loaded={84} total={212} />
          </Spec>
          <Spec
            code="S2"
            name="Скелетон списка"
            hide="с 200 мс"
            when="Список проектов, диалогов или агентов при первом открытии. Столько строк, сколько было в прошлый раз, — высота не прыгает, когда приходят данные."
            basis="400px"
            grow={2}
          >
            <ListSkeleton title="ДИАЛОГИ" rows={6} />
          </Spec>
        </div>
      </section>
    </div>
  );
}

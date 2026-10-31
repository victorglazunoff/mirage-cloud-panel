import { Skeleton } from '@/modules/kabina';
import { useCommandPreviewData } from '@/modules/kabina-commands/hooks/useCommandPreviewData';
import {
  COMMAND_DETAILS,
  CONTEXT_CATEGORY_NAMES,
  MENU_GROUP_LABELS,
  commandSpecial,
  formatTokens,
  parseArgs,
} from '@/modules/kabina-commands/utils/commandMenuModel';
import type { CommandCatalogEntry } from '@/shared/types';
import { tildePath } from '@/shared/utils';

type CommandPreviewProps = {
  entry: CommandCatalogEntry;
  sessionId: string | null;
  onRun: () => void;
  onComplete: () => void;
  /** /model and /effort options: run the command with the picked value. */
  onChoose: (value: string) => void;
};

const SEGMENT_COLORS = ['var(--kb-signal)', 'rgba(255,106,43,0.55)', 'rgba(255,106,43,0.3)', 'var(--kb-sand)', '#7A7266', '#5E584F'];

const MODEL_NOTES: Record<string, string> = {
  opus: 'выводы, архитектура, дизайн',
  sonnet: 'правки по плану, исследования',
  haiku: 'поиск, выгрузки, механика',
};

const EFFORT_NOTES: Record<string, string> = {
  low: 'быстро, для механики',
  medium: 'обычные правки',
  high: 'по умолчанию для сессии',
  xhigh: 'сложные места, дольше',
  max: 'максимум размышлений',
  ultracode: 'включает воркфлоу',
};

/** Russian one-liner for a model row: known families get the user's own rule of thumb. */
function modelNote(value: string, label: string, description: string | undefined): string {
  const text = `${value} ${label}`.toLowerCase();
  const wide = text.includes('1m') ? ' · 1M контекста' : '';
  if (text.includes('plan')) return 'Opus планирует, Sonnet делает';
  if (text.includes('default')) return 'рекомендованная для аккаунта';
  if (text.includes('best')) return 'самая сильная из доступных';
  if (text.includes('fable')) return `самые сложные и долгие задачи${wide}`;
  const family = modelFamily(value);
  if (MODEL_NOTES[family]) return `${MODEL_NOTES[family]}${wide}`;
  return description || value;
}

function modelFamily(value: string): string {
  const lower = value.toLowerCase();
  return ['opus', 'sonnet', 'haiku'].find((family) => lower.includes(family)) ?? lower;
}

function Fact({ k, v, tone }: { k: string; v: string; tone?: 'accent' | 'sand' | 'ok' }) {
  const color = tone === 'accent' ? 'var(--kb-signal-text)' : tone === 'sand' ? 'var(--kb-sand)' : tone === 'ok' ? 'var(--kb-sage)' : undefined;
  return (
    <div className="kbm-fact">
      <span className="kbm-fact-k">{k}</span>
      <span className="kb-m kbm-fact-v" style={color ? { color } : undefined}>{v}</span>
    </div>
  );
}

function Loading() {
  return (
    <div className="kbm-section" aria-hidden="true">
      <Skeleton width="60%" />
      <Skeleton height={14} />
      <Skeleton width="80%" />
    </div>
  );
}

/**
 * Right-hand card of the «/» menu (DarkCommands): what the selected command does, its
 * arguments and an example, plus live data for the commands that have it — the context
 * bar for /context and /compact, tokens and money for /cost, plan limits for /usage,
 * a model or effort choice for /model and /effort, and where a skill lives.
 */
export default function CommandPreview({ entry, sessionId, onRun, onComplete, onChoose }: CommandPreviewProps) {
  const special = commandSpecial(entry);
  const data = useCommandPreviewData(special, sessionId);
  const detail = COMMAND_DETAILS[entry.name];
  const argList = detail?.args ?? parseArgs(entry.args);
  const example = detail?.example ?? (entry.args ? `${entry.name} ${entry.args.replace(/[[\]<>]/g, '')}` : entry.name);
  const groupLabel = entry.group === 'mine' ? MENU_GROUP_LABELS.mine : MENU_GROUP_LABELS[entry.group] ?? entry.groupLabel.toUpperCase();

  let block = null;
  if (special === 'context') {
    const usage = data.context;
    if (!sessionId) {
      block = <div className="kbm-section"><span className="kbm-note">Открой диалог — покажу, чем занят его контекст.</span></div>;
    } else if (!data.settled) {
      block = <Loading />;
    } else if (!usage) {
      block = <div className="kbm-section"><span className="kbm-note">Контекст этой сессии сейчас не прочитать.</span></div>;
    } else {
      const used = usage.categories.filter((category) => category.kind === 'used' && category.tokens > 0)
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, SEGMENT_COLORS.length);
      const threshold = usage.autoCompactThreshold && usage.maxTokens ? Math.round((usage.autoCompactThreshold / usage.maxTokens) * 100) : null;
      const spoken = used.map((category) => `${CONTEXT_CATEGORY_NAMES[category.id] ?? category.name} ${Math.round(category.percentage)}%`).join(', ');
      block = (
        <div className="kbm-section">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span className="kb-m kbm-cap" style={{ color: 'var(--kb-head)', whiteSpace: 'nowrap' }}>КОНТЕКСТ СЕЙЧАС</span>
            <span style={{ flex: 1 }} />
            <span
              className="kb-t"
              title={usage.estimated ? 'оценка по последнему ходу — сессия сейчас не запущена' : undefined}
              style={{ fontSize: 20, fontWeight: 500, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
            >
              {usage.estimated ? '≈' : ''}{Math.round(usage.percentage)}%
            </span>
            <span className="kb-m" style={{ fontSize: 10.5, color: 'var(--kb-mute)', whiteSpace: 'nowrap' }}>{formatTokens(usage.totalTokens)} / {formatTokens(usage.maxTokens)}</span>
          </div>
          <div style={{ position: 'relative', paddingBottom: 18 }}>
            <div className="kbm-ctx-bar" role="img" aria-label={`Занято ${Math.round(usage.percentage)}% контекста: ${spoken}${threshold ? `. Авто-сжатие на ${threshold}%` : ''}`}>
              {used.map((category, index) => (
                <span key={category.id} style={{ width: `${Math.max(0.6, category.percentage)}%`, background: SEGMENT_COLORS[index] }} />
              ))}
            </div>
            <span className="kbm-ctx-ticks" aria-hidden="true" />
            {threshold !== null && (
              <>
                <span className="kbm-ctx-mark" aria-hidden="true" style={{ left: `${threshold}%` }} />
                <span className="kb-m kbm-ctx-mark-label" aria-hidden="true" style={{ left: `${threshold}%` }}>авто-сжатие {threshold}%</span>
              </>
            )}
          </div>
          <div className="kbm-legend">
            {used.map((category, index) => (
              <div key={category.id} className="kbm-legend-row">
                <i aria-hidden="true" style={{ background: SEGMENT_COLORS[index] }} />
                <span className="kbm-legend-k">{CONTEXT_CATEGORY_NAMES[category.id] ?? category.name}</span>
                <span className="kb-m kbm-legend-v">{formatTokens(category.tokens)}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }
  } else if (special === 'cost') {
    const totals = data.context?.session;
    block = !sessionId
      ? <div className="kbm-section"><span className="kbm-note">Открой диалог — посчитаю его токены и стоимость.</span></div>
      : !data.settled ? <Loading /> : (
        <div className="kbm-section" style={{ gap: 0, paddingTop: 6 }}>
          <Fact k="Вход" v={totals ? `${formatTokens(totals.inputTokens)} токенов` : '—'} />
          <Fact k="Выход" v={totals ? `${formatTokens(totals.outputTokens)} токенов` : '—'} />
          <Fact k="Из кэша" v={totals ? `${formatTokens(totals.cacheReadTokens)} токенов` : '—'} />
          <Fact k="Итого за сессию" v={totals?.costUsd != null ? `$${totals.costUsd.toFixed(2).replace('.', ',')}` : 'по подписке'} tone="accent" />
        </div>
      );
  } else if (special === 'usage') {
    const limits = data.limits;
    block = !data.settled ? <Loading /> : (
      <div className="kbm-section" style={{ gap: 0, paddingTop: 6 }}>
        <Fact k="Неделя · все модели" v={limits?.weekly ? `${Math.round(limits.weekly.percent)}%` : '—'} />
        {limits?.credits && (
          <Fact k="Облачные кредиты" v={`$${Math.round(limits.credits.limitDollars - limits.credits.remainingDollars)} / ${Math.round(limits.credits.limitDollars)}`} tone="sand" />
        )}
        {limits && limits.status !== 'ok' && <Fact k="Данные" v={limits.status === 'stale' ? 'последние известные' : 'нет доступа'} tone="sand" />}
      </div>
    );
  } else if (special === 'model' || special === 'effort') {
    const isModel = special === 'model';
    const options = isModel
      ? data.models.map((model) => ({ value: model.value, name: model.label, sub: modelNote(model.value, model.label, model.description) }))
      : (data.effortLevels.length ? data.effortLevels : ['medium', 'high', 'xhigh', 'ultracode']).map((level) => ({ value: level, name: level, sub: EFFORT_NOTES[level] ?? '' }));
    const current = isModel ? data.currentModel : data.currentEffort;
    // A session may report a full model id while the list offers aliases; then the family decides.
    const hasExact = options.some((option) => option.value === current);
    const isCurrent = (value: string) => Boolean(current) && (hasExact ? value === current : isModel && modelFamily(value) === modelFamily(current ?? ''));
    block = !data.settled ? <Loading /> : (
      <div className="kbm-section" role="radiogroup" aria-label={isModel ? 'Модель' : 'Уровень усилия'} style={{ gap: 6 }}>
        {options.map((option) => {
          const checked = isCurrent(option.value);
          return (
            <button key={option.value} type="button" role="radio" aria-checked={checked} className="kbm-opt" onClick={() => onChoose(option.value)}>
              <span className="kbm-radio" aria-hidden="true"><i /></span>
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span className="kb-t kbm-opt-name">{option.name}</span>
                {option.sub && <span className="kbm-opt-sub">{option.sub}</span>}
              </span>
              <span className="kb-m kbm-opt-mark">{checked ? (isModel ? 'ТЕКУЩАЯ' : 'СЕЙЧАС') : ''}</span>
            </button>
          );
        })}
        {options.length === 0 && <span className="kbm-note">Список моделей не пришёл — набери /model и имя модели.</span>}
      </div>
    );
  } else if (special === 'skill') {
    block = (
      <div className="kbm-section" style={{ gap: 0, paddingTop: 6 }}>
        <Fact k="Где лежит" v={entry.path ? tildePath(entry.path).replace(/\/SKILL\.md$/i, '') : entry.source === 'plugin' ? 'плагин' : '—'} />
        <Fact k="В контексте" v="только описание, пока не вызван" />
        <Fact k="Запуск" v="в этом диалоге, после шага" tone="ok" />
      </div>
    );
  }

  return (
    <aside className="kbm-preview kb-bz" aria-label="Превью команды" aria-live="polite">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="kb-m kbm-cap">{groupLabel}</span>
          <span style={{ flex: 1 }} />
          {entry.shortcut && <span className="kb-m kbm-key">{entry.shortcut}</span>}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 10px' }}>
          <span className="kb-t kbm-pv-name">{entry.name}</span>
          {entry.args && <span className="kb-m" style={{ fontSize: 12, color: 'var(--kb-mute)' }}>{entry.args}</span>}
        </div>
        <p className="kbm-what">{detail?.what ?? `${entry.description}.`}</p>
      </div>

      {block}

      {argList.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="kb-m kbm-cap">АРГУМЕНТЫ</span>
          {argList.map((arg) => (
            <div key={arg.a} className="kbm-arg">
              <span className="kb-m kbm-arg-a">{arg.a}</span>
              <span style={{ color: 'var(--kb-soft)', textWrap: 'pretty' }}>{arg.d}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="kb-m kbm-cap">ПРИМЕР</span>
        <code className="kb-m kbm-example">{example}</code>
      </div>

      <div className="kbm-actions">
        <button type="button" className="kbm-pri" onClick={onRun}>
          <span>Выполнить</span><span className="kb-m kbm-pri-key kb-keys">↵</span>
        </button>
        <button type="button" className="kbm-sec" onClick={onComplete}>
          <span>Дополнить</span><span className="kb-m kbm-sec-key kb-keys">Tab</span>
        </button>
      </div>
    </aside>
  );
}

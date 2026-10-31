import '@/modules/kabina-commands/kabinaCommands.css';

/** Input prefixes of the composer (DarkCommands «ПРЕФИКСЫ»). */
export type ComposerPrefix = '/' | '@' | '!' | '#';

const PREFIXES: Array<{ key: ComposerPrefix; label: string }> = [
  { key: '/', label: 'команды' },
  { key: '@', label: 'файлы и агенты' },
  { key: '!', label: 'терминал' },
  { key: '#', label: 'в память' },
];

/** What each prefix does, for the hint line above the composer. */
export const PREFIX_HINTS: Record<ComposerPrefix, string> = {
  '/': 'Claude продолжает ход — команда встанет после текущего шага',
  '@': 'Упомяни файл или агента — @src/, @seo-specialist',
  '!': 'Выполню на сервере и положу вывод в беседу',
  '#': 'Допишу строку в CLAUDE.md проекта',
};

type SlashPrefixBarProps = {
  /** The composer text; its first character marks the active prefix. */
  value: string;
  /** Puts the prefix into the input (the composer decides whether to replace or prepend). */
  onPick: (prefix: ComposerPrefix) => void;
};

/**
 * Used by the chat composer above its input (and by the «/» test page): the four input
 * prefixes `/ @ ! #` as pressable chips; the one the text starts with is highlighted.
 */
export default function SlashPrefixBar({ value, onPick }: SlashPrefixBarProps) {
  const lead = value.trimStart().charAt(0);
  return (
    <div className="kbm-prefixes">
      <span id="kbm-pfx-label" className="kb-m kbm-cap" style={{ letterSpacing: '0.18em' }}>ПРЕФИКСЫ</span>
      <div role="group" aria-labelledby="kbm-pfx-label" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {PREFIXES.map((prefix) => (
          <button
            key={prefix.key}
            type="button"
            className="kbm-prefix"
            aria-pressed={lead === prefix.key}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(prefix.key)}
          >
            <span className="kb-m kbm-prefix-key">{prefix.key}</span>
            {prefix.label}
          </button>
        ))}
      </div>
    </div>
  );
}

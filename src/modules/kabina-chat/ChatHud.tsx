import { useRef } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { HudMeter, HudPopover, KabinaHud } from '@/modules/kabina';
import { ChevronUp, Equalizer, SideIcon } from '@/modules/kabina-chat/ChatIcons';
import type { TurnView } from '@/modules/kabina-chat/ChatStatusLine';
import { plural } from '@/modules/kabina-chat/utils/chatFormat';

type ChatHudProps = {
  isPhone: boolean;
  projectName: string;
  title: string;
  /** «7», «7+» — dialogs of the project. */
  dialogsCount: string;
  /** The navigator (ChatNavigator: this project, all projects, search), shown up from the HUD on a computer. */
  dialogs: ReactNode;
  isDialogsOpen: boolean;
  onToggleDialogs: () => void;
  onCloseDialogs: () => void;
  turn: TurnView;
  agentsCount: number;
  /** «цены · скриншоты» — what the subagents do (the link's tooltip). */
  agentsNames?: string;
  /** The turn waits: scroll to the decision card; otherwise to the end of the feed. */
  onTurnClick: () => void;
  /** Context use: percent and «240k / 1M» for the label. */
  contextPercent: number | null;
  contextTokens: string | null;
  isContextOpen: boolean;
  onToggleContext: () => void;
  artifactsCount: number;
  isArtifactOpen: boolean;
  onToggleArtifacts: () => void;
};

/**
 * Rendered by the kabina-chat screen: its own HUD (ChatLayoutB). Left — project and dialog,
 * which opens the dialogs list up from the strip; centre — the turn (clock, step, waiting,
 * subagents); after the limits — КТКСТ (context panel) and АРТ (artifact beside the feed).
 * Phone: one row under the chat header — the turn cell and the instruments.
 */
export default function ChatHud(props: ChatHudProps) {
  const {
    isPhone, projectName, title, dialogsCount, dialogs, isDialogsOpen, onToggleDialogs, onCloseDialogs, turn, agentsCount, agentsNames,
    onTurnClick, contextPercent, contextTokens, isContextOpen, onToggleContext, artifactsCount, isArtifactOpen, onToggleArtifacts,
  } = props;
  const leftRef = useRef<HTMLDivElement>(null);
  const ledClass = turn.tone === 'wait' ? 'kb-led-wait' : turn.tone === 'run' ? 'kb-led-run' : 'kb-led-idle';
  const statusWords = turn.tone === 'wait' ? 'ждёт твоего решения ↑' : turn.statusText.replace(/^·\s*/, '');
  const agentsWord = `${agentsCount} ${plural(agentsCount, 'субагент', 'субагента', 'субагентов')}`;

  const extra = (
    <>
      <HudMeter
        label="КТКСТ"
        value={contextPercent === null ? '—' : String(contextPercent)}
        unit={contextPercent === null ? undefined : '%'}
        percent={contextPercent}
        ariaLabel={`Контекст: ${contextPercent === null ? 'нет данных' : `${contextPercent} %`}${contextTokens ? `, ${contextTokens}` : ''} — ${isContextOpen ? 'закрыть' : 'открыть'} панель`}
        isPhone={isPhone}
        expanded={isContextOpen}
        hasPopup={isPhone}
        onClick={onToggleContext}
      />
      <HudMeter
        label="АРТ"
        value={String(artifactsCount)}
        percent={null}
        icon={isPhone ? <SideIcon size={12} /> : false}
        ariaLabel={artifactsCount === 0
          ? 'Артефактов в этом диалоге нет'
          : `Артефакты диалога: ${artifactsCount} — ${isArtifactOpen ? 'закрыть' : 'открыть рядом с лентой'}`}
        isPhone={isPhone}
        expanded={isArtifactOpen}
        hasPopup={isPhone}
        disabled={artifactsCount === 0 && !isArtifactOpen}
        onClick={onToggleArtifacts}
      />
    </>
  );

  if (isPhone) {
    const caption = turn.tone === 'wait' ? 'ЖДЁТ ТЕБЯ ↓' : turn.running ? 'РАБОТАЕТ' : 'ХОД НЕ ИДЁТ';
    return (
      <KabinaHud
        isPhone
        extra={extra}
        center={(
          <button
            type="button"
            className="kb-hud-cell kb-hud-turn"
            aria-label={turn.running
              ? `Ход ${turn.elapsed}, шаг ${turn.steps}${turn.tone === 'wait' ? ', ждёт твоего решения' : ''} — показать`
              : 'Ход не идёт — к последнему сообщению'}
            onClick={onTurnClick}
          >
            <span className="kb-m kb-hud-cap" data-tone={turn.tone}>{caption}</span>
            <span className="kb-hud-turn-line">
              <span className={`kb-led ${ledClass}`} />
              {turn.running ? (
                <span className="kb-m">{turn.elapsed}<span className="kbc-hud-dim"> · ш{turn.steps}</span></span>
              ) : (
                <span className="kb-m kbc-hud-dim">тихо{turn.steps > 0 ? ` · ш${turn.steps}` : ''}</span>
              )}
              {agentsCount > 0 && (
                <>
                  <Equalizer />
                  <span className="kb-m kbc-hud-dim">{agentsCount}</span>
                </>
              )}
            </span>
          </button>
        )}
      />
    );
  }

  return (
    <KabinaHud
      isPhone={false}
      left={(
        <div ref={leftRef} className="kbc-hud-dlg-wrap">
          <button
            type="button"
            className="kb-hud-cell kbc-hud-dlg"
            aria-haspopup="dialog"
            aria-expanded={isDialogsOpen}
            aria-label={`Диалоги проекта ${projectName} — ${isDialogsOpen ? 'закрыть список' : 'открыть список'}`}
            onClick={onToggleDialogs}
          >
            <span className="kb-hud-mark" aria-hidden="true" />
            <ChevronUp size={10} className="kbc-hud-chev" />
            <span className="kbc-hud-mark kb-t" aria-hidden="true">{projectName.slice(0, 1).toUpperCase()}</span>
            <span className="kbc-hud-proj">{projectName}</span>
            <span className="kb-m kbc-hud-slash" aria-hidden="true">/</span>
            <span className="kbc-hud-title">{title}</span>
            <span className="kb-m kbc-hud-count">{dialogsCount}</span>
          </button>
          <HudPopover open={isDialogsOpen} onClose={onCloseDialogs} anchorRef={leftRef} align="left" label="Диалоги и проекты" className="kbc-dlg-pop kbn-pop">
            {dialogs}
          </HudPopover>
        </div>
      )}
      center={(
        <div className="kb-hud-center kbc-hud-turn" role="status" aria-live="polite">
          <span className={`kb-led ${ledClass}`} />
          {turn.running ? (
            <>
              <button type="button" className="kbc-hud-turnbtn kb-m" onClick={onTurnClick} aria-label={`Ход ${turn.elapsed}, шаг ${turn.steps} — показать`}>
                ХОД <b>{turn.elapsed}</b> · ШАГ <b>{turn.steps}</b>
              </button>
              <span className="kbc-hud-scan" aria-hidden="true"><span className="kb-scan" /></span>
              <span className="kb-m kbc-hud-status" data-tone={turn.tone}>{statusWords}</span>
            </>
          ) : (
            <span className="kb-m kbc-hud-status">
              ход не идёт{turn.steps > 0 ? ` · в прошлом ${turn.steps} ${plural(turn.steps, 'шаг', 'шага', 'шагов')}` : ''}
            </span>
          )}
          {agentsCount > 0 && (
            <>
              <span className="kb-hud-sep" aria-hidden="true" />
              <Link className="kbc-hud-agents kb-lnk" to="/agents" title={agentsNames || undefined} aria-label={`${agentsWord} работают — открыть агентов`}>
                <Equalizer />
                <span><b>{agentsCount}</b> {plural(agentsCount, 'субагент', 'субагента', 'субагентов')}</span>
              </Link>
            </>
          )}
        </div>
      )}
      extra={extra}
    />
  );
}

import { Fragment } from 'react';
import type { MouseEvent } from 'react';
import { Link } from 'react-router-dom';

import { NotificationBell } from '@/modules/kabina/shell/NotificationCenter';
import { Kbd } from '@/modules/kabina/ui/Chip';
import { Clock } from '@/modules/kabina/ui/Clock';
import { ChevronLeftIcon, FolderIcon, KabinaLogoMark, SearchIcon, SlidersIcon } from '@/modules/kabina/ui/KabinaIcons';
import type { KabinaCrumb } from '@/shared/types';

/** Where the tool screens (Файлы, Настройки) lead back to: the toggles, the phone «‹». */
type KabinaToolReturn = { label: string; href: string; onBack: () => void };

type KabinaHeaderProps = {
  isPhone: boolean;
  /** The trail after the logo; every step with `to` is a link, the last one is the page itself. */
  crumbs?: KabinaCrumb[];
  searchPlaceholder: string;
  filesHref: string;
  /** Which tool is the current page, for aria-current. */
  current?: 'files' | 'settings' | 'home' | null;
  onOpenSearch: () => void;
  /**
   * Computer: a place after the trail a screen fills through a portal (the chat — its crumbs,
   * dialog meta and the project tabs, ChatLayoutB's one-row header).
   */
  slotRef?: (node: HTMLDivElement | null) => void;
  /** On «Файлы» / «Настройки»: their buttons become «вернуться», the phone gets «‹». */
  toolReturn?: KabinaToolReturn | null;
};

/** «Вернуться на главный», «Вернуться в «Сайт клиента · Фид Авито»». */
function returnPhrase(label: string): string {
  return label === 'главный' ? 'Вернуться на главный' : `Вернуться в «${label}»`;
}

/** A plain click goes back through history; ⌘/Ctrl-click still opens the address in a new tab. */
function backClick(toolReturn: KabinaToolReturn) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    toolReturn.onBack();
  };
}

/**
 * Rendered by KabinaShell: logo → главный, the crumbs, clock, ⌘K field, Files and Settings
 * (DarkMain / DarkPhoneMain / ChatLayoutB). Files and Settings are toggles: on their own screen
 * the same button returns to where the panel was. The bell lives in the HUD on a computer, in
 * the header on the phone.
 */
export default function KabinaHeader({ isPhone, crumbs, searchPlaceholder, filesHref, current, onOpenSearch, slotRef, toolReturn }: KabinaHeaderProps) {
  const logo = (
    <Link
      to="/"
      className="kb-logo"
      aria-label="Mirage — главный экран"
      title="Главный экран"
      aria-current={current === 'home' ? 'page' : undefined}
    >
      <KabinaLogoMark size={isPhone ? 26 : crumbs ? 26 : 28} />
      <span className="kb-t kb-logo-word">MIRAGE</span>
    </Link>
  );

  const returnHint = toolReturn ? returnPhrase(toolReturn.label) : '';
  const filesButton = current === 'files' && toolReturn ? (
    <Link
      className="kb-ib"
      to={toolReturn.href}
      aria-label={`Файлы открыты. ${returnHint}`}
      title={returnHint}
      aria-current="page"
      onClick={backClick(toolReturn)}
    >
      <FolderIcon />
    </Link>
  ) : (
    <Link className="kb-ib" to={filesHref} aria-label="Файлы" title="Файлы">
      <FolderIcon />
    </Link>
  );
  const settingsButton = current === 'settings' && toolReturn ? (
    <Link
      className="kb-ib"
      to={toolReturn.href}
      aria-label={`Настройки открыты. ${returnHint}`}
      title={returnHint}
      aria-current="page"
      onClick={backClick(toolReturn)}
    >
      <SlidersIcon />
    </Link>
  ) : (
    <Link className="kb-ib" to="/settings" aria-label="Настройки" title="Настройки">
      <SlidersIcon />
    </Link>
  );

  return (
    <header className="kb-header" data-phone={isPhone ? '' : undefined} data-slot={slotRef && !isPhone ? '' : undefined}>
      {isPhone && toolReturn && (
        <Link className="kb-ib kb-back" data-quiet="" to={toolReturn.href} aria-label={`Назад. ${returnHint}`} title={returnHint} onClick={backClick(toolReturn)}>
          <ChevronLeftIcon />
        </Link>
      )}
      {crumbs && crumbs.length > 0 && !isPhone ? (
        <nav className="kb-crumbs" aria-label="Где ты">
          {logo}
          {crumbs.map((crumb, index) => {
            const isLast = index === crumbs.length - 1;
            return (
              <Fragment key={`${crumb.label}-${index}`}>
                <span className="kb-m kb-crumb-sep" aria-hidden="true">//</span>
                {crumb.to ? (
                  <Link
                    className="kb-crumb kb-crumb-link kb-lnk"
                    to={crumb.to}
                    title={crumb.hint ?? crumb.label}
                    aria-current={isLast ? 'page' : undefined}
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span className="kb-crumb" aria-current={isLast ? 'page' : undefined} title={crumb.label}>{crumb.label}</span>
                )}
              </Fragment>
            );
          })}
        </nav>
      ) : (
        logo
      )}

      {slotRef && !isPhone ? <div ref={slotRef} className="kb-header-slot" /> : null}
      <Clock compact={isPhone} />
      {!(slotRef && !isPhone) && <div className="kb-spacer" />}

      {!isPhone && (
        <button type="button" className="kb-search-field kb-cmd" onClick={onOpenSearch} aria-keyshortcuts="Meta+K Control+K">
          <SearchIcon stroke="#B3AA9B" />
          <span className="kb-search-text">{searchPlaceholder}</span>
          <Kbd>⌘K</Kbd>
        </button>
      )}

      <div className="kb-tools">
        {isPhone && <NotificationBell isPhone />}
        {filesButton}
        {settingsButton}
      </div>
    </header>
  );
}

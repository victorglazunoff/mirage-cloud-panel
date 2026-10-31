import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import '@/modules/kabina/kabinaHud.css';
import { useKabinaLiveSummary } from '@/modules/kabina/context/KabinaHudContext';
import { NotificationBell } from '@/modules/kabina/shell/NotificationCenter';
import { Sheet } from '@/modules/kabina/ui/Modal';
import { toPanelWall } from '@/modules/kabina/ui/panelTime';
import { LIMITS_DETAILS_FLAG } from '@/modules/kabina/utils/kabinaRoutes';
import { useEscapeLayer } from '@/shared/hooks/useEscapeLayer';
import { isSubscriptionLimitsEnabled, useSubscriptionLimits } from '@/shared/hooks/useSubscriptionLimits';
import type { SubscriptionLimits } from '@/shared/types';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const UNAVAILABLE_TEXT: Record<NonNullable<SubscriptionLimits['reason']>, string> = {
  'no-credentials': 'На сервере нет входа Claude Code — войди в claude, и лимиты появятся.',
  'token-expired': 'Токен Claude истёк. Он обновится сам при следующем запросе в любой сессии.',
  'upstream-error': 'Anthropic сейчас не отдал лимиты. Повторю через минуту.',
};

/** Fill level of an instrument: quiet below half, sand to 80 %, signal orange above. */
function meterLevel(percent: number | null): 'calm' | 'mid' | 'hot' | 'none' {
  if (percent === null || !Number.isFinite(percent)) return 'none';
  if (percent >= 80) return 'hot';
  if (percent >= 50) return 'mid';
  return 'calm';
}

function wordFor(count: number, one: string, few: string, many: string): string {
  const tens = count % 100;
  const units = count % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
}

/** «через 3 ч 41 мин · в 18:13» or «чт 5:00 · через 2 дн 14 ч» — when a window resets. */
function resetText(iso: string | null, nowMs: number): string {
  if (!iso) return 'время сброса неизвестно';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 'время сброса неизвестно';
  const wall = toPanelWall(at);
  const clock = `${wall.getHours()}:${String(wall.getMinutes()).padStart(2, '0')}`;
  const minutes = Math.max(0, Math.ceil((at - nowMs) / MINUTE_MS));
  if (at - nowMs < DAY_MS) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    const left = hours > 0 ? `${hours} ч${rest ? ` ${rest} мин` : ''}` : `${rest} мин`;
    return `сброс через ${left} · в ${clock}`;
  }
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  return `сброс ${WEEKDAYS[wall.getDay()]} ${clock} · осталось ${days} ${wordFor(days, 'день', 'дня', 'дней')}${hours ? ` ${hours} ч` : ''}`;
}

/** Share of the 7-day window already behind (0..1), from its reset time. */
function weekElapsed(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const end = Date.parse(iso);
  if (Number.isNaN(end)) return null;
  return Math.min(1, Math.max(0, (nowMs - (end - 7 * DAY_MS)) / (7 * DAY_MS)));
}

function shortDay(iso: string | null): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const wall = toPanelWall(at);
  return `${wall.getDate()} ${MONTHS[wall.getMonth()]}`;
}

type HudMeterProps = {
  /** Mono caption: «НЕД», «$», «КТКСТ», «АРТ». */
  label: string;
  value: string;
  /** Quieter tail of the value: «%», «/250». */
  unit?: string;
  /** Fill of the bar (phone: the ring), 0–100; null — no data. */
  percent: number | null;
  ariaLabel: string;
  isPhone: boolean;
  /** Its panel is open: the instrument lights up. */
  expanded?: boolean;
  /** `dialog` for a panel, omitted for a plain toggle. */
  hasPopup?: boolean;
  disabled?: boolean;
  /** Sand credits; the rest pick their colour by the fill. */
  tone?: 'auto' | 'sand';
  /** Drawn instead of the bar/ring (АРТ — the split-panel glyph); `false` — nothing. */
  icon?: ReactNode | false;
  onClick: () => void;
};

/**
 * Used by KabinaHud (limits) and by kabina-chat (context and artifacts): one instrument of
 * the HUD — caption, a small bar (a ring on the phone) coloured by how full it is, the number.
 */
export function HudMeter({ label, value, unit, percent, ariaLabel, isPhone, expanded = false, hasPopup = true, disabled = false, tone = 'auto', icon, onClick }: HudMeterProps) {
  const level = meterLevel(percent);
  const fill = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const gauge = icon === false ? null : icon ?? (isPhone ? (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="kb-hud-ring">
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="rgba(255,236,210,0.16)" strokeWidth="2" />
      <circle cx="6" cy="6" r="4.5" fill="none" strokeWidth="2" strokeDasharray={`${(fill / 100) * 28.3} 28.3`} transform="rotate(-90 6 6)" />
    </svg>
  ) : (
    <span className="kb-hud-bar" aria-hidden="true"><span style={{ width: `${fill}%` }} /></span>
  ));
  return (
    <button
      type="button"
      className="kb-hud-cell kb-hud-meter"
      data-level={level}
      data-tone={tone === 'sand' ? 'sand' : undefined}
      aria-label={ariaLabel}
      title={isPhone ? undefined : ariaLabel}
      aria-expanded={hasPopup ? expanded : undefined}
      aria-pressed={hasPopup ? undefined : expanded}
      aria-haspopup={hasPopup ? 'dialog' : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="kb-hud-mark" aria-hidden="true" />
      <span className="kb-m kb-hud-label">{label}</span>
      {isPhone ? (
        <span className="kb-hud-pval">
          {gauge}
          <span className="kb-m kb-hud-val">{value}</span>
        </span>
      ) : (
        <>
          {gauge}
          <span className="kb-m kb-hud-val">{value}{unit && <span className="kb-hud-unit">{unit}</span>}</span>
        </>
      )}
    </button>
  );
}

type HudPopoverProps = {
  open: boolean;
  onClose: () => void;
  /** The trigger (and whatever belongs to it): a press there does not count as «outside». */
  anchorRef: RefObject<HTMLElement>;
  /** Which edge of its HUD part the panel lines up with. */
  align: 'left' | 'right';
  /** Up from the HUD (default) or down from a header trigger. */
  direction?: 'up' | 'down';
  label: string;
  className?: string;
  children: ReactNode;
};

/**
 * Used by KabinaHud (limits) and kabina-chat (dialogs list): a panel that opens UP from the
 * HUD on a computer. Esc, a press outside or another address closes it.
 */
export function HudPopover({ open, onClose, anchorRef, align, direction = 'up', label, className, children }: HudPopoverProps) {
  const panelRef = useRef<HTMLElement>(null);
  const location = useLocation();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Esc closes only the newest open layer.
  const isTopLayer = useEscapeLayer(open);

  useEffect(() => {
    if (open) closeRef.current();
    // Only an address change closes it, not the opening itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !isTopLayer()) return;
      event.stopPropagation();
      event.preventDefault();
      closeRef.current();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      closeRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [anchorRef, isTopLayer, open]);

  if (!open) return null;
  return (
    <section ref={panelRef} className={`kb-hud-pop kb-bz${className ? ` ${className}` : ''}`} data-align={align} data-direction={direction} role="dialog" aria-label={label}>
      {children}
    </section>
  );
}

/** The limits in words and bars: what the HUD's НЕД / $ open (DarkMain «Лимиты», compact). */
function LimitsPanel({ limits, titleId }: { limits: SubscriptionLimits | null; titleId: string }) {
  // «Now» for the countdowns, refreshed while the panel is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // Mirage: no «Сессия · 5 ч» row — the plan has no 5-hour window any more (`five_hour: null`).
  const rows: Array<{ key: string; name: string; big: string; unit: string; percent: number; tone: 'auto' | 'sand'; note: string }> = [];
  if (limits?.weekly) {
    const byModel = limits.weeklyByModel.filter((item) => item.percent >= 1).map((item) => `${item.model} ${Math.round(item.percent)}%`).join(' · ');
    rows.push({
      key: 'w', name: 'Неделя · все модели', big: String(Math.round(limits.weekly.percent)), unit: '%', percent: limits.weekly.percent, tone: 'auto',
      note: `${resetText(limits.weekly.resetsAt, now)}${byModel ? ` · ${byModel}` : ''}`,
    });
  }
  if (limits?.credits) {
    const until = shortDay(limits.credits.resetsAt);
    rows.push({
      key: 'c', name: 'Кредиты', big: `$${Math.floor(limits.credits.remainingDollars)}`, unit: ` / ${Math.round(limits.credits.limitDollars)}`,
      percent: limits.credits.percent, tone: 'sand', note: `осталось на счету · потрачено ${Math.round(limits.credits.percent)}%${until ? ` · до ${until}` : ''}`,
    });
  }
  const elapsed = limits?.weekly ? weekElapsed(limits.weekly.resetsAt, now) : null;
  // A couple of points either way is «in step», not «faster than time».
  const ahead = elapsed !== null && limits?.weekly ? limits.weekly.percent > elapsed * 100 + 2 : false;
  const stale = limits?.status === 'stale' && limits.fetchedAt ? toPanelWall(limits.fetchedAt) : null;

  return (
    <>
      <div className="kb-hud-pop-head">
        <h2 id={titleId} className="kb-m kb-hud-pop-title">ЛИМИТЫ{limits?.plan ? ` · ${limits.plan.toUpperCase()}` : ''}</h2>
        {stale && <span className="kb-m kb-hud-pop-meta">на {stale.getHours()}:{String(stale.getMinutes()).padStart(2, '0')}</span>}
        <span className="kb-spacer" />
      </div>
      {!limits && <p className="kb-hud-pop-note">Спрашиваю лимиты…</p>}
      {limits?.status === 'unavailable' && <p className="kb-hud-pop-note">{UNAVAILABLE_TEXT[limits.reason ?? 'upstream-error']}</p>}
      {rows.map((row) => (
        <div key={row.key} className="kb-hud-limit" data-level={meterLevel(row.percent)} data-tone={row.tone === 'sand' ? 'sand' : undefined}>
          <div className="kb-hud-limit-top">
            <span className="kb-hud-limit-name">{row.name}</span>
            <span className="kb-t kb-hud-limit-big">{row.big}<span>{row.unit}</span></span>
          </div>
          <div className="kb-hud-limit-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, row.percent))}%` }} /></div>
          <span className="kb-m kb-hud-limit-note">{row.note}</span>
        </div>
      ))}
      {elapsed !== null && limits?.weekly && (
        <div className="kb-hud-pace">
          <span className={`kb-led ${ahead ? 'kb-led-warn' : 'kb-led-ok'}`} />
          <span>
            Темп недели: израсходовано <span className="kb-m">{Math.round(limits.weekly.percent)}%</span> при прошедших{' '}
            <span className="kb-m">{Math.round(elapsed * 100)}%</span> — {ahead ? 'идёшь быстрее времени' : 'запас есть'}
          </span>
        </div>
      )}
    </>
  );
}

/**
 * Phone: the HUD sits under the header; sheets and the full-screen artifact open below it so
 * it stays in view. Its bottom edge (from the top of the shell) goes to `--kb-hud-clear`.
 */
/*
 * Phone HUDs that measure their bottom edge, newest last: the shell's one steps aside for the
 * chat's own, and an unmounting HUD must not wipe the value the other one keeps.
 */
const clearanceOwners: Array<() => void> = [];

function useHudClearance(ref: RefObject<HTMLElement>, active: boolean) {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!active || !node) return undefined;
    const root = document.documentElement;
    const scroller = node.closest('.kb-shell');
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (clearanceOwners[clearanceOwners.length - 1] !== measure) return;
      const top = scroller?.getBoundingClientRect().top ?? 0;
      root.style.setProperty('--kb-hud-clear', `${Math.max(0, Math.round(node.getBoundingClientRect().bottom - top))}px`);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    clearanceOwners.push(measure);
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    observer?.observe(node);
    // A strip appearing above (the «нет связи» bar) moves the HUD without resizing it.
    const mutations = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null;
    const inner = scroller?.firstElementChild;
    if (inner) mutations?.observe(inner, { childList: true });
    scroller?.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      mutations?.disconnect();
      scroller?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      const index = clearanceOwners.indexOf(measure);
      if (index >= 0) clearanceOwners.splice(index, 1);
      const next = clearanceOwners[clearanceOwners.length - 1];
      if (next) next();
      else root.style.removeProperty('--kb-hud-clear');
    };
  }, [active, ref]);
}

type KabinaHudProps = {
  isPhone: boolean;
  /** Computer: the left part (the chat — project and dialog, opens the dialogs list). */
  left?: ReactNode;
  /** Replaces the live summary «работают N · ждёт N» (the chat — the turn). */
  center?: ReactNode;
  /** Instruments after the limits (the chat — КТКСТ and АРТ). */
  extra?: ReactNode;
  /** Phone page screens: the HUD sticks to the top while the page scrolls. */
  sticky?: boolean;
};

/**
 * Used by KabinaShell on every screen and by kabina-chat (with its own parts): the
 * instrument line (ChatLayoutB). Computer — a thin 32px strip along the bottom edge
 * with the notification bell at its end; phone — one 40px row under the header (the bell
 * stays in the header). Limits are there unless the server's counter is off
 * (`MIRAGE_SUBSCRIPTION_LIMITS`), then the strip simply has no limit cells; each
 * instrument opens its panel.
 */
export function KabinaHud({ isPhone, left, center, extra, sticky = false }: KabinaHudProps) {
  const limits = useSubscriptionLimits();
  const limitsEnabled = isSubscriptionLimitsEnabled(limits);
  const live = useKabinaLiveSummary();
  // The limits panel is open (drop-up on a computer, a sheet on the phone).
  const [isLimitsOpen, setIsLimitsOpen] = useState(false);
  const limitsRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const closeLimits = useCallback(() => setIsLimitsOpen(false), []);
  const toggleLimits = useCallback(() => setIsLimitsOpen((open) => !open), []);
  useHudClearance(hudRef, isPhone);

  // `?limits` — «Подробнее» of the limits from home, the bell or ⌘K: this panel is that one
  // place. The flag is dropped at once, so Back and a reload do not open it again.
  const location = useLocation();
  const navigate = useNavigate();
  const asksForLimits = new URLSearchParams(location.search).has(LIMITS_DETAILS_FLAG);
  useEffect(() => {
    if (!asksForLimits) return;
    setIsLimitsOpen(true);
    const params = new URLSearchParams(location.search);
    params.delete(LIMITS_DETAILS_FLAG);
    const rest = params.toString();
    navigate({ pathname: location.pathname, search: rest ? `?${rest}` : '', hash: location.hash }, { replace: true, state: location.state });
    // Reacts to the flag only; the address parts are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asksForLimits]);

  const hasNumbers = Boolean(limits && limits.status !== 'unavailable');
  const weekly = hasNumbers ? limits?.weekly ?? null : null;
  const credits = hasNumbers ? limits?.credits ?? null : null;
  const pct = (value: number | null | undefined) => (typeof value === 'number' ? String(Math.round(value)) : '—');

  const meters = (
    <div ref={limitsRef} className="kb-hud-limits">
      <HudMeter
        label="НЕД"
        value={pct(weekly?.percent)}
        unit={weekly ? '%' : undefined}
        percent={weekly?.percent ?? null}
        ariaLabel={weekly ? `Неделя: ${Math.round(weekly.percent)} %, ${resetText(weekly.resetsAt, Date.now())}` : 'Лимит недели: нет данных'}
        isPhone={isPhone}
        expanded={isLimitsOpen}
        onClick={toggleLimits}
      />
      {credits && (
        <HudMeter
          label="$"
          value={String(Math.floor(credits.remainingDollars))}
          unit={`/${Math.round(credits.limitDollars)}`}
          percent={credits.percent}
          tone="sand"
          ariaLabel={`Кредиты: осталось ${Math.floor(credits.remainingDollars)} из ${Math.round(credits.limitDollars)} долларов`}
          isPhone={isPhone}
          expanded={isLimitsOpen}
          onClick={toggleLimits}
        />
      )}
      {!isPhone && (
        <HudPopover open={isLimitsOpen} onClose={closeLimits} anchorRef={limitsRef} align="right" label="Лимиты подписки" className="kb-hud-limits-pop">
          <LimitsPanel limits={limits} titleId={titleId} />
        </HudPopover>
      )}
    </div>
  );

  const summary = center ?? (
    isPhone ? (
      <Link className="kb-hud-cell kb-hud-turn" to="/agents" aria-label={`Работают: ${live.working}, ждут тебя: ${live.waiting} — открыть агентов`}>
        <span className="kb-m kb-hud-cap" data-tone={live.waiting > 0 ? 'wait' : undefined}>{live.waiting > 0 ? 'ЖДЁТ ТЕБЯ' : 'СЕЙЧАС'}</span>
        <span className="kb-hud-turn-line">
          <span className={`kb-led ${live.waiting > 0 ? 'kb-led-wait' : live.working > 0 ? 'kb-led-run' : 'kb-led-idle'}`} />
          <span className="kb-m">
            {live.working > 0 || live.waiting > 0 ? `${live.working} в работе${live.waiting > 0 ? ` · ${live.waiting} ждёт` : ''}` : 'тихо'}
          </span>
        </span>
      </Link>
    ) : (
      <div className="kb-hud-center" role="status">
        <Link className="kb-hud-live kb-lnk" to="/agents">
          {live.working === 0 && live.waiting === 0 ? (
            <>
              <span className="kb-led kb-led-idle" />
              <span>тихо — никто не работает</span>
            </>
          ) : (
            <>
              <span className={`kb-led ${live.working > 0 ? 'kb-led-run' : 'kb-led-idle'}`} />
              <span>работают <b className="kb-m">{live.working}</b></span>
              <span className="kb-hud-sep" aria-hidden="true" />
              <span className={`kb-led ${live.waiting > 0 ? 'kb-led-wait' : 'kb-led-idle'}`} />
              <span data-tone={live.waiting > 0 ? 'wait' : undefined}>ждёт тебя <b className="kb-m">{live.waiting}</b></span>
            </>
          )}
        </Link>
      </div>
    )
  );

  const strip = (
    <nav
      ref={hudRef}
      className="kb-hud"
      data-phone={isPhone ? '' : undefined}
      data-sticky={sticky ? '' : undefined}
      aria-label="Приборная строка"
    >
      <span className="kb-hud-ticks" aria-hidden="true" />
      {!isPhone && left && <div className="kb-hud-left">{left}</div>}
      {!isPhone && !left && <div className="kb-hud-left" data-empty="" />}
      {summary}
      <div className="kb-hud-right">
        {limitsEnabled && meters}
        {extra}
        {!isPhone && <NotificationBell isPhone={false} placement="hud" />}
      </div>
    </nav>
  );

  return (
    <>
      {isPhone || typeof document === 'undefined' ? strip : createPortal(<div className="kb-portal kb-hud-dock">{strip}</div>, document.body)}
      {isPhone && limitsEnabled && (
        <Sheet open={isLimitsOpen} onClose={closeLimits} title="ЛИМИТЫ ПОДПИСКИ" belowHud>
          <div className="kb-hud-sheet">
            <LimitsPanel limits={limits} titleId={titleId} />
          </div>
        </Sheet>
      )}
    </>
  );
}

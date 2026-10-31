import type { ReactNode, SVGProps } from 'react';

/** Stroke icons copied from the «Кабина» mock-ups; size and stroke width follow each mock-up's use. */
type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number; strokeWidth?: number };

function StrokeIcon({ size = 16, strokeWidth = 1.6, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Used by the shell header, the phone header and the sign-in screens (auth): the round Mirage mark with the orange horizon line. */
export function KabinaLogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <circle cx="13" cy="13" r="11.5" stroke="#EDE6DA" strokeOpacity="0.45" />
      <path d="M2.5 15.2h21" stroke="#FF6A2B" strokeWidth="1.6" />
      <path d="M8 11.2l5-3.8 5 3.8" stroke="#EDE6DA" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 1.5v2.4M1.5 13h2.4M22.1 13h2.4" stroke="#EDE6DA" strokeOpacity="0.45" />
    </svg>
  );
}

/** Used by the shell search field, the search overlay and the phone home search row. */
export function SearchIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </StrokeIcon>
  );
}

/** Used by the header Files button and search results for files. */
export function FolderIcon(props: IconProps) {
  return (
    <StrokeIcon size={18} strokeWidth={1.5} {...props}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </StrokeIcon>
  );
}

/** Used by the header Settings button. */
export function SlidersIcon(props: IconProps) {
  return (
    <StrokeIcon size={18} strokeWidth={1.5} {...props}>
      <path d="M4 6h9M19 6h1M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </StrokeIcon>
  );
}

/** Used by the voice button and the voice overlay. */
export function MicIcon(props: IconProps) {
  return (
    <StrokeIcon size={24} strokeWidth={1.8} {...props}>
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </StrokeIcon>
  );
}

/** Used by toasts, modals and sheets to close them. */
export function CloseIcon(props: IconProps) {
  return (
    <StrokeIcon size={13} strokeWidth={1.8} {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </StrokeIcon>
  );
}

/** Used by tiles, rows and the primary "Ответить" button. */
export function ArrowRightIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </StrokeIcon>
  );
}

/** Used by the collapsed "Сделано" row on the phone. */
export function ChevronRightIcon(props: IconProps) {
  return (
    <StrokeIcon size={12} strokeWidth={2} {...props}>
      <path d="M9 6l6 6-6 6" />
    </StrokeIcon>
  );
}

/** Used by the phone header on «Файлы» / «Настройки»: «‹» back to where the panel was. */
export function ChevronLeftIcon(props: IconProps) {
  return (
    <StrokeIcon size={20} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M15 5l-7 7 7 7" />
    </StrokeIcon>
  );
}

/** Used by favourite tiles: a filled star. */
export function StarIcon({ size = 14, ...rest }: Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#EDE6DA" fillOpacity="0.72" aria-hidden="true" {...rest}>
      <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />
    </svg>
  );
}

/** Used by "+ Событие" and other add buttons. */
export function PlusIcon(props: IconProps) {
  return (
    <StrokeIcon size={14} {...props}>
      <path d="M12 5v14M5 12h14" />
    </StrokeIcon>
  );
}

/** Used by done states and the "ход закончен" toast. */
export function CheckIcon(props: IconProps) {
  return (
    <StrokeIcon strokeWidth={2} {...props}>
      <path d="M5 12l5 5 9-10" />
    </StrokeIcon>
  );
}

/** Used by the background-work toast. */
export function LayersIcon(props: IconProps) {
  return (
    <StrokeIcon strokeWidth={1.7} {...props}>
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 13l9 5 9-5" />
    </StrokeIcon>
  );
}

/** Used by the queued-message toast. */
export function QueueIcon(props: IconProps) {
  return (
    <StrokeIcon strokeWidth={1.7} {...props}>
      <path d="M4 6h16M4 12h10M4 18h7" />
      <path d="M17 15l3 3-3 3" />
    </StrokeIcon>
  );
}

/** Used by the lost-connection toast and banner. */
export function WifiOffIcon(props: IconProps) {
  return (
    <StrokeIcon strokeWidth={1.7} {...props}>
      <path d="M2 8.5a15 15 0 0 1 4.2-2.7M9.5 5.1A15 15 0 0 1 22 8.5M5 12a10 10 0 0 1 3.5-2.2M13.6 9.3A10 10 0 0 1 19 12M8.5 15.5a5 5 0 0 1 7 0" />
      <path d="M12 19.5v.5" />
      <path d="M3 3l18 18" />
    </StrokeIcon>
  );
}

/** Used by calendar rows for calls. */
export function PhoneCallIcon(props: IconProps) {
  return (
    <StrokeIcon size={14} {...props}>
      <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />
    </StrokeIcon>
  );
}

/** Used by calendar rows for messages (scheduled chat messages included). */
export function MessageIcon(props: IconProps) {
  return (
    <StrokeIcon size={14} {...props}>
      <path d="M4 5h16v11H8l-4 4z" />
    </StrokeIcon>
  );
}

/** Used by calendar rows for meetings. */
export function MeetIcon(props: IconProps) {
  return (
    <StrokeIcon size={14} {...props}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20a6 6 0 0 1 12 0M16 5a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.6" />
    </StrokeIcon>
  );
}

/** Used by the phone nav "Главная": a dial. */
export function DialIcon(props: IconProps) {
  return (
    <StrokeIcon size={22} {...props}>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 13l4-4M4 13h2M18 13h2M12 5v2" />
    </StrokeIcon>
  );
}

/** Used by the phone nav "Проекты". */
export function GridIcon(props: IconProps) {
  return (
    <StrokeIcon size={22} {...props}>
      <rect x="3" y="4" width="7.5" height="7.5" rx="1" />
      <rect x="13.5" y="4" width="7.5" height="7.5" rx="1" />
      <rect x="3" y="14.5" width="7.5" height="5.5" rx="1" />
      <rect x="13.5" y="14.5" width="7.5" height="5.5" rx="1" />
    </StrokeIcon>
  );
}

/** Used by the phone nav "Агенты". */
export function AgentsIcon(props: IconProps) {
  return (
    <StrokeIcon size={22} {...props}>
      <circle cx="12" cy="5" r="2" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="19" r="2" />
      <path d="M12 7v5M12 12l-6 5.5M12 12l6 5.5" />
    </StrokeIcon>
  );
}

/** Used by the phone nav "Календарь" and calendar links. */
export function CalendarIcon(props: IconProps) {
  return (
    <StrokeIcon size={22} {...props}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </StrokeIcon>
  );
}

/** Used by the week pace line under the limits: rising when there is headroom. */
export function TrendIcon({ rising = true, ...props }: IconProps & { rising?: boolean }) {
  return (
    <StrokeIcon size={14} strokeWidth={1.8} {...props}>
      {rising ? <path d="M3 17l6-6 4 4 8-8M15 7h6v6" /> : <path d="M3 7l6 6 4-4 8 8M15 17h6v-6" />}
    </StrokeIcon>
  );
}

/** Used by the hold-to-stop button. */
export function StopSquareIcon(props: IconProps) {
  return (
    <StrokeIcon size={12} strokeWidth={2} {...props}>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </StrokeIcon>
  );
}

/** Used by the search overlay for actions (classic interface, settings). */
export function BoltIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M13 3L5 14h6l-1 7 8-11h-6z" />
    </StrokeIcon>
  );
}

/** Used by the limits warning toast and the Claude error card: the sand warning triangle (DarkStates E1). */
export function WarnTriangleIcon(props: IconProps) {
  return (
    <StrokeIcon strokeWidth={1.8} {...props}>
      <path d="M12 3l10 18H2z" />
      <path d="M12 10v5M12 18v.5" />
    </StrokeIcon>
  );
}

/** Used by the notification centre (KabinaHeader, the phone chat header): the bell. */
export function BellIcon(props: IconProps) {
  return (
    <StrokeIcon size={18} {...props}>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z" strokeLinejoin="round" />
      <path d="M10 21h4" strokeLinecap="round" />
    </StrokeIcon>
  );
}

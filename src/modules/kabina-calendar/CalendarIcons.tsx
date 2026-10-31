import type { ReactNode, SVGProps } from 'react';

import type { CalendarEventType } from '@/shared/types';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number; strokeWidth?: number };

/** Stroke icons of DarkCalendar, path for path. */
function StrokeIcon({ size = 16, strokeWidth = 1.6, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

const TYPE_PATHS: Record<CalendarEventType, ReactNode> = {
  call: <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />,
  message: <path d="M4 5h16v11H8l-4 4z" />,
  meeting: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20a6 6 0 0 1 12 0M16 5a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.6" />
    </>
  ),
  agent_task: <path d="M12 3v5M12 16v5M3 12h5M16 12h5M5.6 5.6l3.2 3.2M15.2 15.2l3.2 3.2M5.6 18.4l3.2-3.2M15.2 8.8l3.2-3.2" />,
  server_schedule: (
    <>
      <rect x="4" y="4" width="16" height="7" rx="2" />
      <rect x="4" y="13" width="16" height="7" rx="2" />
      <path d="M8 7.5h.01M8 16.5h.01" />
    </>
  ),
};

/** The type's shape: phone, speech bubble, people, Claude's spark, server rack. */
export function TypeIcon({ type, ...props }: IconProps & { type: CalendarEventType }) {
  return <StrokeIcon {...props}>{TYPE_PATHS[type]}</StrokeIcon>;
}

export function ChevronIcon({ direction, ...props }: IconProps & { direction: 'left' | 'right' }) {
  return <StrokeIcon {...props}><path d={direction === 'left' ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} /></StrokeIcon>;
}

export function SyncIcon(props: IconProps) {
  return <StrokeIcon {...props}><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4" /></StrokeIcon>;
}

export function PlusIcon(props: IconProps) {
  return <StrokeIcon {...props}><path d="M12 5v14M5 12h14" /></StrokeIcon>;
}

export function MicIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </StrokeIcon>
  );
}

export function CloseIcon(props: IconProps) {
  return <StrokeIcon {...props}><path d="M6 6l12 12M18 6L6 18" /></StrokeIcon>;
}

export function CheckIcon(props: IconProps) {
  return <StrokeIcon {...props}><path d="M5 12.5l4.5 4.5L19 7" /></StrokeIcon>;
}

export function ClockIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l2.5 2.5" />
    </StrokeIcon>
  );
}

export function TelegramIcon(props: IconProps) {
  return <StrokeIcon {...props}><path d="M21 4L3 11l6 2.5M21 4l-3 16-9-6.5M21 4L9 13.5V19l3-3.5" /></StrokeIcon>;
}

export function ArrowIcon(props: IconProps) {
  return <StrokeIcon {...props}><path d="M5 12h14M13 6l6 6-6 6" /></StrokeIcon>;
}

export function TrashIcon(props: IconProps) {
  return <StrokeIcon {...props}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></StrokeIcon>;
}

/** The warning triangle of DarkStates' error card (the stale-calendar notice). */
export function WarnIcon(props: IconProps) {
  return <StrokeIcon {...props}><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18v.5" /></StrokeIcon>;
}

export function MoreIcon(props: IconProps) {
  return <StrokeIcon {...props}><path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth={3} strokeLinecap="round" /></StrokeIcon>;
}

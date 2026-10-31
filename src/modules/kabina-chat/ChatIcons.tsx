import type { ReactNode } from 'react';

/** Icons of DarkChat / DarkPhoneChat, drawn exactly as in the mock-ups (stroke icons, 24 grid). */

type IconProps = { size?: number; strokeWidth?: number; className?: string };

function Stroke({ size = 16, strokeWidth = 1.6, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

export const ChatTabIcon = (p: IconProps) => <Stroke {...p}><path d="M4 5h16v11H8l-4 4z" /></Stroke>;
export const FolderIcon = (p: IconProps) => (
  <Stroke {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Stroke>
);
export const GitIcon = (p: IconProps) => (
  <Stroke {...p}><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 7v10M18 10a6 6 0 0 1-6 6H8" /></Stroke>
);
export const TerminalIcon = (p: IconProps) => (
  <Stroke {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M13 15h4" /></Stroke>
);
export const CalIcon = (p: IconProps) => (
  <Stroke {...p}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></Stroke>
);
export const PlusIcon = (p: IconProps) => <Stroke strokeWidth={1.8} {...p}><path d="M12 5v14M5 12h14" /></Stroke>;
export const ChevronRight = (p: IconProps) => <Stroke strokeWidth={2} {...p}><path d="M9 6l6 6-6 6" /></Stroke>;
export const ChevronDown = (p: IconProps) => <Stroke strokeWidth={2} {...p}><path d="M6 9l6 6 6-6" /></Stroke>;
export const ChevronUp = (p: IconProps) => <Stroke strokeWidth={2.4} {...p}><path d="M6 15l6-6 6 6" /></Stroke>;
export const ChevronLeft = (p: IconProps) => <Stroke strokeWidth={1.7} {...p}><path d="M15 5l-7 7 7 7" /></Stroke>;
export const ArrowRight = (p: IconProps) => <Stroke {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Stroke>;
export const SteerArrow = (p: IconProps) => <Stroke strokeWidth={2.2} {...p}><path d="M4 12h12M12 6l6 6-6 6" /></Stroke>;
export const QueueLines = (p: IconProps) => <Stroke strokeWidth={2} {...p}><path d="M4 6h16M4 12h16M4 18h10" /></Stroke>;
export const CheckIcon = (p: IconProps) => <Stroke strokeWidth={2} {...p}><path d="M5 12l5 5 9-10" /></Stroke>;
export const CloseIcon = (p: IconProps) => <Stroke strokeWidth={1.8} {...p}><path d="M6 6l12 12M18 6L6 18" /></Stroke>;
export const PencilIcon = (p: IconProps) => <Stroke strokeWidth={1.7} {...p}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></Stroke>;
export const ClipIcon = (p: IconProps) => (
  <Stroke {...p}><path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17a1.7 1.7 0 0 1-2.4-2.4L15 7" /></Stroke>
);
export const MicIcon = (p: IconProps) => <Stroke {...p}><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></Stroke>;
export const ChartIcon = (p: IconProps) => <Stroke {...p}><path d="M4 20V11M9 20V5M14 20v-6M19 20V9M2 20h20" /></Stroke>;
export const DocIcon = (p: IconProps) => <Stroke {...p}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></Stroke>;
export const SideIcon = (p: IconProps) => <Stroke strokeWidth={1.8} {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14 4v16" /></Stroke>;
export const CommentIcon = (p: IconProps) => <Stroke {...p}><path d="M4 5h16v11H9l-5 4z" /></Stroke>;
export const ShareIcon = (p: IconProps) => <Stroke strokeWidth={2} {...p}><path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 14v5h14v-5" /></Stroke>;
export const ExpandIcon = (p: IconProps) => <Stroke strokeWidth={1.7} {...p}><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" /></Stroke>;
export const CollapseIcon = (p: IconProps) => <Stroke strokeWidth={1.7} {...p}><path d="M20 10h-6V4M14 10l7-7M4 14h6v6M10 14l-7 7" /></Stroke>;
export const RefreshIcon = (p: IconProps) => (
  <Stroke strokeWidth={1.8} {...p}><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4" /></Stroke>
);
export const LinkOutIcon = (p: IconProps) => <Stroke strokeWidth={1.8} {...p}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></Stroke>;

export function DotsIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}

export function GripIcon() {
  return (
    <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="3" r="1.3" /><circle cx="9" cy="3" r="1.3" /><circle cx="3" cy="8" r="1.3" />
      <circle cx="9" cy="8" r="1.3" /><circle cx="3" cy="13" r="1.3" /><circle cx="9" cy="13" r="1.3" />
    </svg>
  );
}

/** The small Claude mark before «CLAUDE» in the feed. */
export function ClaudeMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <circle cx="13" cy="13" r="11" stroke="#FF6A2B" strokeWidth="2" />
      <path d="M2 15h22" stroke="#FF6A2B" strokeWidth="2.4" />
    </svg>
  );
}

/** The four-bar equaliser of «N субагентов работают». */
export function Equalizer() {
  return <span className="kb-eq" aria-hidden="true"><i /><i /><i /><i /></span>;
}

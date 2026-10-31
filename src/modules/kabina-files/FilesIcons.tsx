// Icons of DarkFiles, drawn exactly as in the mock-up (24-unit grid, stroke icons).
// Used only inside the kabina-files module (tree, places, preview, header).
import type { ReactNode } from 'react';

import type { TreeIconKind } from '@/modules/kabina-files/utils/fileKinds';

type GlyphProps = { size?: number; color?: string; strokeWidth?: number };

function Svg({ size = 16, color = 'currentColor', strokeWidth = 1.6, children }: GlyphProps & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} aria-hidden="true" style={{ flex: 'none' }}>
      {children}
    </svg>
  );
}

const FOLDER = 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z';

export const FolderGlyph = (props: GlyphProps) => <Svg {...props}><path d={FOLDER} /></Svg>;
export const FolderPlusGlyph = (props: GlyphProps) => <Svg {...props}><path d={FOLDER} /><path d="M12 10v6M9 13h6" /></Svg>;
export const DownloadGlyph = (props: GlyphProps) => <Svg {...props}><path d="M12 4v11M7 10l5 5 5-5M4 19h16" /></Svg>;
export const UploadGlyph = (props: GlyphProps) => <Svg strokeWidth={1.8} {...props}><path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></Svg>;
export const ArchiveGlyph = (props: GlyphProps) => <Svg {...props}><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" /></Svg>;
export const ServerGlyph = (props: GlyphProps) => <Svg {...props}><rect x="3" y="4" width="18" height="7" rx="1" /><rect x="3" y="13" width="18" height="7" rx="1" /><path d="M7 7.5h.01M7 16.5h.01" /></Svg>;
export const BranchGlyph = (props: GlyphProps) => <Svg size={13} strokeWidth={1.7} {...props}><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 7v10M18 10c0 4-6 3-11 7" /></Svg>;
export const FilterGlyph = (props: GlyphProps) => <Svg size={15} color="var(--kb-soft)" {...props}><path d="M4 5h16l-6 7.5V19l-4 1.5v-8z" /></Svg>;
export const EyeGlyph = (props: GlyphProps) => <Svg {...props}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></Svg>;
export const ChevronGlyph = () => <svg className="kf-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--kb-mute)" strokeWidth="2" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>;
export const LockGlyph = ({ size = 12 }: GlyphProps) => <Svg size={size} color="var(--kb-mute)" strokeWidth={1.8}><rect x="5" y="11" width="14" height="10" rx="1.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Svg>;
export const BigLockGlyph = () => <Svg size={22}><rect x="5" y="11" width="14" height="10" rx="1.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3M12 15v2" /></Svg>;
export const BigFolderGlyph = () => <Svg size={22}><path d={FOLDER} /></Svg>;
export const BigFileGlyph = () => <Svg size={22}><path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M14 3v5h5" /></Svg>;
export const ChatGlyph = (props: GlyphProps) => <Svg strokeWidth={1.8} {...props}><path d="M4 5h16v11H8l-4 4z" /></Svg>;
export const ArrowGlyph = (props: GlyphProps) => <Svg strokeWidth={2} {...props}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>;
export const PencilGlyph = (props: GlyphProps) => <Svg size={14} {...props}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></Svg>;
export const CopyGlyph = (props: GlyphProps) => <Svg size={14} {...props}><rect x="8" y="8" width="12" height="12" rx="1.5" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></Svg>;
export const CheckGlyph = (props: GlyphProps) => <Svg size={15} color="var(--kb-sage)" strokeWidth={1.8} {...props}><path d="M5 12l5 5 9-10" /></Svg>;

/** The tree's file icons: document, code, picture, spreadsheet, generic. */
export function FileTypeGlyph({ kind, color }: { kind: TreeIconKind; color: string }) {
  switch (kind) {
    case 'doc':
      return <Svg color={color}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h4" /></Svg>;
    case 'code':
      return <Svg color={color}><path d="M9 7l-5 5 5 5M15 7l5 5-5 5" /></Svg>;
    case 'img':
      return <Svg color={color}><rect x="4" y="5" width="16" height="14" rx="1.5" /><path d="M4 16l5-5 4 4 2-2 5 5" /><circle cx="15.5" cy="9.5" r="1.5" /></Svg>;
    case 'xls':
      return <Svg color={color}><rect x="4" y="4" width="16" height="16" rx="1.5" /><path d="M4 10h16M4 15h16M10 4v16" /></Svg>;
    default:
      return <Svg color={color}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></Svg>;
  }
}

// «Кабина» — own interface layer of the Mirage panel.
export { default as KabinaApp } from '@/modules/kabina/KabinaApp';
export { kabinaChatPath, kabinaLimitsHref, matchKabinaRoute } from '@/modules/kabina/utils/kabinaRoutes';
export { useKabinaToasts } from '@/modules/kabina/context/KabinaToastContext';
// The notification centre: the bell (also drawn by the phone chat's own header).
export { NotificationBell } from '@/modules/kabina/shell/NotificationCenter';
// The HUD (ChatLayoutB): the chat draws its own with the dialog, turn, context and artifacts.
export { HudMeter, HudPopover, KabinaHud } from '@/modules/kabina/shell/KabinaHud';
export { useClaimKabinaCrumbs, useClaimKabinaHud, useKabinaHeaderSlot } from '@/modules/kabina/context/KabinaHudContext';
// Voice from a screen's own microphone (the phone chat composer) and the iOS-safe mic start.
export { useKabinaVoiceControl } from '@/modules/kabina/context/KabinaVoiceContext';
export { usePressOrHold } from '@/modules/kabina/hooks/usePressOrHold';
export {
  VOICE_AUDIO_CONSTRAINTS,
  discardPrimedMicrophone,
  primeMicrophone,
  takePrimedMicrophone,
} from '@/modules/kabina/utils/micPrimer';

// UI primitives (the mock-ups' helmet classes as components).
export { Board } from '@/modules/kabina/ui/Board';
export { Button, HoldButton, IconButton } from '@/modules/kabina/ui/Button';
export { Chip, Kbd } from '@/modules/kabina/ui/Chip';
export { Clock, zoneLabel } from '@/modules/kabina/ui/Clock';
// Panel time zone (server MIRAGE_TIMEZONE, else the server zone): every screen shows time in it.
export {
  browserTimeZone,
  fromPanelWall,
  getPanelTimeZone,
  panelTimezoneOffset,
  panelZoneLabel,
  setPanelTimeZone,
  toPanelWall,
  usePanelTimeZone,
} from '@/modules/kabina/ui/panelTime';
export { Gauge } from '@/modules/kabina/ui/Gauge';
export { Modal, Sheet } from '@/modules/kabina/ui/Modal';
export type { ModalPhoneLayout } from '@/modules/kabina/ui/Modal';
export { lockPageScroll } from '@/modules/kabina/utils/pageScrollLock';
export { Panel } from '@/modules/kabina/ui/Panel';
export { SectionRuler } from '@/modules/kabina/ui/SectionRuler';
export { Segmented } from '@/modules/kabina/ui/Segmented';
export { Skeleton, useDelayedFlag } from '@/modules/kabina/ui/Skeleton';
export { StatusShape } from '@/modules/kabina/ui/StatusShape';
export { Toggle } from '@/modules/kabina/ui/Toggle';
export { VoiceButton } from '@/modules/kabina/ui/VoiceButton';
export {
  ArrowRightIcon,
  KabinaLogoMark,
  CalendarIcon,
  CheckIcon,
  ChevronRightIcon,
  MeetIcon,
  MessageIcon,
  PhoneCallIcon,
  PlusIcon,
  SearchIcon,
  StarIcon,
  TrendIcon,
} from '@/modules/kabina/ui/KabinaIcons';

// DarkStates components (wave 2 «Состояния»): chat, home and other screens use them.
export { BigSessionNotice } from '@/modules/kabina/ui/BigSessionNotice';
export { BypassRootCard } from '@/modules/kabina/ui/BypassRootCard';
export { ClaudeErrorCard } from '@/modules/kabina/ui/ClaudeErrorCard';
export { EmptyState } from '@/modules/kabina/ui/EmptyState';
export { LimitWarningCard, LimitWarnings } from '@/modules/kabina/ui/LimitWarningCard';
export { LoadErrorState } from '@/modules/kabina/ui/LoadErrorState';
export { FeedSkeleton, ListSkeleton } from '@/modules/kabina/ui/LoadingSkeletons';
export { PermissionRequestCard } from '@/modules/kabina/ui/PermissionRequestCard';
export { TurnStoppedMark } from '@/modules/kabina/ui/TurnStoppedMark';
export { useBigSessionNotice } from '@/modules/kabina/hooks/useBigSessionNotice';
export { permissionDiffFromToolInput } from '@/modules/kabina/utils/permissionDiff';
export { NO_AUTOFILL } from '@/modules/kabina/utils/noAutofill';

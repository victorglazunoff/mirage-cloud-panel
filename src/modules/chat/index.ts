export { default as ChatInterface } from '@/modules/chat/ChatInterface';
export { getClaudeSettings } from '@/modules/chat/utils/chatStorage';

// Mirage «Кабина»: the kabina-chat screen renders its own markup over the same
// chat logic and reuses the authors' markdown, command dialogs and permission rules.
export { useChatController } from '@/modules/chat/hooks/useChatController';
export { Markdown } from '@/modules/chat/transcript/Markdown';
export { default as StreamingMarkdown } from '@/modules/chat/transcript/StreamingMarkdown';
export { default as ChatMessageImages } from '@/modules/chat/transcript/ChatMessageImages';
export { default as ChatMessageFiles } from '@/modules/chat/transcript/ChatMessageFiles';
export { default as CommandResultModal } from '@/modules/chat/modals/CommandResultModal';
export { buildClaudeToolPermissionEntry, formatToolInputForDisplay } from '@/modules/chat/utils/chatPermissions';
// Mirage: file paths in chat text as links to the Kabina file manager.
export { FileLinkContext } from '@/modules/chat/transcript/FileLinkContext';
export type { FileLinkRenderer } from '@/modules/chat/transcript/FileLinkContext';
export { findFilePathRefs, isLikelyFilePath, splitLineSuffix } from '@/modules/chat/utils/filePathRefs';
export type { FilePathMatch, FilePathRef } from '@/modules/chat/utils/filePathRefs';

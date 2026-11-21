import { createSnapshotTool } from './tool.mjs';

export function telegramChannelTool(readSnapshot, onUnexpectedError) {
  return createSnapshotTool('telegram', readSnapshot, (message) => ({
    externalId: message?.messageId,
    publishedAt: message?.date,
    originalUrl: message?.publicUrl,
    text: message?.text ?? null,
    attributes: message?.attributes ?? {},
  }), onUnexpectedError);
}

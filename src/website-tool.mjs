import { createSnapshotTool, isUri } from './tool.mjs';

export function websiteTool(readSnapshot, onUnexpectedError) {
  return createSnapshotTool('website', readSnapshot, (page) => ({
    externalId: page?.pageId ?? (isUri(page?.canonicalUrl) ? page.canonicalUrl : null),
    publishedAt: page?.publishedAt,
    originalUrl: page?.canonicalUrl,
    text: page?.summary ?? null,
    attributes: page?.attributes ?? {},
  }), onUnexpectedError);
}

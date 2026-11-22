import assert from 'node:assert/strict';
import test from 'node:test';
import { telegramChannelTool } from '../src/telegram-tool.mjs';
import { websiteTool } from '../src/website-tool.mjs';

const publishedAt = '2026-11-20T12:00:00Z';
const from = '2026-11-01T00:00:00Z';
const to = '2026-11-30T23:59:59Z';

for (const type of ['telegram', 'website']) {
  test(`${type}: курсор связан с источником, периодом и pageSize`, async (t) => {
    let reads = 0;
    const readSnapshot = () => {
      reads++;
      return ['1', '2', '3'].map((id) => type === 'telegram'
        ? { messageId: id, date: publishedAt, publicUrl: `https://t.me/example/${id}` }
        : { pageId: id, publishedAt, canonicalUrl: `https://example.org/items/${id}` });
    };
    const tool = type === 'telegram'
      ? telegramChannelTool(readSnapshot)
      : websiteTool(readSnapshot);
    const source = {
      id: 'source-1', type,
      url: type === 'telegram' ? 'https://t.me/example' : 'https://example.org',
      enabled: true, allowed: true,
    };
    const context = {
      cancellationToken: new AbortController().signal,
      deadline: new Date(Date.now() + 30_000).toISOString(),
      requestId: 'cursor-test',
    };
    const initial = { source, from, to, pageSize: 1, cursor: null };
    const first = await tool.collect(initial, context);
    assert.equal(first.records[0].externalId, '1');
    assert.equal(typeof first.nextCursor, 'string');
    assert.ok(first.nextCursor.length > 0);
    const request = { ...initial, cursor: first.nextCursor };

    await t.test('повреждённый курсор отклоняется', async () => {
      const readsBefore = reads;
      const result = await tool.collect({
        ...request,
        cursor: `${first.nextCursor}broken`,
      }, context);

      assert.equal(result.code, 'invalid_tool_request');
      assert.equal(result.field, 'cursor');
      assert.equal(reads, readsBefore);
    });

    const changes = [
      ['source.id', { source: { ...source, id: 'source-2' } }],
      ['source.url', { source: { ...source, url: 'https://example.org/other' } }],
      ['from', { from: '2026-11-02T00:00:00Z' }],
      ['to', { to: '2026-11-29T23:59:59Z' }],
      ['pageSize', { pageSize: 2 }],
    ];
    for (const [field, change] of changes) {
      await t.test(`подмена ${field} отклоняется`, async () => {
        const readsBefore = reads;
        const result = await tool.collect({ ...request, ...change }, context);
        assert.equal(result.code, 'invalid_tool_request');
        assert.equal(result.field, 'cursor');
        assert.equal(reads, readsBefore);
      });
    }

    await t.test('исходные параметры открывают следующую страницу', async () => {
      const second = await tool.collect(request, context);
      assert.deepEqual(second.records.map((record) => record.externalId), ['2']);
      assert.notEqual(second.nextCursor, first.nextCursor);
      const third = await tool.collect({ ...request, cursor: second.nextCursor }, context);
      assert.deepEqual(third.records.map((record) => record.externalId), ['3']);
      assert.equal(third.nextCursor, null);
    });
  });
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findBase, reconcile, splitPage, stampPage, wikiEdits } from '../src/sync.mjs';

const COMMIT = 'a'.repeat(40);
const origin = { file: 'afk/x.txt', commit: COMMIT };
const V1 = '==Gear==\n\n* orb\n\n==Plan==\n\n* attack\n\n==Source==\nPvME';
const V2 = V1.replace('* attack', '* attack twice');
const noHistory = { history: async () => [], regenerate: async () => null };

/** What a later check sees: the live page, its history, and the guide as it converts now. */
async function check(live, generated, sources = noHistory) {
    const base = await findBase(live, sources);
    return { base, ...reconcile({ generated, live: splitPage(live).content, base }) };
}

test('a stamp survives a round trip and is not part of the content', async () => {
    const { content, stamp } = splitPage(await stampPage(V1, origin));
    assert.equal(content, V1);
    assert.equal(stamp.file, 'afk/x.txt');
    assert.equal(stamp.commit, COMMIT);
});

test('an untouched page is synced, or behind once PvME changes', async () => {
    const live = await stampPage(V1, origin);
    assert.equal((await check(live, V1)).state, 'synced');
    const behind = await check(live, V2);
    assert.equal(behind.state, 'pvme-ahead');
    assert.equal(behind.merged, V2);
});

test('a wiki edit is recognised and keeps the wiki text', async () => {
    const published = await stampPage(V1, origin);
    const live = published.replace('* orb', '* abyssal orb');
    const result = await check(live, V1, { ...noHistory, history: async () => [published] });
    assert.equal(result.state, 'wiki-edited');
    assert.match(result.merged, /abyssal orb/);
});

test('changes to different lines merge without losing either side', async () => {
    const published = await stampPage(V1, origin);
    const live = published.replace('* orb', '* abyssal orb');
    const result = await check(live, V2, { ...noHistory, history: async () => [published] });
    assert.equal(result.state, 'mergeable');
    assert.match(result.merged, /abyssal orb/);
    assert.match(result.merged, /attack twice/);
    assert.equal(result.needsReview, false);
});

test('changes to the same line are a conflict and nothing is merged', async () => {
    const published = await stampPage(V1, origin);
    const live = published.replace('* attack', '* attack slowly');
    const result = await check(live, V2, { ...noHistory, history: async () => [published] });
    assert.equal(result.state, 'conflict');
    assert.equal(result.merged, null);
    assert.deepEqual(result.conflicts, [{ wiki: '* attack slowly', base: '* attack', pvme: '* attack twice' }]);
});

test('after a merge is published, the next check still starts from PvME\'s text', async () => {
    const merged = V2.replace('* orb', '* abyssal orb');
    const live = await stampPage(merged, { ...origin, generated: V2 });
    const result = await check(live, V2, { ...noHistory, regenerate: async () => V2 });
    assert.equal(result.base.source, 'regenerated');
    assert.equal(result.state, 'wiki-edited');
});

test('a page whose stamp was deleted is identified from its history', async () => {
    const published = await stampPage(V1, origin);
    const result = await check(V1.replace('* orb', '* abyssal orb'), V2, { ...noHistory, history: async () => [published] });
    assert.equal(result.state, 'mergeable');
});

test('a base that cannot be reproduced exactly is flagged for review', async () => {
    const live = (await stampPage(V1, origin)).replace('* orb', '* abyssal orb');
    const result = await check(live, V2, { ...noHistory, regenerate: async () => V1 + '\nnew footer' });
    assert.equal(result.base.source, 'approximate');
    assert.equal(result.needsReview, true);
});

test('missing, unstamped and removed pages are told apart', async () => {
    assert.equal(reconcile({ generated: V1, live: null, base: null }).state, 'unpublished');
    assert.equal((await check('hand written', V1)).state, 'unmanaged');
    assert.equal(reconcile({ generated: null, live: V1, base: null }).state, 'removed');
});

test('wiki edits point back at the guide lines they came from', () => {
    const lineMap = [
        { line: 1, endLine: 1, sourceLine: 2, sourceEndLine: 2 },
        { line: 3, endLine: 3, sourceLine: 5, sourceEndLine: 6 },
        { line: 5, endLine: 5, sourceLine: 9, sourceEndLine: 9 },
    ];
    const [edit, ...rest] = wikiEdits(V1, V1.replace('* orb', '* abyssal orb'), lineMap);
    assert.equal(rest.length, 0);
    assert.deepEqual(edit, { before: '* orb\n', after: '* abyssal orb\n', line: 3, sourceLine: 5, sourceEndLine: 6 });
});

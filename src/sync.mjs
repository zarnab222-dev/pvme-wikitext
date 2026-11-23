import { diffLines } from 'diff';
import { diff3Merge } from 'node-diff3';

/**
 * Keeps a published wiki page and its PvME guide reconcilable after either side changes.
 *
 * Every generated page ends with a stamp naming the guide, the pvme-guides commit and a hash of the generated text. The
 * stamp is the only state: the text both sides started from (the base) is recovered from the page's own history, or by
 * converting the stamped commit again. Nothing here writes to a wiki.
 *
 * @typedef {'unpublished'|'unmanaged'|'synced'|'pvme-ahead'|'wiki-edited'|'mergeable'|'conflict'|'removed'} SyncState
 *   unpublished  the wiki has no page
 *   unmanaged    the page exists but carries no stamp, so nothing says what it started from
 *   synced       the page equals what the guide generates now
 *   pvme-ahead   only PvME changed: publish the generated text
 *   wiki-edited  only the wiki changed: offer those edits to PvME
 *   mergeable    both changed different lines: publish the merge, offer the wiki edits to PvME
 *   conflict     both changed the same lines: a person decides
 *   removed      the page is stamped but PvME no longer has the guide
 *
 * @typedef {{file: string, commit: string, body: string}} Stamp
 * @typedef {{content: string, commit: string, source: 'history'|'regenerated'|'approximate'}} Base approximate: converting
 *   the stamped commit no longer reproduces the stamped text, because the converter or its tables changed since
 * @typedef {{wiki: string, base: string, pvme: string}} ConflictRegion
 */

const STAMP = /\n*<!-- ?pvme-wikitext file=(\S+) commit=([0-9a-f]{40}) body=([0-9a-f]{64}) ?-->\s*/;

export const normalise = text => text.replace(/\r\n?/g, '\n').trimEnd();

export async function hashText(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalise(text)));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** @return {{content: string, stamp: Stamp|null}} */
export function splitPage(page) {
    const text = normalise(page);
    const match = text.match(STAMP);
    if (!match) return { content: text, stamp: null };
    const after = text.slice(match.index + match[0].length);
    return {
        content: normalise(text.slice(0, match.index) + (after ? '\n' + after : '')),
        stamp: { file: match[1], commit: match[2], body: match[3] },
    };
}

/**
 * @param {string} content generated page text
 * @param {{file: string, commit: string, generated?: string}} origin generated: the generated text when content is a merge
 *     of it with wiki edits, so the next reconciliation still starts from what PvME said
 */
export async function stampPage(content, { file, commit, generated = content }) {
    return `${normalise(content)}\n<!-- pvme-wikitext file=${file} commit=${commit} body=${await hashText(generated)} -->\n`;
}

/**
 * @param {string} live the page as it is now
 * @param {{history: () => Promise<string[]>, regenerate: (stamp: Stamp) => Promise<string|null>}} sources
 *     history: earlier page texts, newest first; regenerate: the guide at the stamped commit, converted now
 * @return {Promise<Base|null>}
 */
export async function findBase(live, { history, regenerate }) {
    let { stamp } = splitPage(live);
    const revisions = [live, ...await history()];
    // An editor may delete the stamp; the newest revision that had one still identifies the base.
    stamp ??= revisions.map(text => splitPage(text).stamp).find(Boolean) ?? null;
    if (!stamp) return null;
    for (const text of revisions) {
        const { content } = splitPage(text);
        if (await hashText(content) === stamp.body) return { content, commit: stamp.commit, source: 'history' };
    }
    const regenerated = await regenerate(stamp);
    if (regenerated === null) return null;
    const exact = await hashText(regenerated) === stamp.body;
    return { content: normalise(regenerated), commit: stamp.commit, source: exact ? 'regenerated' : 'approximate' };
}

/**
 * @param {{generated: string|null, live: string|null, base: Base|null}} texts page texts without stamps
 * @return {{state: SyncState, merged: string|null, conflicts: ConflictRegion[], needsReview: boolean}}
 */
export function reconcile({ generated, live, base }) {
    const result = (state, extra) => ({ state, merged: null, conflicts: [], needsReview: base?.source === 'approximate', ...extra });
    if (live === null) return result('unpublished', { needsReview: false });
    if (generated === null) return result('removed', { needsReview: true });
    const ours = normalise(generated);
    const theirs = normalise(live);
    if (ours === theirs) return result('synced', { needsReview: false });
    if (!base) return result('unmanaged', { needsReview: true });
    if (theirs === base.content) return result('pvme-ahead', { merged: ours });
    if (ours === base.content) return result('wiki-edited', { merged: theirs });

    const regions = diff3Merge(theirs.split('\n'), base.content.split('\n'), ours.split('\n'), { excludeFalseConflicts: true });
    const conflicts = regions.flatMap(region => region.conflict
        ? [{ wiki: region.conflict.a.join('\n'), base: region.conflict.o.join('\n'), pvme: region.conflict.b.join('\n') }] : []);
    if (conflicts.length) return result('conflict', { conflicts, needsReview: true });
    return result('mergeable', { merged: regions.flatMap(region => region.ok).join('\n') });
}

/**
 * The wiki's own edits, with the guide lines they correspond to, for offering back to PvME.
 *
 * @param {string} base
 * @param {string} live
 * @param {import('./convert.mjs').Conversion['lineMap']} lineMap of the conversion that produced base
 * @return {{before: string, after: string, line: number, sourceLine: number|null, sourceEndLine: number|null}[]}
 */
export function wikiEdits(base, live, lineMap) {
    const edits = [];
    let line = 1;
    let open = null;
    for (const part of diffLines(normalise(base) + '\n', normalise(live) + '\n')) {
        if (!part.added && !part.removed) {
            line += part.count;
            open = null;
            continue;
        }
        if (!open) edits.push(open = { before: '', after: '', line });
        if (part.added) open.after += part.value;
        else {
            open.before += part.value;
            line += part.count;
        }
    }
    return edits.map(edit => {
        const end = edit.line + Math.max(0, edit.before.split('\n').length - 2);
        const touched = lineMap.filter(piece => piece.line <= end && piece.endLine >= edit.line);
        return {
            ...edit,
            sourceLine: touched.length ? Math.min(...touched.map(piece => piece.sourceLine)) : null,
            sourceEndLine: touched.length ? Math.max(...touched.map(piece => piece.sourceEndLine)) : null,
        };
    });
}

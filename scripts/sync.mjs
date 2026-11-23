// Compares every guide with its page on a wiki and prepares what each side needs. Reads the wiki; never writes to it.
//   node scripts/sync.mjs --root "User:Example/PvME" [--out sync-report] [--api https://runescape.wiki/api.php]
// Output folder:
//   report.json       every page's state
//   report.md         the same for people
//   publish/          page text ready to paste: new pages, PvME updates, clean merges
//   conflicts/        pages both sides changed on the same or adjacent lines, with conflict markers
//   for-pvme/         wiki edits as a list of guide lines to change upstream
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { convertGuide, pageWikitext } from '../src/convert.mjs';
import { createResolver } from '../src/resolver.mjs';
import { findBase, reconcile, splitPage, stampPage, wikiEdits } from '../src/sync.mjs';
import { createWikiReader } from '../src/wiki.mjs';
import { loadData } from './load-data.mjs';

const { values: options } = parseArgs({
    options: { root: { type: 'string' }, out: { type: 'string', default: 'sync-report' }, api: { type: 'string' }, guides: { type: 'string' } },
});
if (!options.root) {
    console.error('usage: node scripts/sync.mjs --root "<wiki page the guides live under>"');
    process.exit(2);
}

const { source, guides, data } = await loadData({ guides: options.guides });
const resolver = createResolver(data, { root: options.root });
const wiki = createWikiReader(options.api, { 'User-Agent': 'pvme-wikitext/0.1 (guide sync report)' });
const build = (guide, text = guide.text) => {
    const conversion = convertGuide(text, resolver);
    return { conversion, page: pageWikitext(conversion, guide) };
};
async function regenerate(guide, stamp) {
    const response = await fetch(`https://raw.githubusercontent.com/pvme/pvme-guides/${stamp.commit}/${stamp.file}`);
    return response.ok ? build(guide, await response.text()) : null;
}

for (const folder of ['publish', 'conflicts', 'for-pvme']) {
    rmSync(path.join(options.out, folder), { recursive: true, force: true });
    mkdirSync(path.join(options.out, folder), { recursive: true });
}
const write = (folder, name, text) => writeFileSync(path.join(options.out, folder, name), text);

const titleOf = guide => `${options.root}/${guide.path}`;
const live = await wiki.pages(guides.map(titleOf));
const report = [];
for (const guide of guides) {
    const title = titleOf(guide);
    const page = live.get(title);
    const generated = build(guide).page;
    let baseConversion = null;
    const base = page === null ? null : await findBase(page, {
        history: () => wiki.history(title),
        regenerate: async stamp => {
            const result = await regenerate(guide, stamp);
            baseConversion = result?.conversion ?? null;
            return result?.page ?? null;
        },
    });
    const content = page === null ? null : splitPage(page).content;
    const { state, merged, conflicts, needsReview } = reconcile({ generated, live: content, base });
    const entry = { state, title, file: guide.file, needsReview, baseCommit: base?.commit ?? null, baseSource: base?.source ?? null };

    const origin = { file: guide.file, commit: source.commit, generated };
    const publishable = state === 'unpublished' ? generated : state === 'pvme-ahead' || state === 'mergeable' ? merged : null;
    if (publishable) write('publish', guide.slug + '.wiki', await stampPage(publishable, origin));
    if (state === 'conflict') {
        entry.conflicts = conflicts.length;
        write('conflicts', guide.slug + '.txt', conflicts.map(({ wiki: theirs, base: was, pvme }) =>
            `<<<<<<< wiki\n${theirs}\n||||||| both started from\n${was}\n=======\n${pvme}\n>>>>>>> pvme`).join('\n\n') + '\n');
    }
    if (['wiki-edited', 'mergeable', 'conflict'].includes(state)) {
        baseConversion ??= (await regenerate(guide, { commit: base.commit, file: guide.file }))?.conversion;
        const edits = wikiEdits(base.content, content, baseConversion?.lineMap ?? []);
        entry.wikiEdits = edits.length;
        write('for-pvme', guide.slug + '.md', `# ${guide.file}\n\nwiki page: ${title}\n` + edits.map(edit => {
            const lines = edit.sourceLine && `#L${edit.sourceLine}-L${edit.sourceEndLine}`;
            const where = lines ? `https://github.com/pvme/pvme-guides/blob/${base.commit}/${guide.file}${lines}` : 'no matching guide line';
            return `\n## ${where}\n\n\`\`\`diff\n${edit.before.replace(/^(?=.)/gm, '- ')}${edit.after.replace(/^(?=.)/gm, '+ ')}\`\`\`\n`;
        }).join(''));
    }
    report.push(entry);
}

// Pages that came from a guide PvME has since renamed or removed.
const known = new Set(guides.map(titleOf));
const extra = (await wiki.subpages(options.root)).filter(title => !known.has(title));
for (const [title, page] of await wiki.pages(extra)) {
    const stamp = page && splitPage(page).stamp;
    if (stamp && !guides.some(guide => guide.file === stamp.file)) report.push({ state: 'removed', title, file: stamp.file, needsReview: true });
    else if (stamp) report.push({ state: 'moved', title, file: stamp.file, needsReview: true });
}

const counts = Object.groupBy(report, entry => entry.state);
writeFileSync(path.join(options.out, 'report.json'), JSON.stringify({ root: options.root, commit: source.commit, checked: new Date().toISOString(), pages: report }, null, 1));
writeFileSync(path.join(options.out, 'report.md'), `# ${options.root} against pvme-guides ${source.commit.slice(0, 8)}\n` +
    Object.entries(counts).map(([state, entries]) => `\n## ${state} (${entries.length})\n\n` +
        entries.map(entry => `- ${entry.title} (${entry.file})${entry.needsReview ? ', needs review' : ''}`).join('\n') + '\n').join(''));
for (const [state, entries] of Object.entries(counts)) console.log(`${state.padEnd(12)} ${entries.length}`);
console.log(`report in ${options.out}`);

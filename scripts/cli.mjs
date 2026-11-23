#!/usr/bin/env node
// Converts guides.
//   pvme-wikitext afk/afk-arch-glacor.txt            one guide of the newest pvme-guides, or any local .txt file
//   pvme-wikitext --all --out wikitext               every guide, one file each
// Options:
//   --root <page>     wiki page the guides live under; guide links become wiki links below it
//   --guides <dir>    use this pvme-guides checkout
//   --json            print { title, wikitext, issues, counts } for one guide
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { convertGuide, pageWikitext } from '../src/convert.mjs';
import { createResolver } from '../src/resolver.mjs';
import { stampPage } from '../src/sync.mjs';
import { loadData } from './load-data.mjs';

const { values: options, positionals: [target] } = parseArgs({
    allowPositionals: true,
    options: {
        all: { type: 'boolean' }, json: { type: 'boolean' },
        out: { type: 'string' }, root: { type: 'string' }, guides: { type: 'string' },
    },
});
if (!options.all && !target) {
    console.error('usage: pvme-wikitext <guide.txt> [--root <page>] [--json]\n       pvme-wikitext --all --out <dir> [--root <page>]');
    process.exit(2);
}

const { source, guides, data } = await loadData({ guides: options.guides });
const resolver = createResolver(data, { root: options.root });
const reportIssues = (name, issues) => {
    for (const { code, detail, line } of issues) console.error(`${name}:${line ?? '?'} ${code} ${detail}`);
};

if (options.all) {
    const out = options.out ?? 'wikitext';
    mkdirSync(out, { recursive: true });
    for (const guide of guides) {
        const conversion = convertGuide(guide.text, resolver);
        const page = await stampPage(pageWikitext(conversion, guide), { file: guide.file, commit: source.commit });
        writeFileSync(path.join(out, guide.slug + '.wiki'), page);
        reportIssues(guide.file, conversion.issues);
    }
    console.error(`${guides.length} guides from pvme-guides ${source.commit.slice(0, 8)} written to ${out}`);
} else {
    const guide = guides.find(entry => entry.file === target.replaceAll('\\', '/').replace(/^.*pvme-guides\//, ''));
    if (!guide && !existsSync(target)) {
        console.error(`no guide or file named ${target}`);
        process.exit(2);
    }
    const conversion = convertGuide(guide?.text ?? readFileSync(target, 'utf8'), resolver);
    const { title, wikitext, issues, counts } = conversion;
    reportIssues(target, issues);
    if (options.json) console.log(JSON.stringify({ title, wikitext, issues, counts }, null, 1));
    else if (guide) process.stdout.write(await stampPage(pageWikitext(conversion, guide), { file: guide.file, commit: source.commit }));
    else process.stdout.write(wikitext);
}

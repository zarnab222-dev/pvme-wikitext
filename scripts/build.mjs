// Builds dist/: the site, and for other tools index.json plus one stamped page per guide in guides/<slug>.wiki.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { convertGuide, guideTitle, pageWikitext } from '../src/convert.mjs';
import { createResolver } from '../src/resolver.mjs';
import { hashText, stampPage } from '../src/sync.mjs';
import { loadData, ROOT } from './load-data.mjs';

const DIST = path.join(ROOT, 'dist');
const { source, guides, data } = await loadData();
rmSync(DIST, { recursive: true, force: true });
for (const folder of ['assets', 'guides', 'source']) mkdirSync(path.join(DIST, folder), { recursive: true });

function asset(name, content) {
    const { name: stem, ext } = path.parse(name);
    const file = `assets/${stem}-${createHash('sha256').update(content).digest('hex').slice(0, 12)}${ext}`;
    writeFileSync(path.join(DIST, file), content);
    return '/' + file;
}

const resolver = createResolver(data);
const index = [];
for (const { text, ...guide } of guides) {
    const conversion = convertGuide(text, resolver);
    const page = pageWikitext(conversion, guide);
    writeFileSync(path.join(DIST, 'guides', guide.slug + '.wiki'), await stampPage(page, { file: guide.file, commit: source.commit }));
    writeFileSync(path.join(DIST, 'source', guide.slug + '.txt'), text);
    index.push({
        ...guide, title: guideTitle(conversion, guide), wikitext: `/guides/${guide.slug}.wiki`,
        body: await hashText(page), counts: conversion.counts, issues: conversion.issues.length,
    });
}
const manifest = { source, generated: new Date().toISOString(), build: process.env.VERCEL_GIT_COMMIT_SHA ?? 'local', guides: index };
writeFileSync(path.join(DIST, 'index.json'), JSON.stringify(manifest));

const bundle = await build({
    entryPoints: [path.join(ROOT, 'site/app.mjs')], bundle: true, minify: true, format: 'esm', target: 'es2022', write: false,
});
const { presets, ...tables } = data;
const replacements = {
    STYLE: asset('style.css', readFileSync(path.join(ROOT, 'site/style.css'))),
    SCRIPT: asset('app.js', bundle.outputFiles[0].contents),
    TABLES: asset('tables.json', JSON.stringify(tables)),
    PRESETS: asset('presets.json', JSON.stringify(presets)),
    BUILD: manifest.build,
};
const html = readFileSync(path.join(ROOT, 'site/index.html'), 'utf8').replace(/\{\{([A-Z]+)\}\}/g, (_, name) => replacements[name]);
writeFileSync(path.join(DIST, 'index.html'), html);
cpSync(path.join(ROOT, 'site/favicon.svg'), path.join(DIST, 'favicon.svg'));
console.log(`${index.length} guides from pvme-guides ${source.commit.slice(0, 8)}`);

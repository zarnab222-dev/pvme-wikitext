// Checks every guide's conversion.
//   node scripts/check.mjs          every word of the parsed guide is in the wikitext, in order (offline after loading)
//   node scripts/check.mjs --wiki   also renders each page with runescape.wiki's own parser (read-only, about 10 minutes
//                                   the first time; results are cached by page text)
// Options: --only <text in slug>, --guides <pvme-guides checkout>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { convertGuide, embedsOf, isContentsEmbed, isContentsNote, pageWikitext, parseEmbedText, plainText, splitLines } from '../src/convert.mjs';
import { createResolver } from '../src/resolver.mjs';
import { createWikiReader } from '../src/wiki.mjs';
import { loadData, ROOT } from './load-data.mjs';

const { values: options } = parseArgs({ options: { wiki: { type: 'boolean' }, only: { type: 'string' }, guides: { type: 'string' } } });
const { guides, data } = await loadData({ guides: options.guides });
const selected = guides.filter(guide => guide.slug.includes(options.only ?? ''));
const resolver = createResolver(data);

// ---------- every word, in order ----------
const tokens = text => text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
function spokenText(node) {
    if (!node) return '';
    if (Array.isArray(node)) return node.map(child => spokenText(child)).join(' ');
    switch (node.type) {
        case 'text': case 'codeblock': return node.value;
        case 'inline-code': return ` ${node.value} `;
        case 'mention': return node.kind === 'role' ? resolver.role(node.target) ?? '' : '';
        case 'unknown-inline': return node.raw;
        case 'embed':
            return embedsOf(node.value).filter(embed => !isContentsEmbed(embed)).map(embed => [
                embed.author?.name, embed.title, embed.description,
                ...(embed.fields ?? []).flatMap(field => [field.name, field.value]), embed.footer?.text,
            ].filter(Boolean).map(text => spokenText(parseEmbedText(text).messages.flatMap(message => message.blocks))).join(' ')).join(' ');
        case 'paragraph':
            return splitLines(node.children).filter(line => !isContentsNote(plainText(line)))
                .map(line => line.map(spokenText).join('')).join(' ');
        default: {
            // Styles split words ("**A**uras"), so inline runs join without a space.
            const children = node.children ?? node.items ?? [];
            const isInline = ['bold', 'italic', 'underline', 'strikethrough', 'spoiler', 'heading', 'subtext', 'link'].includes(node.type);
            return children.map(child => child.type === 'line-break' ? ' ' : spokenText(child)).join(isInline ? '' : ' ');
        }
    }
}
const decode = text => text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(code)).replace(/&lt;/g, '<').replace(/&amp;/g, '&');
const visibleText = wikitext => decode(wikitext
    .replace(/<!--[\s\S]*?-->/g, '').replace(/\{\{Extimage[^}]*\}\}/g, ' ').replace(/<youtube[\s\S]*?<\/youtube>/g, ' ')
    .replace(/<nowiki\/>/g, '').replace(/<br>/g, ' ').replace(/<\/?(?:u|s|code|pre|small|blockquote|span)\b[^>]*>/g, match => /^<\/?[us]>/.test(match) ? '' : ' ')
    .replace(/\[\[File:[^\]]*\]\]/g, ' ').replace(/\[\[[^\]|]*\|/g, '').replace(/\[\[|\]\]/g, '')
    .replace(/\[(?:https?:\/\/|#)\S*/g, '').replace(/'{2,}/g, ''));

const wordsOnly = { ...resolver, emoji: () => ({ name: '', file: 'x.png' }), preset: () => null };
let wordCount = 0;
const losses = [];
for (const guide of selected) {
    const { wikitext, document, title } = convertGuide(guide.text, wordsOnly);
    const expected = tokens(document.messages.map(message => spokenText(message.blocks)).join(' ').replace(/https?:\/\/\S+/g, ' '));
    const actual = tokens(title + '\n' + visibleText(wikitext).replace(/https?:\/\/\S+/g, ' '));
    // The title leaves the body, wherever it stood in the guide.
    const titleWords = tokens(title);
    const start = titleWords.length ? expected.findIndex((_, i) => titleWords.every((word, j) => expected[i + j] === word)) : -1;
    if (start > 0) expected.unshift(...expected.splice(start, titleWords.length));
    wordCount += expected.length;
    let at = 0;
    for (const [i, word] of expected.entries()) {
        const found = actual.indexOf(word, at);
        if (found < 0 || found - at > 400) {
            losses.push(`${guide.slug}: "${expected.slice(Math.max(0, i - 4), i + 5).join(' ')}" (lost "${word}")`);
            break;
        }
        at = found + 1;
    }
}
console.log(`words: ${wordCount} in ${selected.length} guides, ${losses.length} guides with a word lost or out of order`);
for (const loss of losses) console.log('  ' + loss);

// ---------- runescape.wiki's own parser ----------
const problems = [];
// Links to missing articles come from the guides themselves, so they are listed for PvME rather than failing the check.
const redlinkNotes = [];
if (options.wiki) {
    const cacheFile = path.join(ROOT, '.cache', 'wiki-parse.json');
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
    const wiki = createWikiReader(undefined, { 'User-Agent': 'pvme-wikitext/0.1 (guide converter)' });
    const files = new Set();
    for (const [i, guide] of selected.entries()) {
        const conversion = convertGuide(guide.text, resolver);
        const page = pageWikitext(conversion, guide);
        const key = createHash('sha256').update(page).digest('hex');
        if (!cache[key]) {
            const parsed = await wiki.parse(`User:Example/PvME/${guide.path}`, page);
            cache[key] = {
                warnings: parsed.parsewarnings,
                redlinks: parsed.links.filter(link => !link.exists && link.ns >= 0).map(link => link.title),
                images: parsed.images,
                errors: [...parsed.text.matchAll(/class="(?:scribunto-error|error|cite_error)[^"]*"[^>]*>([^<]{0,120})/g)].map(match => match[1]),
            };
            writeFileSync(cacheFile, JSON.stringify(cache));
            await new Promise(resolve => setTimeout(resolve, 700));
        }
        const { warnings, redlinks, images, errors } = cache[key];
        for (const image of images) files.add(image);
        for (const warning of warnings) problems.push(`${guide.slug}: warning: ${warning}`);
        for (const error of errors) problems.push(`${guide.slug}: error: ${error}`);
        for (const link of redlinks) redlinkNotes.push(`${guide.file}: ${link}`);
        if (i % 50 === 49) console.log(`  rendered ${i + 1} of ${selected.length}`);
    }
    for (const file of await wiki.missingFiles([...files])) problems.push(`missing file: ${file}`);
    console.log(`wiki: ${selected.length} pages rendered, ${files.size} files used, ${problems.length} problems`);
    for (const problem of problems) console.log('  ' + problem);
    console.log(`${redlinkNotes.length} links to articles the wiki does not have, as written in the guides`);
    for (const note of redlinkNotes) console.log('  ' + note);
}
process.exitCode = losses.length || problems.length ? 1 : 0;

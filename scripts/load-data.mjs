import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPresetRenderer } from '../src/presets.mjs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CACHE = path.join(ROOT, '.cache');
const GUIDES_REPO = 'https://github.com/pvme/pvme-guides';
const SETTINGS = 'https://raw.githubusercontent.com/pvme/pvme-settings/';
const PRESET_API = 'https://getpresetv2-bi6xdqcqpq-uc.a.run.app?id=';
const HEADERS = { 'User-Agent': 'pvme-wikitext/0.1 (guide converter)' };
// Discord-only sources that pvme.io does not publish as guides.
const UNPUBLISHED = new Set([
    'archive', 'commands', 'navigation', 'testing',
    'get-involved/editor-entry.txt', 'miscellaneous-information/command-info.txt',
]);

const readData = name => JSON.parse(readFileSync(path.join(ROOT, 'data', name), 'utf8'));
async function fetchJson(url) {
    const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response.json();
}

/** A shallow checkout of pvme-guides at its newest commit, or the directory given. */
function checkoutGuides(directory) {
    const target = directory ?? path.join(CACHE, 'pvme-guides');
    const git = (...args) => execFileSync('git', ['-C', target, ...args], { encoding: 'utf8' }).trim();
    if (!directory && !existsSync(path.join(target, '.git')))
        execFileSync('git', ['clone', '-q', '--depth', '1', GUIDES_REPO, target]);
    else if (!directory) {
        git('fetch', '-q', '--depth', '1', 'origin', 'master');
        git('reset', '-q', '--hard', 'FETCH_HEAD');
    }
    return { directory: target, commit: git('rev-parse', 'HEAD'), date: git('log', '-1', '--format=%cI') };
}

function listGuides(directory) {
    const files = [];
    const walk = folder => {
        for (const entry of readdirSync(path.join(directory, folder), { withFileTypes: true })) {
            const file = folder ? `${folder}/${entry.name}` : entry.name;
            if (entry.name.startsWith('.') || UNPUBLISHED.has(file)) continue;
            if (entry.isDirectory()) walk(file);
            else if (folder && entry.isFile() && file.endsWith('.txt')) files.push(file);
        }
    };
    walk('');
    return files.sort();
}

function spreadsheetValues({ cells, cell_aliases: aliases }, texts) {
    const values = { ...aliases };
    for (const [, key] of texts.flatMap(text => [...text.matchAll(/\$data_([^$\s]+![A-Z]+\d+)\$/g)])) {
        const [, sheet, column, row] = key.match(/^(?:pvme:)?(.+)!([A-Z]+)(\d+)$/);
        const value = cells[sheet]?.[column]?.[Number(row)];
        if (value !== undefined) values[key] = value;
    }
    return values;
}

async function loadPresets(texts) {
    const presets = readData('presets.json');
    const links = /presets\.pvme\.io\/?\?id=([\w-]+)|preset-maker-storage\/embeds\/([\w-]+)/g;
    const ids = new Set(texts.flatMap(text => [...text.matchAll(links)].map(match => match[1] ?? match[2])));
    for (const id of ids) {
        if (presets[id]) continue;
        // A preset that cannot be fetched stays a plain link and is reported as PRESET_AS_LINK.
        presets[id] = await fetchJson(PRESET_API + encodeURIComponent(id)).catch(error => ({ error: error.message }));
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    return Object.fromEntries([...ids].map(id => [id, presets[id]]));
}

/**
 * Guide sources plus everything they reference by id, from PvME's own repositories and this repo's wiki name tables.
 *
 * @param {{guides?: string}} [options] guides: an existing pvme-guides checkout to use instead of the newest commit
 * @return {Promise<{source: {commit: string, date: string}, guides: {slug: string, file: string, path: string, url: string,
 *     sourceUrl: string, text: string}[], data: import('../src/resolver.mjs').GuideData}>}
 */
export async function loadData({ guides: directory } = {}) {
    const source = checkoutGuides(directory);
    const [channels, roles, users, spreadsheet, registryFile] = await Promise.all([
        'pvme-discord/channels.json', 'pvme-discord/roles.json', 'settings/users/users.json',
        'settings/pvme-spreadsheet/pvme_spreadsheet.json', 'master/emojis/emojis_v2.json',
    ].map(file => fetchJson(SETTINGS + file)));
    const registry = registryFile.categories.flatMap(category => category.emojis);
    const titles = new Map(readFileSync(path.join(ROOT, 'data/titles.tsv'), 'utf8').trim().split(/\r?\n/).slice(1)
        .map(line => line.split('\t')));

    const guides = listGuides(source.directory).map(file => {
        const slug = file.replace(/\.txt$/, '').replaceAll('/', '--');
        const text = readFileSync(path.join(source.directory, file), 'utf8');
        const heading = text.match(/^# (.+)$/m)?.[1].replace(/<a?:\w+:\d+>|[*_]{2}/g, '').trim();
        return {
            slug, file, text,
            path: titles.get(slug) ?? `Unsorted/${heading || path.basename(file, '.txt')}`,
            url: `https://pvme.io/pvme-guides/${file.replace(/\.txt$/, '')}/`,
            // Not pinned to a commit: the page text must change only when the guide does. The stamp records the commit.
            sourceUrl: `${GUIDES_REPO}/blob/master/${file}`,
        };
    });
    const texts = guides.map(guide => guide.text);

    const wikiNames = readData('emoji.json');
    const { _why, ...overrides } = readData('emoji-overrides.json');
    const emoji = { ...wikiNames };
    for (const [id, entry] of Object.entries(overrides)) if (entry && /^\d+$/.test(id)) emoji[id] = { ...emoji[id], ...entry };
    for (const [id, entry] of Object.entries(readData('icon-overrides.json'))) emoji[id] = { ...emoji[id], ...entry };
    const emojiNames = {};
    for (const entry of registry) {
        if (!entry.emoji_id) continue;
        emoji[entry.emoji_id] ??= { name: entry.name };
        for (const name of [entry.id, ...(entry.id_aliases ?? [])]) emojiNames[name] = entry.emoji_id;
    }

    const bySlug = new Map(guides.map(guide => [guide.slug, guide]));
    const channelTable = Object.fromEntries(channels.map(({ id, name }) => [id, { label: name }]));
    for (const [id, slug] of Object.entries(readData('channel-guides.json'))) {
        const guide = bySlug.get(slug);
        if (guide) channelTable[id] = { label: guide.path.split('/').pop(), slug };
        else if (slug.startsWith('hub:')) channelTable[id] ??= { label: slug.slice(4) };
    }

    const render = createPresetRenderer({
        emoji: wikiNames, emojiOverrides: overrides, registry,
        itemOverrides: readData('item-overrides.json'), presetGaps: readData('preset-noicon.json'),
    });
    const presets = Object.entries(await loadPresets(texts)).map(([id, preset]) => [id, render(id, preset)]);

    const named = list => Object.fromEntries(list.map(({ id, name }) => [id, name]));
    return {
        source: { commit: source.commit, date: source.date },
        guides,
        data: {
            emoji, emojiNames, channels: channelTable, users: named(users), roles: named(roles),
            spreadsheet: spreadsheetValues(spreadsheet, texts),
            presets: Object.fromEntries(presets.filter(([, wikitext]) => wikitext)),
            guides: Object.fromEntries(guides.map(({ slug, path: guidePath, url }) => [slug, { path: guidePath, url }])),
        },
    };
}

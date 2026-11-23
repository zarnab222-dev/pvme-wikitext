import { convertGuide, pageWikitext } from '../src/convert.mjs';
import { createResolver } from '../src/resolver.mjs';
import { findBase, reconcile, splitPage, stampPage, wikiEdits } from '../src/sync.mjs';
import { createWikiReader } from '../src/wiki.mjs';

const WIKI = 'https://runescape.wiki';
const WIKI_STYLES = WIKI + '/load.php?lang=en-gb&modules=mediawiki.skinning.content.parsoid%7Cskins.vector.styles.legacy%7Csite.styles&only=styles&skin=vector';
const RENDER_DELAY_MS = 900;

const $ = id => document.getElementById(id);
function el(tag, attributes = {}, ...children) {
    const node = Object.assign(document.createElement(tag), attributes);
    node.append(...children.filter(child => child !== null && child !== undefined));
    return node;
}
const remembered = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* a convenience only */ } },
};
async function load(url, kind) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response[kind]();
}

// Symbol and wording both carry the state, so nothing depends on colour.
const STATES = {
    unpublished: ['○', 'not on the wiki', 'Publish the generated page.'],
    unmanaged: ['?', 'no stamp', 'The page was not generated here. Compare it by hand before replacing it.'],
    synced: ['=', 'in sync', 'Nothing to do.'],
    'pvme-ahead': ['→', 'pvme ahead', 'Only pvme changed. Publish the generated page.'],
    'wiki-edited': ['←', 'wiki ahead', 'Only the wiki changed. Offer these edits to pvme.'],
    mergeable: ['⇄', 'both changed, merges', 'Publish the merge and offer the wiki edits to pvme.'],
    conflict: ['✕', 'both changed, conflict', 'Both sides changed the same lines. Choose a version for each.'],
};

const wiki = createWikiReader(WIKI + '/api.php');
const [index, tables] = await Promise.all([load('/index.json', 'json'), load(document.body.dataset.tables, 'json')]);
const data = { ...tables, presets: await load(document.body.dataset.presets, 'json') };
const guides = new Map(index.guides.map(guide => [guide.slug, guide]));
const badges = new Map();

let guide = null;
let original = '';
let current = null;
let resolver = createResolver(data);

// ---------- guide list ----------
function buildRail() {
    const hubs = Map.groupBy([...guides.values()].sort((a, b) => a.path.localeCompare(b.path)), entry => entry.path.split('/')[0]);
    $('guides').replaceChildren(...[...hubs].map(([hub, entries]) => el('section', {}, el('h3', { textContent: hub }),
        ...entries.map(entry => {
            const badge = el('span', { className: 'badge' });
            badges.set(entry.slug, badge);
            const link = el('a', { href: '#' + entry.slug }, el('span', { textContent: entry.path.split('/').slice(1).join('/') || hub }), badge);
            link.dataset.slug = entry.slug;
            link.dataset.search = (entry.path + ' ' + entry.file).toLowerCase();
            return link;
        }))));
}
$('find').addEventListener('input', () => {
    const words = $('find').value.toLowerCase().split(/\s+/).filter(Boolean);
    for (const section of $('guides').children) {
        const links = [...section.querySelectorAll('a')];
        for (const link of links) link.hidden = !words.every(word => link.dataset.search.includes(word));
        section.hidden = links.every(link => link.hidden);
    }
});
function toggleRail(open) {
    document.body.classList.toggle('rail-open', open);
    $('menu').setAttribute('aria-expanded', String(open));
}
$('menu').addEventListener('click', () => toggleRail(!document.body.classList.contains('rail-open')));

// ---------- conversion ----------
const buildPage = (text, entry = guide) => {
    const conversion = convertGuide(text, resolver);
    return { conversion, content: pageWikitext(conversion, entry) };
};
const originOf = (entry, generated) => ({ file: entry.file, commit: index.source.commit, generated });
const rootPage = () => $('root').value.trim().replace(/\/+$/, '');
const wikiTitle = (entry = guide) => `${rootPage() || 'PvME'}/${entry.path}`;

async function convert() {
    const built = buildPage($('source').value);
    const page = await stampPage(built.content, originOf(guide, built.content));
    current = { ...built, page };
    $('wikitext').value = page;
    $('copy').disabled = false;
    $('reset').hidden = $('source').value === original;
    const { conversion } = built;
    const { messages, headings, lists, embeds, icons, presets, images, videos, links } = conversion.counts;
    $('counts').replaceChildren(...Object.entries({ messages, headings, lists, embeds, icons, presets, images, videos, links, 'wikitext characters': page.length })
        .map(([label, value]) => el('div', {}, el('dt', { textContent: label }), el('dd', { textContent: value.toLocaleString('en-GB') }))));
    showIssues(conversion);
    showTree(conversion.document);
    $('editor').href = `${WIKI}/index.php?` + new URLSearchParams({
        // Without a root the page opens in the reader's own user space.
        title: rootPage() ? wikiTitle() : 'Special:MyPage/' + wikiTitle(), action: 'edit',
    });
    scheduleRender();
    await showSandboxSync();
}

const ISSUE_MEANINGS = {
    ICON_AS_TEXT: 'the wiki has no icon for this emoji, so its name is written out',
    UNKNOWN_USER: 'pvme’s user list has no name for this id',
    UNKNOWN_ROLE: 'pvme’s role list has no name for this id',
    UNKNOWN_CHANNEL: 'pvme’s channel list has no name for this id',
    BLOCKED_LINK: 'the wiki’s spam blacklist rejects this host, so only the text is kept',
    PRESET_AS_LINK: 'the preset maker has no data for this preset, so only its link is kept',
    LINK_AS_TEXT: 'this is not a web address, so only the text is kept',
    MISSING_TAG: 'no tag with this name in the guide',
};
function showIssues({ issues, omitted }) {
    $('issue-count').textContent = issues.length || '';
    const groups = Map.groupBy(issues, issue => issue.code);
    const blocks = [...groups].map(([code, entries]) => el('section', {},
        el('h3', { textContent: `${code} · ${entries.length}` }),
        el('p', { className: 'note', textContent: ISSUE_MEANINGS[code] ?? (code.startsWith('PARSER_') ? 'reported by the guide parser' : '') }),
        el('ul', {}, ...entries.map(({ detail, line }) => el('li', {}, line
            ? el('button', { type: 'button', className: 'line', textContent: 'line ' + line, onclick: () => jumpToLine(line) }) : null, ' ' + detail)))));
    if (omitted.length) blocks.push(el('section', {}, el('h3', { textContent: `left out · ${omitted.length}` }),
        el('p', { className: 'note', textContent: 'pinned tables of contents; the wiki builds its own' })));
    $('issues').replaceChildren(...blocks.length ? blocks : [el('p', { className: 'note', textContent: 'Everything in this guide has a wiki form.' })]);
}
function jumpToLine(line) {
    showView('source');
    const box = $('source');
    const start = box.value.split('\n').slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);
    const end = box.value.indexOf('\n', start);
    box.focus();
    box.setSelectionRange(start, end < 0 ? box.value.length : end);
    box.scrollTop = (line - 5) * Number.parseFloat(getComputedStyle(box).lineHeight);
}

function showTree(document) {
    const branch = node => {
        const children = node.blocks ?? node.children ?? node.items ?? [];
        const label = [el('b', { textContent: node.type ?? 'message ' + (node.index + 1) }), ' ',
            el('span', { textContent: node.value && typeof node.value === 'string' ? node.value : node.name ?? node.url ?? node.target ?? node.parameter ?? node.text ?? '' })];
        if (!children.length) return el('div', { className: 'leaf' }, ...label);
        const details = el('details', {}, el('summary', {}, ...label));
        details.addEventListener('toggle', () => { if (details.open && details.children.length === 1) details.append(...children.map(branch)); });
        return details;
    };
    $('tree').replaceChildren(...document.messages.map(branch));
}

// ---------- wiki render ----------
let renderTimer = 0;
let rendered = '';
const isShown = view => document.querySelector(`.view[data-view="${view}"]`).classList.contains('shown');
function scheduleRender() {
    clearTimeout(renderTimer);
    if (isShown('preview') && current && current.content !== rendered) renderTimer = setTimeout(render, RENDER_DELAY_MS);
}
/** The sandboxed render cannot run players, so a video shows as its thumbnail. */
const stillVideos = html => html.replace(/<iframe[^>]*?youtube(?:-nocookie)?[.]com[/]embed[/]([a-zA-Z0-9_-]{11})[^>]*>(?:<[/]iframe>)?/g,
    (_, id) => `<a href="https://www.youtube.com/watch?v=${id}"><img src="https://i.ytimg.com/vi/${id}/hqdefault.jpg" alt="video" width="400"></a>`);
async function render() {
    const { content } = current;
    $('preview-note').textContent = 'rendering on runescape.wiki…';
    try {
        const { text, parsewarnings } = await wiki.parse(wikiTitle(), content);
        if (content !== current.content) return;
        rendered = content;
        $('render').srcdoc = `<!doctype html><base href="${WIKI}/" target="_blank"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${WIKI_STYLES}"><style>html,body{background:#fff;color:#222;height:auto}body{margin:0;padding:16px;font:14px/1.6 system-ui,sans-serif}.mw-parser-output{max-width:100%;overflow-wrap:anywhere}img,iframe{max-width:100%}img{height:auto}</style>
<div class="mw-body-content mw-content-ltr"><h1>${$('title').textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</h1>${stillVideos(text)}</div>`;
        $('preview-note').textContent = parsewarnings.length ? parsewarnings.join(' ') : '';
    } catch (error) {
        $('preview-note').textContent = `runescape.wiki could not render this (${error.message}). Try again by editing or reopening the guide.`;
    }
}

// ---------- sync ----------
function syncReport({ state, merged, conflicts, needsReview }, { base, live, lineMap, generated }) {
    const [symbol, name, advice] = STATES[state];
    const parts = [el('p', { className: 'state' }, el('span', { className: 'symbol', textContent: symbol }), el('strong', { textContent: name }), el('span', { textContent: advice }))];
    if (needsReview && state !== 'unmanaged' && state !== 'conflict') parts.push(el('p', { className: 'note', textContent: 'The converter changed since this page was published, so check the result before using it.' }));
    if (['pvme-ahead', 'mergeable'].includes(state)) {
        const button = el('button', { type: 'button', textContent: 'copy updated page' });
        button.addEventListener('click', () => copyText(async () => stampPage(merged, originOf(guide, generated)), button));
        parts.push(button);
    }
    for (const conflict of conflicts) parts.push(el('div', { className: 'conflict' },
        ...[['wiki', conflict.wiki], ['both started from', conflict.base], ['pvme', conflict.pvme]].map(([label, text]) => el('div', {}, el('h4', { textContent: label }), el('pre', { textContent: text })))));
    if (['wiki-edited', 'mergeable', 'conflict'].includes(state)) {
        const edits = wikiEdits(base.content, live, lineMap);
        parts.push(el('h3', { textContent: `wiki edits · ${edits.length}` }), ...edits.map(edit => el('div', { className: 'edit' },
            edit.sourceLine ? el('a', {
                textContent: `${guide.file} lines ${edit.sourceLine}–${edit.sourceEndLine}`, target: '_blank', rel: 'noopener',
                href: `https://github.com/pvme/pvme-guides/blob/${base.commit}/${guide.file}#L${edit.sourceLine}-L${edit.sourceEndLine}`,
            }) : el('span', { className: 'note', textContent: 'outside the guide text' }),
            el('pre', {}, ...edit.before.split('\n').filter(Boolean).map(line => el('del', { textContent: '- ' + line + '\n' })),
                ...edit.after.split('\n').filter(Boolean).map(line => el('ins', { textContent: '+ ' + line + '\n' }))))));
    }
    $('sync-result').replaceChildren(...parts);
}
let publishedCopy = '';
async function showSandboxSync() {
    const live = $('wiki-copy').value;
    const base = await findBase(live, { history: async () => [publishedCopy], regenerate: async () => null });
    const content = splitPage(live).content;
    syncReport(reconcile({ generated: current.content, live: content, base }),
        { base, live: content, generated: current.content, lineMap: buildPage(original).conversion.lineMap });
}
async function checkAgainstWiki(entry, page) {
    const { conversion, content: generated } = entry === guide ? current : buildPage(await load(`/source/${entry.slug}.txt`, 'text'), entry);
    let lineMap = conversion.lineMap;
    const base = page === null ? null : await findBase(page, {
        history: () => wiki.history(wikiTitle(entry)),
        async regenerate(stamp) {
            const response = await fetch(`https://raw.githubusercontent.com/pvme/pvme-guides/${stamp.commit}/${stamp.file}`);
            if (!response.ok) return null;
            const earlier = buildPage(await response.text(), entry);
            lineMap = earlier.conversion.lineMap;
            return earlier.content;
        },
    });
    const live = page === null ? null : splitPage(page).content;
    return { outcome: reconcile({ generated, live, base }), context: { base, live, lineMap, generated } };
}
function showBadge(slug, state) {
    const [symbol, name] = STATES[state];
    Object.assign(badges.get(slug), { textContent: symbol, title: name, ariaLabel: name });
}
async function withBusy(button, work) {
    button.disabled = true;
    try { await work(); } catch (error) { $('sync-note').textContent = `runescape.wiki could not be read (${error.message}).`; } finally { button.disabled = false; }
}
$('check-page').addEventListener('click', () => withBusy($('check-page'), async () => {
    const title = wikiTitle();
    $('sync-note').textContent = `reading ${title}…`;
    const page = (await wiki.pages([title])).get(title);
    const { outcome, context } = await checkAgainstWiki(guide, page);
    if (page !== null) $('wiki-copy').value = page;
    syncReport(outcome, context);
    showBadge(guide.slug, outcome.state);
    $('sync-note').textContent = `compared with ${title}`;
}));
$('check-all').addEventListener('click', () => withBusy($('check-all'), async () => {
    const entries = [...guides.values()];
    $('sync-note').textContent = 'reading the wiki…';
    const pages = await wiki.pages(entries.map(entry => wikiTitle(entry)));
    const totals = {};
    for (const entry of entries) {
        const { outcome } = await checkAgainstWiki(entry, pages.get(wikiTitle(entry)));
        totals[outcome.state] = (totals[outcome.state] ?? 0) + 1;
        showBadge(entry.slug, outcome.state);
        $('sync-note').textContent = Object.entries(totals).map(([state, count]) => `${STATES[state][0]} ${STATES[state][1]}: ${count}`).join(' · ');
    }
}));
$('root').value = remembered.get('root') ?? '';
function applyRoot() {
    remembered.set('root', rootPage());
    resolver = createResolver(data, { root: rootPage() || null });
}
applyRoot();
$('root').addEventListener('change', async () => {
    applyRoot();
    await resetWikiCopy();
    await convert();
});
async function resetWikiCopy() {
    const { content } = buildPage(original);
    publishedCopy = await stampPage(content, originOf(guide, content));
    $('wiki-copy').value = publishedCopy;
}
$('wiki-copy').addEventListener('input', showSandboxSync);
$('reset-copy').addEventListener('click', async () => {
    await resetWikiCopy();
    await showSandboxSync();
});

// ---------- copy ----------
/** Copies in the click itself, so browsers that require a user gesture allow it. */
async function copyText(getText, button) {
    const label = button.textContent;
    let text = '';
    try {
        text = await getText();
        await navigator.clipboard.writeText(text);
        $('status').textContent = `Copied ${text.length.toLocaleString('en-GB')} characters.`;
        button.textContent = 'copied';
    } catch {
        showView('wikitext');
        if (text) $('wikitext').value = text;
        $('wikitext').focus();
        $('wikitext').select();
        $('status').textContent = 'The browser blocked the clipboard. The wikitext is selected; press Ctrl+C or Command+C.';
    }
    setTimeout(() => {
        button.textContent = label;
        $('status').textContent = '';
    }, 4000);
}
$('copy').addEventListener('click', () => copyText(() => current.page, $('copy')));

// ---------- views ----------
function showView(view) {
    const pane = document.querySelector(`.view[data-view="${view}"]`).closest('.pane');
    for (const node of pane.querySelectorAll('.view')) node.classList.toggle('shown', node.dataset.view === view);
    for (const tab of pane.querySelectorAll('[role=tab]')) tab.setAttribute('aria-selected', String(tab.dataset.view === view));
    remembered.set('view-' + pane.dataset.side, view);
    scheduleRender();
}
for (const tab of document.querySelectorAll('[role=tab]')) tab.addEventListener('click', () => showView(tab.dataset.view));

let convertTimer = 0;
$('source').addEventListener('input', () => {
    clearTimeout(convertTimer);
    convertTimer = setTimeout(convert, 250);
});
$('reset').addEventListener('click', () => {
    $('source').value = original;
    convert();
});

async function openGuide() {
    const slug = decodeURIComponent(location.hash.slice(1));
    guide = guides.get(slug) ?? guides.get('afk--afk-arch-glacor') ?? index.guides[0];
    toggleRail(false);
    for (const link of $('guides').querySelectorAll('a')) link.toggleAttribute('aria-current', link.dataset.slug === guide.slug);
    $('guides').querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' });
    $('title').textContent = guide.title;
    $('file').replaceChildren(el('a', { href: guide.sourceUrl, textContent: guide.file, target: '_blank', rel: 'noopener' }), ' · ',
        el('a', { href: guide.url, textContent: 'pvme.io', target: '_blank', rel: 'noopener' }));
    document.title = `${guide.title} | pvme wikitext`;
    Object.assign($('download'), { href: guide.wikitext, download: guide.slug + '.wiki' });
    const requested = guide;
    const text = await load(`/source/${guide.slug}.txt`, 'text');
    if (guide !== requested) return;
    original = text;
    $('source').value = text;
    original = $('source').value;
    $('sync-note').textContent = '';
    await resetWikiCopy();
    await convert();
}

buildRail();
$('origin').replaceChildren(`${guides.size} guides · pvme-guides `, el('a', {
    href: 'https://github.com/pvme/pvme-guides/commit/' + index.source.commit, textContent: index.source.commit.slice(0, 8), target: '_blank', rel: 'noopener',
}), ` · ${index.source.date.slice(0, 10)}`);
showView(remembered.get('view-left') ?? 'wikitext');
showView(remembered.get('view-right') ?? 'preview');
addEventListener('hashchange', openGuide);
await openGuide();

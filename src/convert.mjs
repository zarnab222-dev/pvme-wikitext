import { parseGuide } from '@pvme/guide-parser';
import { escapeLabel, escapePre, escapeText, escapeUrl, guardLineStart, join, wrapLines } from './escape.mjs';

/**
 * @typedef {Object} Resolver answers for what guide text only references by id; see resolver.mjs
 * @property {(id: string|null, name: string) => {name: string, file?: string, page?: string, qualifier?: string}|null} emoji
 * @property {(id: string) => {label: string, title?: string, url?: string}|null} channel
 * @property {(id: string) => string|null} user
 * @property {(id: string) => string|null} role
 * @property {(key: string) => string|null} data spreadsheet value
 * @property {(id: string) => string|null} preset preset block as wikitext
 *
 * @typedef {Object} Issue something the output could not carry natively
 * @property {string} code
 * @property {string} detail
 * @property {number|null} line source line
 *
 * @typedef {Object} Conversion
 * @property {string} title
 * @property {string} wikitext
 * @property {{line: number, endLine: number, sourceLine: number, sourceEndLine: number}[]} lineMap
 *     which guide lines each run of wikitext lines came from
 * @property {Issue[]} issues
 * @property {string[]} omitted Discord-only text left out (tables of contents and notes about where they are pinned)
 * @property {Object<string, number>} counts
 * @property {import('@pvme/guide-parser').GuideDocument} document
 */

const STYLES = {
    bold: ["'''", "'''"], italic: ["''", "''"], underline: ['<u>', '</u>'],
    strikethrough: ['<s>', '</s>'], spoiler: ['', ''],
};
// Markers that read as words or symbols rather than as list bullets.
const KEPT_MARKERS = new Set(['→', '►', '+', '★', '◆']);
// runescape.wiki's spam blacklist rejects an edit that links these hosts.
const BLOCKED_HOSTS = /^(?:www\.)?(?:forms\.gle|tinyurl\.com|linktr\.ee)$/;
const PRESET_LINK = /(?:presets\.pvme\.io\/?\?(?:[^#]*&)?id=|pvme\.io\/preset-maker-storage\/embeds\/)([\w-]+)/;
const YOUTUBE_LINK = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/;
const IMAGE_LINK = /^https?:\/\/img\.pvme\.io\/.+\.(?:png|jpe?g|gif|webp)$/i;
const VIDEO_FILE = /\.(?:mp4|webm|mov)$/i;
const DISCORD_LINK = /^https?:[/][/](?:(?:www|ptb|canary)[.])?discord(?:app)?[.]com[/]channels[/]534508796639182860[/]([0-9]+)/;
const EMBED_KEYS = new Set(['title', 'description', 'color', 'fields', 'footer', 'thumbnail', 'image', 'url', 'author', 'type']);

/** The RuneScape Wiki page a URL points at, or null for any other URL. */
export function wikiTarget(url) {
    const match = url.match(/^https?:\/\/(?:runescape\.wiki\/w\/|rs\.wiki\/)([^?]+)$/);
    if (!match) return null;
    let target;
    try { target = decodeURIComponent(match[1]); } catch { return null; }
    target = target.replaceAll('_', ' ').replace(/#$/, '').trim();
    if (/[<>[\]{}|]/.test(target) || /^special:/i.test(target)) return null;
    return /^(?:file|category):/i.test(target) ? ':' + target : target;
}

export const plainText = nodes => nodes.map(node => {
    if (node.children) return plainText(node.children);
    if (node.type === 'line-break') return ' ';
    return node.type === 'text' || node.type === 'inline-code' ? node.value : '';
}).join('').replace(/[\u200b\u200e\u200f]/g, '').replace(/\s+/g, ' ').trim();

// The rules marked "as on pvme-website" follow PvME's own renderer (src/lib/renderer.ts in pvme/pvme-website).
// As on pvme-website, but by line: a line pointing readers at Discord's pins means nothing on a page.
export const isContentsNote = text => /[^a-z]table of contents[^a-z]/i.test(` ${text} `) && /[^a-z](?:pins|pinned messages?)[^a-z]/i.test(` ${text} `);
/** Inline nodes by line; a style spanning several lines stays with the line it starts on. */
export const splitLines = nodes => nodes.reduce((lines, node) => {
    if (node.type === 'line-break') lines.push([]);
    else lines.at(-1).push(node);
    return lines;
}, [[]]);
export const isContentsEmbed = embed => /table of contents/i.test(embed.title ?? '');
export function embedsOf(value) {
    if (value?.embeds) return value.embeds;
    if (value?.embed) return [value.embed];
    return value?.title || value?.description || value?.fields ? [value] : [];
}
/** Embed strings carry their own Markdown and indent with no-break spaces. */
export const embedMarkdown = text => String(text).replace(/\r\n/g, '\n')
    .replace(/^[ \u00a0\u200b\u200e\u200f\u2000-\u200a\u2800\u3000]+/gm,
        indent => ' '.repeat(indent.replace(/[\u200b\u200e\u200f]/g, '').length));
// As on pvme-website: Discord accepts a diamond without the space the parser needs. Code fences stay as written.
const spaceDiamonds = text => {
    let isCode = false;
    return text.split('\n').map(line => {
        if (/^ *(?:`{3}|~{3})/.test(line)) isCode = !isCode;
        return isCode ? line : line.replace(/^( *⬥)(?=[^ ])/u, '$1 ');
    }).join('\n');
};
export const parseEmbedText = text => parseGuide(spaceDiamonds(embedMarkdown(text)), { validateReferences: false });

/** As on pvme-website: a row of nothing but media links shows the media; links inside a sentence stay links. */
const isMediaRow = nodes => nodes.every(node => {
    if (node.type === 'link' || node.type === 'image') return YOUTUBE_LINK.test(node.url) || IMAGE_LINK.test(node.url);
    if (node.type === 'text') return /^[ ()[\]/|,·&]*$/.test(node.value.trim());
    return node.type === 'emoji' || node.type === 'line-break' || (node.children ? isMediaRow(node.children) : false);
});

/**
 * @param {string} source PvME guide text
 * @param {Resolver} resolver
 * @return {Conversion}
 */
export function convertGuide(source, resolver) {
    const document = parseGuide(source, { validateReferences: false });
    const issues = [];
    const omitted = [];
    const counts = { messages: document.messages.length, headings: 0, lists: 0, embeds: 0, icons: 0, presets: 0, images: 0, videos: 0, links: 0 };
    const shownPresets = new Set();
    /** Media the current block's links stand for; written after the block. */
    let pendingMedia = [];
    let inMediaRow = false;
    const issue = (code, detail, range) => issues.push({ code, detail, line: range?.start.line ?? null });
    for (const { code, message, range } of document.diagnostics) issue('PARSER_' + code, message, range);

    // ---------- headings and anchors ----------
    const headings = document.messages.flatMap(message => message.blocks.filter(block => block.type === 'heading'));
    const titleHeading = headings.find(heading => heading.level === 1);
    const bodyHeadings = headings.filter(heading => heading !== titleHeading);
    // The page title takes level 1, so the guide's own top level becomes level 2.
    const topLevel = Math.min(...bodyHeadings.map(heading => heading.level));
    const levelOf = heading => Math.min(6, heading.level - topLevel + 2);
    const anchorOfHeading = new Map();
    const uses = new Map();
    for (const heading of bodyHeadings) {
        const text = plainText(heading.children);
        const use = (uses.get(text) ?? 0) + 1;
        uses.set(text, use);
        anchorOfHeading.set(heading, use > 1 ? `${text} ${use}` : text);
    }
    const isInside = (range, outer) => outer.start.offset <= range.start.offset && range.end.offset <= outer.end.offset;
    const contentsRanges = document.embeds.filter(embed => embedsOf(embed.value).some(isContentsEmbed)).map(embed => embed.range);
    const usedTags = new Set(document.references
        .filter(ref => ref.kind === 'tag' && !contentsRanges.some(range => isInside(ref.range, range)))
        .map(ref => ref.target));
    /** Where a tag points: the heading its message starts with, else a marker of its own. */
    const anchors = new Map();
    const markers = new Map();
    for (const { tag, messageIndex } of Object.values(document.tags)) {
        const first = document.messages[messageIndex]?.blocks.find(block => block.type !== 'blank' && block.type !== 'command');
        const heading = anchorOfHeading.get(first);
        if (first === titleHeading && first) anchors.set(tag, '');
        else if (heading && !/[[\]{}|<>#&]/.test(heading)) anchors.set(tag, heading);
        else {
            anchors.set(tag, tag);
            if (usedTags.has(tag)) markers.set(messageIndex, tag);
        }
    }
    function tagLink(tag, label, range) {
        const anchor = anchors.get(tag);
        if (anchor === undefined) issue('MISSING_TAG', tag, range);
        return anchor ? `[[#${anchor}|${label}]]` : label;
    }

    // ---------- inline ----------
    function icon(node, linkTo) {
        const found = resolver.emoji(node.id, node.name);
        // PvME draws some variants as their own icon; the wiki has the base icon, so the variant is named beside it.
        const qualifier = found?.qualifier ? ` (${found.qualifier})` : '';
        if (found?.file) {
            counts.icons++;
            const target = linkTo ?? found.page;
            return `[[File:${found.file}|25x25px${target ? `|link=${target}` : ''}]]${qualifier}`;
        }
        const label = found?.name ?? `:${node.name}:`;
        issue('ICON_AS_TEXT', label, node.range);
        if (linkTo || !found?.page) return escapeText(label);
        return (found.page === label ? `[[${label}]]` : `[[${found.page}|${escapeText(label)}]]`) + qualifier;
    }

    /** Links a label's text. Icons stay outside the link because wiki links cannot nest. */
    function labelled(children, makeLink, iconTarget) {
        const runs = [];
        for (const child of children) {
            if (child.type === 'emoji') runs.push(child);
            else if (Array.isArray(runs.at(-1))) runs.at(-1).push(child);
            else runs.push([child]);
        }
        return join(runs.map(run => {
            if (!Array.isArray(run)) return icon(run, iconTarget);
            const text = inline(run, { inLink: true }).replace(/\n/g, ' ');
            const label = escapeLabel(text);
            return label ? text.match(/^\s*/)[0] + makeLink(label) + text.match(/\s*$/)[0] : text;
        }));
    }

    function link(node) {
        const { url } = node;
        const channel = resolver.channel(url.match(DISCORD_LINK)?.[1] ?? '');
        if (channel?.title) return labelled(node.children, label => `[[${channel.title}|${label}]]`, channel.title);
        if (channel?.url) return labelled(node.children, label => `[${escapeUrl(channel.url)} ${label}]`, escapeUrl(channel.url));
        const tag = url.match(/^\$linkmsg_(.+)\$$/);
        if (tag) return labelled(node.children, label => tagLink(tag[1], label, node.range));
        if (url.startsWith('#')) return labelled(node.children, label => `[[${escapeUrl(url)}|${label}]]`);
        if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) {
            issue('LINK_AS_TEXT', url, node.range);
            return inline(node.children);
        }
        counts.links++;
        const preset = url.match(PRESET_LINK);
        if (preset) pendingMedia.push({ preset: preset[1], range: node.range });
        else if (node.type === 'image') pendingMedia.push({ image: url });
        else if (!node.suppressEmbed && inMediaRow && IMAGE_LINK.test(url)) pendingMedia.push({ image: url });
        else if (!node.suppressEmbed && inMediaRow && YOUTUBE_LINK.test(url)) pendingMedia.push({ youtube: url.match(YOUTUBE_LINK)[1] });

        const label = plainText(node.children);
        const hasOwnLabel = node.children.some(child => child.type === 'emoji') || (label !== '' && label !== url);
        if (BLOCKED_HOSTS.test(new URL(url).hostname)) {
            issue('BLOCKED_LINK', url, node.range);
            const text = hasOwnLabel ? inline(node.children) : escapeText(url.replace(/^https?:\/\//, ''));
            return text + '<!-- linked host is on the wiki spam blacklist -->';
        }
        if (!hasOwnLabel) return node.type === 'image' ? '' : `[${escapeUrl(url)} ${escapeLabel(escapeText(url.replace(/^https?:\/\//, '')))}]`;
        const target = wikiTarget(url);
        if (target) return labelled(node.children, text => text === target ? `[[${text}]]` : `[[${target}|${text}]]`, target);
        return labelled(node.children, text => `[${escapeUrl(url)} ${text}]`, escapeUrl(url));
    }

    function mention(node) {
        if (node.kind === 'channel') {
            const channel = resolver.channel(node.target);
            if (channel?.title) return `[[${channel.title}|${escapeText(channel.label)}]]`;
            if (channel?.url) return `[${escapeUrl(channel.url)} ${escapeLabel(escapeText(channel.label))}]`;
            if (!channel) issue('UNKNOWN_CHANNEL', node.target, node.range);
            return escapeText('#' + (channel?.label ?? 'unknown-channel'));
        }
        if (node.kind === 'user' || node.kind === 'role') {
            const name = resolver[node.kind](node.target);
            if (!name) issue('UNKNOWN_' + node.kind.toUpperCase(), node.target, node.range);
            return escapeText('@' + (name ?? 'Unknown ' + node.kind));
        }
        if (node.kind === 'special') return node.target === 'customize' ? 'Channels & Roles' : 'Server Guide';
        return '@' + node.kind;
    }

    function reference(node) {
        if (node.kind === 'tag') return tagLink(node.target, escapeText(anchors.get(node.target) || node.target), node.range);
        const value = node.kind === 'data' ? resolver.data(node.target) : null;
        if (value === null) issue('UNRESOLVED_REFERENCE', node.raw, node.range);
        return escapeText(value ?? node.raw);
    }

    function inlineNode(node, context) {
        switch (node.type) {
            case 'text': return escapeText(node.value);
            case 'line-break': return '\n';
            case 'spacer': return '';
            case 'inline-code': return `<code>${escapePre(node.value).replace(/[[\]{}']/g, char => `&#${char.charCodeAt(0)};`)}</code>`;
            case 'emoji': return icon(node);
            case 'link': case 'image': return context.inLink ? inline(node.children, context) : link(node);
            case 'mention': return mention(node);
            case 'reference': return reference(node);
            case 'timestamp': return new Date(Number(node.timestamp) * 1000).toUTCString();
            case 'unknown-inline': return escapeText(node.raw);
            default: {
                const [open, close] = STYLES[node.type];
                const text = inline(node.children, context);
                // The wiki already styles headings and links; guides underline and embolden them by hand.
                const isDecoration = (node.type === 'underline' && (context.inHeading || context.inLink))
                    || (node.type === 'bold' && context.inHeading);
                return isDecoration ? text : wrapLines(open, close, text);
            }
        }
    }
    const inline = (nodes, context = {}) => join(nodes.map(node => inlineNode(node, context)));
    const inlineLines = nodes => {
        inMediaRow = isMediaRow(nodes);
        return inline(nodes).split('\n').map(line => line.trim()).filter(Boolean);
    };

    // ---------- media ----------
    function image(url, align = 'center', width = 500) {
        counts.images++;
        return `{{Extimage|${escapeUrl(url)}|${align}|${width}}}`;
    }
    function youtube(id) {
        counts.videos++;
        return `<youtube width=400 height=225>https://www.youtube.com/watch?v=${id}</youtube>`;
    }
    function attachment({ url, kind }) {
        const video = url.match(YOUTUBE_LINK);
        if (video) return youtube(video[1]);
        if (kind === 'image' && !VIDEO_FILE.test(url)) return image(url);
        counts.videos++;
        return `[${escapeUrl(url)} ${kind === 'image' ? 'Video clip' : 'File'}]`;
    }
    function takeMedia() {
        const media = new Map(pendingMedia.map(item => [item.preset ?? item.image ?? item.youtube, item]));
        pendingMedia = [];
        return [...media.values()].flatMap(item => {
            if (item.image) return [image(item.image)];
            if (item.youtube) return [youtube(item.youtube)];
            if (shownPresets.has(item.preset)) return [];
            const preset = resolver.preset(item.preset);
            if (!preset) {
                issue('PRESET_AS_LINK', item.preset, item.range);
                return [];
            }
            shownPresets.add(item.preset);
            counts.presets++;
            return [preset];
        });
    }

    // ---------- blocks ----------
    function listLines(list, prefix) {
        const numbers = list.items.map(item => Number.parseInt(item.marker, 10));
        const isCounted = list.style === 'number' && numbers.every((number, i) => number === i + 1);
        return list.items.flatMap(item => {
            const keepsMarker = (list.ordered && !isCounted) || KEPT_MARKERS.has(item.marker);
            const own = prefix + (isCounted ? '#' : list.ordered ? ':' : '*');
            const marker = keepsMarker ? escapeText(item.marker) + ' ' : '';
            const lines = [];
            let text = [];
            // Text after a nested list continues the item, so it needs a line of its own below that list.
            const flush = () => {
                if (text.length || !lines.length) lines.push(`${own}${lines.length ? ': ' : ' ' + marker}${text.join('<br>')}`.trimEnd());
                text = [];
            };
            for (const child of item.children) {
                if (child.type === 'list') {
                    if (text.length) flush();
                    lines.push(...listLines(child, own));
                } else if (child.type === 'paragraph') text.push(...inlineLines(child.children));
                else if (child.type !== 'blank' && child.type !== 'command') text.push(block(child, { nested: true }).replace(/\n+/g, '<br>'));
            }
            if (text.length || !lines.length) flush();
            return lines;
        });
    }

    const embedText = text => parseEmbedText(text).messages
        .map(message => blocks(message.blocks, { nested: true })).filter(Boolean).join('\n\n');
    const embedLine = text => inlineLines(parseEmbedText(String(text).trim()).messages
        .flatMap(message => message.blocks)
        .flatMap(node => node.type === 'list' ? node.items.flatMap(item => item.children.flatMap(child => child.children ?? [])) : node.children ?? []))
        .join(' ');
    const bold = text => {
        const bare = text.replaceAll("'''", '');
        return bare && `'''${bare}'''`;
    };

    function embed(node) {
        const list = embedsOf(node.value);
        if (!node.valid || (!list.length && !node.value?.content)) {
            issue('EMBED_SKIPPED', node.raw.slice(0, 60), node.range);
            return '';
        }
        const out = node.value.content ? [embedText(node.value.content)] : [];
        for (const item of list) {
            if (isContentsEmbed(item)) {
                omitted.push(node.raw);
                continue;
            }
            counts.embeds++;
            for (const key of Object.keys(item)) if (!EMBED_KEYS.has(key)) issue('EMBED_FIELD', key, node.range);
            if (item.author?.name) out.push(bold(embedLine(item.author.name)));
            if (item.title) out.push(bold(item.url ? `[${escapeUrl(item.url)} ${escapeLabel(embedLine(item.title))}]` : embedLine(item.title)));
            if (item.thumbnail?.url) out.push(image(item.thumbnail.url, 'right', 120));
            if (item.description) out.push(embedText(item.description));
            for (const field of item.fields ?? []) out.push(bold(embedLine(field.name ?? '')), embedText(field.value ?? ''));
            if (item.image?.url) out.push(image(item.image.url));
            if (item.footer?.text) out.push(`<small>${embedText(item.footer.text).replace(/\n+/g, '<br>')}</small>`);
        }
        return out.filter(Boolean).join('\n\n');
    }

    function withoutContentsNotes(nodes) {
        return splitLines(nodes).filter(line => {
            const isNote = isContentsNote(plainText(line));
            if (isNote) omitted.push(plainText(line));
            return !isNote;
        }).flatMap((line, i) => i ? [{ type: 'line-break' }, ...line] : line);
    }

    function block(node, context) {
        switch (node.type) {
            case 'heading': {
                if (node === titleHeading) return '';
                const text = inline(node.children, { inHeading: true }).replace(/\n/g, ' ').trim();
                if (!text) return '';
                if (context.nested) return bold(text);
                counts.headings++;
                const mark = '='.repeat(levelOf(node));
                return mark + text + mark;
            }
            case 'paragraph':
                return inlineLines(withoutContentsNotes(node.children)).map(guardLineStart).join('<br>\n');
            case 'list':
                counts.lists++;
                return listLines(node, '').join('\n');
            case 'blockquote': {
                const content = blocks(node.children, { nested: true });
                return content && `<blockquote>\n${content}\n</blockquote>`;
            }
            case 'codeblock': return `<pre>${escapePre(node.value)}</pre>`;
            case 'subtext': return inlineLines(node.children).map(line => `<small>${line}</small>`).join('<br>\n');
            case 'attachment': return attachment(node);
            case 'embed': return embed(node);
            case 'unknown-command':
                issue('COMMAND_AS_TEXT', node.raw, node.range);
                return guardLineStart(escapeText(node.raw));
            default: return '';
        }
    }

    function blocks(nodes, context = {}) {
        return nodes.flatMap(node => [block(node, context), ...takeMedia()]).filter(Boolean).join('\n\n');
    }

    const pieces = [];
    let line = 1;
    for (const message of document.messages) {
        let marker = markers.get(message.index);
        for (const node of message.blocks) {
            let text = [block(node, {}), ...takeMedia()].filter(Boolean).join('\n\n');
            if (!text) continue;
            if (marker) text = `<span id="${marker.replaceAll('"', '&quot;')}"></span>\n${text}`;
            marker = undefined;
            const lines = text.split('\n').length;
            pieces.push({ text, line, endLine: line + lines - 1, sourceLine: node.range.startLine, sourceEndLine: node.range.endLine });
            line += lines + 1;
        }
    }

    return {
        title: titleHeading ? plainText(titleHeading.children) : '',
        wikitext: pieces.map(piece => piece.text).join('\n\n') + '\n',
        lineMap: pieces.map(({ text, ...lines }) => lines),
        issues, omitted, counts, document,
    };
}

/** The guide's own title, or its name in the guide list when it has none. */
export const guideTitle = (conversion, guide) => conversion.title || guide.path.split('/').pop();

/** A complete page: the guide plus the attribution its licence requires. */
export function pageWikitext(conversion, guide) {
    const title = escapeLabel(escapeText(guideTitle(conversion, guide)));
    return conversion.wikitext + '\n==Source==\n' +
        `Converted from [${guide.url} ''${title}''] by PvME contributors ([${guide.sourceUrl} guide source]) under ` +
        '[https://creativecommons.org/licenses/by-nc-sa/4.0/ CC BY-NC-SA 4.0]. Formatting was converted for the wiki.\n';
}

const entity = char => `&#${char.charCodeAt(0)};`;
const entities = run => [...run].map(entity).join('');

/** Guide prose as wikitext that MediaWiki shows unchanged. */
export function escapeText(text) {
    return text
        .replace(/[\u200b\u200e\u200f\u2060\ufeff]/g, '')
        .replace(/&(?=#?\w+;)/g, '&amp;')
        .replace(/<(?=[!/a-z])/gi, '&lt;')
        .replace(/\[{2,}|\]{2,}|\{{2,}|\}{2,}|'{2,}|~{3,}/g, entities)
        .replace(/\[(?=(?:https?:|ftp:|mailto:)?\/\/)/g, entity)
        .replace(/[[{]$|^[\]}]/g, entity)
        .replace(/__(?=[A-Z]+__)/g, entities);
}

/** Keeps a line of prose from being read as a list, heading, table or preformatted line. */
export const guardLineStart = line => line.trim().replace(/^(?=[*#:;=|!]|\{\||-{4})/, '<nowiki/>');

export const escapeUrl = url => url.replace(/[\s[\]<>"|{}]/g, encodeURIComponent).replaceAll("''", '%27%27');

/** External link labels end at the first "]". */
export const escapeLabel = label => label.replace(/\]/g, '&#93;').replace(/\n/g, ' ').trim();

/** <pre> and <code> content: tags and entities stay literal. */
export const escapePre = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Joins fragments without letting apostrophes or brackets run together into other markup. */
export function join(parts) {
    return parts.reduce((out, part) => {
        const clash = part && ((out.endsWith("'") && part.startsWith("'")) || (out.endsWith('[') && part.startsWith('[')));
        return out + (clash ? '<nowiki/>' : '') + part;
    }, '');
}

/** Wraps every non-empty line: MediaWiki closes bold and italics at each line end. */
export const wrapLines = (open, close, text) => text.split('\n').map(line => {
    const [, before, body, after] = line.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!body) return line;
    const quotes = open.startsWith("'");
    const head = quotes && /^'(?!')/.test(body) ? '<nowiki/>' : '';
    const tail = quotes && /(^|[^'])'$/.test(body) ? '<nowiki/>' : '';
    return before + open + head + body + tail + close + after;
}).join('\n');

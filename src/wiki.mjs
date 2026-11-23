/** Read-only MediaWiki API access, from Node or a browser (anonymous CORS). */

const BATCH = 50;

export function createWikiReader(api = 'https://runescape.wiki/api.php', headers = {}) {
    async function call(parameters) {
        const response = await fetch(`${api}?origin=*`, {
            method: 'POST',
            headers,
            body: new URLSearchParams({ format: 'json', formatversion: '2', ...parameters }),
            signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) throw new Error(`${api} answered ${response.status}`);
        const data = await response.json();
        if (data.error) throw new Error(data.error.info);
        return data;
    }
    const contentOf = revision => revision.slots.main.content;

    return {
        /** @return {Promise<Map<string, string|null>>} current text by title; null when the page does not exist */
        async pages(titles) {
            const texts = new Map(titles.map(title => [title, null]));
            for (let i = 0; i < titles.length; i += BATCH) {
                const { query } = await call({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: titles.slice(i, i + BATCH).join('|') });
                const requested = new Map((query.normalized ?? []).map(entry => [entry.to, entry.from]));
                for (const page of query.pages)
                    if (page.revisions) texts.set(requested.get(page.title) ?? page.title, contentOf(page.revisions[0]));
            }
            return texts;
        },
        /** @return {Promise<string[]>} up to 50 earlier texts, newest first */
        async history(title) {
            const { query } = await call({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', rvlimit: '50', titles: title });
            return (query.pages[0].revisions ?? []).slice(1).map(contentOf);
        },
        /** @return {Promise<string[]>} titles of every page below a root page */
        async subpages(root) {
            const [, namespace, name] = root.match(/^(?:(User):)?(.+)$/i);
            const titles = [];
            for (let next = {}; next;) {
                const data = await call({ action: 'query', list: 'allpages', apprefix: name + '/', apnamespace: namespace ? '2' : '0', aplimit: 'max', ...next });
                titles.push(...data.query.allpages.map(page => page.title));
                next = data.continue ?? null;
            }
            return titles;
        },
        /** How the wiki renders a page that has not been saved. */
        async parse(title, text) {
            const { parse } = await call({
                action: 'parse', title, text, contentmodel: 'wikitext', disableeditsection: '1', disablelimitreport: '1',
                prop: 'text|links|images|parsewarnings',
            });
            return parse;
        },
        /** @return {Promise<string[]>} the given files that the wiki does not have */
        async missingFiles(files) {
            const missing = [];
            for (let i = 0; i < files.length; i += BATCH) {
                const { query } = await call({ action: 'query', titles: files.slice(i, i + BATCH).map(file => 'File:' + file).join('|') });
                missing.push(...query.pages.filter(page => page.missing && !page.known).map(page => page.title));
            }
            return missing;
        },
    };
}

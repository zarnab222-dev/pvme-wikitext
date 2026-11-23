/**
 * @typedef {Object} GuideData everything guide text references by id; built by scripts/load-data.mjs
 * @property {Object<string, {name?: string, file?: string, page?: string}>} emoji by Discord emoji id
 * @property {Object<string, string>} emojiNames Discord emoji id by PvME emoji name
 * @property {Object<string, {label: string, slug?: string}>} channels by Discord channel id
 * @property {Object<string, string>} users
 * @property {Object<string, string>} roles
 * @property {Object<string, string>} spreadsheet resolved value by reference key
 * @property {Object<string, string>} presets wikitext by preset id
 * @property {Object<string, {path: string, url: string}>} guides by slug
 */

/**
 * @param {GuideData} data
 * @param {{root?: string|null}} [options] root: wiki page the guides live under. Links between guides become wiki links
 *     below it; without a root they point at pvme.io, which is safe wherever the page is pasted.
 * @return {import('./convert.mjs').Resolver}
 */
export function createResolver(data, { root = null } = {}) {
    const lookup = (table, key) => Object.hasOwn(table, key) ? table[key] : null;
    return {
        emoji: (id, name) => lookup(data.emoji, id ?? lookup(data.emojiNames, name) ?? ''),
        channel(id) {
            const channel = lookup(data.channels, id);
            const guide = channel?.slug && lookup(data.guides, channel.slug);
            if (!guide) return channel && { label: channel.label };
            return root ? { label: channel.label, title: `${root}/${guide.path}` } : { label: channel.label, url: guide.url };
        },
        user: id => lookup(data.users, id),
        role: id => lookup(data.roles, id),
        data: key => lookup(data.spreadsheet, key),
        preset: id => lookup(data.presets, id),
    };
}

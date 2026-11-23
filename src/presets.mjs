// PvME preset-maker data as {{Equipment}} / {{Inventory}} blocks. Carried over from pvmewiki's wiki-native pipeline.

const SLOTS = ['helm', 'cape', 'neck', 'weap', 'body', 'shield', 'legs', 'gloves', 'boots', 'ring', 'ammo', 'pocket'];
// Equipment and inventory sit in a wrapping flex row: side by side when there is room, stacked on phones.
const ROW_OPEN = '<div class="pvme-preset" style="display:flex; flex-wrap:wrap; gap:0 8px; align-items:flex-start">';
const INVENTORY_OPEN = '<div class="pvme-preset-inventory">';

/**
 * @param {Object} data
 * @param {Object<string, {name?: string, page?: string, file?: string}>} data.emoji by Discord emoji id
 * @param {Object} data.emojiOverrides
 * @param {Object[]} data.registry PvME's emoji registry
 * @param {Object} data.itemOverrides
 * @param {{noIcon: string[], noArticle: string[]}} data.presetGaps items the wiki has no icon or article for
 */
export function createPresetRenderer({ emoji, emojiOverrides, registry, itemOverrides, presetGaps }) {
    const byPvmeId = new Map(registry.flatMap(entry => [entry.id, ...(entry.id_aliases ?? [])].map(id => [id, entry])));
    const noIcon = new Set(presetGaps.noIcon);
    const noArticle = new Set(presetGaps.noArticle);

    /** The wiki article for a preset item, and its icon when that is not "<article>.png". */
    function item(id) {
        if (!id) return { page: '', file: null };
        const override = itemOverrides[id];
        const entry = byPvmeId.get(id);
        const known = entry?.emoji_id ? emoji[entry.emoji_id] : null;
        const verified = known?.page && known?.file ? known : null;
        const page = verified?.page ?? override?.page ?? known?.page ?? known?.file?.replace(/\.\w+$/, '') ?? entry?.name ?? id;
        const file = verified?.file ?? override?.file ?? known?.file ?? null;
        return { page, file: file && file !== page + '.png' ? file : null };
    }
    const link = name => noArticle.has(name) ? name : `[[${name}]]`;
    const iconLink = name => noIcon.has(name) ? link(name) : `{{plink|${name}}}`;
    const words = text => text.toLowerCase().replace(/\(.*?\)/g, '').match(/[a-z]{3,}/g) ?? [];

    /** Icon only when the neighbouring words already name the thing. */
    function noteEmoji(id, before, after) {
        const entry = id in emojiOverrides ? emojiOverrides[id] : emoji[id];
        const page = entry?.page ?? entry?.file?.replace(/\.\w+$/, '');
        if (!page) return '';
        const near = new Set([...words(before).slice(-3), ...words(after).slice(0, 3)]);
        const named = words(entry.name ?? page).some(word => near.has(word));
        if (!entry.file) return named ? '' : `[[${page}|${entry.name ?? page}]]`;
        if (named) return `[[File:${entry.file}|25x25px|link=${page}]]`;
        return entry.file === `${page}.png` ? `{{plink|${page}}}` : `{{plink|${page}|pic=${entry.file.replace(/\.png$/, '')}}}`;
    }

    /** Notes are HTML from the preset maker: emoji images plus layout wrappers. */
    function note(html) {
        let text = String(html ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/<\/?(span|div|p)\b[^>]*>/gi, ' ')
            .replace(/&nbsp;/g, ' ').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        const bare = part => part.replace(/<[^>]*>/g, '');
        text = text.replace(/<img\b[^>]*?emojis\/(\d+)[^>]*>/gi,
            (match, id, at, all) => ` ${noteEmoji(id, bare(all.slice(0, at)), bare(all.slice(at + match.length)))} `);
        text = text.replace(/:([a-z0-9_]+):/gi, (match, code, at, all) => {
            const override = emojiOverrides[match];
            if (override !== undefined) return override ? ` ${override} ` : ' ';
            const entry = byPvmeId.get(code);
            if (entry?.emoji_id && (emoji[entry.emoji_id] || emojiOverrides[entry.emoji_id]))
                return ` ${noteEmoji(entry.emoji_id, all.slice(0, at), all.slice(at + match.length))} `;
            return entry?.preset_type === 'item' || entry?.preset_type === 'familiar' ? ` ${iconLink(item(entry.id).page)} ` : match;
        });
        return text.replace(/\s+/g, ' ').replace(/\s+([.,;:)])/g, '$1').replace(/\}\} 's\b/g, "}}'s").replace(/\(\s+/g, '(').trim();
    }

    /** @return {string|null} null when the preset maker has no such preset */
    return function renderPreset(id, preset) {
        if (!preset || preset.error) return null;
        const iconless = [];
        const equipment = SLOTS.flatMap((slot, i) => {
            const slotId = preset.equipmentSlots?.[i]?.id;
            if (!slotId) return [];
            const { page, file } = item(slotId);
            if (noIcon.has(page)) {
                iconless.push(`${slot}: ${link(page)}`);
                return [];
            }
            return file ? [`|${slot} = ${file.replace(/\.png$/, '')}`, `|${slot}link = ${page}`] : [`|${slot} = ${page}`];
        });
        const inventory = Array.from({ length: 28 }, (_, i) => {
            const found = item(preset.inventorySlots?.[i]?.id);
            if (!noIcon.has(found.page)) return found;
            iconless.push(`inventory slot ${i + 1}: ${link(found.page)}`);
            return { page: '', file: null };
        });
        const rows = Array.from({ length: 7 }, (_, row) => '|' + inventory.slice(row * 4, row * 4 + 4).map(found => found.page).join('|'));
        const images = inventory.flatMap((found, i) => found.file ? [`|image${i + 1}=${found.file.replace(/\.png$/, '')}`] : []);
        if (images.length) rows.push(images.join(''));

        const notes = [];
        if (note(preset.presetNotes)) notes.push(note(preset.presetNotes));
        for (const part of preset.breakdown ?? []) {
            const slots = part.slotType === 'equipment' ? preset.equipmentSlots : preset.inventorySlots;
            const slotId = slots?.[part.slotIndex]?.id;
            const description = note(String(part.description ?? '').replace(/\s*\|\s*/g, '; '));
            if (slotId && description) notes.push(`${iconLink(item(slotId).page)}: ${description}`);
        }
        for (const [label, list] of [['Relics', preset.relics], ['Prayers', preset.prayers], ['Ammo spells', preset.ammoSpells]]) {
            const names = (list ?? []).filter(entry => entry?.id).map(entry => link(item(entry.id).page));
            if (names.length) notes.push(`${label}: ${names.join(', ')}`);
        }
        if (preset.familiar?.id) notes.push(`Familiar: ${link(item(preset.familiar.id).page)}`);
        if (iconless.length) notes.push(`Also in this preset (no wiki icon): ${iconless.join('; ')}`);
        if (preset.aspect?.id) notes.push(`Aspect: ${link(item(preset.aspect.id).page)}`);
        for (const slot of preset.equipmentSlots ?? [])
            if (slot?.eof_spec) notes.push(`Essence of Finality special attack: [[${slot.eof_spec}]]`);

        return `'''${preset.presetName}''' ([https://presets.pvme.io/?id=${id} PvME preset maker])\n` +
            `${ROW_OPEN}\n{{Equipment\n|align = left\n|caption = ${preset.presetName}\n${equipment.join('\n')}\n}}\n` +
            `${INVENTORY_OPEN}\n{{Inventory|align=left\n${rows.join('\n')}\n}}\n</div>\n</div>` +
            notes.map(line => `\n* ${line}`).join('');
    };
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convertGuide } from '../src/convert.mjs';
import { createResolver } from '../src/resolver.mjs';

const data = {
    emoji: {
        1: { name: 'Abyssal orb', file: 'Abyssal orb.png', page: 'Abyssal orb' },
        2: { name: 'Overpower', file: 'Overpower.png', page: 'Overpower', qualifier: 'Igneous' },
        3: { name: 'Red beam' },
    },
    emojiNames: { orb: '1' },
    channels: { 10: { label: 'pvm-help' }, 11: { label: 'AFK overview', slug: 'afk--overview' } },
    users: { 20: 'porfy' }, roles: {}, spreadsheet: { price_x: '1,200' },
    presets: { abc: "'''Preset'''\n{{Equipment}}" },
    guides: { 'afk--overview': { path: 'AFK/Overview', url: 'https://pvme.io/pvme-guides/afk/overview/' } },
};
const convert = (text, options) => convertGuide(text, createResolver(data, options));
const body = (text, options) => convert(text, options).wikitext.trim();

test('the first level-1 heading becomes the title and the rest start at level 2', () => {
    const result = convert('# Solak\n## __Setup__\ntext\n### Gear');
    assert.equal(result.title, 'Solak');
    assert.equal(result.wikitext, '==Setup==\n\ntext\n\n===Gear===\n');
});

test('nested bullets become nested list markup', () => {
    assert.equal(body('⬥ **one**\n    • two\n        ⬩ three\n⬥ four'), "* '''one'''\n** two\n*** three\n* four");
});

test('text after a nested list stays after it', () => {
    assert.equal(body('⬥ one\n    • two\n    three'), '* one\n** two\n*: three');
});

test('numbers that do not count from one keep their own markers', () => {
    assert.equal(body('1. a\n2. b'), '# a\n# b');
    assert.equal(body('4. a\n5. b'), ': 4. a\n: 5. b');
});

test('emoji become wiki icons, variants are named, and unknown icons become their name', () => {
    assert.equal(body('use <:orb:1>'), 'use [[File:Abyssal orb.png|25x25px|link=Abyssal orb]]');
    assert.equal(body('<:op:2>'), '[[File:Overpower.png|25x25px|link=Overpower]] (Igneous)');
    const result = convert('<:red:3> then');
    assert.equal(result.wikitext, 'Red beam then\n');
    assert.deepEqual(result.issues, [{ code: 'ICON_AS_TEXT', detail: 'Red beam', line: 1 }]);
});

test('runescape.wiki links become wiki links, with icons kept outside the link', () => {
    assert.equal(body('[Chaos Roar](https://runescape.wiki/w/Chaos_Roar)'), '[[Chaos Roar]]');
    assert.equal(body('[no mechs](https://runescape.wiki/w/Arch-Glacor#Mechanics)'), '[[Arch-Glacor#Mechanics|no mechs]]');
    assert.equal(body('[Orb <:orb:1>](https://runescape.wiki/w/Orb)'), '[[Orb]] [[File:Abyssal orb.png|25x25px|link=Orb]]');
});

test('channel links point at pvme.io, or below a root page when one is given', () => {
    assert.equal(body('see <#11>'), 'see [https://pvme.io/pvme-guides/afk/overview/ AFK overview]');
    assert.equal(body('see <#11>', { root: 'PvME' }), 'see [[PvME/AFK/Overview|AFK overview]]');
    assert.equal(body('ask in <#10>'), 'ask in #pvm-help');
});

test('tag links go to the heading their message starts with, or to a marker', () => {
    assert.equal(body('## Gear\n.tag:gear\n.\nSee [gear]($linkmsg_gear$)'), '==Gear==\n\nSee [[#Gear|gear]]');
    assert.equal(body('plain\n.tag:here\n.\n[back]($linkmsg_here$)'), '<span id="here"></span>\nplain\n\n[[#here|back]]');
});

test('presets are shown once, after the block that links them', () => {
    assert.equal(body('⬥ [Melee](<https://presets.pvme.io/?id=abc>)\n⬥ next'),
        "* [https://presets.pvme.io/?id=abc Melee]\n* next\n\n'''Preset'''\n{{Equipment}}");
});

test('embeds become labelled sections and pinned contents lists are dropped', () => {
    const embed = value => JSON.stringify({ embed: value }) + '\n.embed:json';
    assert.equal(body(embed({ title: '__Needs__', description: '⬥ a\n\u00a0\u00a0\u00a0\u00a0• b', fields: [{ name: 'Gear', value: 'c' }] })),
        "'''<u>Needs</u>'''\n\n* a\n** b\n\n'''Gear'''\n\nc");
    const result = convert(embed({ title: 'Table of Contents', description: 'x' }) + '\n.pin:delete\n.\ntext');
    assert.equal(result.wikitext, 'text\n');
    assert.equal(result.omitted.length, 1);
});

test('guide prose cannot turn into markup', () => {
    assert.equal(body('a [[b]] {{c}} <ref>'), 'a &#91;&#91;b&#93;&#93; &#123;&#123;c&#125;&#125; &lt;ref>');
    assert.equal(body('= not a heading ='), '<nowiki/>= not a heading =');
    assert.equal(body("**'quoted'**"), "'''<nowiki/>'quoted'<nowiki/>'''");
});

test('bold that spans lines is closed on every line', () => {
    assert.equal(body('**a\nb**'), "'''a'''<br>\n'''b'''");
});

test('spreadsheet values and user names are resolved', () => {
    assert.equal(body('$data_pvme:price_x$ by <@20>'), '1,200 by @porfy');
});

test('the line map names the guide lines behind each run of wikitext', () => {
    const { wikitext, lineMap } = convert('# T\n## A\nfirst\n\nsecond');
    assert.equal(wikitext.split('\n')[lineMap[2].line - 1], 'second');
    assert.deepEqual([lineMap[2].sourceLine, lineMap[2].sourceEndLine], [5, 5]);
});

test('only the line about the pins is dropped, not the paragraph around it', () => {
    const { wikitext, omitted } = convert(['*Note: a **Table of Contents** can be found in the pins.*', 'Real advice'].join(String.fromCharCode(10)));
    assert.equal(wikitext.trim(), 'Real advice');
    assert.deepEqual(omitted, ['Note: a Table of Contents can be found in the pins.']);
});

test('Discord channel links resolve like channel mentions', () => {
    assert.equal(body('[guide](https://discord.com/channels/534508796639182860/11)'), '[https://pvme.io/pvme-guides/afk/overview/ guide]');
});

test('players appear only for rows that are nothing but media links', () => {
    assert.match(body('[Kill](https://youtu.be/g8H1YwTIh-s)'), /<youtube/);
    assert.doesNotMatch(body('Watch [this](https://youtu.be/g8H1YwTIh-s) first'), /<youtube/);
    assert.doesNotMatch(body('[Kill](<https://youtu.be/g8H1YwTIh-s>)'), /<youtube/);
});

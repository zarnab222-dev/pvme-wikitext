# pvme-wikitext

Converts [pvme-guides](https://github.com/pvme/pvme-guides) to RuneScape Wiki wikitext:

```text
pvme-guides text  ->  @pvme/guide-parser  ->  src/convert.mjs  ->  wikitext
```

The site shows every guide's source, parse tree, wikitext and runescape.wiki render, with one button that copies the page.

## Convert

Requires Node 24 and git.

```sh
npm ci
node scripts/cli.mjs afk/afk-arch-glacor.txt                # one guide from the newest pvme-guides
node scripts/cli.mjs my-draft.txt                           # any local file
node scripts/cli.mjs --all --out wikitext --root "PvME"     # every guide, linked below a wiki page
```

The wikitext goes to stdout. Anything without a native wiki form goes to stderr as `file:line CODE detail`.

As a library, `convertGuide(source, resolver)` in `src/convert.mjs` is pure and runs in Node or a browser. A resolver answers
what guide text only references by id: emoji, channels, users, spreadsheet values and presets. `src/resolver.mjs` builds one
from tables.

| in the guide | on the wiki |
| --- | --- |
| `#` / `##` / `###` | page title / `==` / `===` |
| `⬥` `•` `⬩` lists | nested `*` |
| emoji | `[[File:…\|25x25px\|link=…]]`, or the name when the wiki has no icon |
| runescape.wiki links | `[[…]]` |
| channel mentions and Discord channel links | links to that guide |
| `.img:` | `{{Extimage}}`; mp4 clips become links |
| preset links | the link, plus `{{Equipment}}` and `{{Inventory}}` |
| JSON embeds | bold labels and text |
| `.tag:` and `$linkmsg_…$` | section links |
| `$data_…$` | the spreadsheet value at build time |
| pinned tables of contents | dropped; the wiki builds its own |

Where a rule could go either way it follows PvME's own renderer, [pvme-website](https://github.com/pvme/pvme-website). Those
places are marked in the code.

## Keep the wiki and PvME in step

Both sides can change after a page is published. Each generated page ends with a stamp:

```html
<!-- pvme-wikitext file=afk/afk-arch-glacor.txt commit=<pvme-guides commit> body=<sha256 of the generated text> -->
```

The stamp is the only state. `src/sync.mjs` recovers the text both sides started from (the base) from the page's own history,
or by converting the stamped commit again, and compares it with both sides:

| state | what changed | next step |
| --- | --- | --- |
| `synced` | nothing | none |
| `pvme-ahead` | the guide | publish the generated page |
| `wiki-edited` | the wiki page | offer the edits to PvME |
| `mergeable` | both, with an untouched line between the edits | publish the merge, offer the edits to PvME |
| `conflict` | both, on the same or adjacent lines | a person chooses |
| `unmanaged` | the page has no stamp | compare by hand |
| `unpublished` | the wiki has no page | publish the generated page |
| `moved`, `removed` | the guide was renamed or deleted | move or retire the page |

```sh
node scripts/sync.mjs --root "PvME"      # add --api for another wiki
```

It reads the wiki, never writes to it, and fills `sync-report/` with pages ready to publish, conflicts with markers, and the
wiki's edits listed against the guide lines they belong to. The site's sync tab does the same for one page or all of them, and
lets you edit both copies to see how they would reconcile.

Two rules keep this working:

- Publish pages with their stamp. An editor may delete it later, because the page history still has it.
- When publishing a merge, use the generated text's hash in the stamp (`stampPage`'s `generated`), as the scripts do.

If the converter or its tables changed since a page was published, its base may not be reproducible. The result is then marked
as needing review.

## Publish the conversions elsewhere

The site serves what another tool needs to pull: `/index.json` lists every guide with its pvme-guides commit and text hash, and
`/guides/<slug>.wiki` is the stamped page. Both allow cross-origin reads.

## Checks

```sh
npm test               # conversion and sync rules
npm run check          # every word of every guide is in its wikitext, in order
npm run check:wiki     # also renders every page with runescape.wiki's parser (read-only, cached)
```

## Data

| file | what it is |
| --- | --- |
| `data/emoji.json` | Discord emoji id to wiki file and page, verified on runescape.wiki |
| `data/icon-overrides.json` | PvME icon variants as a wiki icon plus the variant's name |
| `data/emoji-overrides.json` | emoji in preset notes |
| `data/item-overrides.json`, `data/preset-noicon.json` | preset items whose wiki name differs, or that have no icon or article |
| `data/channel-guides.json` | Discord channel id to guide |
| `data/titles.tsv` | guide to wiki page path |
| `data/presets.json` | preset-maker data; missing presets are fetched at build time |

Guides, channels, roles, users, spreadsheet values and the emoji registry are read from PvME's repositories at build time, so a
build always converts the newest guides. A guide missing from `data/titles.tsv` appears under "Unsorted".

Deploys: Vercel builds every push to `main`. `.github/workflows/refresh.yml` rebuilds when pvme-guides has moved on.

## Licence

The code is under the [MIT licence](LICENSE). It does not cover PvME's content: guide text is by PvME contributors under
CC BY-NC-SA 4.0, and preset notes in `data/presets.json` are by their authors. `@pvme/guide-parser` is a separate package with
no published licence. RuneScape images and names belong to Jagex.

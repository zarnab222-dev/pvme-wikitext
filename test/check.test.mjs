import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('check rejects a misspelled --only filter', () => {
    const loader = new URL('../scripts/load-data.mjs', import.meta.url);
    const fixture = `import { mock } from 'node:test';
        mock.module(${JSON.stringify(loader.href)}, { exports: {
            ROOT: '.', loadData: async () => ({ guides: [{ slug: 'afk--rasial' }], data: {} }),
        } });`;
    const script = fileURLToPath(new URL('../scripts/check.mjs', import.meta.url));
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks',
        '--import', 'data:text/javascript,' + encodeURIComponent(fixture), script, '--only', 'rasail'],
        { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /no guides matched --only "rasail"/i);
    assert.doesNotMatch(result.stdout, /0 guides/);
});

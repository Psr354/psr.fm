import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../static/js/poster.js', import.meta.url), 'utf8');
const helpersStart = source.indexOf('function normalizeHex');
const helpersEnd = source.indexOf('function syncThemeInputs', helpersStart);
const overridesStart = source.indexOf('const cardOverrides = new Map()');
const overridesEnd = source.indexOf('function getCoverUrl', overridesStart);

assert.notEqual(helpersStart, -1, 'poster color helpers must exist');
assert.notEqual(overridesStart, -1, 'poster card overrides must exist');
assert.notEqual(overridesEnd, -1, 'poster card override section must have an end');

const context = vm.createContext({});
vm.runInContext(`
    let posterCardStart = '#14161c';
    let posterCardEnd = '#1c202b';
    let posterCardText = '#ffffff';
`, context);
vm.runInContext(source.slice(helpersStart, helpersEnd), context);
vm.runInContext(source.slice(overridesStart, overridesEnd), context);

assert.equal(vm.runInContext(`normalizeHex('#12aBef')`, context), '#12ABEF');
assert.equal(vm.runInContext(`normalizeHex('  #12ABEF  ')`, context), '#12ABEF');
for (const malformed of ['', null, '#123', '12ABEF', '#12ABEF00', '#gggggg']) {
    context.malformed = malformed;
    assert.equal(vm.runInContext('normalizeHex(malformed)', context), null);
}

assert.deepEqual(
    JSON.parse(JSON.stringify(vm.runInContext(`getCardColors('1')`, context))),
    { startColor: '#14161c', endColor: '#1c202b', textColor: '#ffffff' }
);
vm.runInContext(`
    cardOverrides.set('1', {
        startColor: '#112233',
        endColor: '#445566',
        textColor: '#778899',
        x: 12,
        behindSubject: false,
        scaleMul: 1.2,
    });
`, context);
assert.deepEqual(
    JSON.parse(JSON.stringify(vm.runInContext(`getCardColors('1')`, context))),
    { startColor: '#112233', endColor: '#445566', textColor: '#778899' }
);
assert.deepEqual(
    JSON.parse(JSON.stringify(vm.runInContext(`getCardColors('2')`, context))),
    { startColor: '#14161c', endColor: '#1c202b', textColor: '#ffffff' }
);

vm.runInContext(`resetCardColors('1')`, context);
assert.deepEqual(
    JSON.parse(JSON.stringify(vm.runInContext(`cardOverrides.get('1')`, context))),
    { x: 12, behindSubject: false, scaleMul: 1.2 }
);
assert.deepEqual(
    JSON.parse(JSON.stringify(vm.runInContext(`getCardColors('1')`, context))),
    { startColor: '#14161c', endColor: '#1c202b', textColor: '#ffffff' }
);
vm.runInContext(`
    cardOverrides.set('3', { startColor: '#abcdef', endColor: '#123456', textColor: '#654321' });
    resetCardColors('3');
`, context);
assert.equal(vm.runInContext(`cardOverrides.has('3')`, context), false);

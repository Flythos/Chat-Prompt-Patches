// Smoke tests for the DOM-free rule engine (src/engine.js).
// Plain Node, no dependencies: `npm test`.
import assert from 'node:assert/strict';
import {
    TARGET_FIELDS,
    applyRule,
    applyRules,
    genId,
    getMatches,
    normalizeRule,
    validateRule,
} from '../src/engine.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`PASS  ${name}`);
    } catch (error) {
        failed++;
        console.log(`FAIL  ${name}\n      ${error?.message ?? error}`);
    }
}

// --- normalizeRule ---

test('normalizeRule: undefined yields defaults with generated id', () => {
    const rule = normalizeRule(undefined);
    assert.equal(rule.target, 'description');
    assert.equal(rule.action, 'replace');
    assert.equal(rule.useRegex, false);
    assert.equal(rule.allMatches, false);
    assert.equal(rule.forBotCard, false);
    assert.ok(rule.id.length > 0);
});

test('normalizeRule: keeps valid values, repairs invalid ones', () => {
    const rule = normalizeRule({
        id: 'fixed-id',
        name: 42,
        target: 'bogus',
        action: ' sideways ',
        search: 'abc',
        insert: 'x',
        useRegex: true,
        allMatches: true,
        forBotCard: true,
    });
    assert.equal(rule.id, 'fixed-id');
    assert.equal(rule.name, ''); // non-string name repaired
    assert.equal(rule.target, 'description'); // invalid target repaired
    assert.equal(rule.action, 'replace'); // invalid action repaired
    assert.equal(rule.useRegex, true);
    assert.equal(rule.allMatches, true);
    assert.equal(rule.forBotCard, true);
});

test('normalizeRule: booleans are strict — truthy non-true values coerce to false', () => {
    // Strictness matters: a stored string "false" must not become enabled.
    const rule = normalizeRule({ useRegex: 1, allMatches: 'yes', forBotCard: 'true' });
    assert.equal(rule.useRegex, false);
    assert.equal(rule.allMatches, false);
    assert.equal(rule.forBotCard, false);
});

test('genId: unique across calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => genId()));
    assert.equal(ids.size, 100);
});

// --- getMatches / literal ---

test('getMatches: literal counts non-overlapping matches', () => {
    assert.equal(getMatches('aaaa', { search: 'aa', useRegex: false }).matches.length, 2);
    assert.equal(getMatches('hello', { search: 'hello', useRegex: false }).matches.length, 1);
    assert.equal(getMatches('hello', { search: 'world', useRegex: false }).matches.length, 0);
});

test('getMatches: empty search yields zero matches, no error', () => {
    const result = getMatches('hello', { search: '', useRegex: false });
    assert.equal(result.matches.length, 0);
    assert.equal(result.error, null);
});

// --- getMatches / regex ---

test('getMatches: regex counts pattern matches', () => {
    const result = getMatches('She is cold. She is distant.', { search: 'She is (cold|distant)', useRegex: true });
    assert.equal(result.matches.length, 2);
    assert.deepEqual(result.matches[0], { start: 0, end: 11 }); // "She is cold" = 11 chars
});

test('getMatches: invalid regex surfaces an error', () => {
    const result = getMatches('hello', { search: '([unclosed', useRegex: true });
    assert.equal(result.matches.length, 0);
    assert.match(result.error, /Invalid regex/);
});

test('getMatches: zero-width regex rejected with error', () => {
    const result = getMatches('hello', { search: 'x*', useRegex: true });
    assert.equal(result.matches.length, 0);
    assert.match(result.error, /empty string/);
});

// --- applyRule / replace ---

test('applyRule: literal replace, first match only by default', () => {
    const rule = normalizeRule({ search: 'cold', action: 'replace', insert: 'warm' });
    const result = applyRule('cold and cold', rule);
    assert.equal(result.text, 'warm and cold');
    assert.equal(result.appliedCount, 1);
});

test('applyRule: literal replace with allMatches', () => {
    const rule = normalizeRule({ search: 'cold', action: 'replace', insert: 'warm', allMatches: true });
    const result = applyRule('cold and cold', rule);
    assert.equal(result.text, 'warm and warm');
    assert.equal(result.appliedCount, 2);
});

test('applyRule: replace with empty insert removes the text', () => {
    const rule = normalizeRule({ search: 'She is cold and distant.', action: 'replace', insert: '' });
    const result = applyRule('Intro. She is cold and distant. Outro.', rule);
    assert.equal(result.text, 'Intro.  Outro.');
    assert.equal(result.appliedCount, 1);
});

test('applyRule: regex replace treats insert literally (no $ substitution)', () => {
    const rule = normalizeRule({ search: 'name is \\w+', action: 'replace', insert: 'name is $& $$', useRegex: true });
    const result = applyRule('Her name is Mara today.', rule);
    assert.equal(result.text, 'Her name is $& $$ today.');
});

// --- applyRule / before & after ---

test('applyRule: before keeps matched text and prefixes insert', () => {
    const rule = normalizeRule({ search: 'cold', action: 'before', insert: '[X]' });
    // First match only by default — the second occurrence ("colder") is untouched.
    assert.equal(applyRule('cold and colder', rule).text, '[X]cold and colder');

    const all = normalizeRule({ search: 'cold', action: 'before', insert: '[X]', allMatches: true });
    assert.equal(applyRule('cold and colder', all).text, '[X]cold and [X]colder');
});

test('applyRule: after with allMatches appends after every match', () => {
    const rule = normalizeRule({ search: 'cold', action: 'after', insert: '!', allMatches: true });
    assert.equal(applyRule('cold, cold', rule).text, 'cold!, cold!');
});

test('applyRule: regex before/after anchors on pattern bounds', () => {
    const before = normalizeRule({ search: 'Scene \\d+', action: 'before', insert: '>>', useRegex: true, allMatches: true });
    assert.equal(applyRule('Scene 1 and Scene 22', before).text, '>>Scene 1 and >>Scene 22');

    const after = normalizeRule({ search: 'Scene \\d+', action: 'after', insert: '<', useRegex: true, allMatches: true });
    assert.equal(applyRule('Scene 1 and Scene 22', after).text, 'Scene 1< and Scene 22<');
});

test('applyRule: insert containing the search text does not loop or double-apply', () => {
    const rule = normalizeRule({ search: 'A', action: 'replace', insert: 'AA', allMatches: true });
    assert.equal(applyRule('ABAB', rule).text, 'AABAAB'.replace(/AA/g, 'AA')); // single pass
    assert.equal(applyRule('ABAB', rule).text, 'AABAAB');
});

test('applyRule: missing match is a no-op with appliedCount 0', () => {
    const rule = normalizeRule({ search: 'zzz', action: 'replace', insert: 'q' });
    const result = applyRule('unchanged', rule);
    assert.equal(result.text, 'unchanged');
    assert.equal(result.appliedCount, 0);
    assert.equal(result.error, null);
});

test('applyRule: regex error is a no-op with the error surfaced', () => {
    const rule = normalizeRule({ search: '([bad', action: 'replace', insert: 'q', useRegex: true });
    const result = applyRule('unchanged', rule);
    assert.equal(result.text, 'unchanged');
    assert.match(result.error, /Invalid regex/);
});

// --- applyRules ---

test('applyRules: sequential — later rules see earlier output', () => {
    const first = normalizeRule({ id: '1', name: 'step1', search: 'one', action: 'replace', insert: 'two' });
    const second = normalizeRule({ id: '2', name: 'step2', search: 'two', action: 'replace', insert: 'three' });
    const result = applyRules('one', [{ rule: first }, { rule: second }]);
    assert.equal(result.text, 'three');
    assert.equal(result.results.length, 2);
    assert.deepEqual(result.results.map(r => r.appliedCount), [1, 1]);
});

test('applyRules: resolved search/insert override the raw rule text', () => {
    const rule = normalizeRule({ search: 'RAW', action: 'replace', insert: 'RAWOUT', allMatches: true });
    const result = applyRules('SUB and SUB', [{ rule, search: 'SUB', insert: 'SUBOUT' }]);
    assert.equal(result.text, 'SUBOUT and SUBOUT');
});

test('applyRules: multi-line literal snippets with newlines', () => {
    const rule = normalizeRule({ search: 'line1\nline2', action: 'replace', insert: 'lineA\nlineB' });
    assert.equal(applyRule('start\nline1\nline2\nend', rule).text, 'start\nlineA\nlineB\nend');
});

// --- validateRule ---

test('validateRule: ok / multi / missing / empty statuses', () => {
    assert.equal(validateRule({ search: 'a' }, 'a b a').status, 'multi');
    assert.equal(validateRule({ search: 'a' }, 'x a y').status, 'ok');
    assert.equal(validateRule({ search: 'zz' }, 'a b c').status, 'missing');
    assert.equal(validateRule({ search: '' }, 'a b c').status, 'empty');
});

test('validateRule: invalid regex flagged', () => {
    const result = validateRule({ search: '([bad', useRegex: true }, 'text');
    assert.equal(result.status, 'invalid');
    assert.ok(result.error);
});

test('validateRule: before/after with empty insert warns', () => {
    const result = validateRule({ search: 'a', action: 'before', insert: '' }, 'a a');
    assert.equal(result.status, 'multi');
    assert.match(result.warning, /Insert text is empty/);
    assert.equal(validateRule({ search: 'a', action: 'replace', insert: '' }, 'a').warning, null);
});

// --- TARGET_FIELDS sanity ---

test('TARGET_FIELDS: ids unique and ccIdentifiers present', () => {
    const ids = new Set(TARGET_FIELDS.map(f => f.id));
    assert.equal(ids.size, TARGET_FIELDS.length);
    for (const field of TARGET_FIELDS) {
        assert.ok(field.label);
        assert.ok(field.ccIdentifier);
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exitCode = 1;
}

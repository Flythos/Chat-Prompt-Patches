// Smoke tests for the DOM-free rule engine (src/engine.js).
// Plain Node, no dependencies: `npm test`.
import assert from 'node:assert/strict';
import {
    TARGET_FIELDS,
    applyRule,
    applyRules,
    collectScanEntries,
    genId,
    getMatches,
    normalizeRule,
    validateRule,
    validateRuleChains,
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
    const rule = normalizeRule({ useRegex: 1, allMatches: 'yes', forBotCard: 'true', includeInScan: 1 });
    assert.equal(rule.useRegex, false);
    assert.equal(rule.allMatches, false);
    assert.equal(rule.forBotCard, false);
    assert.equal(rule.includeInScan, false);
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

test('normalizeRule: accepts the persona target', () => {
    assert.equal(normalizeRule({ target: 'persona' }).target, 'persona');
});

test('TARGET_FIELDS: persona carries the verified chat-completion identifier', () => {
    const persona = TARGET_FIELDS.find(f => f.id === 'persona');
    assert.ok(persona, 'persona target exists');
    // openai.js builds the message as { role: 'system', identifier: 'personaDescription' }
    assert.equal(persona.ccIdentifier, 'personaDescription');
    // ST strips identifiers from the CHAT_COMPLETION_PROMPT_READY payload, so
    // prefix matching could never fire — the field must not set it.
    assert.equal(persona.ccPrefixMatch, undefined);
});

// --- collectScanEntries (World Info scan registrations) ---

test('collectScanEntries: only active, opted-in rules with insert text pass through', () => {
    const rules = [
        normalizeRule({ id: 'a', search: 'x', insert: 'Alpha', includeInScan: true }),
        normalizeRule({ id: 'b', search: 'x', insert: 'Beta' }), // not opted in
        normalizeRule({ id: 'c', search: 'x', insert: 'Gamma', includeInScan: true }),
        normalizeRule({ id: 'd', search: 'x', insert: '', includeInScan: true }), // removal — nothing to scan
    ];
    const result = collectScanEntries(rules, rule => ['a', 'd'].includes(rule.id));
    assert.deepEqual(result.map(e => e.rule.id), ['a']);
    assert.equal(result[0].insert, 'Alpha');
});

test('collectScanEntries: insert text passes through raw (macros stay unsubstituted)', () => {
    const rule = normalizeRule({ id: 'a', search: 'x', insert: '{{char}} is here', includeInScan: true });
    const result = collectScanEntries([rule], () => true);
    assert.equal(result[0].insert, '{{char}} is here');
});

test('collectScanEntries: empty rule list yields no registrations', () => {
    assert.deepEqual(collectScanEntries([], () => true), []);
});

// --- v0.1.9 save-compatibility (old stored arrays must survive load, reorder, save) ---

// A rule array as v0.1.7 wrote it: writes snapshot normalized rules, so all
// ten keys are present on every entry; targets are limited to the six
// pre-persona card fields; ids may be UUIDs or the genId() fallback form;
// name may be empty. Derived from git history (v0.1.7 normalizeRule is
// byte-identical to the current one apart from TARGET_FIELDS lacking 'persona').
const v017Fixture = [
    {
        id: '0f6ad9e2-3d64-4a58-9ec4-7b21f8a1c9d3',
        name: 'Warm up the boss',
        target: 'description',
        useRegex: false,
        search: 'She is cold and distant.',
        action: 'after',
        insert: '\n\nLately she has been thawing.',
        allMatches: false,
        forBotCard: true,
        includeInScan: false,
    },
    {
        id: 'patch-lx2k1f-3fa9c2d1',
        name: '',
        target: 'mes_example',
        useRegex: true,
        search: '\\*She smiles\\*',
        action: 'replace',
        insert: 'She beams.',
        allMatches: true,
        forBotCard: false,
        includeInScan: true,
    },
];

test('compat: v0.1.7-era stored array normalizes with every id, field value and the ORDER preserved', () => {
    const loaded = v017Fixture.map(normalizeRule);
    assert.deepEqual(loaded.map(rule => rule.id), v017Fixture.map(rule => rule.id)); // ids + order
    assert.deepEqual(loaded, v017Fixture); // every field value byte-identical
    assert.deepEqual(
        Object.keys(loaded[0]).sort(),
        ['action', 'allMatches', 'forBotCard', 'id', 'includeInScan', 'insert', 'name', 'search', 'target', 'useRegex'],
    ); // exactly the ten keys, no shape drift
});

test('compat: JSON snapshot roundtrip is stable (normalize is idempotent)', () => {
    const loaded = v017Fixture.map(normalizeRule);
    const once = JSON.parse(JSON.stringify(loaded)).map(normalizeRule);
    assert.deepEqual(once, loaded);
    const twice = JSON.parse(JSON.stringify(once)).map(normalizeRule);
    assert.deepEqual(twice, once);
});

test('compat: reorder → snapshot → reload keeps the moved order and stable ids', () => {
    const loaded = v017Fixture.map(normalizeRule);
    // Simulate the panel's move-one-down on the first rule.
    const [moved] = loaded.splice(0, 1);
    loaded.splice(1, 0, moved);
    const reloaded = JSON.parse(JSON.stringify(loaded)).map(normalizeRule);
    assert.deepEqual(reloaded.map(rule => rule.id), [v017Fixture[1].id, v017Fixture[0].id]);
    assert.deepEqual(reloaded[0], v017Fixture[1]);
    assert.deepEqual(reloaded[1], v017Fixture[0]);
});

test('compat: unknown target ids downgrade to description without throwing, other fields intact', () => {
    const raw = { ...v017Fixture[0], target: 'legacy_field' };
    const rule = normalizeRule(raw);
    assert.equal(rule.target, 'description');
    assert.equal(rule.id, raw.id);
    assert.equal(rule.name, raw.name);
    assert.equal(rule.search, raw.search);
    assert.equal(rule.action, raw.action);
    assert.equal(rule.insert, raw.insert);
    assert.equal(rule.useRegex, false);
    assert.equal(rule.forBotCard, true);
});

test('compat: chaining order guarantee — rule N\'s insert is rule N+1\'s search text, in list order', () => {
    const marker = normalizeRule({ id: 'r1', name: 'insert marker', search: 'She is cold.', action: 'after', insert: ' [MARKER]' });
    const seeker = normalizeRule({ id: 'r2', name: 'find marker', search: '[MARKER]', action: 'replace', insert: '[FOUND]' });
    // collectActiveEntries (index.js) passes active rules through filter+map,
    // preserving array order; applyRules consumes them sequentially.
    const chained = applyRules('She is cold.', [{ rule: marker }, { rule: seeker }]);
    assert.equal(chained.text, 'She is cold. [FOUND]');
    assert.deepEqual(chained.results.map(r => r.appliedCount), [1, 1]);
    // Swapped order breaks the chain: the seeker runs first and finds nothing.
    const swapped = applyRules('She is cold.', [{ rule: seeker }, { rule: marker }]);
    assert.equal(swapped.text, 'She is cold. [MARKER]');
    assert.equal(swapped.results[0].appliedCount, 0);
    assert.equal(swapped.results[1].appliedCount, 1);
});

// --- validateRuleChains (chain-aware status dots / scan gating) ---

const chainField = 'She is cold and distant.';

test('validateRuleChains: an active earlier rule\'s insert satisfies a later rule\'s search', () => {
    const first = normalizeRule({ id: 'a', target: 'description', search: 'She is cold', action: 'after', insert: ' [MARKER]' });
    const second = normalizeRule({ id: 'b', target: 'description', search: '[MARKER]', action: 'replace', insert: 'x' });
    const result = validateRuleChains([first, second], () => true, () => chainField);
    assert.equal(result.get('a').status, 'ok');
    assert.equal(result.get('b').status, 'ok'); // would be 'missing' without the chain
});

test('validateRuleChains: swapped order — the dependent rule reports missing', () => {
    const first = normalizeRule({ id: 'a', target: 'description', search: 'She is cold', action: 'after', insert: ' [MARKER]' });
    const second = normalizeRule({ id: 'b', target: 'description', search: '[MARKER]', action: 'replace', insert: 'x' });
    const result = validateRuleChains([second, first], () => true, () => chainField);
    assert.equal(result.get('a').status, 'ok');
    assert.equal(result.get('b').status, 'missing');
});

test('validateRuleChains: an inactive rule is validated against the chain but does not feed it', () => {
    const first = normalizeRule({ id: 'a', target: 'description', search: 'She is cold', action: 'after', insert: ' [MARKER]' });
    const second = normalizeRule({ id: 'b', target: 'description', search: '[MARKER]', action: 'replace', insert: 'x' });
    const result = validateRuleChains([first, second], rule => rule.id !== 'a', () => chainField);
    // 'a' is off: it still validates (found in the raw field) but inserts
    // nothing, so the dependent rule drops back to missing.
    assert.equal(result.get('a').status, 'ok');
    assert.equal(result.get('b').status, 'missing');
});

test('validateRuleChains: cross-field chain — the chat-completion fallback finds text another field\'s rule inserted', () => {
    const order = TARGET_FIELDS.map(field => field.id);
    const first = normalizeRule({ id: 'a', target: 'description', search: 'She is cold', action: 'after', insert: ' [MARKER]' });
    const second = normalizeRule({ id: 'b', target: 'scenario', search: '[MARKER]', action: 'after', insert: ' CONFIRMED' });
    const third = normalizeRule({ id: 'c', target: 'description', search: 'CONFIRMED', action: 'replace', insert: 'HIT' });
    const result = validateRuleChains(
        [first, second, third],
        () => true,
        target => (target === 'description' ? chainField : 'A quiet room.'),
        order,
    );
    assert.equal(result.get('a').status, 'ok');
    // b's own field (scenario) lacks the text, but the fallback model finds it
    // in description — matching applyEntryToMessages' cross-field fallback.
    assert.equal(result.get('b').status, 'ok');
    assert.equal(result.get('b').fallback, 'Description');
    assert.match(result.get('b').warning, /only exists in Description/);
    // Feed-forward: b's insert landed in description's simulated text, so the
    // later description rule finds it there via the primary path.
    assert.equal(result.get('c').status, 'ok');
    assert.equal(result.get('c').fallback, undefined);
});

test('validateRuleChains: no fallback claim when the search exists in the rule\'s own field', () => {
    const order = TARGET_FIELDS.map(field => field.id);
    const rule = normalizeRule({ id: 'a', target: 'scenario', search: 'quiet', action: 'replace', insert: 'loud' });
    const result = validateRuleChains([rule], () => true, target => (target === 'scenario' ? 'A quiet room.' : 'She is cold.'), order);
    assert.equal(result.get('a').status, 'ok');
    assert.equal(result.get('a').fallback, undefined);
    assert.equal(result.get('a').warning, null);
});

test('validateRuleChains: text absent from every field stays missing (the rule will truly do nothing)', () => {
    const order = TARGET_FIELDS.map(field => field.id);
    const rule = normalizeRule({ id: 'a', target: 'scenario', search: 'GHOST', action: 'replace', insert: 'x' });
    const result = validateRuleChains([rule], () => true, () => 'A quiet room.', order);
    assert.equal(result.get('a').status, 'missing');
    assert.equal(result.get('a').fallback, undefined);
});

test('validateRuleChains: an active removal makes a dependent later rule miss', () => {
    const remover = normalizeRule({ id: 'a', target: 'description', search: ' [MARKER]', action: 'replace', insert: '' });
    const seeker = normalizeRule({ id: 'b', target: 'description', search: '[MARKER]', action: 'replace', insert: 'x' });
    const result = validateRuleChains([remover, seeker], () => true, () => 'seed [MARKER]');
    assert.equal(result.get('a').status, 'ok');
    assert.equal(result.get('b').status, 'missing');
});

test('validateRuleChains: every rule gets a result, keyed by id, in list order', () => {
    const rules = [
        normalizeRule({ id: 'a', target: 'description', search: 'x', insert: 'y' }),
        normalizeRule({ id: 'b', target: 'persona', search: 'x', insert: 'y' }),
    ];
    const result = validateRuleChains(rules, () => true, () => 'x');
    assert.deepEqual([...result.keys()], ['a', 'b']);
    assert.deepEqual([...result.values()].map(v => v.status), ['ok', 'ok']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exitCode = 1;
}

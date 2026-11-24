// Chat Prompt Patches — pure rule engine.
//
// No SillyTavern imports here: this file is the node-testable core. The
// extension layer (index.js) resolves rule targets against live prompts,
// substitutes macros, and passes the resolved strings in.
//
// Rule shape (after normalizeRule):
//   {
//     id: string,                  // stable UUID — chat-level activation is keyed by this
//     name: string,                // optional label shown in the panel
//     target: TARGET_FIELDS[].id,  // which card field the rule is aimed at
//     useRegex: boolean,           // false = literal text match, true = search is a RegExp pattern
//     search: string,              // text/pattern to find
//     action: 'before' | 'after' | 'replace',
//     insert: string,              // inserted text; replace + empty insert = removal
//     allMatches: boolean,         // false = act on the first match only
//     forBotCard: boolean,         // true = active in every chat; false = per-chat slider
//     includeInScan: boolean,      // true = insert text is shown to the World Info scanner while the rule applies
//   }

export const TARGET_FIELDS = [
    // ccIdentifier: the chat-completion message identifier this card field
    // lands in (verified against the ST release source). 'main' and 'jailbreak'
    // also contain the preset's own text — rules patch within that content.
    { id: 'description', label: 'Description', ccIdentifier: 'charDescription' },
    { id: 'personality', label: 'Personality', ccIdentifier: 'charPersonality' },
    { id: 'scenario', label: 'Scenario', ccIdentifier: 'scenario' },
    { id: 'system_prompt', label: 'System Prompt (card)', ccIdentifier: 'main' },
    { id: 'post_history_instructions', label: 'Post-History Instructions (card)', ccIdentifier: 'jailbreak' },
    // Example messages become several messages: 'dialogueExamples' plus
    // per-example 'dialogueExamples <i>-<j>' variants — prefix matched.
    { id: 'mes_example', label: 'Example Messages (card)', ccIdentifier: 'dialogueExamples', ccPrefixMatch: true },
    // The chat's selected user persona. ST only builds the message when the
    // description is non-empty AND its position is "In prompt" (openai.js);
    // other positions leave no persona message — the rule then runs through
    // the system-role fallback or finds nothing. (ST 1.19 strips identifiers
    // from the CHAT_COMPLETION_PROMPT_READY payload entirely, so for every
    // target here the content fallback is what actually locates messages.)
    { id: 'persona', label: 'User Persona (this chat)', ccIdentifier: 'personaDescription' },
];

export const ACTIONS = ['before', 'after', 'replace'];

export function genId() {
    return globalThis.crypto?.randomUUID?.() ?? `patch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Repairs a stored rule into a known-good shape. Never throws. */
export function normalizeRule(raw) {
    return {
        id: typeof raw?.id === 'string' && raw.id ? raw.id : genId(),
        name: typeof raw?.name === 'string' ? raw.name : '',
        target: TARGET_FIELDS.some(f => f.id === raw?.target) ? raw.target : 'description',
        useRegex: raw?.useRegex === true,
        search: typeof raw?.search === 'string' ? raw.search : '',
        action: ACTIONS.includes(raw?.action) ? raw.action : 'replace',
        insert: typeof raw?.insert === 'string' ? raw.insert : '',
        allMatches: raw?.allMatches === true,
        forBotCard: raw?.forBotCard === true,
        includeInScan: raw?.includeInScan === true,
    };
}

/** Non-overlapping literal matches, scanned left to right. */
function* literalMatches(text, needle) {
    let i = 0;
    while (needle.length > 0) {
        const found = text.indexOf(needle, i);
        if (found === -1) return;
        yield { start: found, end: found + needle.length };
        i = found + needle.length;
    }
}

/**
 * Finds match ranges of the search text/pattern in `text`.
 * @returns {{ matches: {start:number,end:number}[], error: string|null }}
 */
export function getMatches(text, { search, useRegex }) {
    if (!search) {
        return { matches: [], error: null };
    }
    if (useRegex) {
        let re;
        try {
            re = new RegExp(search, 'g');
        } catch (error) {
            return { matches: [], error: `Invalid regex: ${error?.message ?? error}` };
        }
        const matches = [];
        let match;
        while ((match = re.exec(text)) !== null) {
            // A pattern that can match the empty string would loop and produce
            // meaningless zero-width insertions — reject it instead.
            if (match[0].length === 0) {
                return { matches: [], error: 'Regex can match an empty string — narrow the pattern.' };
            }
            matches.push({ start: match.index, end: match.index + match[0].length });
        }
        return { matches, error: null };
    }
    return { matches: [...literalMatches(text, search)], error: null };
}

/**
 * Validates a rule against a field's current text.
 * @returns {{ status: 'empty'|'invalid'|'ok'|'multi'|'missing', count: number, error: string|null, warning: string|null }}
 */
export function validateRule(rule, fieldText) {
    if (!rule?.search) {
        return { status: 'empty', count: 0, error: null, warning: null };
    }
    const { matches, error } = getMatches(String(fieldText ?? ''), { search: rule.search, useRegex: rule.useRegex });
    if (error) {
        return { status: 'invalid', count: 0, error, warning: null };
    }
    let warning = null;
    if (rule.action !== 'replace' && !rule.insert) {
        warning = 'Insert text is empty — before/after does nothing.';
    }
    const status = matches.length === 0 ? 'missing' : matches.length === 1 ? 'ok' : 'multi';
    return { status, count: matches.length, error: null, warning };
}

/**
 * Chain-aware validation: walks the rules in list order while keeping one
 * simulated text per target field, mirroring what the generation hooks do:
 *  - Primary: a rule validates against its own target's simulated text, and
 *    an ACTIVE rule's outcome is applied to that text, so later rules see
 *    what earlier active rules leave behind.
 *  - Fallback: when the search misses the rule's own field, the chat-completion
 *    hook's fallback (applyEntryToMessages) still patches the first system-role
 *    message containing the text — in whichever field that message belongs to.
 *    The other fields' simulated texts are therefore probed in `targetOrder`
 *    (an approximation of the runtime prompt order — the real order is the
 *    user's prompt manager). A hit marks the validation with `fallback` (the
 *    field's label) and, for an active rule, the outcome is applied to THAT
 *    field's text so later rules chain off it, as they do at generation.
 *
 * Inactive rules are validated against the current simulated texts but never
 * mutate them (they will not run at generation, so they must not feed the
 * chain either).
 *
 * @param {object[]} rules Rule definitions, in list (application) order
 * @param {(rule: object) => boolean} isActive True when the rule applies to
 *        the current generation (forBotCard, or slider on in this chat)
 * @param {(target: string) => string} textForTarget Current text of a target field
 * @param {string[]} [targetOrder] Target ids to probe when the search misses
 *        the rule's own field, in approximate prompt order (TARGET_FIELDS)
 * @returns {Map<string, object>} rule id → validateRule() result, plus a
 *          `fallback` field (the other field's label) when the search text
 *          only exists in that other field
 */
export function validateRuleChains(rules, isActive, textForTarget, targetOrder = []) {
    const texts = new Map();
    const results = new Map();
    const textFor = target => {
        if (!texts.has(target)) {
            texts.set(target, String(textForTarget(target) ?? ''));
        }
        return texts.get(target);
    };
    for (const rule of rules) {
        let validation = validateRule(rule, textFor(rule.target));
        let appliedTo = rule.target;
        if (validation.status === 'missing') {
            for (const target of targetOrder) {
                if (target === rule.target) {
                    continue; // own field just missed — that is why we are here
                }
                const { matches, error } = getMatches(textFor(target), { search: rule.search, useRegex: rule.useRegex });
                if (error || matches.length === 0) {
                    continue;
                }
                const label = TARGET_FIELDS.find(field => field.id === target)?.label ?? target;
                validation = {
                    status: matches.length === 1 ? 'ok' : 'multi',
                    count: matches.length,
                    error: null,
                    warning: [validation.warning, `Search text only exists in ${label} — at generation the fallback patches that message instead of this field.`].filter(Boolean).join(' '),
                    fallback: label,
                };
                appliedTo = target;
                break;
            }
        }
        results.set(rule.id, validation);
        // Mirror applyRules: only active rules mutate the text, and only when
        // they actually applied — a missing/invalid/empty search is the same
        // no-op here as it is at generation time.
        if (isActive(rule)) {
            const outcome = applyRule(texts.get(appliedTo), rule);
            if (outcome.appliedCount > 0) {
                texts.set(appliedTo, outcome.text);
            }
        }
    }
    return results;
}

/**
 * Resolves the rules whose insert text should be shown to the World Info
 * scanner: rules that are active, opted into scanning, and actually insert
 * something (a removal has no text to scan). The insert text is returned raw —
 * macros are substituted by SillyTavern when the scan reads the injection.
 * @param {object[]} rules Rule definitions
 * @param {(rule: object) => boolean} isActive True when the rule applies to the
 *        current generation (the caller folds in activation state and whether
 *        the search text is actually found, so phantom text never triggers entries).
 * @returns {{ rule: object, insert: string }[]}
 */
export function collectScanEntries(rules, isActive) {
    return rules
        .filter(rule => rule.includeInScan === true && rule.insert && isActive(rule))
        .map(rule => ({ rule, insert: rule.insert }));
}

/**
 * Applies one rule to a text.
 * @param {string} text
 * @param {object} rule
 * @param {{ search?: string, insert?: string }} [resolved] Optional pre-substituted
 *        search/insert (index.js substitutes macros before calling).
 * @returns {{ text: string, appliedCount: number, error: string|null }}
 */
export function applyRule(text, rule, resolved = {}) {
    const search = typeof resolved.search === 'string' ? resolved.search : rule.search;
    const insert = typeof resolved.insert === 'string' ? resolved.insert : rule.insert;
    const source = String(text ?? '');

    const { matches, error } = getMatches(source, { search, useRegex: rule.useRegex });
    if (error) {
        return { text: source, appliedCount: 0, error };
    }
    const selected = rule.allMatches ? matches : matches.slice(0, 1);
    if (selected.length === 0) {
        return { text: source, appliedCount: 0, error: null };
    }

    let result = '';
    let cursor = 0;
    for (const { start, end } of selected) {
        result += source.slice(cursor, start);
        switch (rule.action) {
            case 'replace':
                result += insert;
                break;
            case 'before':
                result += insert + source.slice(start, end);
                break;
            case 'after':
                result += source.slice(start, end) + insert;
                break;
        }
        cursor = end;
    }
    result += source.slice(cursor);

    return { text: result, appliedCount: selected.length, error: null };
}

/**
 * Applies rules sequentially in list order — each rule sees the previous
 * rule's output.
 * @param {string} text
 * @param {object[]} rules Array of { rule, search?, insert? } — index.js resolves
 *        macro substitution per rule and only passes ACTIVE rules.
 * @returns {{ text: string, results: { name: string, appliedCount: number, error: string|null }[] }}
 */
export function applyRules(text, entries) {
    let current = String(text ?? '');
    const results = [];
    for (const entry of entries) {
        const outcome = applyRule(current, entry.rule, { search: entry.search, insert: entry.insert });
        current = outcome.text;
        results.push({ name: entry.rule.name || entry.rule.id, appliedCount: outcome.appliedCount, error: outcome.error });
    }
    return { text: current, results };
}

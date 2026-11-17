// Chat Prompt Patches — per-chat prompt surgery without touching the card.
//
// A "patch rule" says: in card field X, find text T and insert before/after it
// or replace it (empty insert + replace = remove). Rules are defined once per
// CHARACTER (stored in the character's extension sidecar via
// writeExtensionField — the card's prompt fields themselves are never
// modified) and take effect at generation time on the assembled prompt.
//
// Activation model:
//   - rule.forBotCard = true  → active in every chat of that bot ("ALL CHATS").
//   - rule.forBotCard = false → per-chat slider; a new chat starts OFF. The
//     slider states live in chat_metadata, keyed by the rule's stable id, so
//     they travel with the chat.
//
// Hook points (both payloads are mutable, both fire before the request is
// sent, dry-run included so the Prompt Manager preview shows patched text):
//   - GENERATE_AFTER_COMBINE_PROMPTS { prompt: string }  — text completion
//   - CHAT_COMPLETION_PROMPT_READY    { chat: messages[] } — chat completion
//
// Field targeting: chat completion messages carry identifiers, so rules can
// target a field precisely (charDescription / charPersonality / scenario /
// main / jailbreak / dialogueExamples*). In text completion the card is baked
// into one flat story string, so there the field selector only drives
// validation — application searches the final prompt string.
//
// Macros: search and insert texts are run through substituteParams at apply
// time, so text copied from the card editor (containing {{char}} etc.)
// matches the substituted prompt content.

import { renderExtensionTemplateAsync, saveMetadataDebounced, writeExtensionField } from '../../../extensions.js';
import {
    animation_duration,
    characters,
    chat_metadata,
    eventSource,
    event_types,
    substituteParams,
    this_chid,
} from '../../../../script.js';
import { selected_group } from '../../../../scripts/group-chats.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../../../scripts/popup.js';
import { loadMovingUIState } from '../../../../scripts/power-user.js';
import { dragElement } from '../../../../scripts/RossAscends-mods.js';
import { delay, escapeHtml } from '../../../../scripts/utils.js';
import {
    applyRule,
    applyRules,
    genId,
    normalizeRule,
    TARGET_FIELDS,
    validateRule,
} from './src/engine.js';

// `$` (jQuery) and `toastr` are page-level globals provided by SillyTavern.

const MODULE_NAME = 'ChatPromptPatches';
const FIELD_KEY = 'prompt_patches'; // character extension field with the rule definitions
const STATES_KEY = 'prompt_patch_states'; // chat_metadata key with per-chat slider states

let panelElement = null;
let buttonInjected = false;
let injectionObserver = null;
let rules = []; // in-memory rule definitions for the current character (source of truth for the panel)
const expandedIds = new Set();
let persistTimer = null;
let persistPending = null;

function log(message, ...rest) {
    console.debug(`[${MODULE_NAME}]`, message, ...rest);
}

function toast(kind, message) {
    if (typeof toastr === 'function') {
        toastr[kind](message, '', { timeOut: 2500 });
    } else {
        console.warn(`[${MODULE_NAME}] toastr missing: ${message}`);
    }
}

// --- Character access ---

/** ST's this_chid is a STRING (setCharacterId stores String(value)); parse it to a numeric index, or -1. */
function getCharacterIndex() {
    const index = Number.parseInt(this_chid, 10);
    return Number.isInteger(index) && index >= 0 ? index : -1;
}

/** True when a chat is open and it belongs to an individual (non-group) character. */
function hasCharacter() {
    return !selected_group
        && Array.isArray(characters)
        && getCharacterIndex() >= 0
        && Boolean(characters[getCharacterIndex()]);
}

function getCharacter() {
    return hasCharacter() ? characters[getCharacterIndex()] : null;
}

function getCharacterName() {
    return getCharacter()?.name ?? '';
}

/** Current raw text of a target card field (empty string when unset). */
function getFieldText(target) {
    const char = getCharacter();
    if (!char) {
        return '';
    }
    switch (target) {
        case 'description':
            return String(char.description ?? '');
        case 'personality':
            return String(char.personality ?? '');
        case 'scenario':
            return String(char.scenario ?? '');
        case 'system_prompt':
            return String(char.system_prompt ?? '');
        case 'post_history_instructions':
            return String(char.post_history_instructions ?? '');
        case 'mes_example':
            return String(char.mes_example ?? '');
        default:
            return '';
    }
}

function fieldLabel(target) {
    return TARGET_FIELDS.find(f => f.id === target)?.label ?? target;
}

// --- Storage: definitions (character sidecar) + activation (chat metadata) ---

function loadRules() {
    const stored = getCharacter()?.data?.extensions?.[FIELD_KEY];
    rules = Array.isArray(stored) ? stored.map(normalizeRule) : [];
    return rules;
}

function schedulePersistRules() {
    // Snapshot at schedule time: whatever the user saw edited is what gets
    // written, even if they switch characters before the debounce fires.
    const chid = getCharacterIndex();
    const snapshot = JSON.parse(JSON.stringify(rules));
    clearTimeout(persistTimer);
    persistPending = async () => {
        try {
            await writeExtensionField(chid, FIELD_KEY, snapshot);
            log('rule definitions saved', snapshot.length);
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Failed to save rule definitions`, error);
            toast('error', 'Failed to save patch rules.');
        }
    };
    persistTimer = setTimeout(persistPending, 400);
}

function flushPersistRules() {
    clearTimeout(persistTimer);
    const pending = persistPending;
    persistPending = null;
    if (pending) {
        return pending();
    }
    return Promise.resolve();
}

function getStates() {
    if (!chat_metadata || typeof chat_metadata !== 'object') {
        return {};
    }
    if (!chat_metadata[STATES_KEY] || typeof chat_metadata[STATES_KEY] !== 'object') {
        chat_metadata[STATES_KEY] = {};
    }
    return chat_metadata[STATES_KEY];
}

function isRuleActive(rule) {
    if (rule.forBotCard) {
        return true;
    }
    return getStates()[rule.id] === true;
}

function setChatState(ruleId, active) {
    const states = getStates();
    if (active) {
        states[ruleId] = true;
    } else {
        delete states[ruleId];
    }
    saveMetadataDebounced();
}

/**
 * Resolves the rules to apply for one generation: active rules only, in list
 * order, with macro-substituted search/insert texts.
 */
function collectActiveEntries() {
    return rules
        .filter(rule => isRuleActive(rule) && rule.search)
        .map(rule => ({
            rule,
            search: substituteParams(rule.search),
            insert: substituteParams(rule.insert),
        }));
}

// --- Generation hooks (never allowed to break a generation) ---

function onAfterCombinePrompts(eventData) {
    try {
        if (typeof eventData?.prompt !== 'string') {
            return;
        }
        const entries = collectActiveEntries();
        if (entries.length === 0) {
            return;
        }
        // Note: with CFG enabled ST also runs getCombinedPrompt(true) for the
        // negative prompt (dryRun payload) — patches applying there is
        // harmless, and dry-run=true also covers the prompt preview, which
        // SHOULD show patched text. So: apply unconditionally.
        const result = applyRules(eventData.prompt, entries);
        eventData.prompt = result.text;
        logApplied('text completion', result.results);
    } catch (error) {
        console.warn(`[${MODULE_NAME}] text completion patching failed — prompt left unpatched`, error);
    }
}

function onChatCompletionPromptReady(eventData) {
    try {
        const chat = eventData?.chat;
        if (!Array.isArray(chat)) {
            return;
        }
        const entries = collectActiveEntries();
        if (entries.length === 0) {
            return;
        }
        for (const entry of entries) {
            applyEntryToMessages(chat, entry);
        }
    } catch (error) {
        console.warn(`[${MODULE_NAME}] chat completion patching failed — prompt left unpatched`, error);
    }
}

/**
 * Chat completion messages carry identifiers, so prefer the field's own
 * message. If the field's message is missing entirely (empty field, or the
 * squash of consecutive system messages placed the content under a different
 * identifier), fall back to the first system-role message containing the
 * search text — chat history (user/assistant) is never touched by the
 * fallback.
 */
function applyEntryToMessages(messages, entry) {
    const rule = entry.rule;
    const field = TARGET_FIELDS.find(f => f.id === rule.target);
    if (!field) {
        return;
    }

    const candidates = findCandidateMessages(messages, field);
    if (candidates.length > 0) {
        patchMessage(candidates[0], entry, field.label, false);
        return;
    }

    const fallback = messages.find(message =>
        typeof message?.content === 'string'
        && (message.role === 'system' || (field.ccPrefixMatch && String(message.identifier ?? '').startsWith(field.ccIdentifier)))
        && message.content.includes(entry.search),
    );
    if (fallback) {
        patchMessage(fallback, entry, field.label, true);
        return;
    }

    log(`rule "${ruleLabel(rule)}": target "${field.label}" not found in prompt — not applied`);
}

function findCandidateMessages(messages, field) {
    if (field.ccPrefixMatch) {
        const prefixed = messages.filter(message => typeof message?.identifier === 'string' && message.identifier.startsWith(field.ccIdentifier));
        const exact = prefixed.filter(message => message.identifier === field.ccIdentifier);
        return exact.length > 0 ? exact : prefixed;
    }
    return messages.filter(message => message?.identifier === field.ccIdentifier);
}

function patchMessage(message, entry, fieldLabel, isFallback) {
    const outcome = applyRule(message.content, entry.rule, { search: entry.search, insert: entry.insert });
    if (outcome.error) {
        log(`rule "${ruleLabel(entry.rule)}": ${outcome.error}`);
        return;
    }
    if (outcome.appliedCount > 0) {
        message.content = outcome.text;
        log(`rule "${ruleLabel(entry.rule)}": ${outcome.appliedCount} application(s) in ${fieldLabel}${isFallback ? ' (via fallback message)' : ''}`);
        return;
    }
    log(`rule "${ruleLabel(entry.rule)}": search text not found in ${fieldLabel} — not applied`);
}

function ruleLabel(rule) {
    return rule.name || 'Unnamed patch';
}

function logApplied(mode, results) {
    const applied = results.filter(result => result.appliedCount > 0);
    if (applied.length > 0) {
        log(`${mode}: applied ${applied.map(result => `"${result.name}" ×${result.appliedCount}`).join(', ')}`);
    }
}

// --- Validation display ---

function dotStatusText(rule, validation, active) {
    const base = {
        ok: 'Found exactly once',
        multi: `Found ${validation.count} times`,
        missing: 'Search text not found in the field',
        invalid: validation.error ?? 'Invalid search pattern',
        empty: 'No search text entered',
    }[validation.status] ?? '';
    return `${base}${active ? '' : ' — rule is OFF in this chat'}`;
}

function matchInfoHtml(validation) {
    const classes = {
        ok: 'cpp-match-ok',
        multi: 'cpp-match-multi',
        missing: 'cpp-match-missing',
        invalid: 'cpp-match-invalid',
        empty: 'cpp-match-empty',
    };
    const symbols = { ok: '✔', multi: '⚠', missing: '✖', invalid: '✖', empty: '–' };
    const texts = {
        ok: 'Found exactly once',
        multi: `Found ${validation.count} times — first one is used unless "all matches" is set`,
        missing: 'Not found in the field — the rule will not do anything',
        invalid: validation.error ?? 'Invalid search pattern',
        empty: 'No search text entered',
    };
    const extra = validation.warning ? ` — ${escapeHtml(validation.warning)}` : '';
    return `<div class="cpp-match-info ${classes[validation.status]}">${symbols[validation.status]} ${escapeHtml(texts[validation.status])}${extra}</div>`;
}

// --- Panel rendering ---

function rowHtml(rule) {
    const active = isRuleActive(rule);
    const validation = validateRule(rule, getFieldText(rule.target));
    const expanded = expandedIds.has(rule.id);

    const dotClass = active ? `cpp-dot cpp-dot-${validation.status}` : 'cpp-dot';
    const dotTitle = escapeHtml(dotStatusText(rule, validation, active));
    const nameClass = rule.name ? 'cpp-rule-name' : 'cpp-rule-name cpp-rule-unnamed';
    const nameText = escapeHtml(rule.name || 'Unnamed patch');

    let scopeControl;
    if (rule.forBotCard) {
        scopeControl = '<span class="cpp-allchats-badge" title="Active in every chat of this bot (entire card)">ALL CHATS</span>';
    } else {
        scopeControl = `
            <label class="cpp-slider" title="Active in this chat — off in new chats until enabled here">
                <input type="checkbox" class="cpp-chat-toggle" ${active ? 'checked' : ''}>
                <span class="cpp-slider-track"><span class="cpp-slider-knob"></span></span>
            </label>`;
    }

    const targetOptions = TARGET_FIELDS
        .map(field => `<option value="${field.id}" ${field.id === rule.target ? 'selected' : ''}>${escapeHtml(field.label)}</option>`)
        .join('');

    return `
        <div class="cpp-rule ${expanded ? 'cpp-expanded' : ''}" data-id="${escapeHtml(rule.id)}">
            <div class="cpp-rule-header" title="Click to expand / collapse">
                <span class="${dotClass}" title="${dotTitle}"></span>
                <span class="${nameClass}">${nameText}</span>
                ${scopeControl}
                <i class="cpp-expand fa-solid fa-chevron-right fa-sm"></i>
            </div>
            <div class="cpp-rule-body">
                <div class="cpp-form-row">
                    <small class="cpp-label">Rule name (optional)</small>
                    <input type="text" class="text_pole cpp-name-input" value="${escapeHtml(rule.name)}" placeholder="e.g. Warm up the boss">
                </div>
                <label class="cpp-checkbox-label" title="Run this rule automatically in every chat of this bot. If unchecked, it starts OFF in new chats and you enable it per chat with the slider.">
                    <input type="checkbox" class="cpp-forbotcard" ${rule.forBotCard ? 'checked' : ''}>
                    <span>Apply in every chat (entire card)</span>
                </label>
                <div class="cpp-form-row-inline">
                    <div class="cpp-form-row flex1">
                        <small class="cpp-label">Where to look</small>
                        <select class="cpp-target">${targetOptions}</select>
                    </div>
                    <label class="cpp-checkbox-label" title="Treat the search text as a regular expression pattern instead of literal text">
                        <input type="checkbox" class="cpp-use-regex" ${rule.useRegex ? 'checked' : ''}>
                        <span>regex</span>
                    </label>
                </div>
                <div class="cpp-form-row">
                    <small class="cpp-label">Search for</small>
                    <textarea class="text_pole cpp-search" rows="2" placeholder="Text to find in the selected field — paste it from the card">${escapeHtml(rule.search)}</textarea>
                </div>
                ${matchInfoHtml(validation)}
                <label class="cpp-checkbox-label" title="Apply to every occurrence instead of just the first one">
                    <input type="checkbox" class="cpp-all-matches" ${rule.allMatches ? 'checked' : ''}>
                    <span>Apply to all matches</span>
                </label>
                <div class="cpp-form-row">
                    <small class="cpp-label">Action</small>
                    <select class="cpp-action">
                        <option value="replace" ${rule.action === 'replace' ? 'selected' : ''}>Replace</option>
                        <option value="before" ${rule.action === 'before' ? 'selected' : ''}>Insert before</option>
                        <option value="after" ${rule.action === 'after' ? 'selected' : ''}>Insert after</option>
                    </select>
                </div>
                <div class="cpp-form-row">
                    <small class="cpp-label">${rule.action === 'replace' ? 'With (empty = remove)' : 'Insert this text'}</small>
                    <textarea class="text_pole cpp-insert" rows="2" placeholder="${rule.action === 'replace' ? 'Empty + Replace = remove the found text' : 'Text to insert'}">${escapeHtml(rule.insert)}</textarea>
                </div>
                <div class="cpp-body-actions">
                    <div class="menu_button cpp-preview" title="Show the selected field with this rule applied"><i class="fa-solid fa-eye"></i><span>Preview</span></div>
                    <div class="menu_button cpp-delete" title="Delete this rule"><i class="fa-solid fa-trash-can"></i><span>Delete</span></div>
                </div>
            </div>
        </div>`;
}

// Re-reads rule definitions from the character record, then renders. Use when
// storage is the source of truth changed: chat switched, card edited externally.
// NOT after in-memory mutations (add/delete/edit): those persist on a debounce,
// so re-reading here would clobber them (added rows vanish, deleted ones resurrect).
function reloadPanel() {
    if (!panelElement) {
        return;
    }
    loadRules();
    refreshPanel();
}

// Renders the current in-memory rules without re-reading storage.
function refreshPanel() {
    if (!panelElement) {
        return;
    }

    const charName = getCharacterName();
    panelElement.find('.cpp-title-char').text(charName ? `— ${charName}` : '');

    const notice = panelElement.find('#cppNotice');
    const list = panelElement.find('#cppRuleList');
    const addButton = panelElement.find('#cppAddButton');

    if (!hasCharacter()) {
        notice.text('Open a chat with an individual character to manage its patch rules. (Group chats are not supported yet.)');
        notice.removeClass('cpp-hidden');
        list.empty();
        addButton.addClass('cpp-hidden');
        return;
    }

    notice.addClass('cpp-hidden');
    addButton.removeClass('cpp-hidden');
    list.html(rules.map(rowHtml).join(''));
}

function updateRuleDisplay(ruleId) {
    const row = panelElement?.find(`.cpp-rule[data-id="${ruleId}"]`);
    const rule = rules.find(candidate => candidate.id === ruleId);
    if (!row || !rule) {
        return;
    }
    const active = isRuleActive(rule);
    const validation = validateRule(rule, getFieldText(rule.target));
    const dot = row.find('.cpp-dot').first();
    dot.attr('class', active ? `cpp-dot cpp-dot-${validation.status}` : 'cpp-dot');
    dot.attr('title', dotStatusText(rule, validation, active));
    row.find('.cpp-match-info').first().replaceWith(matchInfoHtml(validation));
}

// --- Panel actions ---

function addRule() {
    if (!hasCharacter()) {
        return;
    }
    const rule = normalizeRule({ id: genId() });
    rules.push(rule);
    expandedIds.add(rule.id);
    schedulePersistRules();
    refreshPanel();
    panelElement?.find(`.cpp-rule[data-id="${rule.id}"]`)?.[0]?.scrollIntoView({ block: 'nearest' });
    log('rule added', rule.id);
}

async function deleteRule(ruleId) {
    const rule = rules.find(candidate => candidate.id === ruleId);
    if (!rule) {
        return;
    }
    const confirmed = await callGenericPopup(`Delete patch "${ruleLabel(rule)}"?`, POPUP_TYPE.CONFIRM);
    if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }
    rules = rules.filter(candidate => candidate.id !== ruleId);
    expandedIds.delete(ruleId);
    delete getStates()[ruleId];
    saveMetadataDebounced();
    schedulePersistRules();
    refreshPanel();
}

async function previewRule(ruleId) {
    const rule = rules.find(candidate => candidate.id === ruleId);
    if (!rule) {
        return;
    }
    const fieldText = getFieldText(rule.target);
    const outcome = applyRule(fieldText, rule);
    if (outcome.error) {
        toast('warning', outcome.error);
        return;
    }
    const html = `
        <div>
            <strong>Preview</strong> — <em>${escapeHtml(fieldLabel(rule.target))}</em> with
            "${escapeHtml(ruleLabel(rule))}" applied (${outcome.appliedCount} match${outcome.appliedCount === 1 ? '' : 'es'}):
        </div>
        <pre class="text_pole" style="white-space: pre-wrap; max-height: 50dvh; overflow-y: auto; margin-top: 0.5rem;">${escapeHtml(outcome.text || '(empty)')}</pre>
        <small style="opacity: 0.75;">Note: actual patching happens on the assembled prompt at generation time; macros are substituted there.</small>`;
    await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, okButton: 'Close' });
}

// --- Panel lifecycle (moving-UI shell, same as the other panels) ---

async function buildPanel() {
    const template = await renderExtensionTemplateAsync(getExtensionName(), 'panel');
    panelElement = $(template);
    $('#movingDivs').append(panelElement);

    wirePanel();
    loadMovingUIState();
    dragElement(panelElement);
    reloadPanel();
}

function wirePanel() {
    const panel = panelElement;

    panel.find('#cppClose').on('click', hidePanel);
    panel.find('#cppMinimize').on('click', () => panel.toggleClass('cpp-minimized'));
    panel.find('#cppAddButton').on('click', addRule);

    // Delegated events — rows are re-rendered as a whole, so handlers live on
    // the panel, not on individual rows.
    panel.on('click', '.cpp-rule-header', function (event) {
        if ($(event.target).closest('.cpp-slider, input').length > 0) {
            return; // slider clicks must not toggle expansion
        }
        const row = $(this).closest('.cpp-rule');
        const ruleId = String(row.data('id'));
        if (expandedIds.has(ruleId)) {
            expandedIds.delete(ruleId);
            row.removeClass('cpp-expanded');
        } else {
            expandedIds.add(ruleId);
            row.addClass('cpp-expanded');
        }
    });

    panel.on('change', '.cpp-chat-toggle', function () {
        const row = $(this).closest('.cpp-rule');
        setChatState(String(row.data('id')), this.checked);
        updateRuleDisplay(String(row.data('id')));
    });

    panel.on('change', '.cpp-forbotcard', function () {
        const rule = findRuleByRow(this);
        if (!rule) {
            return;
        }
        rule.forBotCard = this.checked;
        schedulePersistRules();
        refreshPanel();
    });

    panel.on('change', '.cpp-target', function () {
        const rule = findRuleByRow(this);
        if (!rule) {
            return;
        }
        rule.target = String(this.value);
        schedulePersistRules();
        updateRuleDisplay(rule.id);
    });

    panel.on('change', '.cpp-use-regex', function () {
        const rule = findRuleByRow(this);
        if (!rule) {
            return;
        }
        rule.useRegex = this.checked;
        schedulePersistRules();
        updateRuleDisplay(rule.id);
    });

    panel.on('change', '.cpp-all-matches', function () {
        const rule = findRuleByRow(this);
        if (!rule) {
            return;
        }
        rule.allMatches = this.checked;
        schedulePersistRules();
        updateRuleDisplay(rule.id);
    });

    panel.on('change', '.cpp-action', function () {
        const rule = findRuleByRow(this);
        if (!rule) {
            return;
        }
        rule.action = String(this.value);
        schedulePersistRules();
        refreshPanel(); // re-render updates the insert field's label/placeholder
    });

    panel.on('input', '.cpp-search', function () {
        const rule = findRuleByRow(this);
        if (!rule) {
            return;
        }
        rule.search = String($(this).val() ?? '');
        schedulePersistRules();
        updateRuleDisplay(rule.id);
    });

    panel.on('input', '.cpp-insert', function () {
        const rule = findRuleByRow(this);
        if (!rule) {
            return;
        }
        rule.insert = String($(this).val() ?? '');
        schedulePersistRules();
        updateRuleDisplay(rule.id);
    });

    panel.on('input', '.cpp-name-input', function () {
        const rule = findRuleByRow(this);
        if (!rule) {
            return;
        }
        rule.name = String($(this).val() ?? '');
        schedulePersistRules();
        const nameSpan = $(this).closest('.cpp-rule').find('.cpp-rule-name').first();
        nameSpan.text(rule.name || 'Unnamed patch');
        nameSpan.toggleClass('cpp-rule-unnamed', !rule.name);
    });

    panel.on('click', '.cpp-preview', function () {
        previewRule(String($(this).closest('.cpp-rule').data('id')));
    });

    panel.on('click', '.cpp-delete', function () {
        deleteRule(String($(this).closest('.cpp-rule').data('id')));
    });
}

function findRuleByRow(element) {
    const ruleId = String($(element).closest('.cpp-rule').data('id'));
    return rules.find(candidate => candidate.id === ruleId) ?? null;
}

function showPanel() {
    if (!panelElement) {
        return;
    }
    refreshPanel();
    if (panelElement.css('display') !== 'flex') {
        panelElement.addClass('resizing');
        panelElement.css('display', 'flex');
        panelElement.css('opacity', 0);
        panelElement.transition({
            opacity: 1.0,
            duration: animation_duration,
        }, async function () {
            await delay(50);
            panelElement.removeClass('resizing');
        });
    }
}

function hidePanel() {
    if (!panelElement) {
        return;
    }
    flushPersistRules();
    panelElement.addClass('resizing');
    panelElement.transition({
        opacity: 0.0,
        duration: animation_duration,
    });
    setTimeout(function () {
        panelElement.removeClass('resizing');
        panelElement.hide();
    }, animation_duration);
}

function togglePanel() {
    if (!panelElement) {
        return;
    }
    if (panelElement.css('display') === 'flex') {
        hidePanel();
    } else {
        showPanel();
    }
}

// --- Wand menu button (extensions menu, like Author's Note) ---

function injectMenuButton() {
    if (buttonInjected) {
        return;
    }
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        // Extensions menu not injected yet (load order) — wait for it.
        watchForExtensionsMenu();
        return;
    }
    if (document.getElementById('cppMenuButton')) {
        buttonInjected = true;
        return;
    }

    const button = document.createElement('div');
    button.id = 'cppMenuButton';
    button.className = 'list-item';
    button.innerHTML = '<i class="fa-fw fa-solid fa-puzzle-piece"></i><span>Prompt Patches</span>';
    button.title = 'Per-chat prompt patches';
    menu.appendChild(button);
    $(button).on('click', togglePanel);

    buttonInjected = true;
    if (injectionObserver) {
        injectionObserver.disconnect();
        injectionObserver = null;
    }
    log('wand menu button injected');
}

function watchForExtensionsMenu() {
    if (injectionObserver) {
        return;
    }
    injectionObserver = new MutationObserver(function () {
        if (document.getElementById('extensionsMenu')) {
            injectMenuButton();
        }
    });
    injectionObserver.observe(document.body, { childList: true, subtree: true });
}

// --- Install-folder name for template loading (rename-safe) ---

function getExtensionName() {
    try {
        // '.' keeps the file's own directory (the extension root); '../' would
        // climb above it, since URL resolution drops index.js before applying it.
        const rootUrl = new URL('.', import.meta.url);
        const match = rootUrl.pathname.match(/\/scripts\/extensions\/(.+?)\/?$/);
        if (match) {
            return match[1];
        }
    } catch {
        /* fall through */
    }
    return 'third-party/Chat-Prompt-Patches';
}

// --- Events / init ---

function registerEventListeners() {
    // Prompt hooks — both payloads are mutable, both fire before the request.
    eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, onAfterCombinePrompts);
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);

    // Panel data follows the current chat / character edits.
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        // Chat switched: flush any pending definition write for the PREVIOUS
        // character first, then reload definitions (same bot, other
        // activation state) and re-render.
        await flushPersistRules();
        reloadPanel();
    });
    eventSource.on(event_types.CHARACTER_EDITED, async () => {
        // Card edited elsewhere (character editor): flush, then re-read so the
        // panel reflects what was actually saved.
        await flushPersistRules();
        reloadPanel();
    });
}

async function init() {
    await buildPanel();
    injectMenuButton();
    registerEventListeners();
    log('ready');
}

jQuery(() => {
    init().catch(error => {
        console.error(`[${MODULE_NAME}] init failed`, error);
    });
});

# Chat Prompt Patches

A SillyTavern extension for per-character prompt patch rules: find text in a character card field and insert before or after it, replace it, or remove it — at generation time, without ever editing the character card itself.

## What it does

A rule says: *in field X, find text T, and* insert before it / insert after it / replace it (replace with an empty insert removes the snippet). Fields cover description, personality, scenario, the card's system prompt, post-history instructions, example messages and the chat's selected user persona. Rules are managed in the **wand (extensions) menu → "Prompt Patches"** and are defined once per character.

- Rules live in the character's extension data, so the card's prompt fields are never modified — but the rules do ride along when you export or share the card.
- Each rule has an **"Apply in every chat (entire card)"** checkbox. Checked: the rule runs automatically in every chat of that character (marked with an ALL CHATS badge). Unchecked: the rule exists in every chat but starts off; flip its lorebook-style **slider** to activate it for the current chat. Slider states are stored in the chat metadata, so they survive reloads and travel with the chat.
- A status dot on each row shows the rule's state in the current chat: **grey** = off, **green** = search text found exactly once, **amber** = found multiple times, **red** = not found. The dots are chain-aware: they validate against what the *active* rules before each rule leave behind, so a rule that searches for text an earlier rule inserts shows green/amber, not red. A rule whose search text is gone is simply a no-op with a console warning — it never blocks a generation.
- Rules run in list order, so a later rule sees an earlier rule's output — reorder with the **up/down chevrons** on each rule row (see *Rule order* below).
- `{{char}}`, `{{user}}` and other macros are substituted in the search and insert texts at apply time, so text copied from the card editor matches; macros in the inserted text resolve normally because patching happens before the prompt is sent.
- Search is case-sensitive. A per-rule **regex** toggle treats the search text as a pattern (regexes that can match an empty string are rejected). Multi-match rules act on the first occurrence unless "apply to all matches" is set.
- Each rule has an **"Include in World Info Scanning"** checkbox (the same mechanism as Author's Note's option of that name). While the rule is active and its status dot shows the search text was found (green/amber), the inserted text is registered as a *scan-only* injection, so lorebook entries can activate from the patch text — even though it is not part of the chat history. Only text the patch **adds** is scanned, and the scan entry never appears in the prompt itself. Leave it unchecked and the patch stays invisible to the lorebook scanner (previous behavior).
- The **"User Persona (this chat)"** target aims a rule at the description of the user persona currently selected for this chat — the live value SillyTavern itself injects. It follows persona switches and description edits mid-chat: the status dot and World Info scan registrations refresh automatically.

## Rule order

Rules apply in list order, top to bottom: each rule sees the text the rules before it have already produced, so text an earlier rule inserts can be the search text of a later rule (a two-step "insert a marker, then find it" chain). The **up/down chevrons** on each rule row move a rule one position; the list order is saved with the bot and is the order the rules apply in.

A rule aims at one field, but a chain is not strictly confined to it: each rule first looks in its own field's text, and when the search text isn't there, the chat-completion fallback patches the first system message containing the text — in whichever field that message belongs to. So a Scenario rule can legitimately search for text an earlier Description rule inserted; the status dots and World Info scan gating model exactly this (a cross-field rule shows green/amber with a note that it patches the other field's message via the fallback). Two approximations remain: which message the fallback really patches when several fields hold the text is decided by your live prompt order at generation, and the dots work on raw field texts while macros are substituted at generation time. On **text completion** APIs the whole card is one flat prompt string, so everything chains there regardless of fields.

The chaining is already reflected in the status dots and in World Info scanning: a rule whose search text is produced by an earlier **active** rule — same field or not — shows green/amber and registers its scan text normally; switch that earlier rule off (or edit its insert away) and the dependent rule drops back to red until its text exists on its own. Rules that are off are validated but never feed the chain.

## Downgrading

The stored rule shape is unchanged between v0.1.7, v0.1.8 and v0.1.9 — updating between them (including reordering) never rewrites or drops existing rules; a reorder just saves the same rules in the new order. Data from older versions still loads too: missing optional keys are repaired with their defaults. Downgrading the **extension** below v0.1.8 is different: versions before v0.1.8 don't know the "User Persona" target, so rules targeting it load as Description-targeted there — lossy (the target choice is lost on that old version's next save) but not corrupting: the rule keeps its id, name, search, action and insert text.

## Install

In SillyTavern, go to **Extensions → Install extension**, paste

```
https://github.com/Flythos/Chat-Prompt-Patches
```

and confirm. Then restart SillyTavern and hard-refresh the browser tab (Ctrl+F5). Open the **wand menu → "Prompt Patches"** to start adding rules.

Requires SillyTavern 1.19.x. Group chats are not supported yet — the panel works on individual characters. Depth-based prompt inserts were deliberately left to the built-in `/inject`.

## How it works

- On **chat completion** APIs, each card field lands in the prompt as a message with a known identifier (`charDescription`, `charPersonality`, `scenario`, `main` for the card's system prompt, `jailbreak` for post-history instructions, `dialogueExamples*` for example messages). Rules patch exactly that message's content. If the field's message doesn't exist (empty field, or consecutive system messages were squashed under a different identifier), the rule falls back to the first system-role message containing the search text — chat history is never touched by the fallback.
- On **text completion**, the card is baked into one flat story string; the field selector then only drives validation, and the rule is applied to the final prompt string.
- The **User Persona** target reads what SillyTavern actually injects for the chat's selected persona (chat-completion identifier `personaDescription`). Caveats worth knowing:
    - SillyTavern only builds a dedicated persona message when the description is non-empty **and** the persona's position is set to **"In prompt"** (User Personas panel). With any other position (in the author's note, in-chat at depth, disabled) there is no persona message — a chat-completion rule then either patches an occurrence of the text found via the system-message fallback (e.g. one produced by a `{{persona}}` macro) or reports "not found".
    - On text completion the persona text is part of the assembled story string (or a `{{persona}}` macro expansion), so the rule simply searches the final prompt like any other field.
    - A `{{persona}}` macro anywhere in the prompt expands to the same text independently of the position setting, so the persona text can appear more than once in one prompt — a rule patches one occurrence (or all with "apply to all matches"), not every expansion. SillyTavern does not label the persona message in the hook payload, so Chat Prompt Patches prefers the message holding the persona text exactly as injected (the dedicated persona message in the default prompt order); if you rearranged the prompt order so an identical macro expansion sits later, that occurrence may be patched instead — pick a search text unique to what you want to patch.
- Definitions are stored in the character record (`data.extensions.prompt_patches`), which is embedded in the card's `json_data` — so exported/shared cards carry their rules with them.
- "Include in World Info Scanning" uses ST's own injection mechanism: the rule's insert text is registered via `setExtensionPrompt` at position NONE with the scan flag — `checkWorldInfo` feeds scan-flagged injections into the World Info scan buffer, while position NONE keeps the injection out of the assembled prompt. Macros are substituted by ST at scan time. The gate is deliberately strict: the scan entry exists only while the rule is active *and* its search text is actually found, so phantom text can never trigger entries. Note that card-field text a patch removes or replaces is not "un-scanned" — whether ST scans the description/scenario/etc. at all is decided per lorebook entry in the World Info editor. The gate itself counts a rule's search text as found when it exists in the rule's own field or, via the chat-completion fallback, in another field's text.

## Development

No build step; plain ES modules loaded by SillyTavern as-is. `npm test` runs the rule engine tests, `npm run audit` checks every SillyTavern import used by the code against the ST sources.

# Chat Prompt Patches

A SillyTavern extension for per-character prompt patch rules: find text in a character card field and insert before or after it, replace it, or remove it — at generation time, without ever editing the character card itself.

## What it does

A rule says: *in field X, find text T, and* insert before it / insert after it / replace it (replace with an empty insert removes the snippet). Fields cover description, personality, scenario, the card's system prompt, post-history instructions and example messages. Rules are managed in the **wand (extensions) menu → "Prompt Patches"** and are defined once per character.

- Rules live in the character's extension data, so the card's prompt fields are never modified — but the rules do ride along when you export or share the card.
- Each rule has an **"Apply in every chat (entire card)"** checkbox. Checked: the rule runs automatically in every chat of that character (marked with an ALL CHATS badge). Unchecked: the rule exists in every chat but starts off; flip its lorebook-style **slider** to activate it for the current chat. Slider states are stored in the chat metadata, so they survive reloads and travel with the chat.
- A status dot on each row shows the rule's state in the current chat: **grey** = off, **green** = search text found exactly once, **amber** = found multiple times, **red** = not found in the card. A rule whose search text is gone is simply a no-op with a console warning — it never blocks a generation.
- Rules run in list order, so a later rule sees an earlier rule's output.
- `{{char}}`, `{{user}}` and other macros are substituted in the search and insert texts at apply time, so text copied from the card editor matches; macros in the inserted text resolve normally because patching happens before the prompt is sent.
- Search is case-sensitive. A per-rule **regex** toggle treats the search text as a pattern (regexes that can match an empty string are rejected). Multi-match rules act on the first occurrence unless "apply to all matches" is set.

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
- Definitions are stored in the character record (`data.extensions.prompt_patches`), which is embedded in the card's `json_data` — so exported/shared cards carry their rules with them.

## Development

No build step; plain ES modules loaded by SillyTavern as-is. `npm test` runs the rule engine tests, `npm run audit` checks every SillyTavern import used by the code against the ST sources.

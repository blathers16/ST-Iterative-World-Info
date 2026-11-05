/**
 * Browser-side integration tests against the REAL index.js in a mocked
 * SillyTavern environment. Only external APIs/events are mocked; extension
 * code and public helper exports are not rewritten.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as core from '../core.mjs';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    .replace(/^import\s+\{[\s\S]*?\}\s+from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/^import\s+[^\n]+;\s*/gm, '');

const entries = {
    elf: { world: 'species', uid: 1, comment: 'Elf', content: 'Elf lore content: pointed ears.' },
    dwarf: { world: 'species', uid: 2, comment: 'Dwarf', content: 'Dwarf lore content: compact and slender.' },
    pirate: { world: 'settings', uid: 3, comment: 'Pirate', content: 'Pirate lore content: spacefaring.' },
};
const entryLabels = list => list.map(e => e.comment);
const containsLog = (lines, text) => lines.some(line => line.includes(text));

function build({
    group = false,
    drafts = [],
    maxPasses = 3,
    seed = -1,
    mainApi = 'textgenerationwebui',
    type = 'koboldcpp',
    includeNames = false,
    logLoreText = false,
    debug = false,
    scan = null,
    supplyRequested = null,
    generateError = null,
} = {}) {
    const listeners = new Map();
    const logs = { info: [], warn: [], error: [], debug: [] };
    const logger = Object.fromEntries(Object.keys(logs).map(level => [level, (...args) => {
        logs[level].push(args.map(String).join(' '));
    }]));
    const forcedRequests = [];
    const generated = [];
    const scans = [];
    const ui = new Map();
    const statuses = { textContent: '' };
    const timers = new Map();
    let timerId = 0;
    let pendingForced = [];
    let chatId = 'chat1';
    let settingsSaves = 0;
    let restoredMessages = 0;
    let chatSaves = 0;

    const ctx = {
        chat: [],
        characters: [
            { name: 'Helena', avatar: 'helena.png' },
            { name: 'Mio', avatar: 'mio.png' },
        ],
        name2: 'Helena',
        characterId: 0,
        groupId: group ? 'g1' : undefined,
        maxContext: 8000,
        mainApi,
        textCompletionSettings: { type, seed },
        extensionSettings: {
            iterative_world_info: {
                enabled: true,
                maxPasses,
                notifications: false,
                debug,
                logLoreText,
            },
        },
        getCurrentChatId: () => chatId,
        saveSettingsDebounced: () => { settingsSaves++; },
        saveChat: async () => { chatSaves++; },
        addOneMessage: async () => { restoredMessages++; },
        renderExtensionTemplateAsync: async () => '<div>settings</div>',
        eventSource: {
            on(event, fn) { listeners.set(event, [...(listeners.get(event) || []), fn]); },
            async emit(event, ...args) {
                for (const listener of listeners.get(event) ?? []) await listener(...args);
            },
        },
        eventTypes: {
            GENERATION_STARTED: 'generation_started',
            WORLD_INFO_ACTIVATED: 'world_info_activated',
            GENERATION_ENDED: 'generation_ended',
            GROUP_MEMBER_DRAFTED: 'group_member_drafted',
            GROUP_WRAPPER_FINISHED: 'group_wrapper_finished',
            WORLDINFO_FORCE_ACTIVATE: 'force',
            CHAT_CHANGED: 'chat_changed',
            GENERATION_STOPPED: 'stopped',
            MAIN_API_CHANGED: 'api_changed',
            PRESET_CHANGED: 'preset_changed',
        },
    };

    ctx.eventSource.on('force', lore => {
        forcedRequests.push([...lore]);
        pendingForced = [...lore];
    });

    const defaultScan = texts => {
        const text = texts.join(' ');
        return [
            /\belf\b/i.test(text) && entries.elf,
            /\bdwarf\b/i.test(text) && entries.dwarf,
            /\bpirate\b/i.test(text) && entries.pirate,
        ].filter(Boolean);
    };

    const checkWorldInfo = async (texts, maxContext, dryRun) => {
        scans.push({ texts: [...texts], maxContext, dryRun, characterId: ctx.characterId });
        return { allActivatedEntries: new Set((scan ?? defaultScan)(texts, ctx) ?? []) };
    };

    const $ = selector => {
        if (typeof selector === 'function') {
            initPromise = selector();
            return;
        }
        let element = ui.get(selector);
        if (!element) {
            element = {
                props: {},
                value: undefined,
                handlers: {},
                append() { return this; },
                prop(key, value) { this.props[key] = value; return this; },
                val(value) { this.value = value; return this; },
                on(event, fn) { this.handlers[event] = fn; return this; },
            };
            ui.set(selector, element);
        }
        return element;
    };
    let initPromise;

    ctx.generate = async (kind, options = {}) => {
        assert.equal(kind, 'regenerate', 'extension must only request a single-message regeneration');
        generated.push({ kind, speakerId: Number(ctx.characterId), seed: ctx.textCompletionSettings.seed, options });
        assert.ok(ctx.chat.at(-1) && !ctx.chat.at(-1).is_user, 'regeneration must target an assistant reply');
        ctx.chat.pop(); // native regenerate replaces ONLY the last assistant message
        if (generateError) throw generateError;
        if (!drafts.length) throw new Error('Test fixture ran out of revised drafts');
        const next = drafts.shift();
        const nextMessage = typeof next === 'string' ? { mes: next } : next;
        const speakerId = Number(ctx.characterId);
        ctx.chat.push(makeMessage(nextMessage, speakerId));
        const supplied = supplyRequested
            ? supplyRequested([...pendingForced], generated.length, ctx)
            : pendingForced;
        pendingForced = []; // SillyTavern's force-activation request is consumed by one generation
        await ctx.eventSource.emit('world_info_activated', supplied);
        // Real regeneration emits generation events, but the active cycle ignores them.
        await ctx.eventSource.emit('generation_started', 'regenerate');
        await ctx.eventSource.emit('generation_ended');
    };

    function makeMessage(value, speakerId = 0) {
        const message = typeof value === 'string' ? { mes: value } : value;
        return {
            is_user: false,
            is_system: false,
            name: ctx.characters[speakerId]?.name ?? 'Unknown',
            original_avatar: ctx.characters[speakerId]?.avatar,
            mes: '',
            ...message,
        };
    }

    const kai_settings = { seed };
    const sandbox = {
        ...core,
        console: logger,
        $, structuredClone,
        setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
        clearTimeout: id => timers.delete(id),
        SillyTavern: { getContext: () => ctx },
        checkWorldInfo,
        world_info_include_names: includeNames,
        setCharacterId: id => { ctx.characterId = id; },
        setCharacterName: name => { ctx.name2 = name; },
        kai_settings,
        document: { getElementById: id => id === 'iwi_status' ? statuses : null },
        globalThis: null,
    };
    sandbox.globalThis = sandbox;
    new vm.Script(source, { filename: 'index.js' }).runInNewContext(sandbox);

    async function flushSolo() {
        for (let i = 0; i < 20; i++) {
            const pending = [...timers];
            timers.clear();
            for (const [, callback] of pending) callback();
            await new Promise(resolve => setImmediate(resolve));
            if (timers.size === 0 && (
                /stable after|Pass limit|Error|No completed|before validation finished/.test(statuses.textContent)
            )) return;
        }
        throw new Error(`Timed out waiting for solo cycle: ${statuses.textContent}`);
    }

    return {
        ctx, ready: initPromise, logs, entries, forcedRequests, generated, scans, statuses, kai_settings, ui,
        emit: (event, ...args) => ctx.eventSource.emit(event, ...args),
        makeMessage,
        user: (text = 'Go') => ({ is_user: true, is_system: false, name: 'User', mes: text }),
        async initial(draft, initialLore = [], speakerId = 0) {
            ctx.chat.push(makeMessage(draft, speakerId));
            await ctx.eventSource.emit('world_info_activated', initialLore);
        },
        speaker(id) { ctx.characterId = id; ctx.name2 = ctx.characters[id].name; },
        async flushSolo() { await flushSolo(); },
        setChatId(value) { chatId = value; },
        setCheckbox(selector, value) {
            const element = ui.get(selector);
            assert.ok(element?.handlers.change, `missing checkbox: ${selector}`);
            element.handlers.change.call({ checked: value });
        },
        get saves() { return { settings: settingsSaves, messages: restoredMessages, chats: chatSaves }; },
    };
}

async function solo(f, { original, lore = [], startType = 'normal' } = {}) {
    f.ctx.chat.push(f.user('Enter the guild.'));
    await f.emit('generation_started', startType);
    await f.initial(original ?? 'An elf appears.', lore);
    await f.emit('generation_ended');
    await f.flushSolo();
}

test('solo: thinking and visible draft trigger iterative cumulative lore without changing random seed', async () => {
    const f = build({ drafts: ['An elf and a dwarf appear.', 'The scene continues without keywords.'] });
    await f.ready;
    await solo(f, { original: { mes: 'An elf appears.', extra: { reasoning: 'What about a pirate?' } } });
    // The first draft discovers both an elf and pirate from independent text fields.
    // The second discovers a dwarf; the third retains all entries even without their keys.
    assert.equal(f.generated.length, 2);
    assert.deepEqual(entryLabels(f.forcedRequests[0]), ['Elf', 'Pirate']);
    assert.deepEqual(entryLabels(f.forcedRequests[1]), ['Elf', 'Pirate', 'Dwarf']);
    assert.equal(f.ctx.chat.length, 2);
    assert.equal(f.ctx.chat[0].is_user, true);
    assert.match(f.statuses.textContent, /stable after 3 passes/);
    assert.equal(f.ctx.textCompletionSettings.seed, -1);
    assert.ok(f.generated.every(generation => generation.seed === -1));
    assert.ok(containsLog(f.logs.info, 'FINAL | Original 0 → Final 3 | ADDED 3 | REMOVED 0 | UNSUPPLIED 0'));
});

test('thinking-only assistant response is scanned', async () => {
    const f = build({ drafts: [{ mes: 'No species is mentioned.' }] });
    await f.ready;
    await solo(f, { original: { mes: '', extra: { reasoning: 'I might introduce an elf.' } } });
    assert.equal(f.generated.length, 1);
    assert.deepEqual(entryLabels(f.forcedRequests[0]), ['Elf']);
    assert.ok(f.scans[0].texts[0].includes('I might introduce an elf.'));
});

test('inline <think> content is scanned, but previous reasoning is stripped from history', async () => {
    const f = build({
        drafts: ['The reply continues.'],
        scan: texts => texts[0].includes('dwarf') ? [entries.dwarf] : [],
    });
    await f.ready;
    f.ctx.chat.push(f.user());
    f.ctx.chat.push(f.makeMessage('<think>Old elf planning</think>Normal conversation.'));
    await f.emit('generation_started', 'normal');
    await f.initial('<think>Perhaps a dwarf instead</think> A human enters.');
    await f.emit('generation_ended');
    await f.flushSolo();
    assert.equal(f.generated.length, 1);
    assert.match(f.scans[0].texts[0], /Perhaps a dwarf/);
    assert.ok(f.scans[0].texts.some(text => text.includes('Normal conversation.')));
    assert.ok(f.scans[0].texts.every(text => !text.includes('Old elf planning')));
});

test('Include Names controls speaker prefixes on both draft and history', async () => {
    for (const includeNames of [true, false]) {
        const f = build({ includeNames, scan: () => [] });
        await f.ready;
        f.ctx.chat.push(f.user('Hello'));
        await f.emit('generation_started', 'normal');
        await f.initial('The scene begins.');
        await f.emit('generation_ended');
        await f.flushSolo();
        assert.equal(f.scans.length, 1);
        assert.equal(f.scans[0].texts[0].startsWith('Helena: '), includeNames);
        assert.equal(f.scans[0].texts[1].startsWith('User: '), includeNames);
        assert.equal(f.scans[0].maxContext, 8000);
        assert.equal(f.scans[0].dryRun, true);
    }
});

test('original naturally activated lore remains mandatory on every pass', async () => {
    const f = build({ drafts: ['An elf arrives without pirates.'] });
    await f.ready;
    await solo(f, { original: 'An elf arrives.', lore: [entries.pirate] });
    assert.equal(f.generated.length, 1);
    assert.deepEqual(entryLabels(f.forcedRequests[0]), ['Pirate', 'Elf']);
    assert.ok(containsLog(f.logs.info, 'PASS 1 | ORIGINAL LORE (1)'));
    assert.ok(containsLog(f.logs.info, 'FINAL | Original 1 → Final 2 | ADDED 1 | REMOVED 0 | UNSUPPLIED 0'));
});

test('missing baseline lore triggers warning and cannot be treated as stable', async () => {
    const f = build({
        maxPasses: 2,
        drafts: ['An elf stays in the room.'],
        supplyRequested: requested => requested.filter(e => e !== entries.pirate),
    });
    await f.ready;
    await solo(f, { original: 'An elf arrives.', lore: [entries.pirate] });
    assert.equal(f.generated.length, 1);
    assert.match(f.statuses.textContent, /Pass limit \(2\)/);
    assert.ok(containsLog(f.logs.warn, 'PASS 2 MISSING ORIGINAL | settings / Pirate'));
    assert.ok(containsLog(f.logs.warn, 'FINAL REMOVED (ERROR) | settings / Pirate'));
    assert.ok(containsLog(f.logs.info, 'UNSTABLE | Original 1 → Final 1 | ADDED 1 | REMOVED 1'));
});

test('pass limit 1 leaves draft unchanged and logs an unsupplied entry', async () => {
    const f = build({ maxPasses: 1 });
    await f.ready;
    await solo(f, { original: 'An elf arrives.' });
    assert.equal(f.generated.length, 0);
    assert.equal(f.ctx.chat.at(-1).mes, 'An elf arrives.');
    assert.match(f.statuses.textContent, /Pass limit \(1\) reached; 1 lore entry was not included/);
    assert.ok(containsLog(f.logs.warn, 'FINAL UNSUPPLIED (ERROR) | species / Elf'));
    assert.equal(f.ctx.textCompletionSettings.seed, -1);
});

test('no missing lore completes in one pass with final baseline summary', async () => {
    const f = build();
    await f.ready;
    await solo(f, { original: 'A human sits at the table.', lore: [entries.pirate] });
    assert.equal(f.generated.length, 0);
    assert.match(f.statuses.textContent, /stable after 1 pass/);
    assert.ok(containsLog(f.logs.info, 'PASS 1 | ORIGINAL LORE (1)'));
    assert.ok(containsLog(f.logs.info, 'FINAL | Original 1 → Final 1 | ADDED 0 | REMOVED 0 | UNSUPPLIED 0'));
});

test('logging lists entry names by default, with optional full text and no original text', async () => {
    for (const logLoreText of [false, true]) {
        const f = build({ logLoreText, drafts: ['No more changes.'] });
        await f.ready;
        await solo(f, { original: 'An elf arrives.', lore: [entries.pirate] });
        assert.ok(containsLog(f.logs.info, '[IWI-LORE] Helena | PASS 1 | DISCOVERED (1)'));
        assert.ok(containsLog(f.logs.info, '[IWI-LORE] Helena | PASS 2 | NEW ADDITIONS (1)'));
        assert.ok(containsLog(f.logs.info, 'FINAL ADDED | species / Elf'));
        const elfLines = f.logs.info.filter(line => line.includes('species / Elf'));
        assert.equal(elfLines.some(line => line.includes(entries.elf.content)), logLoreText);
        const originalLines = f.logs.info.filter(line => line.includes('PASS 1 ORIGINAL'));
        assert.ok(originalLines.every(line => !line.includes(entries.pirate.content)));
        assert.ok(f.logs.info.every(line => line.startsWith('[IWI-LORE]') || line.startsWith('[Iterative World Info]')));
    }
});

test('lore text setting is independent of debug and can change through UI', async () => {
    const f = build({ debug: false, logLoreText: false, drafts: ['No changes.'] });
    await f.ready;
    assert.equal(f.ctx.extensionSettings.iterative_world_info.logLoreText, false);
    f.setCheckbox('#iwi_log_lore_text', true);
    assert.equal(f.ctx.extensionSettings.iterative_world_info.logLoreText, true);
    assert.equal(f.ctx.extensionSettings.iterative_world_info.debug, false);
    assert.ok(f.saves.settings > 0);
    await solo(f, { original: 'An elf enters.' });
    assert.ok(containsLog(f.logs.info, entries.elf.content));
    assert.deepEqual(f.logs.debug, []);
});

test('group finalizes each character independently before the next begins', async () => {
    const f = build({
        group: true,
        drafts: ['Helena finishes her elf description.', 'Mio finishes describing a dwarf.'],
        scan: texts => [
            texts[0].includes('elf') && entries.elf,
            texts[0].includes('dwarf') && entries.dwarf,
        ].filter(Boolean),
    });
    await f.ready;
    f.ctx.chat.push(f.user('Enter the guild.'));
    f.speaker(0);
    await f.emit('generation_started', 'normal');
    await f.initial('An elf approaches Helena.', [entries.pirate], 0);
    f.speaker(1); // group wrapper has already selected Mio for the NEXT message
    await f.emit('group_member_drafted', 1);
    assert.equal(f.generated.length, 1, 'Helena must stabilize BEFORE Mio starts');
    assert.equal(f.generated[0].speakerId, 0);
    assert.equal(f.ctx.chat.at(-1).name, 'Helena');
    assert.equal(f.ctx.characterId, 1, 'selected next character must be restored');
    assert.equal(f.ctx.name2, 'Mio');

    await f.emit('generation_started', 'normal');
    await f.initial('A dwarf approaches Mio.', [], 1);
    await f.emit('group_wrapper_finished');
    assert.equal(f.generated.length, 2);
    assert.equal(f.generated[1].speakerId, 1);
    assert.deepEqual(f.ctx.chat.map(m => m.name), ['User', 'Helena', 'Mio']);
    assert.deepEqual(entryLabels(f.forcedRequests[0]), ['Pirate', 'Elf']);
    assert.deepEqual(entryLabels(f.forcedRequests[1]), ['Dwarf'], 'no previous speaker forced lore should leak into Mio');
    assert.ok(containsLog(f.logs.info, '[IWI-LORE] Helena | FINAL'));
    assert.ok(containsLog(f.logs.info, '[IWI-LORE] Mio | FINAL'));
    assert.equal(f.ctx.textCompletionSettings.seed, -1);
});

test('group unrecognized speaker fails safely without deleting messages', async () => {
    const f = build({ group: true });
    await f.ready;
    f.ctx.chat.push(f.user());
    f.speaker(0);
    await f.emit('generation_started', 'normal');
    f.ctx.chat.push({ is_user: false, is_system: false, name: 'Someone else', mes: 'An elf appears.' });
    f.speaker(1);
    await f.emit('group_member_drafted', 1);
    assert.equal(f.generated.length, 0);
    assert.equal(f.ctx.chat.length, 2);
    assert.match(f.statuses.textContent, /No completed assistant reply to scan/);
});

test('llama.cpp Text Completion passes random seed through unchanged', async () => {
    const f = build({ type: 'llamacpp', seed: -1, drafts: ['An elf appears again.'] });
    await f.ready;
    await solo(f, { original: 'An elf appears.' });
    assert.equal(f.generated[0].seed, -1);
    assert.equal(f.ctx.textCompletionSettings.seed, -1);
});

test('fixed and random seeds stay unchanged across all supported backend configurations', async () => {
    for (const { mainApi, type } of [
        { mainApi: 'textgenerationwebui', type: 'koboldcpp' },
        { mainApi: 'textgenerationwebui', type: 'llamacpp' },
        { mainApi: 'kobold', type: 'koboldcpp' },
    ]) {
        for (const seed of [-1, 4711]) {
            const f = build({ mainApi, type, seed, drafts: ['An elf appears again.'] });
            await f.ready;
            await solo(f, { original: 'An elf appears.' });
            assert.equal(f.generated[0].seed, seed);
            assert.equal(f.ctx.textCompletionSettings.seed, seed);
            assert.equal(f.kai_settings.seed, seed);
        }
    }
});

test('same-seed UI is removed and old saved sameSeed preference is ignored', async () => {
    const f = build({ drafts: ['An elf appears again.'] });
    // Existing installations can retain this obsolete preference in saved settings.
    f.ctx.extensionSettings.iterative_world_info.sameSeed = true;
    await f.ready;
    assert.equal(f.ui.has('#iwi_same_seed'), false);
    await solo(f, { original: 'An elf appears.' });
    assert.equal(f.generated[0].seed, -1);
    assert.equal(f.ctx.textCompletionSettings.seed, -1);
});

test("failed regeneration restores the original assistant message and preserves the backend error", async () => {
    const f = build({ generateError: new Error("Backend unavailable") });
    await f.ready;
    await solo(f, { original: "An elf arrives." });
    assert.equal(f.ctx.chat.length, 2);
    assert.equal(f.ctx.chat[0].is_user, true);
    assert.equal(f.ctx.chat[1].mes, "An elf arrives.");
    assert.equal(f.saves.messages, 1);
    assert.equal(f.saves.chats, 1);
    assert.equal(f.statuses.textContent, "Error: Backend unavailable");
    assert.equal(f.ctx.textCompletionSettings.seed, -1);
    assert.ok(containsLog(f.logs.error, "Failed to process response"));
});

test('regeneration error status should preserve the underlying error', async () => {
    const f = build({ generateError: new Error('Backend unavailable') });
    await f.ready;
    await solo(f, { original: 'An elf arrives.' });
    assert.match(f.statuses.textContent, /Error: Backend unavailable/);
});

test('chat change cancels active cycle without modifying seed', async () => {
    const f = build();
    await f.ready;
    f.ctx.chat.push(f.user());
    await f.emit('generation_started', 'normal');
    assert.equal(f.ctx.textCompletionSettings.seed, -1);
    f.setChatId('other-chat');
    await f.emit('chat_changed');
    assert.equal(f.ctx.textCompletionSettings.seed, -1);
    assert.equal(f.statuses.textContent, 'Chat switched.');
    assert.equal(f.generated.length, 0);
});

test('disabling via UI cancels a cycle and prevents regeneration', async () => {
    const f = build();
    await f.ready;
    f.ctx.chat.push(f.user());
    await f.emit('generation_started', 'normal');
    f.setCheckbox('#iwi_enabled', false);
    assert.equal(f.ctx.textCompletionSettings.seed, -1);
    assert.equal(f.statuses.textContent, 'Disabled.');
    await f.initial('An elf appears.');
    await f.emit('generation_ended');
    assert.equal(f.generated.length, 0);
});

test('manual seed edits during a cycle are untouched on cancellation', async () => {
    const f = build();
    await f.ready;
    f.ctx.chat.push(f.user());
    await f.emit('generation_started', 'normal');
    assert.equal(f.ctx.textCompletionSettings.seed, -1);
    f.ctx.textCompletionSettings.seed = 12345;
    await f.emit('stopped');
    assert.equal(f.ctx.textCompletionSettings.seed, 12345);
    assert.equal(f.statuses.textContent, 'Generation stopped by user.');
});

test('stopping a generation cancels its scheduled scan and reroll', async () => {
    const f = build();
    await f.ready;
    f.ctx.chat.push(f.user());
    await f.emit('generation_started', 'normal');
    await f.initial('An elf appears.');
    await f.emit('generation_ended');
    await f.emit('stopped');
    assert.equal(f.ctx.textCompletionSettings.seed, -1);
    assert.equal(f.generated.length, 0);
    assert.equal(f.statuses.textContent, 'Generation stopped by user.');
});

test('UI clamps maximum generation passes between 1 and 8', async () => {
    const f = build();
    await f.ready;
    const maxPasses = f.ui.get('#iwi_max_passes');
    const edit = value => {
        const input = { value };
        maxPasses.handlers.change.call(input);
        return input.value;
    };
    assert.equal(edit('100'), '8');
    assert.equal(f.ctx.extensionSettings.iterative_world_info.maxPasses, 8);
    assert.equal(edit('0'), '3', 'zero uses the default before clamping');
    assert.equal(edit('-5'), '1');
    assert.equal(edit('4.7'), '5');
    assert.ok(f.saves.settings >= 4);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as core from '../core.mjs';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    .replace(/^import \{[\s\S]*?\} from '[^']+';\s*/gm, '')
    .replace(/^import [^\n]+;\s*/gm, '');

function build({ group = false, maxPasses = 3, drafts = [], initialMessage = 'Hello', seed = -1 } = {}) {
    const listeners = new Map();
    const ctx = {
        chat: [],
        characters: [
            { name: 'Helena', avatar: 'helena.png' },
            { name: 'Mio', avatar: 'mio.png' },
        ],
        name2: group ? '' : 'Helena',
        characterId: group ? undefined : '0',
        groupId: group ? 'g1' : undefined,
        maxContext: 8000,
        mainApi: 'textgenerationwebui',
        textCompletionSettings: { type: 'koboldcpp', seed },
        extensionSettings: { iterative_world_info: { enabled: true, maxPasses, sameSeed: true, notifications: false, debug: false } },
        getCurrentChatId: () => 'chat1',
        saveSettingsDebounced: () => {},
        saveChat: async () => {},
        deleteLastMessage: async () => { ctx.chat.pop(); },
        addOneMessage: async () => {},
        renderExtensionTemplateAsync: async () => '<div>settings</div>',
        eventSource: {
            on(name, fn) { listeners.set(name, [...(listeners.get(name) || []), fn]); },
            async emit(name, ...args) {
                for (const listener of listeners.get(name) || []) await listener(...args);
            },
        },
        eventTypes: {
            GENERATION_STARTED: 'generation_started',
            WORLD_INFO_ACTIVATED: 'world_info_activated',
            GENERATION_ENDED: 'generation_ended',
            GROUP_WRAPPER_FINISHED: 'group_wrapper_finished',
            WORLDINFO_FORCE_ACTIVATE: 'force',
            CHAT_CHANGED: 'chat_changed',
            GENERATION_STOPPED: 'stopped',
            MAIN_API_CHANGED: 'api_changed',
            PRESET_CHANGED: 'preset_changed',
        },
    };
    const statuses = { textContent: '' };
    let initPromise;
    const $ = value => {
        if (typeof value === 'function') return (initPromise = value());
        return { append: () => {}, prop: () => ({ on: () => {} }), val: () => ({ on: () => {} }), on: () => {} };
    };
    const loreElf = { world: 'species', uid: 1, comment: 'Elf' };
    const loreDwarf = { world: 'species', uid: 2, comment: 'Dwarf' };
    const forced = [];
    ctx.eventSource.on('force', entries => { forced.push(entries); });
    let generated = 0;
    let initialSeed = null;
    ctx.generate = async (_kind, options = {}) => {
        generated++;
        const currentSeed = ctx.textCompletionSettings.seed;
        if (initialSeed !== null) assert.equal(currentSeed, initialSeed, 'fixed seed must be reused');
        if (!group) ctx.chat.pop();
        const message = drafts.shift();
        const speakerId = group ? options.force_chid : 0;
        ctx.chat.push({ name: ctx.characters[speakerId].name, original_avatar: ctx.characters[speakerId].avatar, is_user: false, mes: message });
        await ctx.eventSource.emit('world_info_activated', forced.at(-1) ?? []);
        await ctx.eventSource.emit(group ? 'group_wrapper_finished' : 'generation_ended');
    };
    const sandbox = {
        ...core,
        console,
        $, setTimeout, clearTimeout,
        structuredClone,
        SillyTavern: { getContext: () => ctx },
        checkWorldInfo: async ([draft]) => ({ allActivatedEntries: new Set([
            ...(/elf/i.test(draft) ? [loreElf] : []),
            ...(/dwarf/i.test(draft) ? [loreDwarf] : []),
        ]) }),
        setCharacterId: id => { ctx.characterId = id; },
        setCharacterName: name => { ctx.name2 = name; },
        kai_settings: { seed: -1 },
        document: { getElementById: id => id === 'iwi_status' ? statuses : null },
        globalThis: {},
    };
    sandbox.globalThis = sandbox;
    const script = new vm.Script(source, { filename: 'index.js' });
    script.runInNewContext(sandbox);
    const ready = initPromise;
    return { ctx, ready, loreElf, loreDwarf, forced, statuses,
        emit: (event, ...args) => ctx.eventSource.emit(event, ...args),
        message: (text, speaker = 0) => ({ is_user: false, is_system: false, name: ctx.characters[speaker].name, original_avatar: ctx.characters[speaker].avatar, mes: text }),
        async settle() { await new Promise(resolve => setTimeout(resolve, 280)); },
        get initialSeed() { return initialSeed; },
        set initialSeed(value) { initialSeed = value; },
        get generated() { return generated; },
    };
}

test('solo: adds lore from draft, regenerates until stable, restores seed', async () => {
    const f = build({ drafts: ['Elf and dwarf enter', 'Elf and dwarf agree'] });
    await f.ready;
    await f.emit('generation_started', 'normal');
    f.initialSeed = f.ctx.textCompletionSettings.seed;
    f.ctx.chat.push({ is_user: true, mes: 'Go!' });
    f.ctx.chat.push(f.message('<think>Dwarf hidden</think> An elf enters'));
    await f.emit('generation_ended');
    await f.settle();
    assert.equal(f.generated, 2);
    assert.equal(f.ctx.chat.length, 2);
    assert.equal(f.ctx.chat[0].is_user, true);
    assert.equal(f.ctx.textCompletionSettings.seed, -1);
    assert.match(f.statuses.textContent, /Stable after 3 passes/);
    assert.equal(f.forced.at(-1).length, 2);
});

test('group: rerolls identical speakers without deleting user input', async () => {
    const f = build({ group: true, drafts: ['Elf appears to Helena', 'Mio sees an elf'] });
    await f.ready;
    await f.emit('generation_started', 'normal');
    f.initialSeed = f.ctx.textCompletionSettings.seed;
    f.ctx.chat.push({ is_user: true, mes: 'Enter the market.' });
    f.ctx.chat.push(f.message('An elf greets Helena', 0));
    f.ctx.chat.push(f.message('Mio smiles', 1));
    await f.emit('group_wrapper_finished');
    await f.settle();
    assert.equal(f.generated, 2);
    assert.equal(f.ctx.chat.length, 3);
    assert.equal(f.ctx.chat[0].is_user, true);
    assert.deepEqual(f.ctx.chat.slice(1).map(m => m.name), ['Helena', 'Mio']);
    assert.equal(f.ctx.textCompletionSettings.seed, -1);
    assert.match(f.statuses.textContent, /Stable after 2 passes/);
});

test('max pass limit warns if newly required lore has not been supplied', async () => {
    const f = build({ maxPasses: 1 });
    await f.ready;
    await f.emit('generation_started', 'normal');
    f.ctx.chat.push(f.message('Dwarf appears'));
    await f.emit('generation_ended');
    await f.settle();
    assert.equal(f.generated, 0);
    assert.match(f.statuses.textContent, /Pass limit/);
    assert.match(f.statuses.textContent, /not included/);
    assert.equal(f.ctx.textCompletionSettings.seed, -1);
});

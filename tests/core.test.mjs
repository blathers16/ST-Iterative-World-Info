import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assistantBatch,
    entryKey,
    isAssistantMessage,
    newEntries,
    resolveSpeaker,
    stripReasoning,
    uniqueEntries,
} from '../core.mjs';

test('stripReasoning removes closed/unclosed think blocks but preserves visible prose', () => {
    assert.equal(stripReasoning('<think>deliberation</think>Elf arrives.'), 'Elf arrives.');
    assert.equal(stripReasoning('Dwarf arrived. <think>unfinished thoughts'), 'Dwarf arrived.');
    assert.equal(stripReasoning('<think>just thinking</think>'), '');
    assert.equal(stripReasoning('First <think mode="x">private</think> second'), 'First  second');
    assert.equal(stripReasoning('<|im_start|>assistant<|meta_sep|>analysis Secret<|im_end|>Hello'), 'Hello');
    assert.equal(stripReasoning(null), '');
});

test('assistantBatch includes thinking-only assistant messages and excludes user/system/empty entries', () => {
    const chat = [
        { is_user: true, mes: 'hello' },
        { is_user: false, mes: '<think>hidden</think>Elf appears' },
        { is_user: false, mes: '<think>private</think>' },
        { is_system: true, mes: 'System' },
        { is_user: false, mes: '', extra: { reasoning: 'A dwarf could arrive.' } },
        { is_user: false, mes: ' ' },
        { is_user: true, mes: 'Dwarf' },
    ];
    assert.deepEqual(assistantBatch(chat, 0).map(x => x.index), [1, 2, 4]);
    assert.deepEqual(assistantBatch(chat, 2).map(x => x.index), [2, 4]);
    assert.deepEqual(assistantBatch(chat, -9).map(x => x.index), [1, 2, 4]);
    assert.deepEqual(assistantBatch(chat, 100), []);
    assert.equal(isAssistantMessage(chat[0]), false);
    assert.equal(isAssistantMessage(chat[1]), true);
    assert.equal(isAssistantMessage(chat[3]), false);
    assert.equal(isAssistantMessage({ mes: null }), false);
});

test('entry keys distinguish world and UID, and ignore missing identity', () => {
    const e1 = { world: 'characters', uid: 5 };
    const e2 = { world: 'places', uid: 5 };
    const e3 = { world: 'characters', uid: 5, comment: 'repeat' };
    assert.notEqual(entryKey(e1), entryKey(e2));
    assert.equal(entryKey(e1), entryKey(e3));
    assert.equal(entryKey({ world: 'places' }), null);
    assert.equal(entryKey({ uid: 3 }), null);
    assert.equal(entryKey(null), null);
    assert.deepEqual(uniqueEntries([e1, e2, e3]), [e3, e2]);
    assert.deepEqual(newEntries([e1, e2, e3], new Set([entryKey(e1)])), [e2]);
});

test('resolveSpeaker uses avatar to disambiguate duplicate names', () => {
    const characters = [{ name: 'Mio', avatar: 'mio1.png' }, { name: 'Mio', avatar: 'mio2.png' }];
    assert.equal(resolveSpeaker({ name: 'Mio', original_avatar: 'mio2.png' }, characters), 1);
    assert.equal(resolveSpeaker({ name: 'Mio', original_avatar: 'absent.png' }, characters), null);
    assert.equal(resolveSpeaker({ name: 'Mio' }, characters), null);
    assert.equal(resolveSpeaker({ name: 'Unknown' }, characters), null);
    assert.equal(resolveSpeaker({ name: 'Mio', original_avatar: 'mio1.png' }, characters), 0);
});

test('resolveSpeaker accepts a unique character name without an avatar', () => {
    const characters = [{ name: 'Helena' }, { name: 'Mio' }];
    assert.equal(resolveSpeaker({ name: 'Helena' }, characters), 0);
    assert.equal(resolveSpeaker({ name: 'Mio' }, characters), 1);
    assert.equal(resolveSpeaker(null, characters), null);
});

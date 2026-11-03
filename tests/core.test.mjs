import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assistantBatch, entryKey, generateSeed, newEntries, resolveSpeaker, stripReasoning, uniqueEntries,
} from '../core.mjs';

test('extracts final prose and ignores regular and unclosed Qwen thinking', () => {
    assert.equal(stripReasoning('<think>deliberation</think>Elf arrives.'), 'Elf arrives.');
    assert.equal(stripReasoning('Dwarf arrived. <think>unfinished thoughts'), 'Dwarf arrived.');
    assert.equal(stripReasoning('<think>just thinking</think>'), '');
});
test('assistant batch does not include intervening user/system or thinking-only text', () => {
    const chat = [
        { is_user: true, mes: 'hello' },
        { is_user: false, mes: '<think>hidden</think>Elf appears' },
        { is_user: false, mes: '<think>private</think>' },
        { is_system: true, mes: 'System' },
    ];
    assert.deepEqual(assistantBatch(chat, 0).map(x => x.index), [1]);
});
test('compares lorebook entries by world and ID', () => {
    const e1 = { world: 'characters', uid: 5 };
    const e2 = { world: 'places', uid: 5 };
    const e3 = { world: 'characters', uid: 5, comment: 'repeat' };
    assert.notEqual(entryKey(e1), entryKey(e2));
    assert.equal(entryKey(e1), entryKey(e3));
    assert.deepEqual(uniqueEntries([e1, e2, e3]), [e3, e2]);
    assert.deepEqual(newEntries([e1, e2], new Set([entryKey(e1)])), [e2]);
});
test('resolves duplicate character names via original avatar', () => {
    const characters = [{ name: 'Mio', avatar: 'mio1.png' }, { name: 'Mio', avatar: 'mio2.png' }];
    assert.equal(resolveSpeaker({ name: 'Mio', original_avatar: 'mio2.png' }, characters), 1);
    assert.equal(resolveSpeaker({ name: 'Mio' }, characters), null);
});
test('generated seed is an integer inside KoboldCpp safe range', () => {
    for (let i = 0; i < 30; i++) {
        const seed = generateSeed();
        assert.equal(Number.isInteger(seed), true);
        assert.ok(seed >= 0 && seed <= 2147483647);
    }
});

/** Pure helpers for Iterative World Info; kept independent for tests. */
export function entryKey(entry) {
    if (entry?.world === undefined || entry?.uid === undefined) return null;
    return `${entry.world}\u0000${String(entry.uid)}`;
}

export function stripReasoning(input) {
    if (typeof input !== 'string') return '';
    return input
        .replace(/<think(?:\s[^>]*)?>[\s\S]*?<\/think\s*>/gi, '')
        .replace(/<think(?:\s[^>]*)?>[\s\S]*$/gi, '')
        .replace(/<\|im_start\|>assistant<\|meta_sep\|>analysis[\s\S]*?<\|im_end\|>/gi, '')
        .trim();
}

export function isAssistantMessage(message) {
    return !!message && !message.is_user && !message.is_system && typeof message.mes === 'string';
}

export function assistantBatch(chat, startIndex) {
    const result = [];
    for (let index = Math.max(0, startIndex); index < chat.length; index++) {
        if (isAssistantMessage(chat[index]) && stripReasoning(chat[index].mes)) {
            result.push({ index, message: chat[index] });
        }
    }
    return result;
}

export function newEntries(entries, suppliedKeys) {
    const result = new Map();
    for (const entry of entries) {
        const key = entryKey(entry);
        if (key && !suppliedKeys.has(key)) result.set(key, entry);
    }
    return [...result.values()];
}

export function uniqueEntries(entries) {
    const map = new Map();
    for (const entry of entries) {
        const key = entryKey(entry);
        if (key) map.set(key, entry);
    }
    return [...map.values()];
}

export function resolveSpeaker(message, characters) {
    if (message?.original_avatar) {
        const index = characters.findIndex(c => c?.avatar === message.original_avatar);
        if (index !== -1) return index;
    }
    const matching = characters.map((c, index) => ({ c, index })).filter(x => x.c?.name === message?.name);
    return matching.length === 1 ? matching[0].index : null;
}

export function generateSeed() {
    const bytes = new Uint32Array(1);
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
        globalThis.crypto.getRandomValues(bytes);
        return bytes[0] & 0x7fffffff;
    }
    // crypto.getRandomValues is standard on the SillyTavern browser frontend.
    return Math.floor(Math.random() * 2147483647);
}

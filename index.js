import { checkWorldInfo } from '/scripts/world-info.js';
import { setCharacterId, setCharacterName } from '/script.js';
import { kai_settings } from '/scripts/kai-settings.js';
import {
    assistantBatch, entryKey, generateSeed, newEntries, resolveSpeaker, stripReasoning,
    uniqueEntries,
} from './core.mjs';

const MODULE = 'iterative_world_info';
const DEFAULTS = Object.freeze({
    enabled: false,
    maxPasses: 3,
    sameSeed: true,
    notifications: true,
    debug: false,
});

let current = null;
let pendingCompletion = null;
let sessionCounter = 0;
let contextProvider = () => SillyTavern.getContext();

function ctx() { return contextProvider(); }
function settings() {
    const c = ctx();
    c.extensionSettings[MODULE] ??= structuredClone(DEFAULTS);
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (!Object.hasOwn(c.extensionSettings[MODULE], key)) c.extensionSettings[MODULE][key] = value;
    }
    return c.extensionSettings[MODULE];
}
function log(...args) {
    if (settings().debug) console.debug('[Iterative World Info]', ...args);
}
function uiStatus(message, notify = false, warning = false) {
    const node = document.getElementById('iwi_status');
    if (node) node.textContent = message;
    if (notify && settings().notifications && globalThis.toastr) {
        const method = warning ? 'warning' : 'info';
        globalThis.toastr[method](message, 'Iterative World Info', { timeOut: warning ? 12000 : 4000 });
    }
    log(message);
}
function sessionMatches(cycle) {
    const c = ctx();
    return !!cycle && current === cycle && !cycle.cancelled
        && c.getCurrentChatId() === cycle.chatId && String(c.groupId ?? '') === cycle.groupId;
}

function seedTarget(c) {
    if (c.mainApi === 'kobold') return kai_settings;
    if (c.mainApi === 'textgenerationwebui' && c.textCompletionSettings?.type === 'koboldcpp') {
        return c.textCompletionSettings;
    }
    return null;
}
function prepareSeed(cycle) {
    if (!settings().sameSeed) return;
    const target = seedTarget(ctx());
    if (!target) {
        log('Same-seed option unavailable on this API. Regeneration will still proceed.');
        return;
    }
    const original = target.seed;
    const originalNumber = Number(original);
    const seed = Number.isInteger(originalNumber) && originalNumber >= 0 ? originalNumber : generateSeed();
    cycle.seedState = { target, original, seed };
    target.seed = seed;
    log('Using fixed seed', seed, originalNumber >= 0 ? '(original)' : '(temporary)');
}
function restoreSeed(cycle) {
    const record = cycle?.seedState;
    if (!record) return;
    // Don't undo a seed manually changed during a generation.
    if (record.target.seed === record.seed) record.target.seed = record.original;
    cycle.seedState = null;
}
function finish(cycle, message, notify = false, warning = false) {
    if (current !== cycle) return;
    restoreSeed(cycle);
    current = null;
    if (pendingCompletion) {
        clearTimeout(pendingCompletion);
        pendingCompletion = null;
    }
    uiStatus(message, notify, warning);
}
function cancel(reason) {
    if (!current) return;
    current.cancelled = true;
    restoreSeed(current);
    current = null;
    if (pendingCompletion) {
        clearTimeout(pendingCompletion);
        pendingCompletion = null;
    }
    uiStatus(reason);
}

function onGenerationStarted(type, _options, dryRun) {
    if (dryRun || !settings().enabled) return;
    // Internal, nested generations are handled synchronously by the active cycle.
    if (current) return;
    if (!['normal', 'regenerate', 'swipe', undefined, null].includes(type)) return;
    const c = ctx();
    const replaceLast = type === 'regenerate' || type === 'swipe';
    const cycle = {
        id: ++sessionCounter,
        chatId: c.getCurrentChatId(),
        groupId: String(c.groupId ?? ''),
        firstIndex: Math.max(0, c.chat.length - (replaceLast && !c.groupId ? 1 : 0)),
        currentPass: 1,
        suppliedThisPass: new Map(),
        desired: new Map(),
        running: false,
        cancelled: false,
        seedState: null,
    };
    current = cycle;
    prepareSeed(cycle);
    uiStatus('Pass 1: generating initial draft…');
}

function onWorldInfoActivated(entries) {
    const cycle = current;
    if (!cycle || cycle.cancelled || !Array.isArray(entries)) return;
    for (const entry of entries) {
        const key = entryKey(entry);
        if (key) {
            cycle.suppliedThisPass.set(key, entry);
            cycle.desired.set(key, entry);
        }
    }
}

function scheduleCompletion(cycle) {
    if (!sessionMatches(cycle) || cycle.running || pendingCompletion) return;
    pendingCompletion = setTimeout(() => {
        pendingCompletion = null;
        if (!sessionMatches(cycle) || cycle.running) return;
        cycle.running = true;
        void processCompletion(cycle).catch(error => {
            console.error('[Iterative World Info] Failed to process response', error);
            finish(cycle, `Error: ${error?.message ?? error}`, true, true);
        });
    }, 150);
}

function onGenerationEnded() {
    const cycle = current;
    if (!cycle || cycle.running) return;
    // Group wrappers emit completion for individual members; wait for the whole batch.
    if (cycle.groupId) return;
    scheduleCompletion(cycle);
}
function onGroupWrapperFinished() {
    const cycle = current;
    if (!cycle || cycle.running || !cycle.groupId) return;
    scheduleCompletion(cycle);
}

function collectMessages(cycle) {
    const c = ctx();
    return assistantBatch(c.chat, cycle.firstIndex);
}

/**
 * Scan a completed draft using SillyTavern's own WI scanner. The scanner operates
 * in dry-run mode, so it does not emit WORLD_INFO_ACTIVATED or commit timed WI effects.
 * Group speakers are temporarily selected because their individual lorebooks are
 * only available while their character is selected.
 */
async function scanDrafts(cycle, messages) {
    const c = ctx();
    const originalCharacterId = c.characterId;
    const originalCharacterName = c.name2;
    const discoveries = [];
    try {
        for (const { index, message } of messages) {
            if (!sessionMatches(cycle)) return discoveries;
            const speakerId = cycle.groupId ? resolveSpeaker(message, c.characters) : c.characterId;
            if (cycle.groupId && speakerId === null) {
                throw new Error(`Cannot identify the group speaker for draft at message ${index + 1}`);
            }
            if (cycle.groupId) {
                setCharacterId(speakerId);
                setCharacterName(c.characters[speakerId].name);
            }
            const history = c.chat.slice(0, index)
                .filter(item => !item.is_system && typeof item.mes === 'string')
                .map(item => stripReasoning(item.mes))
                .filter(Boolean)
                .reverse();
            const draft = stripReasoning(message.mes);
            if (!draft) continue;
            const result = await checkWorldInfo([draft, ...history], c.maxContext, true);
            for (const entry of result.allActivatedEntries ?? []) discoveries.push(entry);
        }
    } finally {
        if (cycle.groupId) {
            setCharacterId(originalCharacterId);
            setCharacterName(originalCharacterName);
        }
    }
    return uniqueEntries(discoveries);
}

/** Strip only the current response batch, retaining the user's message. */
async function deleteBatch(cycle) {
    const c = ctx();
    const currentMessages = collectMessages(cycle);
    // A group send may append its user message AFTER GENERATION_STARTED. Do not
    // mistake that user message for part of the assistant batch.
    const firstAssistantIndex = currentMessages[0]?.index;
    const continuousTail = firstAssistantIndex !== undefined
        && firstAssistantIndex >= cycle.firstIndex
        && firstAssistantIndex + currentMessages.length === c.chat.length
        && currentMessages.every(({ index }, i) => index === firstAssistantIndex + i);
    if (!continuousTail) {
        throw new Error('Chat changed while validating; refusing to delete unrelated messages');
    }
    for (let i = 0; i < currentMessages.length; i++) {
        if (!sessionMatches(cycle)) throw new Error('Chat switched during regeneration');
        await ctx().deleteLastMessage();
    }
}

async function forceLore(cycle) {
    if (cycle.desired.size) {
        // Must be done before EACH actual generation: the WI scanner consumes the force map.
        await ctx().eventSource.emit(ctx().eventTypes.WORLDINFO_FORCE_ACTIVATE, [...cycle.desired.values()]);
    }
}

async function replaceDrafts(cycle, messages) {
    const c = ctx();
    if (!cycle.groupId) {
        // Native regenerate deletes/replaces the last reply and handles both UI and persistence.
        if (messages.length !== 1 || messages[0].index !== c.chat.length - 1) {
            throw new Error('Cannot safely regenerate: expected one final assistant message');
        }
        cycle.suppliedThisPass.clear();
        await forceLore(cycle);
        await c.generate('regenerate');
        return;
    }

    // In a group, replay EXACTLY the speakers who responded, in the same order.
    const speakers = messages.map(({ message }) => resolveSpeaker(message, c.characters));
    if (speakers.some(speaker => speaker === null)) {
        throw new Error('Group member lookup failed; leaving the original batch intact');
    }
    const backup = messages.map(({ message }) => structuredClone(message));
    const groupBaseIndex = messages[0].index; // First assistant message, not the preceding user message.
    let deleted = false;
    try {
        await deleteBatch(cycle);
        deleted = true;
        cycle.suppliedThisPass.clear();
        for (const speaker of speakers) {
            if (!sessionMatches(cycle)) throw new Error('Chat switched during group replay');
            await forceLore(cycle);
            // In group mode this invokes a one-member wrapper, which generates a
            // fresh message without removing the preceding group member's message.
            await ctx().generate('regenerate', { force_chid: speaker });
            if (!collectMessages(cycle).length) {
                throw new Error('Group replay did not produce a response');
            }
        }
    } catch (error) {
        if (deleted && sessionMatches(cycle)) {
            try {
                // Best-effort rollback of the group batch. No user messages are touched.
                while (ctx().chat.length > groupBaseIndex) {
                    await ctx().deleteLastMessage();
                }
                for (const message of backup) {
                    ctx().chat.push(message);
                    await ctx().addOneMessage(message, { forceId: ctx().chat.length - 1 });
                }
                await ctx().saveChat();
            } catch (rollbackError) {
                console.error('[Iterative World Info] Could not restore original group drafts', rollbackError);
            }
        }
        throw error;
    }
}

async function processCompletion(cycle) {
    try {
        while (sessionMatches(cycle)) {
            const messages = collectMessages(cycle);
            if (!messages.length) {
                finish(cycle, 'No completed assistant reply to scan.');
                return;
            }
            uiStatus(`Pass ${cycle.currentPass}: scanning ${messages.length} response(s)…`);
            const activatedByDraft = await scanDrafts(cycle, messages);
            if (!sessionMatches(cycle)) return;
            const missing = newEntries(activatedByDraft, new Set(cycle.suppliedThisPass.keys()));
            for (const entry of missing) {
                const key = entryKey(entry);
                if (key) cycle.desired.set(key, entry);
            }
            if (!missing.length) {
                finish(cycle, `Stable after ${cycle.currentPass} pass${cycle.currentPass === 1 ? '' : 'es'}; ${cycle.desired.size} lore entries used.`, cycle.currentPass > 1);
                return;
            }
            log('Newly required lore', missing.map(e => `${e.world} / ${e.comment || e.uid}`));
            if (cycle.currentPass >= settings().maxPasses) {
                finish(cycle,
                    `Pass limit (${cycle.currentPass}) reached; ${missing.length} lore entr${missing.length === 1 ? 'y was' : 'ies were'} not included in the final generation.`,
                    true, true);
                return;
            }
            cycle.currentPass++;
            uiStatus(`Pass ${cycle.currentPass}: regenerating with ${missing.length} newly activated entr${missing.length === 1 ? 'y' : 'ies'}…`);
            await replaceDrafts(cycle, messages);
        }
    } finally {
        // The initial event handler owns the cycle; all revisions are completed here.
        if (current === cycle && !cycle.cancelled && cycle.running) {
            // Unexpected early exit: never leave a temporary seed enabled.
            finish(cycle, 'Generation cycle ended before validation finished.', true, true);
        }
    }
}

async function init() {
    const c = ctx();
    settings();
    const html = await c.renderExtensionTemplateAsync('third-party/ST-Iterative-World-Info', 'settings');
    $('#extensions_settings2').append(html);
    const s = settings();
    $('#iwi_enabled').prop('checked', s.enabled).on('change', function () {
        s.enabled = this.checked;
        c.saveSettingsDebounced();
        if (!s.enabled) cancel('Disabled.');
        else uiStatus('Enabled. Waiting for a response.');
    });
    $('#iwi_max_passes').val(s.maxPasses).on('change', function () {
        const number = Math.min(8, Math.max(1, Math.round(Number(this.value) || 3)));
        s.maxPasses = number;
        this.value = String(number);
        c.saveSettingsDebounced();
    });
    for (const [name, key] of [
        ['#iwi_same_seed', 'sameSeed'],
        ['#iwi_notifications', 'notifications'],
        ['#iwi_debug', 'debug'],
    ]) {
        $(name).prop('checked', s[key]).on('change', function () {
            s[key] = this.checked;
            c.saveSettingsDebounced();
        });
    }

    c.eventSource.on(c.eventTypes.GENERATION_STARTED, onGenerationStarted);
    c.eventSource.on(c.eventTypes.WORLD_INFO_ACTIVATED, onWorldInfoActivated);
    c.eventSource.on(c.eventTypes.GENERATION_ENDED, onGenerationEnded);
    c.eventSource.on(c.eventTypes.GROUP_WRAPPER_FINISHED, onGroupWrapperFinished);
    c.eventSource.on(c.eventTypes.GENERATION_STOPPED, () => cancel('Generation stopped by user.'));
    c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => cancel('Chat switched.'));
    c.eventSource.on(c.eventTypes.MAIN_API_CHANGED, () => cancel('API changed.'));
    c.eventSource.on(c.eventTypes.PRESET_CHANGED, () => cancel('Preset changed.'));
    uiStatus(s.enabled ? 'Enabled. Waiting for a response.' : 'Disabled.');
    console.info('[Iterative World Info] v0.1.0 loaded');
}

$(init);

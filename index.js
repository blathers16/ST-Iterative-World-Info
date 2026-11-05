import { checkWorldInfo, world_info_include_names } from '/scripts/world-info.js';
import { setCharacterId, setCharacterName } from '/script.js';
import {
    assistantBatch, entryKey, newEntries, resolveSpeaker, stripReasoning,
    uniqueEntries,
} from './core.mjs';

const MODULE = 'iterative_world_info';
const DEFAULTS = Object.freeze({
    enabled: false,
    maxPasses: 3,
    notifications: true,
    debug: false,
    logLoreText: false,
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

// Logs are independent of the Debug setting and are intentionally NOT collapsed.
const LORE_PREFIX = '[IWI-LORE]';

function logLoreContent(cycle, label, entry, warning = false) {
    const world = entry.world ?? 'Unknown World';
    const name = entry.comment || `UID ${entry.uid ?? 'unknown'}`;
    const heading = `${LORE_PREFIX} ${cycle.speakerName} | ${label} | ${world} / ${name}`;
    const line = settings().logLoreText && label !== "PASS 1 ORIGINAL"
        ? `${heading}\n\n${entry.content ?? ''}`
        : heading;
    if (warning) console.warn(line);
    else console.info(line);
}

/**
 * Record actual changes to the lore supplied to this ONE character's prompt.
 * Pass 1 is the baseline, not an extension addition. Report each addition once.
 */
function logPassLoreDelta(cycle) {
    if (cycle.loggedPasses.has(cycle.currentPass)) return;
    cycle.loggedPasses.add(cycle.currentPass);

    if (cycle.currentPass === 1) {
        console.info(
            `${LORE_PREFIX} ${cycle.speakerName} | PASS 1 | ORIGINAL LORE (${cycle.initialLore.size})`,
        );
        for (const entry of cycle.initialLore.values()) {
            logLoreContent(cycle, "PASS 1 ORIGINAL", entry);
        }
        return;
    }

    const added = [];
    for (const [key, entry] of cycle.suppliedThisPass) {
        if (cycle.initialLore.has(key) || cycle.reportedAdditions.has(key)) continue;
        cycle.reportedAdditions.add(key);
        added.push(entry);
    }

    if (added.length) {
        console.info(`${LORE_PREFIX} ${cycle.speakerName} | PASS ${cycle.currentPass} | NEW ADDITIONS (${added.length})`);
        for (const entry of added) logLoreContent(cycle, `PASS ${cycle.currentPass} ADDED`, entry);
    }

    // This is not expected: retries should retain the original generation's lore.
    const droppedBaseline = [...cycle.initialLore]
        .filter(([key]) => !cycle.suppliedThisPass.has(key))
        .map(([, entry]) => entry);
    for (const entry of droppedBaseline) {
        logLoreContent(cycle, `PASS ${cycle.currentPass} MISSING ORIGINAL`, entry, true);
    }
}

/** Compare the final prompt's activated entries against the original prompt. */
function logFinalLoreDelta(cycle, stable) {
    const original = cycle.initialLore;
    const final = cycle.suppliedThisPass;
    const added = [...final].filter(([key]) => !original.has(key)).map(([, entry]) => entry);
    const removed = [...original].filter(([key]) => !final.has(key)).map(([, entry]) => entry);
    const missing = [...cycle.desired]
        .filter(([key]) => !final.has(key) && !original.has(key))
        .map(([, entry]) => entry);

    console.info(`${LORE_PREFIX} ${cycle.speakerName} | ${stable ? 'FINAL' : 'UNSTABLE'} | Original ${original.size} → Final ${final.size} | ADDED ${added.length} | REMOVED ${removed.length} | UNSUPPLIED ${missing.length}`);
    for (const entry of added) logLoreContent(cycle, 'FINAL ADDED', entry);
    for (const entry of removed) logLoreContent(cycle, 'FINAL REMOVED (ERROR)', entry, true);
    for (const entry of missing) logLoreContent(cycle, 'FINAL UNSUPPLIED (ERROR)', entry, true);
}

function finish(cycle, message, notify = false, warning = false, report = false) {
    if (current !== cycle) return;
    if (report) logFinalLoreDelta(cycle, !warning);
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
    current = null;
    if (pendingCompletion) {
        clearTimeout(pendingCompletion);
        pendingCompletion = null;
    }
    uiStatus(reason);
}

function onGenerationStarted(type, _options, dryRun) {
    if (dryRun || !settings().enabled || current) return;
    if (!['normal', 'regenerate', 'swipe', undefined, null].includes(type)) return;
    const c = ctx();
    const replaceLast = type === 'regenerate' || type === 'swipe';
    const cycle = {
        id: ++sessionCounter,
        chatId: c.getCurrentChatId(),
        groupId: String(c.groupId ?? ''),
        speakerId: c.groupId ? Number(c.characterId) : null,
        speakerName: c.name2 || c.characters[c.characterId]?.name || 'Character',
        firstIndex: Math.max(0, c.chat.length - (replaceLast ? 1 : 0)),
        currentPass: 1,
        suppliedThisPass: new Map(),
        initialLore: new Map(),
        desired: new Map(),
        reportedAdditions: new Set(),
        loggedPasses: new Set(),
        running: false,
        cancelled: false,
    };
    if (c.groupId && !Number.isInteger(cycle.speakerId)) return;
    current = cycle;
    uiStatus(`${cycle.speakerName}: pass 1, generating initial draft…`);
}

function onWorldInfoActivated(entries) {
    const cycle = current;
    if (!cycle || cycle.cancelled || !Array.isArray(entries)) return;
    for (const entry of entries) {
        const key = entryKey(entry);
        if (key) {
            cycle.suppliedThisPass.set(key, entry);
            cycle.desired.set(key, entry);
            if (cycle.currentPass === 1) cycle.initialLore.set(key, entry);
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
    if (!cycle || cycle.running || cycle.groupId) return;
    scheduleCompletion(cycle);
}

/**
 * The group wrapper AWAITS GROUP_MEMBER_DRAFTED before generating the next
 * speaker. Finalize the previous member here, while it is still the chat tail.
 */
async function onGroupMemberDrafted(_nextSpeakerId) {
    const cycle = current;
    if (cycle?.groupId && !cycle.running) await finalizeGroupMember(cycle);
}

/** Final member: this event is awaited after the wrapper ends. */
async function onGroupWrapperFinished() {
    const cycle = current;
    if (cycle?.groupId && !cycle.running) await finalizeGroupMember(cycle);
}

async function finalizeGroupMember(cycle) {
    if (!sessionMatches(cycle) || cycle.running) return;
    const c = ctx();
    const restoreId = c.characterId;
    const restoreName = c.name2;
    cycle.running = true;
    try {
        // GROUP_MEMBER_DRAFTED has already selected the NEXT speaker; scanning
        // and regenerating must temporarily use the PREVIOUS speaker instead.
        setCharacterId(cycle.speakerId);
        setCharacterName(cycle.speakerName);
        await processCompletion(cycle);
    } catch (error) {
        console.error('[Iterative World Info] Failed to finalize group member', error);
        finish(cycle, `Error in ${cycle.speakerName}: ${error?.message ?? error}`, true, true);
    } finally {
        setCharacterId(restoreId);
        setCharacterName(restoreName);
    }
}

/** Only inspect the one completed response at the end of the chat. */
function collectMessages(cycle) {
    const c = ctx();
    const messages = assistantBatch(c.chat, cycle.firstIndex);
    const last = messages.at(-1);
    if (!last || last.index !== c.chat.length - 1) return [];
    if (cycle.groupId && resolveSpeaker(last.message, c.characters) !== cycle.speakerId) return [];
    return [last];
}

/** Scan this message's thinking and visible text, plus prior visible history. */
async function scanDrafts(cycle, messages) {
    const c = ctx();
    const discoveries = [];
    const format = (message, text) =>
        world_info_include_names && message.name ? `${message.name}: ${text}` : text;
    for (const { index, message } of messages) {
        if (!sessionMatches(cycle)) return discoveries;
        const history = c.chat.slice(0, index)
            .filter(item => !item.is_system && typeof item.mes === 'string')
            .map(item => ({ message: item, text: stripReasoning(item.mes) }))
            .filter(({ text }) => Boolean(text))
            .map(({ message, text }) => format(message, text))
            .reverse();
        const draftText = [message.extra?.reasoning, message.mes]
            .filter(text => typeof text === 'string' && text.trim())
            .join('\n\n');
        if (!draftText) continue;
        const result = await checkWorldInfo([format(message, draftText), ...history], c.maxContext, true);
        for (const entry of result.allActivatedEntries ?? []) discoveries.push(entry);
    }
    return uniqueEntries(discoveries);
}

async function forceLore(cycle) {
    if (cycle.desired.size) {
        // Must be done before EACH actual generation: the WI scanner consumes the force map.
        await ctx().eventSource.emit(ctx().eventTypes.WORLDINFO_FORCE_ACTIVATE, [...cycle.desired.values()]);
    }
}

async function replaceDrafts(cycle, messages) {
    const c = ctx();
    // Both solo and group mode regenerate ONE last assistant message.
    if (messages.length !== 1 || messages[0].index !== c.chat.length - 1) {
        throw new Error('Cannot safely regenerate: expected one final assistant message');
    }
    const index = messages[0].index;
    const backup = structuredClone(messages[0].message);
    cycle.suppliedThisPass.clear();
    await forceLore(cycle);
    try {
        await c.generate('regenerate');
        if (!sessionMatches(cycle) || !collectMessages(cycle).length) {
            throw new Error('Regeneration failed or the chat changed');
        }
    } catch (error) {
        // SillyTavern removes the previous message before regenerating. If the
        // request fails without replacing it, restore ONLY that message.
        if (sessionMatches(cycle) && c.chat.length === index) {
            c.chat.push(backup);
            await c.addOneMessage(backup, { forceId: index });
            await c.saveChat();
        }
        throw error;
    }
}

async function processCompletion(cycle) {
    try {
        while (sessionMatches(cycle)) {
            const messages = collectMessages(cycle);
            if (!messages.length) {
                finish(cycle, "No completed assistant reply to scan.");
                return;
            }
            // Log what was actually supplied for this generation before scanning
            // the draft to discover lore needed for a future pass.
            logPassLoreDelta(cycle);
            uiStatus(
                `Pass ${cycle.currentPass}: scanning ${messages.length} response(s)…`,
            );
            const activatedByDraft = await scanDrafts(cycle, messages);
            if (!sessionMatches(cycle)) return;
            // Every original and previously discovered entry remains mandatory.
            const required = uniqueEntries([
                ...cycle.desired.values(),
                ...activatedByDraft,
            ]);
            const missing = newEntries(
                required,
                new Set(cycle.suppliedThisPass.keys()),
            );
            const discovered = missing.filter((entry) => {
                const key = entryKey(entry);
                return key && !cycle.desired.has(key);
            });
            if (discovered.length) {
                console.info(
                    `${LORE_PREFIX} ${cycle.speakerName} | PASS ${cycle.currentPass} | DISCOVERED (${discovered.length})`,
                );
                for (const entry of discovered) {
                    logLoreContent(
                        cycle,
                        `PASS ${cycle.currentPass} DISCOVERED`,
                        entry,
                    );
                }
            }
            for (const entry of missing) {
                const key = entryKey(entry);
                if (key) cycle.desired.set(key, entry);
            }
            if (!missing.length) {
                finish(
                    cycle,
                    `${cycle.speakerName}: stable after ${cycle.currentPass} pass${cycle.currentPass === 1 ? "" : "es"}; ${cycle.desired.size} lore entries used.`,
                    cycle.currentPass > 1,
                    false,
                    true,
                );
                return;
            }
            log(
                "Newly required lore",
                missing.map((e) => `${e.world} / ${e.comment || e.uid}`),
            );
            if (cycle.currentPass >= settings().maxPasses) {
                finish(
                    cycle,
                    `Pass limit (${cycle.currentPass}) reached; ${missing.length} lore entr${missing.length === 1 ? "y was" : "ies were"} not included in the final generation.`,
                    true,
                    true,
                    true,
                );
                return;
            }
            cycle.currentPass++;
            uiStatus(
                `Pass ${cycle.currentPass}: regenerating with ${missing.length} newly activated entr${missing.length === 1 ? "y" : "ies"}…`,
            );
            await replaceDrafts(cycle, messages);
        }
    } catch (error) {
        // Preserve the actual error before the fallback runs.
        finish(cycle, `Error: ${error?.message ?? error}`, true, true);
        throw error;
    } finally {
        // The initial event handler owns the cycle; all revisions are completed here.
        if (current === cycle && !cycle.cancelled && cycle.running) {
            // Unexpected early exit: report incomplete validation.
            finish(
                cycle,
                "Generation cycle ended before validation finished.",
                true,
                true,
            );
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
        ['#iwi_notifications', 'notifications'],
        ['#iwi_log_lore_text', 'logLoreText'],
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
    c.eventSource.on(c.eventTypes.GROUP_MEMBER_DRAFTED, onGroupMemberDrafted);
    c.eventSource.on(c.eventTypes.GROUP_WRAPPER_FINISHED, onGroupWrapperFinished);
    c.eventSource.on(c.eventTypes.GENERATION_STOPPED, () => cancel('Generation stopped by user.'));
    c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => cancel('Chat switched.'));
    c.eventSource.on(c.eventTypes.MAIN_API_CHANGED, () => cancel('API changed.'));
    c.eventSource.on(c.eventTypes.PRESET_CHANGED, () => cancel('Preset changed.'));
    uiStatus(s.enabled ? 'Enabled. Waiting for a response.' : 'Disabled.');
    console.info('[Iterative World Info] v0.1.0 loaded');
}

$(init);

# Iterative World Info (SillyTavern extension)

**Experimental v0.1.0 — front-end only.** Iterative World Info checks what additional World Info a generated reply (including its reasoning) would have activated. If the reply requires lore that was not supplied for that generation, the extension requests the missing entries and regenerates. It repeats until the response has all accumulated required lore or the configured pass limit is reached.

Unlike SillyTavern's built-in **recursive scanning**, which can find keywords inside activated World Info entries, this extension scans a **newly generated draft**. In group chats, **each character's reply is handled independently**: the extension finishes that character's retries before the next member generates.

## Installation (GitHub — recommended)

**Repository:** https://github.com/blathers16/ST-Iterative-World-Info

1. Make sure **Git** is installed on the computer running SillyTavern. SillyTavern uses Git to install extensions from repositories.
2. In SillyTavern, open **Extensions → Install Extension**.
3. Paste this repository URL into the Git URL field:

   ```text
   https://github.com/blathers16/ST-Iterative-World-Info
   ```

4. Install from the default branch (`main`). If you use multiple SillyTavern users, select the appropriate installation target (usually **Current User**).
5. Once installation finishes, reload SillyTavern if the extension does not appear automatically.
6. Open **Extensions** settings and expand **Iterative World Info**. Turn on **Enable automatic lore-aware regeneration** (off by default). Start with **Maximum generation passes = 3**.

### Updating a GitHub installation

In SillyTavern, open **Extensions → Manage Extensions**, find **Iterative World Info**, and use its **Update** action when a new version is available. Reload SillyTavern if prompted. Updates are pulled from the installed Git repository.

### Switching from an older manual ZIP installation

If you previously copied the extension into `data/<user-handle>/extensions/ST-Iterative-World-Info/` by hand, back up any local changes first. That directory usually has no Git metadata, so **do not assume the Install Extension tool can convert it into a Git-managed installation in place**. Move or remove the old extension folder before installing from the repository to avoid a destination-folder conflict. Do not keep two copies of the same extension active.

### Manual installation (alternative)

If you cannot use Git-based installation, download the repository's source ZIP from GitHub (**Code → Download ZIP**) and extract it. Place the folder containing `manifest.json` at:

```text
SillyTavern/data/<user-handle>/extensions/ST-Iterative-World-Info/
```

For a typical single-user installation, `<user-handle>` is `default-user`. Make sure `manifest.json` and `index.js` are directly inside the extension folder rather than inside another nested directory. Reload SillyTavern and enable the extension as described above. **Manual ZIP installations are not automatically updated through Git**; replace their files manually when updating.

## Example

- **Pass 1:** Helena's initial reply (or thinking) considers an elf. Elf lore was not present in her original prompt, so the extension discovers it.
- **Pass 2:** Helena regenerates with that lore. Her revised reply introduces a dwarf, so the extension discovers dwarf lore as well.
- **Pass 3:** Helena regenerates with **both** entries retained. No additional required lore is missing, so her reply is accepted.
- **Next group member:** Only after Helena's response is finalized does Mio begin her own, separate cycle, with her own original lore baseline, discoveries, and pass count. Helena's finalized reply stays in the conversation.

Revisions may change the story in response to added lore. Earlier draft text is **not** copied into a special instruction for the next pass. The extension does not override sampler seeds. With a random seed, each pass can vary; a manually fixed seed remains fixed, but prompt changes can still change the outcome.

## How it works

1. On `GENERATION_STARTED`, create a cycle for one assistant response (including normal, regenerate, and swipe generations). Record its chat, character, starting boundary, and pass number.
2. During prompt construction, record `WORLD_INFO_ACTIVATED` entries as the lore actually **reported as activated** for that pass. Entries reported on pass 1 establish the original-lore baseline and are kept in the cumulative required set.
3. After a solo response, process it on `GENERATION_ENDED`. In group chats, use the awaited `GROUP_MEMBER_DRAFTED` and `GROUP_WRAPPER_FINISHED` events to finish the current character's cycle before the next character proceeds.
4. Scan the just-generated message's **visible response and reasoning**. The scan includes reasoning stored in `message.extra.reasoning` and any thinking still embedded in `message.mes` (such as `<think>...</think>`). Previous chat messages contribute visible text only; their embedded thinking is stripped. When World Info's **Include Names** option is enabled, speaker names are prefixed to scanned text.
5. Pass the draft followed by preceding chat text to SillyTavern's native `checkWorldInfo` scanner. This reuses normal World Info activation logic and its scan-depth handling, though it is not an exact reproduction of every possible prompt input.
6. Compare what the scanner requires, **plus all lore accumulated from earlier passes**, with what `WORLD_INFO_ACTIVATED` reported for the current generation. If anything is missing, accumulate it and request the complete required set using `WORLDINFO_FORCE_ACTIVATE` before regenerating the **same last assistant message**.
7. Continue until there are no missing entries or the pass limit is reached. On success, leave the final reply; on pass-limit failure, leave the last reply and report an unstable result.

**Group behavior:** A group turn is **not** rerolled as a whole. Each speaker has an independent cycle. The preceding speaker's accepted response remains available in the chat when the next speaker starts.

## Settings

| Setting | Default | Behavior |
|---|---|---|
| **Enable automatic lore-aware regeneration** | Off | Enables generation interception and iterative scanning. Turning it off cancels an active extension cycle. |
| **Maximum generation passes** | 3 | Range **1–8**. Includes the original generation; 3 allows up to 2 revisions **per character response**. |
| **Show status notifications** | On | Shows toasts on multi-pass completion or warnings; status text in the settings panel updates independently. |
| **Log complete lorebook entry text** | Off | By default, `[IWI-LORE]` logs entry names. When enabled, it also prints raw entry content for discoveries and changes, **but not pass-1 original-lore entries**. |
| **Detailed logs in browser console** | Off | Enables additional `[Iterative World Info]` diagnostic messages via `console.debug()`. Lore-change logs do **not** depend on this setting. |

**Sampler seeds:** This extension does not change the seed or seed-related settings for any backend, including llama.cpp and KoboldCpp. SillyTavern and the connected backend determine the seed used for each generation. An old `sameSeed` preference saved by a previous version is ignored; the checkbox has been removed.

## Console logging

Open the browser developer console (often **F12**) and filter for **`[IWI-LORE]`**. These messages appear whether Detailed Logging is on or off:

```text
[IWI-LORE] Helena | PASS 1 | ORIGINAL LORE (2)
[IWI-LORE] Helena | PASS 1 ORIGINAL | World / Guild Rules
[IWI-LORE] Helena | PASS 1 ORIGINAL | World / Helena's Ship
[IWI-LORE] Helena | PASS 1 | DISCOVERED (1)
[IWI-LORE] Helena | PASS 1 DISCOVERED | World / Elves
[IWI-LORE] Helena | PASS 2 | NEW ADDITIONS (1)
[IWI-LORE] Helena | PASS 2 ADDED | World / Elves
[IWI-LORE] Helena | FINAL | Original 2 → Final 3 | ADDED 1 | REMOVED 0 | UNSUPPLIED 0
[IWI-LORE] Helena | FINAL ADDED | World / Elves
```

- **PASS 1 ORIGINAL** is the baseline supplied without the extension's added lore. It is **not** counted as an addition. Its entry names are logged even if no regeneration is needed.
- **DISCOVERED** means the draft scan identified missing lore; it does **not** mean the entry has reached the model yet.
- **PASS n ADDED** reports newly activated entries relative to pass 1, once, on the first retry where they are reported as supplied.
- **FINAL** compares the final pass with pass 1 and may repeat the names of entries already shown under per-pass additions. A completed one-pass cycle also produces a final summary.
- **MISSING ORIGINAL**, **FINAL REMOVED (ERROR)**, and **FINAL UNSUPPLIED (ERROR)** are warnings about entries not reported as activated when required. A pass-limit failure is labeled **UNSTABLE**.

The optional full-text setting prints the **raw World Info entry content**, not the fully macro-expanded, formatted prompt segment. `WORLD_INFO_ACTIVATED` confirms activation reported by SillyTavern; it does not independently verify the final bytes sent to the backend.

## Scope and limitations

- **Experimental.** Runtime behavior depends on SillyTavern's generation and World Info event contracts. All **27 included automated tests pass** in a mocked frontend environment, but live SillyTavern/KoboldCpp/llama.cpp integration has not been verified by those tests; see **Development and tests** below.
- **Lore availability is not lore compliance.** A stable result means the scan found no additional entries missing from the set reported as activated for the latest generation. It does not guarantee that the model follows those entries.
- **Cumulative within a cycle, not between characters.** Originally activated lore and all newly discovered lore are requested again for that same character's retries. The next group character starts a fresh cycle and independently scans the finalized chat context.
- **Activation restrictions still matter.** Force requests do not guarantee inclusion if SillyTavern excludes an entry because of budget, filters, groups, probability, or other activation conditions. Repeatedly missing entries may result in an **UNSTABLE** pass-limit report.
- **Scanned context differs from the fully composed prompt.** `checkWorldInfo` receives the draft and reconstructed preceding messages. Some special scan sources (such as particular card-description or creator-note inputs) may not be represented identically.
- **Reasoning is intentionally scanned.** This can discover lore for possibilities Qwen merely considered and did not include in the visible response, potentially adding entries that the final scene does not use.
- **Reasoning-only drafts:** A message with reasoning in `extra.reasoning` may be scanned even when its visible reply is empty. A generation with no usable assistant message cannot be processed.
- **Group-chat safety:** The extension attempts to regenerate only the current character's last assistant message. Unexpected speaker identity, unusual group-message ordering, or third-party extensions that change generation flow can interfere. A failed regeneration attempts to restore a missing last message when it can do so safely.
- **Backend differences:** Different backends may expose reasoning and message completion differently. The extension leaves all sampler seed settings untouched. If a regeneration throws an error, the extension attempts to restore the original assistant message and display the underlying error rather than a generic incomplete-cycle status.
- **Inference cost:** The extension has no extra server component and makes no separate third-party request. Every additional generation uses the connected model/backend and may consume time or paid tokens.

## Troubleshooting

- **No settings panel:** Verify the path and that `manifest.json` is at the top of the extension directory. Reload SillyTavern and check the console for `[Iterative World Info] v0.1.0 loaded`.
- **No `[IWI-LORE]` messages, including PASS 1:** Check that the extension is enabled and a supported generation event completes. If a response finishes with no pass-1 or final log, the completion handler may not be running.
- **PASS 1 appears but no DISCOVERED or reroll:** There may be no matching missing lore, the matching lore may already have been included, the World Info entry/book may not be active, or maximum passes may be set to 1. Thinking as well as visible reply text is scanned.
- **DISCOVERED appears but no later ADDED:** Check for World Info activation restrictions, budget, or a failed regeneration. `DISCOVERED` records a scan result, not confirmation of insertion.
- **Original lore shows as missing later:** Review `[IWI-LORE] ... MISSING ORIGINAL` warnings. The extension requests cumulative lore on retries, but the World Info engine may not report all requests as activated.
- **Different results between passes:** Newly activated lore changes the prompt, so even with a fixed sampler seed the response may change. With random sampling enabled, each generation may also use a different seed.
- **Unexpected group behavior:** Disable the extension, preserve a copy of the chat, and inspect the browser console for `[Iterative World Info]` errors. Test with a small group before using important conversations.
- **Detailed troubleshooting:** Enable **Detailed logs in browser console** and make sure your developer console displays Debug-level messages.

## Development and tests

The project includes pure helper tests and a mocked event-flow suite. With Node.js installed:

```bash
cd ST-Iterative-World-Info
node --check index.js
node --test tests/*.test.mjs
```

**Verified against the current ZIP (November 4, 2026, Node.js 22.16.0):** `node --check index.js` succeeds and **all 27 tests pass** (0 failed, 0 skipped, 0 TODO). The suite exercises thinking-inclusive scans, Include Names, per-character group sequencing, cumulative and baseline lore, pass limits, logging, untouched random/fixed seeds across backends, cancellation, and recovery after a regeneration error. In the error regression, the original reply is restored and the reported status preserves the backend error (`Error: Backend unavailable`).

These tests mock SillyTavern events and APIs; they are **not** live integration tests. The suite does not independently prove that a particular SillyTavern release waits for the group event handlers or that every World Info entry reaches the final prompt. Test in a disposable chat before relying on it for important sessions.

## License

MIT — see [LICENSE](LICENSE).

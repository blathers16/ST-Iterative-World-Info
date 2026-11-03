# Iterative World Info (SillyTavern extension)

**Experimental v0.1.0 — front-end only.** Generate an initial reply, discover World Info that its text would have activated, and regenerate using that lore. Keep adding newly discovered entries and regenerating until the latest draft requires no *additional* World Info or the configured pass limit is reached.

This is *not* World Info recursive scanning. It scans the **generated response** after a model run, not merely the contents of already-activated lorebook entries.

## Installation (manual, local ZIP)

1. Download `ST-Iterative-World-Info.zip` and extract it.
2. Copy the **entire** `ST-Iterative-World-Info` folder (the folder containing `manifest.json`) into your SillyTavern installation's `data/<user-handle>/extensions/` directory. For a standard one-user installation, that is often `SillyTavern/data/default-user/extensions/ST-Iterative-World-Info/`.
3. Restart SillyTavern, or reload its web page after SillyTavern notices the extension.
4. Open **Extensions** settings and expand **Iterative World Info**. Check **Enable automatic lore-aware regeneration**. It is **off by default**.
5. Start with **Maximum generation passes = 3** and same-seed reuse checked.

This ZIP is a local folder distribution. SillyTavern's **Install Extension** field takes a *Git repository URL*, not a ZIP; upload the extracted folder manually unless you publish it to GitHub.

## Example

- Draft 1: A scene introduces an **elf**. The `elf` entry wasn't in the generation prompt. The extension scans the draft using SillyTavern's actual World Info activation system, finds the new entry and rerolls.
- Draft 2: With elf lore now loaded, the scene instead introduces an **elf and a dwarf**. The extension discovers dwarf lore and rerolls again with **both** entries.
- Draft 3: The final reply mentions both; no extra lore is needed. It is accepted.

Regenerations are allowed to change the narrative in response to lore. Draft text itself is **not** carried forward as a separate model instruction. Since prompts change, keeping the same sampler seed does *not* make the output identical.

## How it works

1. Hook `GENERATION_STARTED`, remember starting chat boundary and seed. If the model's seed was random (`-1`), choose a temporary nonnegative integer seed so every pass can use the same value.
2. During actual prompt construction, listen for `WORLD_INFO_ACTIVATED` to record entries genuinely supplied to the model.
3. On completion (`GENERATION_ENDED` for solo chats, `GROUP_WRAPPER_FINISHED` for groups), inspect the new response(s), excluding `<think>...</think>` blocks.
4. Ask SillyTavern's native `checkWorldInfo` to dry-run activation against each completed draft and preceding chat, using the relevant speaking character's lorebook in group chat.
5. Compare the entries the draft requires to the entries supplied on the *current pass*. Newly required entries are accumulated and force-activated via `WORLDINFO_FORCE_ACTIVATE` on the next pass.
6. Regenerate with the same seed. In a group, replay the **same speaker sequence** (one speaker at a time) so character order doesn't change; user messages must not be removed.
7. Stop when no additional entries are required. Restore the user's original seed setting.

## Settings

- **Enabled:** Off initially; changes affect future and currently active extension cycles.
- **Maximum generation passes:** 1–8, default 3. Each pass is a full model generation; group passes can include multiple speakers.
- **Same seed:** Default on. Supported for SillyTavern's KoboldAI/KoboldCpp-compatible `kobold` API and Text Completion's `koboldcpp` type. Unsupported backends continue without guaranteed seed reuse. A new random seed is chosen for each separate cycle if the original setting was random.
- **Notifications:** Status messages when finishing a multi-pass cycle or reaching the pass limit.
- **Debug:** Additional browser console logs.

## Scope and limitations

- **Experimental**: implemented against SillyTavern's November 2026 `release` source, but **not live-tested** with a running SillyTavern/KoboldCpp instance. Do a test chat before relying on it for important sessions.
- Stability means **no newly triggered entries** compared to the lore recorded as supplied for that pass, *not* a guarantee that the LLM obeyed all lore or that the final story is identical to the earlier draft.
- Uses SillyTavern's own matching, recursion, filters, probability, groups, placement, and token-budget machinery in the dry-run scan. Force-activation still runs through SillyTavern and cannot guarantee an entry is accepted if its own conditions/budget exclude it. The pass limit produces a warning when additional lore would be needed.
- Group chats: rerolls the exact sequence of members that generated the original responses. Group replay can behave differently from SillyTavern's regular whole-group regeneration; work on a test chat first. Ambiguous/missing speaker identity fails safely rather than deleting messages.
- Other extensions that modify prompts, auto-continue, manipulate messages, or use generation event hooks may interfere. If unusual behavior occurs, disable this extension temporarily.
- A draft that names a lorebook entity only in model-private thinking will **not** activate lore; this is intentional.
- The scanner uses the ordinary `normal` World Info trigger and its generic global scan context. It will **not** perfectly reproduce every special per-card scan configuration (e.g. extra description/creator-note scan inputs). This can cause additional or missed activations relative to a fully composed model prompt.
- The extension adds no server dependency and sends nothing to a third-party service. It uses the API already connected in SillyTavern, so additional passes consume model inference time, and may consume paid tokens for remote endpoints.
- When you reach the pass limit, the last response is left intact with a visible warning. A model draft that contains an unclosed think tag and no user-facing text cannot be scanned.

## Troubleshooting

- **No settings panel:** Check that `manifest.json` is directly inside `data/<user>/extensions/ST-Iterative-World-Info/`, not another nested directory. Refresh SillyTavern and check the browser DevTools console for `[Iterative World Info]`.
- **Never rerolls:** Ensure it is enabled, that the lorebook and its keys are active, and that the draft actually contains a matching key in the *visible* reply. Set max passes to 3 or more.
- **Seed isn't being reused:** Use Text Completion type **KoboldCpp** (or KoboldAI), and ensure the chosen backend supports `sampler_seed`.
- **Error or unusual group replay:** Turn this extension off and save a copy of the conversation for inspection. If a retry fails, the extension attempts to restore the original group messages.
- **Debugging:** Enable **Detailed logs in browser console** and look for `[Iterative World Info]`.

## Development and tests

Pure helper tests and a mocked SillyTavern event-flow test suite are included. With Node.js installed:

```bash
cd ST-Iterative-World-Info
node --test tests/*.test.mjs
node --check index.js
```

The flow tests simulate solo, group, same-seed, multi-pass discovery, and pass-limit behavior. They do **not** substitute for testing against an actual running SillyTavern server with KoboldCpp.

## License

MIT — see [LICENSE](LICENSE).

# Changelog

## 0.6.1 — 2026-11-26

- Recognize numbered acceptance headings with scenario tables. Changes to a scenario invalidate confirmations scoped to that acceptance criterion.
- Include the product reply and its disposition when DSH reads a review item so the second review can use the actual answer.
- Ship the shared collaboration engine and review changes introduced with the Codex port. Structured findings and an accompanying candidate can be saved together in a single ledger transaction.
- Retain the DSH sidebar, session coordinator and Ready gates. Describe review progress in terms of the current version and project.
- Make the DSH browser suite dismiss the optional first-run sign-in dialog in an isolated profile.

## 0.6.0 — 2026-11-25

- Use a native DSH sidebar panel with a document annotation icon. The workspace tree stays available while the Spec workbench occupies the center panel.
- Add a searchable requirement library and a two-pane workbench with version progress, the next action, responsive collaboration controls, and host light and dark themes.
- Keep the actual base commit when restoring a draft so that saves detect concurrent changes. Streamline identity registration and decision editing.
- Verify the packed plugin on DSH 0.2.3-alpha.2 and declare compatibility for that exact Alpha version alongside the existing 0.2.x ranges.

## 0.5.0 — 2026-11-25

- Share one commit transition across saves, renames, restores, and accepted patches. Invalidate the previous Ready package, whole-version confirmations, and pending patches when the Spec advances.
- Record the next collaboration ledger before moving the Git ref. Recover interrupted writes on startup and isolate Spec commits from unrelated staged files.
- Commit human actions and AI submissions atomically. Keep terminal AI results when dispatch acknowledgements arrive late.
- Use the same current-version human signers for Ready admission and export. Keep the existing compatibility range and verify the packaged plugin on DSH 0.2.2-rc.5.
- Refresh the walkthrough and validate the core mechanisms with reproducible ablation tests.

## 0.4.1 — 2026-11-11

- Support DSH 0.2.2-rc.1 while retaining 0.2.1-rc.5 compatibility. Declare bounded runtime and SDK peer windows for both release lines, including npm's default prerelease matching, and reject unverified 0.2.3 and later releases.
- Replace the removed Session Controller inspection call with paginated event history on DSH 0.2.2. Keep one history cursor while reading earlier pages, preserve chronological replies, reject non-advancing cursors, and fall back to inspection on DSH 0.2.1.
- Build and type-check against the 0.2.2-rc.1 SDK and support both Cordis 4.0/4.1 and native schema versions. Cover the original exact-peer rejection, supported and unsupported runtimes, legacy history, and the current history protocol.

## 0.4.0 — 2026-11-03

- Support DeepSeek Harness 0.2.1-rc.5 and declare its Host services as exact SDK peers. Older DSH 0.1.1-rc.1 installations must continue using plugin 0.3.1.
- Replace the removed API proxy with the Session Controller, Workspace Registry and Agent Preset Registry. Use direct business results, request IDs and cancellable prompt delivery.
- Read flat Session events through the current inspection API so review conversations and follow-ups remain visible.
- Remove the retired client runtime dependency and the unused client Session injection; mount the workbench entry beside the current Plugins panel, including compact Chinese and English sidebars.
- Align configuration schemas and the dependency lock with the current SDK, and cover the official compatibility gate, Host activation/disposal and review session integration.

## 0.3.1 — 2026-10-27

- Enforce the same Ready admission rules in frontend guidance and the server: require a completed engineering precheck for the current commit, settled reviews and patches, passing readiness checks, and current version confirmations from both roles.
- Preserve the review session association when a delayed launch resolves after a rejected action restores the collaboration state.
- Add regression coverage for missing, queued, running, failed and stale prechecks, expired confirmations, pending patches, delayed launches and HTTP admission.
- Declare the supported host tools package as a runtime peer dependency so a clean installation can load the Host entry point.
- Keep raw acceptance evidence in Git while excluding it from the npm package; retain product documentation and walkthrough images.

Compatibility remains DeepSeek Harness 0.1.1-rc.1. This release does not add support for the newer host API.

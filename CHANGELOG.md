# Changelog

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

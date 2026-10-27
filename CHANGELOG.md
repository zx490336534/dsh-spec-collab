# Changelog

## 0.3.1 — 2026-10-27

- Enforce the same Ready admission rules in frontend guidance and the server: require a completed engineering precheck for the current commit, settled reviews and patches, passing readiness checks, and current version confirmations from both roles.
- Preserve the review session association when a delayed launch resolves after a rejected action restores the collaboration state.
- Add regression coverage for missing, queued, running, failed and stale prechecks, expired confirmations, pending patches, delayed launches and HTTP admission.
- Declare the supported host tools package as a runtime peer dependency so a clean installation can load the Host entry point.
- Keep raw acceptance evidence in Git while excluding it from the npm package; retain product documentation and walkthrough images.

Compatibility remains DeepSeek Harness 0.1.1-rc.1. This release does not add support for the newer host API.

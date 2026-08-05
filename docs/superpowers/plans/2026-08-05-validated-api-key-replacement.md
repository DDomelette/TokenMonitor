# Validated API Key Replacement Implementation Plan

**Goal:** Prevent the settings page from overwriting a valid DeepSeek API key with unvalidated, incomplete, empty, or abandoned input.

**Architecture:** Remove the legacy `apiKey` alias from the generic writable-settings boundary. Add a pure asynchronous credential replacement helper that trims and rejects empty candidates, verifies the candidate through the existing DeepSeek balance adapter, and writes the canonical credential only after successful verification. Expose that helper through one dedicated, preload-allowlisted `settings:replace-api-key` invoke channel. Render the credential as an explicit input plus “验证并保存” button; typing alone never enters the keyed settings queue, and verification failures show a generic inline error while leaving the saved credential untouched.

## Task 1: Establish RED

- Create `test/validated-api-key-replacement.test.js`.
- Require a missing `src/main/core/api-key-replacement.js` helper.
- Verify the old credential remains untouched while verification is pending.
- Verify successful verification performs one canonical write and broadcasts the sanitized setting state.
- Verify invalid and empty candidates never write or broadcast.
- Require generic settings security to reject both `apiKey` and the canonical credential path.
- Guard the dedicated preload and IPC invoke channel.
- Guard an explicit credential control that has no `data-key`, is not bound to the generic input queue, and submits only from its button.
- Guard generic writer tests so they no longer rely on the removed credential alias.
- Create a Draft PR and record expected RED while all existing tests remain green except guards that intentionally encode the old alias.

## Task 2: Implement GREEN

- Add `src/main/core/api-key-replacement.js`.
- Remove the `apiKey` generic writable alias from `settings-security.js`.
- Register `settings:replace-api-key` in preload and `ipc.js`, using the existing DeepSeek balance adapter/context for verification.
- Change the settings definition to an explicit credential control.
- Render and bind the verify/save button without adding the input to the debounce queue.
- Show generic credential validation feedback and retain the candidate after failure for correction.
- Update prior generic-writer tests to use non-credential writable settings.
- Run the complete test suite, renderer build, and Electron/Xvfb smoke test.
- Review the final diff, confirm zero unresolved review threads, update PR evidence, mark ready, and squash merge with the verified head SHA.

## Scope boundary

This issue only provides validated replacement. It does not add a credential removal action, change the first-login flow, add proxy support to DeepSeek balance verification, expose the stored key to the renderer, or redesign credential storage.
# Component Visibility Review Checklist

- [x] Root cause traced from settings write/broadcast to missing renderer consumption.
- [x] Focused regression test observed failing before production implementation.
- [x] Registry-driven visibility helper implemented and focused tests pass.
- [x] Dashboard subscribes to `settings:loaded` and rebuilds only when visible IDs change.
- [x] Hidden and unavailable module geometry is merged back before layout validation.
- [x] Dashboard JSX parsed with the TypeScript compiler with zero diagnostics.
- [ ] Complete repository `npm test` passes in PR CI.
- [ ] Renderer build passes in PR CI.
- [ ] Electron Xvfb hide/show/geometry smoke test passes.
- [ ] Screenshot artifact contains enabled, disabled, and restored states.
- [ ] Final branch diff reviewed after CI fixes.
- [ ] Draft PR remains unmerged.

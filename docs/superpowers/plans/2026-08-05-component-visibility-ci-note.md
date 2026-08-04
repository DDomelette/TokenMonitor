# CI Verification Note

The ChatGPT execution container cannot resolve `github.com`, so a complete local checkout is unavailable in this session. Focused RED/GREEN tests were executed in an isolated local harness using the exact new test and production helper code.

For complete repository verification, this branch adds a pull-request CI job that performs:

1. `npm ci`
2. `npm --prefix renderer ci`
3. `npm test`
4. `npm run build:renderer`
5. An Xvfb Electron smoke test that hides and restores `token-line`, compares its GridStack geometry, and uploads three screenshots.

The Draft PR must remain draft until the CI run completes successfully. Any CI failure must be investigated and fixed rather than waived.

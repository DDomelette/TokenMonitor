const fs = require('fs');
const path = require('path');

const RENDERER_ENTRY_RELATIVE = path.join('renderer', 'dist', 'index.html');

function assertRendererBuild(options = {}) {
  const projectRoot = options.projectRoot || path.resolve(__dirname, '..', '..', '..');
  const existsSync = options.existsSync || fs.existsSync;
  const entryPath = path.join(projectRoot, RENDERER_ENTRY_RELATIVE);

  if (!existsSync(entryPath)) {
    const error = new Error(
      `Renderer build is missing at ${RENDERER_ENTRY_RELATIVE}. Run npm run build:renderer before launching Electron.`
    );
    error.code = 'RENDERER_BUILD_MISSING';
    throw error;
  }

  return entryPath;
}

module.exports = {
  RENDERER_ENTRY_RELATIVE,
  assertRendererBuild
};

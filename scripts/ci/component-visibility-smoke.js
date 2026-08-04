const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '../..');
const artifactDir = path.join(root, 'artifacts', 'component-visibility');

function componentSettings(tokenLine) {
  return {
    components: {
      quotaCodex: false,
      quotaKimi: false,
      balanceCard: false,
      todayCostCard: false,
      cacheRateCard: false,
      modelBar: false,
      providerBar: false,
      tokenLine,
      costLine: true,
      tokenHeatmap: false
    },
    layout: null,
    componentOrder: ['token-line', 'cost-line'],
    window: { layoutLocked: true }
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(win, expression, description, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const matched = await win.webContents.executeJavaScript(`Boolean(${expression})`);
    if (matched) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function geometry(win, componentId) {
  return win.webContents.executeJavaScript(`(() => {
    const node = document.querySelector('[data-component-id="${componentId}"]');
    if (!node) return null;
    return {
      x: node.getAttribute('gs-x'),
      y: node.getAttribute('gs-y'),
      w: node.getAttribute('gs-w'),
      h: node.getAttribute('gs-h'),
      preset: node.getAttribute('data-layout-preset')
    };
  })()`);
}

async function capture(win, filename) {
  await sleep(350);
  const image = await win.capturePage();
  fs.writeFileSync(path.join(artifactDir, filename), image.toPNG());
}

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

app.whenReady().then(async () => {
  fs.mkdirSync(artifactDir, { recursive: true });
  const win = new BrowserWindow({
    width: 760,
    height: 900,
    show: true,
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, 'component-visibility-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  win.webContents.on('console-message', (event, level, message) => {
    if (level >= 2) console.error('[renderer]', message);
  });

  await win.loadFile(path.join(root, 'renderer', 'dist', 'index.html'));
  await waitFor(win, "document.querySelector('[data-component-id=\"token-line\"]')", 'initial token-line module');
  await waitFor(win, "document.querySelector('[data-component-id=\"cost-line\"]')", 'cost-line module');

  const before = await geometry(win, 'token-line');
  assert.ok(before, 'token-line geometry should exist before disabling');
  await capture(win, '01-enabled.png');

  await win.webContents.executeJavaScript(
    `window.api.__emitSettings(${JSON.stringify(componentSettings(false))})`
  );
  await waitFor(win, "!document.querySelector('[data-component-id=\"token-line\"]')", 'token-line removal');
  await waitFor(win, "document.querySelector('[data-component-id=\"cost-line\"]')", 'cost-line remaining visible');
  await capture(win, '02-disabled.png');

  await win.webContents.executeJavaScript(
    `window.api.__emitSettings(${JSON.stringify(componentSettings(true))})`
  );
  await waitFor(win, "document.querySelector('[data-component-id=\"token-line\"]')", 'token-line restoration');
  const after = await geometry(win, 'token-line');
  assert.deepEqual(after, before, 'token-line geometry must be restored after re-enabling');
  await capture(win, '03-restored.png');

  console.log('component visibility smoke test passed');
  console.log('geometry:', JSON.stringify(after));
  win.destroy();
  app.quit();
}).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  app.exit(1);
});

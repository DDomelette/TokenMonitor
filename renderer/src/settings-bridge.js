export function installSettingsOpenBridge(on, send) {
  return on('open:settings', () => {
    send('open:settings');
  });
}

// Provider 适配器注册表。

const adapters = [];

function register(adapter) {
  if (!adapter || typeof adapter.id !== 'string' || !adapter.id) return;
  const index = adapters.findIndex(function (a) { return a.id === adapter.id; });
  if (index !== -1) adapters[index] = adapter;
  else adapters.push(adapter);
}

function unregister(id) {
  const index = adapters.findIndex(function (a) { return a.id === id; });
  if (index !== -1) adapters.splice(index, 1);
}

function list() {
  return adapters.slice();
}

function get(id) {
  return adapters.find(function (a) { return a.id === id; });
}

module.exports = { register, unregister, list, get };

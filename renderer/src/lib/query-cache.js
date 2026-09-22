// 按键共享请求和订阅。失效期间到达的旧响应不提交,有订阅者时补取最新数据。
export function createQueryCache(load) {
  const entries = new Map();

  function entryFor(key) {
    if (!entries.has(key)) {
      entries.set(key, { value: null, stale: true, revision: 0, pending: null, listeners: new Set() });
    }
    return entries.get(key);
  }

  function request(key) {
    const entry = entryFor(key);
    if (entry.pending) return entry.pending;
    if (!entry.stale) return Promise.resolve();
    const revision = entry.revision;
    entry.pending = Promise.resolve().then(() => load(key)).then((value) => {
      if (revision !== entry.revision) return;
      entry.value = value;
      entry.stale = false;
      entry.listeners.forEach((listener) => listener());
    }).catch(() => {
      // 保留上次成功值,下一次变化或重新订阅时再尝试。
    }).finally(() => {
      entry.pending = null;
      if (revision !== entry.revision && entry.listeners.size) request(key);
    });
    return entry.pending;
  }

  return {
    read(key) { return entryFor(key).value; },
    request,
    subscribe(key, listener) {
      const entry = entryFor(key);
      entry.listeners.add(listener);
      request(key);
      return () => entry.listeners.delete(listener);
    },
    invalidate(matches = () => true) {
      entries.forEach((entry, key) => {
        if (!matches(key)) return;
        entry.stale = true;
        entry.revision += 1;
        if (entry.listeners.size) request(key);
      });
    }
  };
}

// 按键共享请求和订阅。失效期间到达的旧响应不提交,有订阅者时补取最新数据。
// 相同内容的响应保留旧引用且不通知,避免后台轮询触发无意义的图表重绘。
export function createQueryCache(load) {
  const entries = new Map();

  function sameValue(left, right) {
    if (Object.is(left, right)) return true;
    if (left == null || right == null) return false;
    try {
      const leftJson = JSON.stringify(left);
      return leftJson !== undefined && leftJson === JSON.stringify(right);
    } catch (_) {
      return false;
    }
  }

  function entryFor(key) {
    if (!entries.has(key)) {
      entries.set(key, { value: null, hasValue: false, stale: true, revision: 0, pending: null, listeners: new Set() });
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
      const unchanged = entry.hasValue && sameValue(entry.value, value);
      entry.hasValue = true;
      entry.stale = false;
      if (!unchanged) {
        entry.value = value;
        entry.listeners.forEach((listener) => listener());
      }
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

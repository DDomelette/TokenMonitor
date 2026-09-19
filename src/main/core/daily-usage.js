// 合并四个 Token 桶;返回新聚合,不修改输入或承担游标/存储提交职责。
function mergeDailyUsage(current, additions) {
  const merged = { ...current };
  Object.keys(additions || {}).forEach((key) => {
    const prev = merged[key] || { input: 0, cached: 0, output: 0, total: 0 };
    const add = additions[key];
    merged[key] = {
      input: prev.input + add.input,
      cached: prev.cached + add.cached,
      output: prev.output + add.output,
      total: prev.total + add.total
    };
  });
  return merged;
}

module.exports = { mergeDailyUsage };

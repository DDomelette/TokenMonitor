// 为日期驱动图表提供北京日键;即使后台数据不变,跨午夜也会触发一次渲染。
import { useEffect, useState } from 'react';
import { createLocalCalendarClock, localDayKey } from '../lib/local-calendar-clock.js';

export default function useBeijingDayKey() {
  const [dayKey, setDayKey] = useState(() => localDayKey(new Date()));

  useEffect(() => {
    const clock = createLocalCalendarClock({
      onChange: (_, nextKey) => setDayKey(nextKey)
    });
    return () => clock.stop();
  }, []);

  return dayKey;
}

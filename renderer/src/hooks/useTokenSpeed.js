import { useEffect, useState } from 'react';
import { getTokenSpeed, onTokenSpeedChanged } from '../api.js';

export default function useTokenSpeed() {
  const [snapshot, setSnapshot] = useState(null);

  useEffect(() => {
    let active = true;
    getTokenSpeed()
      .then((value) => {
        if (active) setSnapshot(value);
      })
      .catch(() => {});
    const unsubscribe = onTokenSpeedChanged((value) => setSnapshot(value));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return snapshot;
}

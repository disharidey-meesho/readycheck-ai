// The live dynamic settings for the screens. Fetched once after sign-in and shared by every
// component; the Dynamic settings panel refreshes it after a save.
import { useEffect, useState } from 'react';
import { DEFAULT_CONFIG, type AppConfig } from './app-config';

let current: AppConfig = DEFAULT_CONFIG;
let loading: Promise<void> | null = null;
const listeners = new Set<(c: AppConfig) => void>();

export function setAppConfig(c: AppConfig) {
  current = c;
  for (const l of listeners) l(c);
}

export function loadAppConfig(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = fetch('/api/config')
    .then((r) => (r.ok ? r.json() : null))
    .then((c) => { if (c) setAppConfig({ ...DEFAULT_CONFIG, ...c }); })
    .catch(() => {});
  return loading;
}

export function useAppConfig(): AppConfig {
  const [c, setC] = useState(current);
  useEffect(() => {
    listeners.add(setC);
    void loadAppConfig();
    return () => { listeners.delete(setC); };
  }, []);
  return c;
}

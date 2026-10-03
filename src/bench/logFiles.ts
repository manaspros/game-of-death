import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const LOG_DIR = 'bench-logs';

export interface LogFile {
  id: string;
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

/** Real match logs (not smoke-test logs), newest first. */
export function listLogs(dir: string = LOG_DIR): LogFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.startsWith('match-') && f.endsWith('.jsonl'))
    .map(f => {
      const path = join(dir, f);
      const st = statSync(path);
      return { id: f.replace(/\.jsonl$/, ''), path, mtimeMs: st.mtimeMs, sizeBytes: st.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function latestLogPath(dir: string = LOG_DIR): string {
  const logs = listLogs(dir);
  if (logs.length === 0) throw new Error(`No match logs found in ${dir}/`);
  return logs[0].path;
}

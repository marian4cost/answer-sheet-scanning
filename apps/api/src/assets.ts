import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import { PROJECT_ROOT } from './config';

/** Assets must work both in the monorepo checkout and in a Vercel function bundle. */
export function assetPath(relative: string): string {
  if (!relative || isAbsolute(relative) || win32.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..' || !part)) {
    throw new Error('Recurso interno inválido.');
  }
  const candidates = [resolve(__dirname, '../assets'), resolve(process.cwd(), 'assets'), join(PROJECT_ROOT, 'apps/api/assets')];
  for (const directory of candidates) {
    const path = resolve(directory, relative);
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  // Do not disclose host paths or environment variables in public errors.
  throw new Error('Recurso do servidor indisponível. Verifique o empacotamento dos arquivos.');
}

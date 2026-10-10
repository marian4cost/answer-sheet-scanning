import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(resolve(root, 'apps/api/assets'), {recursive:true});
await copyFile(resolve(root, 'infra/sql/001-schema.sql'), resolve(root, 'apps/api/assets/schema.sql'));

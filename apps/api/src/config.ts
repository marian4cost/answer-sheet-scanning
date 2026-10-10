import { resolve } from 'node:path';
import { config as dotenv } from 'dotenv';
export const PROJECT_ROOT = resolve(__dirname, '../../..');
dotenv({ path: resolve(PROJECT_ROOT, '.env'), quiet: true });
export const DATABASE_URL = process.env.DATABASE_URL || '';
export const DATABASE_SSL = process.env.DATABASE_SSL === 'true';
// A CA do provedor permite validar a cadeia TLS sem desativar rejectUnauthorized.
export const DATABASE_SSL_CA = process.env.DATABASE_SSL_CA_BASE64
  ? Buffer.from(process.env.DATABASE_SSL_CA_BASE64, 'base64').toString('utf8') : '';
export const API_HOST = process.env.API_HOST || '127.0.0.1';
export const OMR_REMOTE_URL = process.env.OMR_REMOTE_URL || '';
export const OMR_REMOTE_SECRET = process.env.OMR_REMOTE_SECRET || '';
export const STORAGE_MODE = process.env.STORAGE_MODE || 'local';
export const SUPABASE_URL = process.env.SUPABASE_URL || '';
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
export const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'omr-private';
export const DATABASE_PATH = resolve(PROJECT_ROOT, process.env.DATABASE_PATH || 'db.sqlite3');
export const MEDIA_ROOT = resolve(PROJECT_ROOT, process.env.MEDIA_ROOT || (process.env.VERCEL ? '/tmp/enem-media' : 'media'));
export const PYTHON_EXECUTABLE = resolve(PROJECT_ROOT, process.env.PYTHON_EXECUTABLE || 'venv/bin/python');
export const WORKER_PATH = resolve(PROJECT_ROOT, 'python/worker.py');
export const API_PORT = Number(process.env.API_PORT || 3001);
export const WEB_PORT = Number(process.env.WEB_PORT || 3000);
export const MAX_FILE_SIZE = 20 * 1024 * 1024;
export const ALLOWED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff'];

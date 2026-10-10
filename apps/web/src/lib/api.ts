export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch('/api' + path, {...options, cache: 'no-store', headers: {'X-OMR-Client': 'web', ...options.headers}});
  const content = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/') && typeof window !== 'undefined') window.location.assign('/login');
    const message = content?.message;
    throw new Error(Array.isArray(message) ? message.join(' ') : message || 'Não foi possível concluir a solicitação. Tente novamente.');
  }
  return content as T;
}
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Não foi possível concluir a operação.'; }
export const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff';
export const FORMAT_TEXT = 'PDF, JPEG/JPG, PNG, WEBP, BMP e TIFF';
export function validateFiles(files: File[]) {
  if (!files.length) throw new Error('Selecione pelo menos um arquivo.');
  if (files.length > 50) throw new Error('Envie até 50 arquivos por vez. Você pode adicionar mais provas depois.');
  for (const file of files) {
    if (!ACCEPT.split(',').includes('.' + file.name.split('.').pop()?.toLowerCase())) throw new Error(`${file.name}: formato não suportado.`);
    if (!file.size || file.size > 20 * 1024 * 1024) throw new Error(`${file.name}: envie um arquivo válido de até 20 MB.`);
  }
}
export function dateText(date: string) {
  return new Intl.DateTimeFormat('pt-BR', {dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Fortaleza'}).format(new Date(date));
}

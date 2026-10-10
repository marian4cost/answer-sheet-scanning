import type { OMRReading, UploadResult } from '@enem/shared';
import { api, validateFiles } from './api';
async function privateUploads() { return (await api<{private_uploads: boolean}>('/config')).private_uploads; }
async function store(files: File[], purpose: 'gabarito' | 'prova') {
  const result = await api<{uploads: Array<{id: string; url: string; name: string}>}>('/uploads/preparar', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({files: files.map(file => ({name: file.name, size: file.size, purpose}))}),
  });
  for (let index = 0; index < files.length; index++) {
    const response = await fetch(result.uploads[index].url, {method: 'PUT', headers: {'Content-Type': files[index].type || 'application/octet-stream'}, body: files[index]});
    if (!response.ok) throw new Error(`Não foi possível enviar ${files[index].name}. Tente novamente.`);
  }
  return result.uploads.map(upload => upload.id);
}
export async function readKey(file: File, count: number) {
  validateFiles([file]);
  if (await privateUploads()) {
    const [upload_id] = await store([file], 'gabarito');
    return api<OMRReading>('/leituras/gabarito/armazem', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({upload_id, total_questoes: count})});
  }
  const form = new FormData(); form.append('gabarito_pdf', file); form.append('total_questoes', String(count));
  return api<OMRReading>('/leituras/gabarito', {method: 'POST', body: form});
}
export async function uploadProofs(id: number, files: File[], matriculas: string[], onProgress: (done: number) => void) {
  validateFiles(files);
  if (matriculas.some(value => !value.trim() || value.trim().length > 100)) throw new Error('Informe uma matrícula de até 100 caracteres para cada prova.');
  if (!(await privateUploads())) {
    const form = new FormData(); files.forEach(file => form.append('pdf_files', file)); form.append('matriculas', JSON.stringify(matriculas));
    return api<UploadResult>(`/simulados/${id}/provas`, {method: 'POST', body: form});
  }
  // Cada lote concluído é durável; lotes pequenos respeitam o tempo de execução da hospedagem.
  let result: UploadResult | undefined;
  for (let start = 0; start < files.length; start += 3) {
    const batch = files.slice(start, start + 3);
    const upload_ids = await store(batch, 'prova');
    result = await api<UploadResult>(`/simulados/${id}/provas/armazem`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({upload_ids, matriculas: matriculas.slice(start, start + batch.length)})});
    onProgress(start + batch.length);
  }
  return result!;
}

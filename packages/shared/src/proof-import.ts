export type RegistrationStatus = 'CONFIRMADA' | 'AUSENTE' | 'AMBIGUA' | 'INCERTA';
export interface DocumentIdentity {
  page_number: number; matricula_detectada: string | null; matricula_status: RegistrationStatus;
  matricula_fonte: 'pdf_texto' | 'ocr' | null; matricula_candidatas: string[]; erro_msg: string;
}
export interface DocumentInspection { page_count: number; pages: DocumentIdentity[] }
export interface DocumentInfo { page_count: number }
export interface ProofImportPage {
  id: string; arquivo: string; arquivo_indice: number; pagina: number; matricula_detectada: string | null; matricula: string;
  identificacao: RegistrationStatus | 'PENDENTE'; fonte: string; candidatas: string[]; mensagem: string;
  estado: 'PENDENTE' | 'PRONTA' | 'PROCESSANDO' | 'CONCLUIDA' | 'IGNORADA'; resultado_id: number | null;
}
export interface ProofImportPlan {
  id: string; simulado_id: number; estado: 'PREVIA' | 'CONFIRMADA' | 'CONCLUIDA'; criado_em: string; expira_em: string;
  total_arquivos: number; total_paginas: number; total_identificadas: number; total_concluidas: number; envio_id: number | null;
  paginas: ProofImportPage[];
}

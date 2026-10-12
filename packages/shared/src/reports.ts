import type { ReadingStatus, Score, ThemeScore } from './index';

export interface StudentContact { matricula: string; email: string; nome: string; curso?: string; atualizado_em?: string }
export interface EssayFeedback {
  nota_redacao: number | null; feedback_redacao: string; atualizado_em?: string;
  competencias_redacao?: number[]; avaliador_redacao?: string; situacao_redacao?: string; origem_redacao?: string;
}
export interface ReportArea extends Score { area: string; total_questoes: number; nota: number | null; nota_dez: number | null }
export interface ReportQuestion { numero: number; resposta: string; gabarito: string; tema: string; area: string | null; resultado: 'CORRETA'|'INCORRETA'|'BRANCO'|'DUPLA'|'INCERTA'|'PENDENTE' }
export interface ReportPriority { area: string; incorretas: number[]; brancos: number[]; duplas: number[]; incertas: number[] }
export interface StudentReport {
  resultado_id: number; simulado_id: number; titulo: string; matricula: string; nome: string;
  email: string | null; curso: string; total_questoes: number; status: ReadingStatus; geral: Score; nota_geral_dez: number | null;
  temas: ThemeScore[]; areas: ReportArea[]; redacao: EssayFeedback; gerado_em: string;
  apto_envio: boolean; pendencias: string[]; avisos: string[]; content_hash: string;
  modelo: 'boletim_individual_v2'; metodologia: string; interpretacao: string; prioridades: ReportPriority[]; questoes: ReportQuestion[];
}
export interface ReportListRow {
  resultado_id: number; matricula: string; nome: string; email: string | null;
  nota_percentual: number | null; status: ReadingStatus; pendencias: string[]; avisos: string[];
  apto_envio: boolean; redacao: EssayFeedback; temas: ThemeScore[];
}
export interface ReportList {
  simulado_id: number; titulo: string; envio_disponivel: boolean; envio_motivo: string;
  alunos: ReportListRow[]; total: number;
}
export interface ContactImportPreview {
  token: string; contatos: StudentContact[]; erros: string[]; avisos: string[]; total: number; expira_em: string;
}
export interface DeliveryPlan {
  token: string; simulado_id: number; alunos: Array<{resultado_id: number; matricula: string; nome: string; email: string; nota_percentual: number; content_hash: string}>;
  total: number; expira_em: string; envio_disponivel: boolean; envio_motivo: string;
  reemissao?: boolean; delivery_id?: number;
}
export interface ReportDelivery {
  resultado_id: number; matricula: string; email: string;
  status: 'ENVIADO' | 'ENVIANDO' | 'AMBIGUO' | 'BLOQUEADO'; message_id: string; erro: string;
}
export interface DeliveryResult { total_enviados: number; total_ignorados: number; resultados: ReportDelivery[] }

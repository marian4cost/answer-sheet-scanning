export type Answer = 'A' | 'B' | 'C' | 'D' | 'E' | 'BNK' | 'RAS' | 'INC';
export type AnswerKey = Record<string, string>;
export type ReadingStatus = 'SUCESSO' | 'ALERTA_RASURA' | 'ALERTA_REVISAO' | 'ERRO_LEITURA';
export interface ThemeRange { inicio: number; fim: number; tema: string }
export interface ThemeScore extends Score { tema: string; total_questoes: number }
export interface Simulado {
  id: number; titulo: string; data_criacao: string; gabarito_oficial: AnswerKey;
  total_questoes: number; temas: ThemeRange[];
  total_provas: number; total_envios: number; gabarito_valido: boolean;
}
export interface Envio {
  id: number; simulado_id: number; titulo: string; criado_em: string; total_provas: number;
}
export interface Score {
  total_acertos: number; total_erros: number; total_rasuras: number;
  total_brancos: number; total_incertas: number; nota_percentual: number;
}
export interface Resultado extends Score {
  id: number; lote_id: number; matricula: string; respostas_detectadas: AnswerKey;
  status: ReadingStatus; mensagem_leitura: string; imagem_debug: string | null;
  criado_em: string; gabarito_do_envio: AnswerKey;
  desempenho_temas: ThemeScore[];
  arquivo_origem?: string; pagina_origem?: number | null; matricula_fonte?: string;
}
export interface Indicators {
  total_provas: number; total_envios: number; media_nota: number;
  sucesso_count: number; rasura_count: number; revisao_count: number; erro_count: number;
}
export interface DashboardData {
  simulados: Simulado[]; envios_recentes: Envio[];
  total_simulados: number; total_provas: number;
}
export interface SimuladoDetail { simulado: Simulado; envios: Envio[] }
export interface ResultsData {
  simulado: Simulado; resultados: Resultado[]; indicadores: Indicators; envio: Envio | null;
}
export interface UploadResult { envio_id: number; simulado_id: number; message: string; total_provas: number }
export interface OMRReading {
  respostas_detectadas: AnswerKey; status: ReadingStatus; erro_msg: string;
  debug_image_path: string | null; layout?: string;
  page_number?: number; matricula_detectada?: string | null; matricula_status?: string;
  matricula_fonte?: string | null; matricula_candidatas?: string[];
}

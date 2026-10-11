/** The five values follow the ENEM competency order and retain their 0–200 scale. */
export interface EssayImportLine {
  linha: number;
  matricula: string;
  nome: string;
  avaliador: string;
  situacao: string;
  competencias: number[];
  nota_redacao: number;
  feedback_redacao: string;
  resultado_ids: number[];
  anteriores?: Array<{resultado_id:number; nota_redacao:number|null; competencias:number[]; feedback_redacao:string}>;
  acao: 'NOVA' | 'ATUALIZAR' | 'SEM_ALTERACAO' | 'SEM_RESULTADO';
}
export interface EssayImportPreview {
  token: string;
  simulado_id: number;
  total: number;
  total_resultados: number;
  novas: number;
  atualizacoes: number;
  sem_alteracao: number;
  sem_resultado: number;
  linhas: EssayImportLine[];
  erros: string[];
  avisos: string[];
  expira_em: string;
}
export interface EssayImportResult {
  message: string;
  total: number;
  total_resultados: number;
  sem_alteracao: number;
  ignoradas: number;
}

import type { StudentReport } from './reports';
import type { ThemeScore } from './index';

export function formatReportCount(acertos: number, total: number, available?: boolean): string;
export function reportInterpretation(report: Pick<StudentReport, 'nota_geral_dez' | 'status' | 'geral'>): string;
export function reportMethodology(): string;
export function reportAdditionalThemes(report: Pick<StudentReport, 'areas' | 'temas'>): ThemeScore[];

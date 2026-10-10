import { BadRequestException } from '@nestjs/common';
import type { ThemeRange } from '@enem/shared';

export function questionCount(value: unknown = 50): number {
  const count = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 50 || count > 60) {
    throw new BadRequestException('Informe uma quantidade inteira entre 50 e 60 questões.');
  }
  return count;
}

export function themeRanges(value: unknown, count: number): ThemeRange[] {
  if (value === undefined) return [];
  let ranges: unknown = value;
  if (typeof ranges === 'string') {
    try { ranges = JSON.parse(ranges); }
    catch { throw new BadRequestException('Os intervalos de temas devem ser uma lista válida.'); }
  }
  if (!Array.isArray(ranges) || ranges.length > count) throw new BadRequestException('Informe uma lista de intervalos de temas.');
  const parsed = ranges.map((range: unknown) => {
    if (!range || typeof range !== 'object') throw new BadRequestException('Intervalo de tema inválido.');
    const {inicio, fim, tema} = range as ThemeRange;
    if (!Number.isInteger(inicio) || !Number.isInteger(fim) || inicio < 1 || fim < inicio || fim > count) {
      throw new BadRequestException(`Cada intervalo deve começar em 1 ou mais e terminar até a questão ${count}, sem inverter os limites.`);
    }
    if (typeof tema !== 'string' || !tema.trim() || tema.trim().length > 100) throw new BadRequestException('Informe um tema de até 100 caracteres para cada intervalo.');
    return {inicio, fim, tema: tema.trim()};
  }).sort((a, b) => a.inicio - b.inicio);
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].inicio <= parsed[i - 1].fim) throw new BadRequestException('Os intervalos de temas não podem se sobrepor. Cada questão deve ter apenas um tema.');
  }
  return parsed;
}

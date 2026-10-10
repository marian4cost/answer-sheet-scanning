import type { AnswerKey, ReadingStatus, Score, Resultado, Indicators, ThemeRange, ThemeScore } from '@enem/shared';
export function invalidQuestions(key: AnswerKey, count = 50): string[] {
  return Array.from({length: count}, (_, i) => String(i + 1)).filter(q => !['A', 'B', 'C', 'D', 'E'].includes(key[q]));
}
export function grade(answers: AnswerKey, key: AnswerKey, status: ReadingStatus, count = Object.keys(key).length): Score {
  const result: Score = {total_acertos: 0, total_erros: 0, total_rasuras: 0, total_brancos: 0, total_incertas: 0, nota_percentual: 0};
  if (status === 'ERRO_LEITURA') return result;
  for (let q = 1; q <= count; q++) {
    const answer = answers[String(q)] || 'BNK';
    if (answer === 'INC') result.total_incertas++;
    else if (answer === 'RAS') result.total_rasuras++;
    else if (answer === 'BNK') result.total_brancos++;
    else if (answer === key[String(q)]) result.total_acertos++;
    else result.total_erros++;
  }
  result.nota_percentual = count ? Math.round(result.total_acertos / count * 10000) / 100 : 0;
  return result;
}
export function gradeThemes(answers: AnswerKey, key: AnswerKey, status: ReadingStatus, count: number, themes: ThemeRange[]): ThemeScore[] {
  if (!themes.length) return [];
  const groups = new Map<string, number[]>();
  for (let q = 1; q <= count; q++) {
    const name = themes.find(range => range.inicio <= q && range.fim >= q)?.tema || 'Sem tema';
    const questions = groups.get(name) || [];
    questions.push(q); groups.set(name, questions);
  }
  return [...groups].map(([tema, questions]) => {
    const subsetAnswers: AnswerKey = {}, subsetKey: AnswerKey = {};
    questions.forEach((q, i) => { subsetAnswers[String(i + 1)] = answers[String(q)]; subsetKey[String(i + 1)] = key[String(q)]; });
    return {tema, total_questoes: questions.length, ...grade(subsetAnswers, subsetKey, status, questions.length)};
  });
}
export function indicators(results: Resultado[], totalEnvios: number): Indicators {
  const confirmed = results.filter(r => ['SUCESSO', 'ALERTA_RASURA'].includes(r.status));
  return {
    total_provas: results.length, total_envios: totalEnvios,
    media_nota: confirmed.length ? Math.round(confirmed.reduce((total, r) => total + r.nota_percentual, 0) / confirmed.length * 10) / 10 : 0,
    sucesso_count: results.filter(r => r.status === 'SUCESSO').length,
    rasura_count: results.filter(r => r.status === 'ALERTA_RASURA').length,
    revisao_count: results.filter(r => r.status === 'ALERTA_REVISAO').length,
    erro_count: results.filter(r => r.status === 'ERRO_LEITURA').length,
  };
}

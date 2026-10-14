/** Counts are the visible report score; historical grading data stays intact. */
function formatReportCount(acertos, total, available = true) {
  if (!Number.isInteger(total) || total < 0) return 'Pendente';
  if (!total) return 'Sem questões';
  if (!available || !Number.isInteger(acertos) || acertos < 0 || acertos > total) return 'Pendente';
  return `${acertos}/${total}`;
}

function reportInterpretation(report) {
  if (report.nota_geral_dez === null) return 'A leitura ou a chave histórica está incompleta. Confira as pendências antes de emitir o boletim; os acertos por área e tema ficam pendentes até concluir a correção.';
  const score = report.geral;
  return 'O desempenho de cada área e tema é apresentado como acertos/total de questões. '+
    (report.status === 'ALERTA_REVISAO' || score.total_incertas ? 'Há respostas incertas: os acertos são provisórios até a revisão do professor. ' : '')+
    `${score.total_brancos} ${score.total_brancos === 1 ? 'resposta em branco' : 'respostas em branco'} e ${score.total_rasuras} ${score.total_rasuras === 1 ? 'marcação dupla' : 'marcações duplas'} não pontuam e permanecem no total. Confira as questões indicadas nas prioridades de revisão.`;
}

function reportMethodology() {
  return 'Desempenho objetivo por área e tema: quantidade de acertos / total de questões. Brancos e duplas não pontuam e permanecem no denominador; não há anulação oficial de questões. Este boletim não calcula a TRI do ENEM. Redação: avaliação manual de 0 a 1000.';
}

/** Keep custom subjects visible; do not repeat an identical ENEM area card. */
function reportAdditionalThemes(report) {
  return report.temas.filter(theme => !report.areas.some(area => area.area === theme.tema &&
    area.total_questoes === theme.total_questoes && area.total_acertos === theme.total_acertos));
}

module.exports = {formatReportCount, reportInterpretation, reportMethodology, reportAdditionalThemes};

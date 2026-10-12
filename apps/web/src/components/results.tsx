'use client';
import { useId, useState } from 'react';
import Link from 'next/link';
import { Search, Eye, Upload, Download, Trash2, CheckCircle2, Users, AlertTriangle, BarChart3 } from 'lucide-react';
import type { ResultsData, Resultado } from '@enem/shared';
import { useResource } from '@/lib/use-resource';
import { dateText } from '@/lib/api';
import { Alert, BackLink, Badge, Empty, Loading, Modal } from './ui';
import { ResultTabs } from './result-tabs';
import { AnswerReview } from './answer-review';

export function ResultsView({simuladoId, envioId}: {simuladoId?: number; envioId?: number}) {
  const endpoint = envioId ? `/envios/${envioId}` : `/simulados/${simuladoId}/resultados`;
  const {data, loading, error, refresh} = useResource<ResultsData>(endpoint);
  const [search, setSearch] = useState(''), [selected, setSelected] = useState<Resultado | null>(null);
  const [selectedTheme, setSelectedTheme] = useState<string | null>(null);
  const tabsId = useId();
  if (loading) return <Loading/>;
  if (error || !data) return <><BackLink/><Alert kind="error">{error || 'Resultados não encontrados.'}</Alert><button className="button outline" onClick={refresh}>Tentar novamente</button></>;
  const {simulado, indicadores: stats, envio} = data;
  const themes = [...new Set(simulado.temas.map(range => range.tema))];
  const covered = simulado.temas.reduce((sum, range) => sum + range.fim - range.inicio + 1, 0);
  if (themes.length && covered < simulado.total_questoes && !themes.includes('Sem tema')) themes.push('Sem tema');
  const activeTheme = selectedTheme !== null && themes.includes(selectedTheme) ? selectedTheme : null;
  const tabIndex = activeTheme === null ? 0 : themes.indexOf(activeTheme) + 1;
  const themeQuestions = activeTheme === null ? [] : Array.from({length: simulado.total_questoes}, (_, i) => i + 1)
    .filter(q => (simulado.temas.find(range => range.inicio <= q && range.fim >= q)?.tema || 'Sem tema') === activeTheme);
  const filtered = data.resultados.filter(row => row.matricula.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <><BackLink/><div className="page-heading"><div><span className="eyebrow">{envio ? `ENVIO #${envio.id}` : 'TODAS AS PROVAS'}</span><h1>{simulado.titulo}</h1><p>{envio ? `Enviado em ${dateText(envio.criado_em)}` : `${stats.total_provas} provas armazenadas em ${stats.total_envios} envios. Novas provas se somam às anteriores.`}</p></div><div className="actions">
    {envio && <Link className="button primary" href={`/simulado/${simulado.id}/resultados`}>Todas as provas</Link>}
    <Link className="button outline" href={`/simulado/${simulado.id}/upload`}><Upload size={17}/>Adicionar provas</Link>
    <Link className="button outline" href={`/simulado/${simulado.id}/boletins`}>Boletins dos alunos</Link>
    <a className="button success" href={`/api${envio ? `/envios/${envio.id}` : `/simulados/${simulado.id}`}/exportar`}><Download size={17}/>Exportar Excel</a>
    <Link className="button danger-outline" href={`/simulado/${simulado.id}/deletar`}><Trash2 size={16}/>Excluir simulado</Link>
  </div></div>
    <div className="metrics"><div className="metric"><span><Users size={18}/>Total de provas</span><strong>{stats.total_provas}</strong></div><div className="metric green"><span><BarChart3 size={18}/>Média das notas confirmadas</span><strong>{stats.media_nota.toLocaleString('pt-BR')}%</strong></div><div className="metric amber"><span><AlertTriangle size={18}/>Marcações duplas</span><strong>{stats.rasura_count}</strong></div><div className="metric teal"><span><CheckCircle2 size={18}/>Leituras sem alertas</span><strong>{stats.sucesso_count}</strong></div></div>
    {(stats.revisao_count > 0 || stats.erro_count > 0) && <Alert kind="warning">{stats.revisao_count} provas precisam de revisão e {stats.erro_count} tiveram falha de leitura. Notas com * são provisórias; essas provas não entram na média.</Alert>}
    {simulado.temas.length > 0 && <section className="card theme-overview"><div className="section-heading between"><h2>Temas do simulado · {simulado.total_questoes} questões</h2><Link className="button outline small" href={`/simulado/${simulado.id}`}>Editar temas</Link></div><div className="theme-list">{simulado.temas.map(range => <span className="theme-tag" key={range.inicio}><strong>{range.inicio}–{range.fim}</strong>{range.tema}</span>)}</div><p className="help">Use as abas da tabela para consultar cada tema. O Excel inclui a nota geral e uma aba para cada tema. Questões fora dos intervalos aparecem como “Sem tema”.</p></section>}
    <section className="card"><div className="section-heading between table-heading"><h2>{envio ? 'Provas deste envio' : 'Todas as provas do simulado'}</h2><label className="search"><Search size={17}/><input placeholder="Buscar matrícula..." aria-label="Buscar matrícula" value={search} onChange={event => setSearch(event.target.value)}/></label></div>
      {themes.length > 0 && <ResultTabs id={tabsId} themes={themes} selected={activeTheme} onChange={setSelectedTheme}/>}
      <div id={`${tabsId}-panel`} role={themes.length ? 'tabpanel' : undefined} aria-labelledby={themes.length ? `${tabsId}-tab-${tabIndex}` : undefined} tabIndex={themes.length ? 0 : undefined}>
      {activeTheme !== null && <div className="active-theme"><div><h3>Desempenho em {activeTheme}</h3><p>{themeQuestions.length} questões neste tema · A nota considera somente essas questões.</p></div><span className="count">{themeQuestions.length} questões</span></div>}
      {!data.resultados.length ? <Empty>Nenhuma prova enviada ainda. Adicione as primeiras provas para começar.</Empty> : <div className="table-scroll"><table aria-label={activeTheme === null ? 'Resultados gerais' : `Resultados de ${activeTheme}`}><thead><tr><th>Matrícula</th><th>Envio</th><th>{activeTheme === null ? 'Nota' : 'Nota no tema'}</th><th>Acertos</th><th>Erros</th><th>Duplas</th><th>Brancos</th><th>Revisar</th><th>Status</th><th>Espelho</th></tr></thead><tbody>
        {filtered.map(row => {
          const score = activeTheme === null ? row : row.desempenho_temas.find(theme => theme.tema === activeTheme);
          const readable = !!score && row.status !== 'ERRO_LEITURA';
          const countAvailable = !!score && (activeTheme === null || readable);
          return <tr key={row.id}><td className="matricula">{row.matricula}</td><td><Link className="envio-badge" href={`/lote/${row.lote_id}`}>#{row.lote_id}</Link></td><td className={`score ${readable && score.nota_percentual >= 70 ? 'positive' : ''}`}>{readable ? `${score.nota_percentual.toLocaleString('pt-BR')}%${row.total_incertas ? '*' : ''}` : '—'}</td><td><span className="number success-number">{countAvailable ? `${score.total_acertos}${activeTheme !== null ? `/${themeQuestions.length}` : ''}` : '—'}</span></td><td><span className="number error-number">{countAvailable ? score.total_erros : '—'}</span></td><td><span className="number warning-number">{countAvailable ? score.total_rasuras : '—'}</span></td><td>{countAvailable ? score.total_brancos : '—'}</td><td>{countAvailable ? score.total_incertas : '—'}</td><td><Badge status={row.status}/>{row.mensagem_leitura && <p className="reading-message">{row.mensagem_leitura}</p>}</td><td><button className="button outline small" type="button" onClick={() => setSelected(row)} aria-label={`Ver espelho da matrícula ${row.matricula}`}><Eye size={16}/>Ver</button></td></tr>;
        })}
        {!filtered.length && <tr><td colSpan={10}><Empty>Nenhuma matrícula encontrada.</Empty></td></tr>}
      </tbody></table></div>}
      </div>
      {activeTheme !== null && <p className="help table-foot">Acertos, erros, duplas, brancos e questões a revisar correspondem ao tema selecionado. O status se refere à leitura da prova inteira; notas com * são provisórias.</p>}
      {!themes.length && <p className="help table-foot">Cadastre os <Link href={`/simulado/${simulado.id}`}>intervalos de temas no gabarito</Link> para consultar o desempenho por tema.</p>}
      {data.resultados.length > 0 && <p className="help table-foot">Cada linha corresponde a uma prova armazenada. Reenvios da mesma matrícula são mantidos no histórico.</p>}
    </section>
    {selected && <Modal title={`Espelho · ${selected.matricula}`} onClose={() => setSelected(null)}><div className="mirror-grid"><aside><div className="mirror-summary"><Badge status={selected.status}/><h3>{selected.status === 'ERRO_LEITURA' ? 'Leitura indisponível' : `${selected.nota_percentual}%${selected.total_incertas ? ' · provisória' : ''}`}</h3><p>Envio #{selected.lote_id} · {dateText(selected.criado_em)}</p><dl><div><dt>Acertos</dt><dd>{selected.total_acertos}/{simulado.total_questoes}</dd></div><div><dt>Erros</dt><dd>{selected.total_erros}</dd></div><div><dt>Marcações duplas</dt><dd>{selected.total_rasuras}</dd></div><div><dt>Em branco</dt><dd>{selected.total_brancos}</dd></div><div><dt>Revisar</dt><dd>{selected.total_incertas}</dd></div></dl></div>
      {selected.mensagem_leitura && <Alert kind="warning">{selected.mensagem_leitura}</Alert>}
      {selected.desempenho_temas.length > 0 && <div className="theme-results"><h4>Acertos por tema</h4>{selected.desempenho_temas.map(theme => <div key={theme.tema}><strong>{theme.tema}</strong><span>{selected.status === 'ERRO_LEITURA' ? 'Leitura indisponível' : `${theme.total_acertos}/${theme.total_questoes} · ${theme.nota_percentual.toLocaleString('pt-BR')}%${selected.total_incertas ? ' (provisório)' : ''}`}</span></div>)}</div>}
      <div className="legend"><span><i className="green-dot"/>Correta</span><span><i className="red-dot"/>Erro ou dupla</span><span><i className="yellow-dot"/>Gabarito oficial</span><span><i className="blue-dot"/>Leitura incerta</span></div><p className="help">A tinta original foi preservada. BNK = em branco; RAS = múltiplas marcações; INC = leitura incerta.</p>
      <div className="answer-detail">{Array.from({length: simulado.total_questoes}, (_, i) => <div key={i} title={simulado.temas.find(range => range.inicio <= i + 1 && range.fim >= i + 1)?.tema || 'Sem tema'}><span>Q{String(i + 1).padStart(2, '0')}</span><strong>{selected.respostas_detectadas[String(i + 1)] || '—'}</strong><small>({selected.gabarito_do_envio[String(i + 1)] || '—'})</small></div>)}</div>
    </aside><div className="mirror-image">{selected.imagem_debug ? <img src={selected.imagem_debug} alt={`Espelho de respostas da matrícula ${selected.matricula}`}/> : <Empty>Espelho indisponível para esta leitura.</Empty>}</div><AnswerReview id={selected.id} onSaved={proof => {setSelected(proof.resultado); refresh();}}/></div></Modal>}
  </>;
}

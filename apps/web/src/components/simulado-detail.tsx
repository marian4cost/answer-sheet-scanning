'use client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { KeyRound, Upload, Trash2, RefreshCw, ArrowRight, History } from 'lucide-react';
import type { AnswerKey, SimuladoDetail } from '@enem/shared';
import { useResource } from '@/lib/use-resource';
import { api, dateText, ACCEPT, FORMAT_TEXT, validateFiles, errorMessage } from '@/lib/api';
import { Alert, BackLink, Empty, Loading, useNotice } from './ui';
import { ThemesEditor } from './themes-editor';
import { KeyEditor } from './key-editor';
import { readKey } from '@/lib/uploads';
import { SharingPanel } from './simulation-sharing';
export function DetailView({id}: {id: number}) {
  const {data, loading, error, refresh} = useResource<SimuladoDetail>(`/simulados/${id}`);
  const [busy, setBusy] = useState(false), [formError, setFormError] = useState('');
  const [editedKey, setEditedKey] = useState<AnswerKey | null>(null);
  const notify = useNotice();
  async function update(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setFormError(''); const element = event.currentTarget;
    try {
      if (!editedKey || !data || Array.from({length: data.simulado.total_questoes}, (_, i) => editedKey[String(i + 1)]).some(answer => !/^[A-E]$/.test(answer || ''))) throw new Error('Confira uma alternativa A a E para cada questão.');
      setBusy(true);
      await api(`/simulados/${id}/gabarito`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({gabarito_manual: editedKey})});
      notify('Gabarito atualizado. As notas e as chaves dos envios anteriores foram preservadas.'); setEditedKey(null); refresh();
    } catch (error) { setFormError(errorMessage(error)); } finally { setBusy(false); }
  }
  async function read(file?: File) {
    if (!file || !data) return;
    setFormError(''); setBusy(true);
    try { const reading = await readKey(file, data.simulado.total_questoes); if (reading.status === 'ERRO_LEITURA') throw new Error(reading.erro_msg); setEditedKey(reading.respostas_detectadas); }
    catch (error) { setFormError(errorMessage(error)); } finally { setBusy(false); }
  }
  if (loading && !data) return <Loading/>;
  if (error || !data) return <><BackLink/><Alert kind="error">{error || 'Simulado não encontrado.'}</Alert></>;
  const {simulado, envios} = data;
  const editable=simulado.pode_editar!==false;
  return <><BackLink/><div className="page-heading"><div><span className="eyebrow">GABARITO OFICIAL</span><h1>{simulado.titulo}</h1><p>Cadastrado em {dateText(simulado.data_criacao)}</p></div><div className="actions"><Link className="button primary" href={`/simulado/${id}/resultados`}>Todas as provas ({simulado.total_provas})</Link>{editable&&<><Link className="button outline" href={`/simulado/${id}/upload`}><Upload size={17}/>Adicionar provas</Link><Link className="button danger-outline" href={`/simulado/${id}/deletar`}><Trash2 size={16}/>Excluir</Link></>}</div></div>
    {!editable&&<Alert>Compartilhado por {simulado.compartilhado_por?.nome||simulado.compartilhado_por?.email||'outro usuário'}. Você pode consultar as respostas deste simulado em modo de leitura.</Alert>}
    {simulado.expira_em && <Alert>Este simulado, os resultados, as redações e o histórico de envios serão excluídos em {dateText(simulado.expira_em)}. Exporte os arquivos antes dessa data.</Alert>}
    {!simulado.gabarito_valido && <Alert kind="warning">O gabarito atual está incompleto ou contém marcações inválidas. Reenvie uma folha com uma alternativa clara em cada questão.</Alert>}
    <div className="detail-grid"><section className="card"><div className="section-heading"><KeyRound size={21}/><h2>{simulado.total_questoes} alternativas oficiais</h2></div><div className="answer-key">{Array.from({length: simulado.total_questoes}, (_, i) => {
      const theme = simulado.temas.find(range => range.inicio <= i + 1 && range.fim >= i + 1)?.tema || 'Sem tema';
      return <div key={i} title={theme}><span>Q{String(i + 1).padStart(2, '0')}</span><strong>{simulado.gabarito_oficial[String(i + 1)] || '—'}</strong></div>;
    })}</div>
      {editable&&<div className="update-key"><h3><RefreshCw size={17}/>Atualizar folha oficial</h3><p className="help">{FORMAT_TEXT}, até 20 MB, com {simulado.total_questoes} questões. Os envios anteriores mantêm suas notas; novos envios usam a nova chave.</p><input type="file" aria-label="Nova folha oficial" accept={ACCEPT} disabled={busy} onChange={event => read(event.target.files?.[0])}/><button type="button" className="button outline" disabled={busy} onClick={() => setEditedKey({...simulado.gabarito_oficial})}>Editar alternativas atuais</button>{editedKey && <form onSubmit={update}><KeyEditor count={simulado.total_questoes} value={editedKey} onChange={setEditedKey} disabled={busy}/><button className="button primary" disabled={busy} type="submit">Confirmar novo gabarito</button></form>}{formError && <Alert kind="error">{formError}</Alert>}</div>}
    </section><div className="stack">{editable?<><section className="card"><SharingPanel id={id}/></section><ThemesEditor key={JSON.stringify(simulado.temas)} simulado={simulado} onSaved={refresh}/></>:<section className="card"><h2>Temas do simulado</h2><div className="theme-list">{simulado.temas.map(range=><span className="theme-tag" key={range.inicio}><strong>{range.inicio}–{range.fim}</strong>{range.tema}</span>)}</div>{!simulado.temas.length&&<p className="help">O responsável ainda não cadastrou os temas.</p>}</section>}<section className="card"><div className="section-heading"><History size={21}/><h2>Histórico de envios</h2></div>{!envios.length ? <Empty>Nenhuma prova enviada para este simulado ainda.</Empty> : <div className="recent-list">{envios.map(envio => <Link key={envio.id} href={`/lote/${envio.id}`}><span className="recent-number">#{envio.id}</span><div><strong>{envio.total_provas} provas</strong><span>{dateText(envio.criado_em)}</span></div><ArrowRight size={17}/></Link>)}</div>}</section></div></div>
  </>;
}

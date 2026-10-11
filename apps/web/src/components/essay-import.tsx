'use client';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Check, FileSpreadsheet, Upload } from 'lucide-react';
import type { EssayImportPreview, EssayImportResult } from '@enem/shared/src/essay-import';
import { api, dateText, errorMessage } from '@/lib/api';
import { Alert, useNotice } from './ui';
import './essay-import.css';

const actionLabel = {NOVA:'Nova avaliação',ATUALIZAR:'Substitui avaliação',SEM_ALTERACAO:'Sem alteração',SEM_RESULTADO:'Sem prova neste simulado'};
export function EssayImport({id,onImported}:{id:number;onImported?:()=>void}) {
  const input = useRef<HTMLInputElement>(null);
  const [file,setFile] = useState<File|null>(null), [skipMissing,setSkipMissing] = useState(false);
  const [preview,setPreview] = useState<EssayImportPreview|null>(null), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const [confirmed,setConfirmed] = useState(false), [replace,setReplace] = useState(false), [result,setResult] = useState<EssayImportResult|null>(null);
  const notify = useNotice();
  function resetPreview() {setPreview(null);setConfirmed(false);setReplace(false);setResult(null);setError('');}
  async function prepare(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();setError('');setResult(null);setPreview(null);setConfirmed(false);setReplace(false);
    if (!file) {setError('Selecione a planilha exportada do formulário de redações.');return;}
    if (!/\.(xlsx|csv)$/i.test(file.name) || !file.size || file.size > 2 * 1024 * 1024) {setError('Envie uma planilha XLSX ou CSV válida com até 2 MB.');return;}
    try {
      setBusy(true);const body = new FormData();body.append('arquivo',file);if(skipMissing) body.append('ignorar_sem_resultado','sim');
      setPreview(await api<EssayImportPreview>(`/simulados/${id}/redacoes/preview`,{method:'POST',body}));
    } catch(error) {setError(errorMessage(error));} finally {setBusy(false);}
  }
  async function importRows() {
    if (!preview?.token || !confirmed || (preview.atualizacoes && !replace)) return;
    try {
      setBusy(true);setError('');
      const outcome = await api<EssayImportResult>(`/simulados/${id}/redacoes/importar`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:preview.token,confirmar:'sim',atualizar_existentes:replace ? 'sim' : 'nao'})});
      setResult(outcome);setPreview(null);setFile(null);if(input.current) input.current.value='';
      setConfirmed(false);setReplace(false);notify(outcome.message);onImported?.();
    } catch(error) {setError(errorMessage(error));} finally {setBusy(false);}
  }
  return <section className="card essay-import" aria-label="Importação de notas de redação"><div className="section-heading"><FileSpreadsheet size={21}/><h2>Importar avaliações de redação</h2></div>
    <p className="help">Exporte as respostas do Google Forms como XLSX ou CSV. A associação usa a matrícula exata das provas deste simulado. Cada competência vai de 0 a 200; a nota final é a soma das cinco. As observações do professor aparecem no boletim.</p>
    <form onSubmit={prepare} className="essay-import-form"><label className="field-label" htmlFor={`essay-import-${id}`}>Planilha de avaliações</label><input ref={input} id={`essay-import-${id}`} type="file" accept=".xlsx,.csv" disabled={busy} onChange={event=>{setFile(event.target.files?.[0] || null);resetPreview();}}/>
      <label className="essay-import-check"><input type="checkbox" checked={skipMissing} disabled={busy} onChange={event=>{setSkipMissing(event.target.checked);resetPreview();}}/>Ignorar avaliações cuja matrícula ainda não tem prova neste simulado. Elas serão indicadas na prévia.</label>
      <button className="button outline" type="submit" disabled={busy || !file}><Upload size={17}/>{busy ? 'Processando...' : 'Conferir planilha'}</button>
    </form>
    {error && <Alert kind="error">{error}</Alert>}{result && <Alert kind="success">{result.message} Os boletins foram atualizados. Esta importação não envia emails.</Alert>}
    {preview && <div className="essay-import-preview"><h3>Prévia da importação</h3><p>{preview.total} avaliação(ões): {preview.novas} nova(s), {preview.atualizacoes} atualização(ões), {preview.sem_alteracao} sem alteração e {preview.sem_resultado} sem prova. {preview.total_resultados} correção(ões) associada(s).</p>
      {preview.erros.length > 0 && <Alert kind="error"><strong>A importação foi bloqueada. Corrija estas informações:</strong><ul>{preview.erros.map((message,index)=><li key={index}>{message}</li>)}</ul></Alert>}
      {preview.avisos.length > 0 && <Alert kind="warning"><ul>{preview.avisos.map((message,index)=><li key={index}>{message}</li>)}</ul></Alert>}
      {preview.linhas.length > 0 && <div className="table-scroll"><table aria-label="Prévia de avaliações de redação"><thead><tr><th>Linha / matrícula</th><th>Aluno</th><th>C1</th><th>C2</th><th>C3</th><th>C4</th><th>C5</th><th>Total</th><th>Alteração</th><th>Professor e observações</th></tr></thead><tbody>{preview.linhas.map(row=><tr key={`${row.linha}-${row.matricula}`}><td><span className="essay-import-sub">Linha {row.linha}</span><strong>{row.matricula}</strong></td><td>{row.nome || 'Não informado'}</td>{row.competencias.map((note,index)=><td key={index}>{note.toLocaleString('pt-BR')}</td>)}<td><strong>{row.nota_redacao.toLocaleString('pt-BR')}/1000</strong></td><td><strong className={`essay-import-action action-${row.acao.toLowerCase()}`}>{actionLabel[row.acao]}</strong>{row.resultado_ids.length > 0 && <span className="essay-import-sub">Correções: {row.resultado_ids.map(resultId=>`#${resultId}`).join(', ')}</span>}{!!row.anteriores?.length && <details className="essay-import-previous"><summary>Avaliação atual</summary>{row.anteriores.map(old=><div key={old.resultado_id}><strong>Correção #{old.resultado_id}: {old.nota_redacao === null ? 'Sem nota' : old.nota_redacao+'/1000'}</strong>{old.competencias.length === 5 && <p>C1 a C5: {old.competencias.join(' / ')}</p>}<p className="essay-import-feedback">{old.feedback_redacao || 'Sem observações'}</p></div>)}</details>}</td><td><strong>{row.avaliador || 'Não informado'}</strong>{row.situacao && <span className="essay-import-sub">{row.situacao}</span>}<p className="essay-import-feedback">{row.feedback_redacao || 'Sem observações'}</p></td></tr>)}</tbody></table></div>}
      {!!preview.token && <div className="essay-import-confirmation"><p className="help">Prévia válida até {dateText(preview.expira_em)}. Reenvios da mesma matrícula recebem a mesma avaliação neste simulado; provas de outros simulados permanecem como estão.</p>
        <label className="essay-import-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)}/>Conferi as matrículas, as notas por competência, as observações e as correções associadas.</label>
        {preview.atualizacoes > 0 && <label className="essay-import-check"><input type="checkbox" checked={replace} disabled={busy} onChange={event=>setReplace(event.target.checked)}/>Confirmo substituir as {preview.atualizacoes} avaliação(ões) existentes indicadas na prévia.</label>}
        <button type="button" className="button primary" disabled={busy || !confirmed || (!!preview.atualizacoes && !replace)} onClick={importRows}><Check size={17}/>{busy ? 'Importando...' : 'Confirmar importação das redações'}</button>
      </div>}
    </div>}
  </section>;
}

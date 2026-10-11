'use client';
import { useEffect, useRef, useState } from 'react';
import { Download, FileText } from 'lucide-react';
import type { StudentReport } from '@enem/shared/src/reports';
import './public-report.css';

type PublicStudentReport = Omit<StudentReport, 'resultado_id'|'simulado_id'|'email'|'content_hash'|'apto_envio'|'pendencias'|'avisos'>;
type Access = {boletim:PublicStudentReport; instituicao:string; expira_em:string};
const note = (value:number|null) => value === null ? 'Pendente' : value.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}) + ' / 10';
const date = (value:string) => new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short',timeZone:'America/Fortaleza'}).format(new Date(value));
const INVALID_LINK = 'Abra o link completo recebido por e-mail. Se ele expirou ou foi substituído, solicite um novo acesso ao professor.';
async function failure(response:Response) {
  const body = await response.json().catch(()=>null);
  return new Error(typeof body?.message === 'string' ? body.message : 'Não foi possível consultar o boletim. Tente novamente mais tarde.');
}
export function PublicReport() {
  const token = useRef<string|null>(null);
  const [access,setAccess] = useState<Access|null>(null), [error,setError] = useState(''), [loading,setLoading] = useState(true), [downloading,setDownloading] = useState(false);
  useEffect(()=>{
    let controller: AbortController | undefined;
    const consult = () => {
      // Keep the credential only in memory; remove it before making the POST request.
      const fragment = window.location.hash.slice(1);
      if (fragment) {
        window.history.replaceState(null,'',window.location.pathname);
        token.current = /^[A-Za-z0-9_-]{43}$/.test(fragment) ? fragment : '';
      } else if (token.current === null) token.current = '';
      controller?.abort();setAccess(null);setError('');setLoading(true);
      if (!token.current) { setError(INVALID_LINK); setLoading(false); return; }
      const active = controller = new AbortController();
      fetch('/api/boletim/consultar',{method:'POST',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json','X-OMR-Client':'web'},body:JSON.stringify({token:token.current}),signal:active.signal})
      .then(async response=>{ if (!response.ok) throw await failure(response); return response.json() as Promise<Access>; })
      .then(value=>{if (!active.signal.aborted) setAccess(value);}).catch(reason=>{if (!active.signal.aborted) setError(reason instanceof Error ? reason.message : INVALID_LINK);})
      .finally(()=>{if (!active.signal.aborted) setLoading(false);});
    };
    consult();
    window.addEventListener('hashchange',consult);
    return ()=>{window.removeEventListener('hashchange',consult);controller?.abort();};
  },[]);
  async function download() {
    if (!token.current || downloading) return;
    setDownloading(true); setError('');
    try {
      const response = await fetch('/api/boletim/pdf',{method:'POST',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json','X-OMR-Client':'web'},body:JSON.stringify({token:token.current})});
      if (!response.ok) throw await failure(response);
      const blob = await response.blob();
      if (blob.type !== 'application/pdf') throw new Error('Não foi possível gerar o PDF. Tente novamente.');
      const url = URL.createObjectURL(blob), anchor = document.createElement('a');
      anchor.href = url; anchor.download = 'Boletim_Individual.pdf'; anchor.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Não foi possível baixar o boletim.'); }
    finally {setDownloading(false);}
  }
  if (loading) return <section className="card student-access-state" aria-live="polite"><FileText size={28}/><h1>Consultando seu boletim…</h1></section>;
  if (!access) return <section className="card student-access-state"><h1>Acesso ao boletim</h1><p role="alert">{error || INVALID_LINK}</p><p>O professor pode emitir um novo link para você.</p></section>;
  const report = access.boletim;
  return <article className="card student-report">
    <div className="student-report-band">{access.instituicao}</div>
    <div className="student-report-body">
      <div className="student-report-heading"><div><p className="eyebrow">Boletim individual</p><h1>{report.nome}</h1><p>{report.titulo}</p></div><button className="button primary" onClick={download} disabled={downloading}><Download size={17}/>{downloading?'Gerando PDF…':'Baixar PDF'}</button></div>
      {error && <p className="alert" role="alert">{error}</p>}
      <dl className="student-report-info"><div><dt>Matrícula</dt><dd>{report.matricula}</dd></div><div><dt>Curso</dt><dd>{report.curso || 'Não informado'}</dd></div><div><dt>Acesso disponível até</dt><dd>{date(access.expira_em)}</dd></div></dl>
      <h2>Desempenho por área</h2>
      <div className="student-score-grid">{report.areas.map(area=><section key={area.area}><h3>{area.area}</h3><strong>{area.total_questoes ? note(area.nota_dez) : 'Sem questões'}</strong><p>{area.total_acertos} acertos em {area.total_questoes} questões</p></section>)}<section className="student-overall"><h3>Nota objetiva geral</h3><strong>{note(report.nota_geral_dez)}</strong><p>{report.geral.total_acertos} acertos em {report.total_questoes} questões</p></section></div>
      <h2>Leitura do resultado</h2><p className="student-interpretation">{report.interpretacao}</p>
      <h2>Redação</h2><p className="student-essay-note"><strong>{report.redacao.nota_redacao === null ? 'Avaliação ainda não informada' : `${report.redacao.nota_redacao} / 1000`}</strong></p>
      {!!report.redacao.competencias_redacao?.length && <div className="student-competencies">{report.redacao.competencias_redacao.map((value,index)=><div key={index}><span>Competência {index+1}</span><strong>{value} / 200</strong></div>)}</div>}
      {report.redacao.situacao_redacao && <p>Situação: {report.redacao.situacao_redacao}</p>}
      {report.redacao.avaliador_redacao && <p>Professor(a): {report.redacao.avaliador_redacao}</p>}
      <p className="student-feedback">{report.redacao.feedback_redacao || 'Feedback ainda não informado pelo professor.'}</p>
      <h2>Prioridades de revisão</h2><div className="student-priorities">{report.prioridades.map(priority=><section key={priority.area}><h3>{priority.area}</h3><p>Incorretas: {priority.incorretas.join(', ') || 'nenhuma'}<br/>Em branco: {priority.brancos.join(', ') || 'nenhuma'}<br/>Marcações duplas: {priority.duplas.join(', ') || 'nenhuma'}<br/>Incertas: {priority.incertas.join(', ') || 'nenhuma'}</p></section>)}</div>
      <details className="student-question-detail"><summary>Ver respostas por questão</summary><div className="student-table-wrap"><table><thead><tr><th>Questão</th><th>Área/tema</th><th>Resposta</th><th>Gabarito</th><th>Resultado</th></tr></thead><tbody>{report.questoes.map(question=><tr key={question.numero}><td>{question.numero}</td><td>{question.tema}</td><td>{question.resposta}</td><td>{question.gabarito}</td><td>{question.resultado}</td></tr>)}</tbody></table></div></details>
      <p className="student-methodology">{report.metodologia}</p><p className="student-access-note">Mantenha seu link em sigilo. Ele permite consultar este boletim até o prazo informado. Ao fechar esta página, use o link original do e-mail para abrir o boletim novamente.</p>
    </div>
  </article>;
}

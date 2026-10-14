'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Upload, FileText, Image as ImageIcon, X, ScanLine, Check, RotateCcw } from 'lucide-react';
import type { SimuladoDetail } from '@enem/shared';
import type { ProofImportPlan } from '@enem/shared/src/proof-import';
import { useResource } from '@/lib/use-resource';
import { api, ACCEPT, FORMAT_TEXT, validateFiles, errorMessage, dateText } from '@/lib/api';
import { Alert, BackLink, Loading, useNotice } from './ui';
import { prepareProofImport } from '@/lib/uploads';

const labels = {PENDENTE:'Aguardando identificação',CONFIRMADA:'Identificada',AUSENTE:'Não encontrada',AMBIGUA:'Mais de uma matrícula',INCERTA:'Conferência necessária'};
const checkStyle = {width:'auto',padding:0,flexShrink:0} as const;
const checkLabelStyle = {display:'flex',alignItems:'flex-start',gap:9,margin:'12px 0',fontSize:13} as const;
const pause = () => new Promise(resolve => setTimeout(resolve, 1000));

export function UploadView({id}: {id: number}) {
  const {data, loading, error} = useResource<SimuladoDetail>(`/simulados/${id}`);
  const [files,setFiles] = useState<File[]>([]), [fileError,setFileError] = useState('');
  const [plan,setPlan] = useState<ProofImportPlan|null>(null), [jobs,setJobs] = useState<ProofImportPlan[]>([]);
  const [matriculas,setMatriculas] = useState<Record<string,string>>({}), [included,setIncluded] = useState<Record<string,boolean>>({});
  const [reviewed,setReviewed] = useState(false), [allowDuplicates,setAllowDuplicates] = useState(false);
  const [busy,setBusy] = useState(false), [dragging,setDragging] = useState(false), [phase,setPhase] = useState('');
  const input = useRef<HTMLInputElement>(null), mounted = useRef(true), activePlanId = useRef<string|null>(null);
  const router = useRouter(), notify = useNotice();

  useEffect(() => {
    mounted.current = true;
    api<{importacoes:ProofImportPlan[]}>(`/simulados/${id}/provas/importacoes`)
      .then(result => {if(mounted.current) setJobs(result.importacoes);})
      .catch(failure => {if(mounted.current) setFileError(errorMessage(failure));});
    return () => {mounted.current = false;};
  },[id]);

  function applyPlan(next:ProofImportPlan, reset=false) {
    if (!mounted.current) return;
    activePlanId.current = next.id;setPlan(next);
    setJobs(values => [next,...values.filter(value=>value.id!==next.id)].filter(value=>value.estado!=='CONCLUIDA'));
    setMatriculas(values => Object.fromEntries(next.paginas.map(page=>[page.id,!reset && values[page.id] ? values[page.id] : page.matricula || page.matricula_detectada || ''])));
    setIncluded(values => Object.fromEntries(next.paginas.map(page=>[page.id,!reset && values[page.id] !== undefined ? values[page.id] : page.estado!=='IGNORADA'])));
    if(reset) {setReviewed(false);setAllowDuplicates(false);}
  }
  function select(selected:File[]) {
    setFileError('');setReviewed(false);setAllowDuplicates(false);
    try {validateFiles(selected);setFiles(selected);} catch(failure) {setFiles([]);setFileError(errorMessage(failure));}
  }
  async function handleFailure(failure:unknown) {
    if (!mounted.current) return;
    let detail = '';
    if(activePlanId.current) {
      try {const latest=await api<ProofImportPlan>(`/provas/importacoes/${activePlanId.current}`);applyPlan(latest);detail=` ${latest.total_concluidas} página(s) concluída(s) ou ignorada(s) permanecem registradas. Use a opção de continuar ou retomar abaixo.`;} catch {detail=' As páginas concluídas permanecem armazenadas. Reabra esta tela para retomar a importação.';}
    } else {
      // A criação pode ter sido gravada mesmo quando a resposta foi interrompida.
      try {const latest=await api<{importacoes:ProofImportPlan[]}>(`/simulados/${id}/provas/importacoes`);if(mounted.current) setJobs(latest.importacoes);if(latest.importacoes.length) detail=' Confira as importações para retomar antes de enviar os mesmos arquivos novamente.';} catch {detail=' Reabra esta tela e confira as importações para retomar antes de reenviar os arquivos.';}
    }
    setFileError(errorMessage(failure)+detail);
  }
  async function identify(initial:ProofImportPlan) {
    let current=initial, unchanged=0;
    while(mounted.current && current.estado==='PREVIA' && current.total_identificadas<current.total_paginas) {
      setPhase(`Identificando páginas e matrículas: ${current.total_identificadas} de ${current.total_paginas}.`);
      const next=await api<ProofImportPlan>(`/provas/importacoes/${current.id}/identificar`,{method:'POST'});
      applyPlan(next);
      unchanged=next.total_identificadas===current.total_identificadas ? unchanged+1 : 0;
      current=next;
      if(unchanged>=3) throw new Error('A identificação ainda está em andamento em outra solicitação. Aguarde um momento e continue a identificação.');
      if(unchanged) await pause();
    }
    return current;
  }
  async function process(initial:ProofImportPlan) {
    let current=initial, unchanged=0;
    while(mounted.current && current.estado==='CONFIRMADA') {
      setPhase(`Corrigindo e salvando páginas: ${current.paginas.filter(page=>page.estado==='CONCLUIDA').length} concluída(s) de ${current.paginas.filter(page=>page.estado!=='IGNORADA').length}.`);
      const next=await api<ProofImportPlan>(`/provas/importacoes/${current.id}/processar`,{method:'POST'});
      applyPlan(next);
      unchanged=next.total_concluidas===current.total_concluidas && next.estado===current.estado ? unchanged+1 : 0;
      current=next;
      if(unchanged>=3) throw new Error('Há uma correção em andamento em outra solicitação. Aguarde um momento e use Retomar correção.');
      if(unchanged) await pause();
    }
    if(mounted.current && current.estado==='CONCLUIDA') {
      notify(`${current.paginas.filter(page=>page.estado==='CONCLUIDA').length} página(s) corrigida(s) e armazenada(s). Confira os alertas nos resultados.`);
      router.push(`/simulado/${id}/resultados`);
    }
    return current;
  }
  async function start() {
    setFileError('');
    try {
      validateFiles(files);setBusy(true);setPhase('Enviando arquivos e preparando as páginas...');
      const prepared=await prepareProofImport(id,files);applyPlan(prepared,true);setFiles([]);if(input.current) input.current.value='';
      await identify(prepared);
    } catch(failure) {await handleFailure(failure);} finally {if(mounted.current) {setBusy(false);setPhase('');}}
  }
  async function resume(jobId:string) {
    setFileError('');setBusy(true);setPhase('Consultando a importação armazenada...');
    try {
      const latest=await api<ProofImportPlan>(`/provas/importacoes/${jobId}`);applyPlan(latest,true);
      if(latest.estado==='PREVIA') await identify(latest);
      else if(latest.estado==='CONFIRMADA') await process(latest);
    } catch(failure) {await handleFailure(failure);} finally {if(mounted.current) {setBusy(false);setPhase('');}}
  }
  async function cancel() {
    if(!plan) return;
    setBusy(true);setFileError('');setPhase('Cancelando a importação...');
    try {
      await api(`/provas/importacoes/${plan.id}/cancelar`,{method:'POST'});
      setJobs(values=>values.filter(value=>value.id!==plan.id));setPlan(null);activePlanId.current=null;
      setMatriculas({});setIncluded({});setReviewed(false);setAllowDuplicates(false);
      notify('Importação cancelada. Os resultados já concluídos permanecem armazenados.');
    } catch(failure) {await handleFailure(failure);} finally {if(mounted.current) {setBusy(false);setPhase('');}}
  }
  const selected=plan?.paginas.filter(page=>included[page.id]) || [];
  const missing=selected.some(page=>!matriculas[page.id]?.trim());
  const duplicateIds=new Set<string>(), seen=new Set<string>();
  for(const page of selected) {const value=matriculas[page.id]?.trim();if(value) {if(seen.has(value)) duplicateIds.add(value);seen.add(value);}}
  const identified=!!plan && plan.total_identificadas===plan.total_paginas;
  async function confirm() {
    if(!plan || !identified || !reviewed || !selected.length || missing || (duplicateIds.size>0 && !allowDuplicates)) return;
    setFileError('');setBusy(true);setPhase('Confirmando matrículas e páginas selecionadas...');
    try {
      const next=await api<ProofImportPlan>(`/provas/importacoes/${plan.id}/confirmar`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        confirmar:'sim',permitir_repetidas:allowDuplicates ? 'sim' : 'nao',
        paginas:plan.paginas.map(page=>({id:page.id,incluir:!!included[page.id],matricula:matriculas[page.id] || ''})),
      })});
      applyPlan(next);await process(next);
    } catch(failure) {await handleFailure(failure);} finally {if(mounted.current) {setBusy(false);setPhase('');}}
  }

  if(loading) return <Loading/>;
  if(error || !data) return <><BackLink/><Alert kind="error">{error || 'Simulado não encontrado.'}</Alert></>;
  if(data.simulado.pode_editar===false)return <><BackLink/><Alert>Somente o responsável pode adicionar provas. Seu acesso a este simulado é apenas para leitura.</Alert><Link className="button outline" href={`/simulado/${id}/resultados`}>Ver respostas</Link></>;
  return <div className="narrow"><BackLink href={`/simulado/${id}/resultados`}>Voltar aos resultados</BackLink>
    <div className="page-heading"><div><span className="eyebrow">CORREÇÃO DA TURMA</span><h1>Adicionar provas</h1><p>{data.simulado.titulo}</p></div><span className="count">{data.simulado.total_questoes} questões</span></div>
    <section className="card"><div className="stored-info"><div><strong>{data.simulado.total_provas} provas já armazenadas</strong><p>As novas provas serão somadas aos resultados anteriores.</p></div><Link href={`/simulado/${id}/resultados`}>Ver todas as provas →</Link></div>
      {!data.simulado.gabarito_valido ? <Alert kind="warning">Atualize o <Link href={`/simulado/${id}`}>gabarito oficial</Link> antes de corrigir novas provas.</Alert> : <>
        {!plan && jobs.length>0 && <section style={{marginBottom:24}}><h2>Importações para retomar</h2><p className="help">Os arquivos e o progresso estão salvos. Continue uma importação após fechar o navegador ou interromper a conexão.</p>
          <div className="table-scroll"><table aria-label="Importações armazenadas"><thead><tr><th>Início</th><th>Progresso</th><th>Ação</th></tr></thead><tbody>{jobs.map(job=><tr key={job.id}><td>{dateText(job.criado_em)}</td><td>{job.total_arquivos} arquivo(s), {job.total_paginas} página(s)<br/>{job.estado==='PREVIA' ? `${job.total_identificadas} identificada(s)` : `${job.total_concluidas} concluída(s) ou ignorada(s)`}</td><td><button className="button outline small" type="button" disabled={busy} onClick={()=>resume(job.id)}><RotateCcw size={15}/>Retomar</button></td></tr>)}</tbody></table></div>
        </section>}
        {!plan && <><div className={`drop-zone ${dragging ? 'dragging' : ''}`} onDragOver={event=>{event.preventDefault();if(!busy) setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={event=>{event.preventDefault();setDragging(false);if(!busy) select(Array.from(event.dataTransfer.files));}}>
          <span className="upload-icon"><Upload size={30}/></span><h2>Envie o PDF da turma ou cartões individuais</h2><p>Arraste PDFs ou imagens, ou selecione no computador.</p><button className="button outline" type="button" disabled={busy} onClick={()=>input.current?.click()}>Selecionar arquivos</button>
          <input ref={input} type="file" id="pdf_files" name="pdf_files" accept={ACCEPT} multiple hidden disabled={busy} onChange={event=>select(Array.from(event.target.files || []))}/>
          <p className="help">{FORMAT_TEXT} · até 20 MB por arquivo · até 50 arquivos · até 100 páginas no total</p>
        </div><p className="help upload-help">Cada página do PDF representa um cartão. A matrícula é lida do conteúdo da página, inclusive em imagens individuais. Fotografe a folha inteira e confira a identificação antes de corrigir.</p>
          {files.length>0 && <div className="file-preview"><div className="section-heading between"><h3>Arquivos selecionados</h3><span className="count">{files.length}</span></div><ul>{files.map((file,index)=><li key={`${file.name}-${index}`}>{file.name.toLowerCase().endsWith('.pdf') ? <FileText size={18}/> : <ImageIcon size={18}/>}<div><strong>{file.name}</strong><span>{(file.size/1024).toFixed(1)} KB</span></div><button className="icon-button" type="button" aria-label={`Remover ${file.name}`} disabled={busy} onClick={()=>setFiles(values=>values.filter((_,i)=>i!==index))}><X size={17}/></button></li>)}</ul></div>}
          <button className="button primary full" type="button" disabled={busy || !files.length} onClick={start}><ScanLine size={18}/>Identificar páginas e matrículas</button>
        </>}
        {plan && <section aria-label="Conferência de páginas e matrículas"><div className="section-heading between"><h2>{plan.estado==='PREVIA' ? 'Conferir matrículas por página' : 'Correção da importação'}</h2><span className="count">{plan.total_paginas} páginas</span></div>
          <p className="help">{plan.total_arquivos} arquivo(s). Identificação: {plan.total_identificadas}/{plan.total_paginas} páginas. Correção armazenada: {plan.paginas.filter(page=>page.estado==='CONCLUIDA').length} página(s). Prévia disponível até {dateText(plan.expira_em)}.</p>
          {plan.estado==='PREVIA' && <Alert>Confira cada matrícula no original. Se a leitura estiver ausente ou incerta, digite a matrícula correta ou desmarque a página para deixá-la fora desta importação. Os zeros iniciais são preservados.</Alert>}
          {plan.estado==='PREVIA' && identified && <div className="actions" style={{marginBottom:14}}><button className="button outline small" type="button" disabled={busy} onClick={()=>{setIncluded(Object.fromEntries(plan.paginas.map(page=>[page.id,true])));setReviewed(false);}}>Selecionar todas</button><button className="button outline small" type="button" disabled={busy} onClick={()=>{setIncluded(Object.fromEntries(plan.paginas.map(page=>[page.id,!!matriculas[page.id]?.trim()])));setReviewed(false);}}>Selecionar páginas com matrícula</button></div>}
          <div className="table-scroll"><table aria-label="Páginas e matrículas identificadas"><thead><tr><th>Incluir</th><th>Arquivo / página</th><th>Identificação</th><th>Matrícula</th><th>Original / resultado</th></tr></thead><tbody>{plan.paginas.map(page=><tr key={page.id}>
            <td><input style={checkStyle} type="checkbox" aria-label={`Incluir página ${page.pagina} de ${page.arquivo}`} checked={!!included[page.id]} disabled={busy || !identified || plan.estado!=='PREVIA'} onChange={event=>{setIncluded(values=>({...values,[page.id]:event.target.checked}));setReviewed(false);}}/></td>
            <td><strong style={{overflowWrap:'anywhere'}}>{page.arquivo}</strong><br/>Página {page.pagina}</td>
            <td><span className={`status ${page.identificacao==='CONFIRMADA' ? 'sucesso' : 'alerta_revisao'}`}>{labels[page.identificacao]}</span>{page.fonte && <p className="reading-message">{page.fonte==='pdf_texto' ? 'Texto do PDF' : 'Leitura da imagem (OCR)'}</p>}{page.candidatas.length>0 && page.identificacao!=='CONFIRMADA' && <p className="reading-message">Candidatas: {page.candidatas.join(', ')}</p>}{page.mensagem && <p className="reading-message">{page.mensagem}</p>}</td>
            <td><input type="text" style={{minWidth:165}} maxLength={100} autoComplete="off" aria-label={`Matrícula da página ${page.pagina} de ${page.arquivo}`} value={matriculas[page.id] || ''} disabled={busy || !identified || plan.estado!=='PREVIA'} onChange={event=>{setMatriculas(values=>({...values,[page.id]:event.target.value}));setReviewed(false);}}/>{page.estado==='CONCLUIDA' && <span className="help">Armazenada</span>}{page.estado==='IGNORADA' && <span className="help">Fora da importação</span>}</td>
            <td><a className="button outline small" href={`/api/provas/importacoes/${plan.id}/arquivo/${page.arquivo_indice}#page=${page.pagina}`} target="_blank" rel="noreferrer">Original</a>{page.resultado_id && <Link className="button outline small" style={{marginTop:7}} href={`/simulado/${id}/resultados`}>Correção #{page.resultado_id}</Link>}</td>
          </tr>)}</tbody></table></div>
          {plan.estado==='PREVIA' && identified && <div style={{marginTop:20}}>
            <p><strong>{selected.length} página(s) selecionada(s)</strong> e {plan.total_paginas-selected.length} fora desta importação.</p>
            {missing && <Alert kind="warning">Preencha a matrícula de todas as páginas selecionadas ou desmarque as que precisam ser conferidas depois.</Alert>}
            {!!duplicateIds.size && <Alert kind="warning"><div>Matrículas repetidas: {Array.from(duplicateIds).join(', ')}. Cada cartão será salvo como uma prova distinta no histórico.</div><label style={checkLabelStyle}><input style={checkStyle} type="checkbox" checked={allowDuplicates} disabled={busy} onChange={event=>setAllowDuplicates(event.target.checked)}/>Conferi os originais e confirmo que os cartões da mesma matrícula são provas distintas.</label></Alert>}
            <label style={checkLabelStyle}><input style={checkStyle} type="checkbox" checked={reviewed} disabled={busy || !selected.length || missing} onChange={event=>setReviewed(event.target.checked)}/>Conferi as matrículas e as {selected.length} página(s) selecionada(s), com {plan.total_paginas-selected.length} página(s) fora desta importação.</label>
            <button className="button primary full" type="button" disabled={busy || !reviewed || !selected.length || missing || (!!duplicateIds.size && !allowDuplicates)} onClick={confirm}><Check size={18}/>Confirmar matrículas e corrigir {selected.length} página(s)</button>
          </div>}
          <div className="actions" style={{marginTop:20}}>
            {plan.estado==='PREVIA' && !identified && <button className="button primary" type="button" disabled={busy} onClick={()=>resume(plan.id)}><RotateCcw size={17}/>Continuar identificação</button>}
            {plan.estado==='CONFIRMADA' && <button className="button primary" type="button" disabled={busy} onClick={()=>resume(plan.id)}><RotateCcw size={17}/>Retomar correção</button>}
            {plan.estado==='CONCLUIDA' && <Link className="button primary" href={`/simulado/${id}/resultados`}>Ver resultados armazenados</Link>}
            <button className="button danger-outline" type="button" disabled={busy} onClick={cancel}>Cancelar importação</button>
          </div><p className="help">Cancelar a importação conserva os resultados já concluídos. Importar ou corrigir provas não envia emails.</p>
        </section>}
        {busy && <Loading text={phase || 'Processando páginas...'}/>}
      </>}
      {fileError && <div style={{marginTop:20}}><Alert kind="error">{fileError}</Alert></div>}
    </section></div>;
}

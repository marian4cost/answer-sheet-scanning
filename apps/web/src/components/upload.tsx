'use client';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Upload, FileText, Image as ImageIcon, X, ScanLine } from 'lucide-react';
import type { SimuladoDetail, UploadResult } from '@enem/shared';
import { useResource } from '@/lib/use-resource';
import { api, ACCEPT, FORMAT_TEXT, validateFiles, errorMessage } from '@/lib/api';
import { Alert, BackLink, Loading, useNotice } from './ui';
import { uploadProofs } from '@/lib/uploads';
export function UploadView({id}: {id: number}) {
  const {data, loading, error} = useResource<SimuladoDetail>(`/simulados/${id}`);
  const [files, setFiles] = useState<File[]>([]), [fileError, setFileError] = useState('');
  const [matriculas, setMatriculas] = useState<string[]>([]), [done, setDone] = useState(0);
  const [busy, setBusy] = useState(false), [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter(); const notify = useNotice();
  function select(selected: File[]) {
    setFileError('');
    try { validateFiles(selected); setFiles(selected); setMatriculas(selected.map(file => file.name.replace(/\.[^.]+$/, '').slice(0, 100))); setDone(0); }
    catch (error) { setFiles([]); setFileError(errorMessage(error)); }
  }
  async function submit() {
    setFileError('');
    let completed = 0;
    try {
      validateFiles(files); setBusy(true); setDone(0);
      const result = await uploadProofs(id, files, matriculas, value => {completed = value; setDone(value);});
      notify(result.message); router.push(`/simulado/${id}/resultados`);
    } catch (error) {
      if (completed) {setFiles(values => values.slice(completed)); setMatriculas(values => values.slice(completed));}
      setFileError(errorMessage(error) + (completed ? ` ${completed} provas concluídas já foram armazenadas e removidas da seleção. Consulte os resultados antes de reenviar as restantes.` : ' Consulte os resultados antes de reenviar após uma interrupção.'));
    } finally { setBusy(false); }
  }
  if (loading) return <Loading/>;
  if (error || !data) return <><BackLink/><Alert kind="error">{error || 'Simulado não encontrado.'}</Alert></>;
  return <div className="narrow"><BackLink href={`/simulado/${id}/resultados`} children="Voltar aos resultados"/><div className="page-heading"><div><span className="eyebrow">CORREÇÃO DA TURMA</span><h1>Adicionar provas</h1><p>{data.simulado.titulo}</p></div><span className="count">{data.simulado.total_questoes} questões</span></div>
    <section className="card"><div className="stored-info"><div><strong>{data.simulado.total_provas} provas já armazenadas</strong><p>As novas provas serão somadas aos resultados anteriores.</p></div><Link href={`/simulado/${id}/resultados`}>Ver todas as provas →</Link></div>
      {!data.simulado.gabarito_valido ? <Alert kind="warning">Atualize o <Link href={`/simulado/${id}`}>gabarito oficial</Link> antes de corrigir novas provas.</Alert> : <>
      <div className={`drop-zone ${dragging ? 'dragging' : ''}`} onDragOver={event => {event.preventDefault(); if (!busy) setDragging(true);}} onDragLeave={() => setDragging(false)} onDrop={event => {event.preventDefault(); setDragging(false); if (!busy) select(Array.from(event.dataTransfer.files));}}>
        <span className="upload-icon"><Upload size={30}/></span><h2>Arraste seus PDFs ou imagens aqui</h2><p>ou selecione os arquivos no computador</p><button className="button outline" type="button" disabled={busy} onClick={() => input.current?.click()}>Selecionar arquivos</button>
        <input ref={input} type="file" id="pdf_files" name="pdf_files" accept={ACCEPT} multiple hidden disabled={busy} onChange={event => select(Array.from(event.target.files || []))}/>
        <p className="help">{FORMAT_TEXT} · até 20 MB por arquivo · até 50 arquivos por envio</p>
      </div><p className="help upload-help">Um cartão por arquivo. Confira a matrícula de cada aluno abaixo; ela será associada ao e-mail da planilha. Fotografe a folha inteira. Em PDFs, lemos a primeira página.</p>
      {files.length > 0 && <div className="file-preview"><div className="section-heading between"><h3>Arquivos selecionados</h3><span className="count">{files.length}</span></div><ul>{files.map((file, index) => <li key={`${file.name}-${index}`}>{file.name.toLowerCase().endsWith('.pdf') ? <FileText size={18}/> : <ImageIcon size={18}/>}<div><strong>{file.name}</strong><span>{(file.size / 1024).toFixed(1)} KB</span><label>Matrícula<input aria-label={`Matrícula de ${file.name}`} maxLength={100} value={matriculas[index] || ''} disabled={busy} onChange={event => setMatriculas(values => values.map((value, i) => i === index ? event.target.value : value))}/></label></div><button className="icon-button" aria-label={`Remover ${file.name}`} disabled={busy} onClick={() => {setFiles(values => values.filter((_, i) => i !== index)); setMatriculas(values => values.filter((_, i) => i !== index));}}><X size={17}/></button></li>)}</ul></div>}
      {fileError && <Alert kind="error">{fileError}</Alert>}
      {busy && <Loading text={`Lendo ${files.length} prova(s) e identificando as alternativas... ${done ? `${done} armazenadas.` : ''}`}/>}
      <button className="button primary full" disabled={busy || !files.length} type="button" onClick={submit}><ScanLine size={18}/>{busy ? 'Processando provas...' : `Processar${files.length ? ` ${files.length}` : ''} provas`}</button>
      </>}
    </section></div>;
}

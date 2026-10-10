'use client';
import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Download, Search, Upload, UserRoundCheck, Check } from 'lucide-react';
import type { ContactImportPreview, StudentContact } from '@enem/shared/src/reports';
import { api, errorMessage, dateText } from '@/lib/api';
import { useResource } from '@/lib/use-resource';
import { Alert, BackLink, Empty, Loading, useNotice } from './ui';
import './report-ui.css';

export function ContactsView() {
  const {data, loading, error, refresh} = useResource<{contatos: StudentContact[]}>('/contatos');
  const [busy, setBusy] = useState(false), [formError, setFormError] = useState('');
  const [preview, setPreview] = useState<ContactImportPreview | null>(null);
  const [search, setSearch] = useState(''), [page, setPage] = useState(0), [previewPage, setPreviewPage] = useState(0);
  const notify = useNotice();
  const filtered = useMemo(() => (data?.contatos || []).filter(contact => [contact.matricula,contact.nome,contact.email,contact.curso || ''].some(value => value.toLocaleLowerCase().includes(search.toLocaleLowerCase()))), [data,search]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 25) - 1));
  async function read(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setFormError(''); setPreview(null);
    const form = new FormData(event.currentTarget), file = form.get('arquivo') as File;
    if (!file?.size || file.size > 2 * 1024 * 1024) {setFormError('Selecione uma planilha de até 2 MB.'); return;}
    if (!/\.(csv|xlsx)$/i.test(file.name)) {setFormError('Use uma planilha CSV ou XLSX.'); return;}
    try {setBusy(true); setPreview(await api<ContactImportPreview>('/contatos/preview', {method:'POST',body:form})); setPreviewPage(0);}
    catch (error) {setFormError(errorMessage(error));} finally {setBusy(false);}
  }
  async function confirm() {
    if (!preview?.token) return;
    try {
      setBusy(true); setFormError('');
      const result = await api<{message:string}>('/contatos/importar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:preview.token,confirmar:'sim'})});
      notify(result.message); setPreview(null); refresh();
    } catch(error) {setFormError(errorMessage(error));} finally {setBusy(false);}
  }
  return <><BackLink/><div className="page-heading"><div><span className="eyebrow">MATRÍCULAS E DESTINATÁRIOS</span><h1>Contatos dos alunos</h1><p>Associe cada matrícula ao email correto para preparar os boletins.</p></div><a className="button outline" href="/api/contatos/modelo.csv"><Download size={17}/>Baixar modelo CSV</a></div>
    <div className="contacts-grid"><section className="card"><div className="section-heading"><Upload size={21}/><h2>Importar planilha</h2></div>
      <p className="help">Colunas obrigatórias: <strong>Matrícula</strong> e <strong>Email</strong> ou <strong>Email Acadêmico</strong>. <strong>Nome</strong> e <strong>Curso</strong> ou <strong>Descrição do Curso</strong> são opcionais. O relatório com abas Registros e Filtros é aceito. Use CSV ou XLSX, até 2 MB e 10.000 contatos. Sem a coluna curso, os cursos já cadastrados são preservados.</p>
      <Alert>Formate a coluna de matrícula como <strong>Texto</strong> no Excel. Assim, <strong>000123</strong> continua diferente de <strong>123</strong>. A matrícula deve ser a mesma usada no envio da prova.</Alert>
      <form onSubmit={read}><label className="field-label" htmlFor="contacts-file">Planilha de contatos</label><input id="contacts-file" name="arquivo" type="file" accept=".csv,.xlsx" required disabled={busy} onChange={() => {setPreview(null);setFormError('');}}/><label className="report-confirm"><input type="checkbox" name="ignorar_sem_email" value="sim" disabled={busy} onChange={()=>setPreview(null)}/>Ignorar linhas sem e-mail (serão indicadas na prévia)</label><button className="button primary full" type="submit" disabled={busy}>{busy ? 'Processando...' : 'Ver prévia da importação'}</button></form>
      <p className="help">A planilha será validada antes de salvar. Matrículas repetidas ou linhas inválidas precisam ser corrigidas; contatos existentes aparecem como atualizações na prévia.</p>
      {formError && <Alert kind="error">{formError}</Alert>}
    </section><section className="card"><div className="section-heading"><UserRoundCheck size={21}/><h2>Como funciona a associação</h2></div><ol className="report-steps"><li>Use a matrícula exata da prova na planilha de contatos.</li><li>Confira nomes e emails na prévia e confirme a importação.</li><li>Abra os boletins do simulado para informar a redação e revisar o conteúdo.</li><li>Selecione os alunos e confira os destinatários antes de enviar.</li></ol><Alert kind="info">Importar contatos não envia mensagens. O envio acontece apenas após a confirmação na tela de boletins.</Alert></section></div>
    {preview && <section className="card report-section"><div className="section-heading between"><h2>Prévia · {preview.total} contatos válidos</h2><span className="count">Ainda não importados</span></div>
      {preview.erros.length > 0 && <Alert kind="error"><strong>Corrija {preview.erros.length} problema(s) e envie a planilha novamente.</strong><ul className="report-messages">{preview.erros.slice(0,20).map((message,i) => <li key={i}>{message}</li>)}</ul>{preview.erros.length > 20 && <p>Mais {preview.erros.length - 20} erros encontrados.</p>}</Alert>}
      {preview.avisos.length > 0 && <Alert kind="warning"><strong>Avisos da importação</strong><ul className="report-messages">{preview.avisos.slice(0,20).map((message,i) => <li key={i}>{message}</li>)}</ul>{preview.avisos.length > 20 && <p>Mais {preview.avisos.length - 20} avisos encontrados.</p>}</Alert>}
      <ContactsTable contacts={preview.contatos.slice(previewPage * 25, previewPage * 25 + 25)}/><Paging page={previewPage} total={preview.total} onChange={setPreviewPage}/>
      <div className="actions end"><button className="button outline" type="button" disabled={busy} onClick={() => setPreview(null)}>Cancelar prévia</button><button className="button primary" type="button" disabled={busy || !preview.token || preview.erros.length > 0} onClick={confirm}><Check size={17}/>{busy ? 'Importando...' : `Confirmar importação de ${preview.total} contatos`}</button></div><p className="help">Prévia válida até {dateText(preview.expira_em)}. Confira todas as páginas antes de confirmar.</p>
    </section>}
    <section className="card report-section"><div className="section-heading between table-heading"><h2>Contatos cadastrados · {data?.contatos.length || 0}</h2><label className="search"><Search size={17}/><input aria-label="Buscar contato" placeholder="Matrícula, nome ou email..." value={search} onChange={event => {setSearch(event.target.value);setPage(0);}}/></label></div>
      {loading && !data ? <Loading/> : error ? <><Alert kind="error">{error}</Alert><button className="button outline" onClick={refresh}>Tentar novamente</button></> : !filtered.length ? <Empty>{search ? 'Nenhum contato encontrado.' : 'Nenhum contato cadastrado. Importe a primeira planilha.'}</Empty> : <><ContactsTable contacts={filtered.slice(currentPage * 25,currentPage * 25 + 25)}/><Paging page={currentPage} total={filtered.length} onChange={setPage}/></>}
    </section></>;
}
function ContactsTable({contacts}:{contacts:StudentContact[]}) {
  return <div className="table-scroll"><table aria-label="Matrículas e emails"><thead><tr><th>Matrícula</th><th>Nome</th><th>Curso</th><th>Email</th></tr></thead><tbody>{contacts.map(contact => <tr key={contact.matricula}><td className="matricula">{contact.matricula}</td><td>{contact.nome || 'Não informado'}</td><td>{contact.curso || 'Não informado'}</td><td className="report-email">{contact.email}</td></tr>)}</tbody></table></div>;
}
function Paging({page,total,onChange}:{page:number;total:number;onChange:(page:number)=>void}) {
  if (total <= 25) return null;
  const pages = Math.ceil(total / 25);
  return <div className="report-paging"><span>Página {page + 1} de {pages} · {total} contatos</span><div className="actions"><button className="button outline small" type="button" disabled={page === 0} onClick={() => onChange(page - 1)}>Anterior</button><button className="button outline small" type="button" disabled={page + 1 === pages} onClick={() => onChange(page + 1)}>Próxima</button></div></div>;
}

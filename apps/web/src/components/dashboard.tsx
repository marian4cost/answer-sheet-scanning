'use client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FileCheck2, Upload, ArrowRight, Eye, Trash2, Clock3, Plus, Files, ScanLine, Share2 } from 'lucide-react';
import type { AnswerKey, DashboardData, Simulado, ThemeRange } from '@enem/shared';
import { useResource } from '@/lib/use-resource';
import { api, ACCEPT, FORMAT_TEXT, validateFiles, errorMessage, dateText } from '@/lib/api';
import { Alert, Empty, Loading, useNotice } from './ui';
import { ThemeFields, validateThemes } from './theme-fields';
import { KeyEditor } from './key-editor';
import { readKey } from '@/lib/uploads';

export function Dashboard() {
  const {data, error, loading, refresh} = useResource<DashboardData>('/simulados');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [selected, setSelected] = useState('');
  const [count, setCount] = useState(50), [themes, setThemes] = useState<ThemeRange[]>([]);
  const [key, setKey] = useState<AnswerKey | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const router = useRouter();
  const notify = useNotice();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setFormError('');
    const form = new FormData(event.currentTarget);
    try {
      validateThemes(themes, count);
      if (!key || Array.from({length: count}, (_, i) => key[String(i + 1)]).some(answer => !/^[A-E]$/.test(answer || ''))) throw new Error('Confira uma alternativa A a E para cada questão antes de salvar.');
      setBusy(true);
      form.delete('gabarito_pdf'); form.set('gabarito_manual', JSON.stringify(key));
      const simulado = await api<Simulado>('/simulados', {method: 'POST', body: form});
      notify(`Simulado cadastrado. Confira as ${simulado.total_questoes} alternativas antes de corrigir a turma.`);
      router.push(`/simulado/${simulado.id}`);
    } catch (error) { setFormError(errorMessage(error)); } finally { setBusy(false); }
  }
  async function read() {
    setFormError('');
    try {
      if (!file) throw new Error('Selecione a folha oficial.');
      if (count < 50 || count > 60 || !Number.isInteger(count)) throw new Error('Informe de 50 a 60 questões.');
      setBusy(true); const reading = await readKey(file, count);
      if (reading.status === 'ERRO_LEITURA') throw new Error(reading.erro_msg || 'Não foi possível localizar a folha.');
      setKey(reading.respostas_detectadas);
    } catch (error) { setFormError(errorMessage(error)); } finally { setBusy(false); }
  }
  const owned = data?.simulados.filter(simulado=>simulado.acesso!=='compartilhado')||[];
  const received = data?.simulados.filter(simulado=>simulado.acesso==='compartilhado')||[];
  return <>
    <div className="page-heading"><div><span className="eyebrow">PAINEL DE CORREÇÃO</span><h1>Seus simulados</h1><p>Cadastre o gabarito oficial, acompanhe a turma e consulte os simulados compartilhados com você.</p></div><div className="summary-pill"><Files size={18}/><strong>{data?.total_provas ?? '—'}</strong> provas acessíveis</div></div>
    {data?.retencao_dias && <Alert>Seu histórico e seus contatos são privados. Somente os simulados que você compartilhar ficam visíveis aos usuários escolhidos. Os simulados são excluídos automaticamente após {data.retencao_dias} dias do cadastro; o compartilhamento mantém esse prazo.</Alert>}
    <div className="dashboard-grid">
      <section className="card create-card"><div className="section-heading"><span className="step">01</span><div><h2>Cadastrar simulado</h2><p>Comece pela folha oficial do professor.</p></div></div>
        <form onSubmit={submit}>
          <label className="field-label" htmlFor="titulo">Título do simulado</label><input id="titulo" name="titulo" maxLength={255} placeholder="Ex.: Simulado ENEM 2026 · 1º dia" required disabled={busy}/>
          <label className="field-label" htmlFor="total_questoes">Quantidade de questões</label><input id="total_questoes" name="total_questoes" type="number" min={50} max={60} required disabled={busy} value={count || ''} onChange={event => {setCount(Number(event.target.value)); setKey(null);}}/>
          <p className="help">De 50 a 60 questões, alternativas A a E, em duas colunas: {Math.ceil(count / 2)} à esquerda e {Math.floor(count / 2)} à direita.</p>
          <label className="official-file" htmlFor="gabarito_pdf"><span className="upload-icon"><FileCheck2 size={30}/></span><strong>Folha do gabarito oficial</strong><span>{selected || 'Selecione o PDF ou uma imagem preenchida'}</span>
            <input id="gabarito_pdf" name="gabarito_pdf" type="file" accept={ACCEPT} disabled={busy} onChange={event => {const chosen = event.target.files?.[0] || null; setSelected(chosen?.name || ''); setFile(chosen); setKey(null);}}/>
          </label>
          <p className="help">{FORMAT_TEXT}. Até 20 MB. Uma alternativa por questão, com a folha inteira e legível. O PDF do gabarito oficial deve conter uma única página.</p>
          <div className="actions"><button className="button outline" type="button" disabled={busy || !file} onClick={read}>{busy ? 'Lendo...' : 'Ler folha para conferir'}</button><button className="button outline" type="button" disabled={busy} onClick={() => setKey({})}>Digitar gabarito</button></div>
          {key && <KeyEditor count={count} value={key} onChange={setKey} disabled={busy}/>}
          <ThemeFields count={count} value={themes} onChange={setThemes} disabled={busy}/>
          {formError && <Alert kind="error">{formError}</Alert>}
          <button className="button primary full" disabled={busy || !key} type="submit"><ScanLine size={18}/>{busy ? 'Aguarde...' : 'Confirmar gabarito e criar simulado'}{!busy && <ArrowRight size={18}/>}</button>
          {busy && <Loading text={`Localizando as ${count} questões com OpenCV...`}/>}
        </form>
      </section>
      <div className="stack"><section className="card"><div className="section-heading between"><h2>Simulados ativos</h2><span className="count">{owned.length}</span></div>
        {loading ? <Loading/> : error ? <><Alert kind="error">{error}</Alert><button onClick={refresh} className="button outline">Tentar novamente</button></> : !owned.length ? <Empty>Nenhum simulado cadastrado. Envie a folha oficial para começar.</Empty> :
          <div className="simulado-list">{owned.map(simulado=><SimulationCard key={simulado.id} simulado={simulado}/>)}</div>}
      </section>
      <section className="card"><div className="section-heading between"><h2><Share2 size={19}/> Compartilhados comigo</h2><span className="count">{received.length}</span></div>{loading?<Loading/>:!received.length?<p className="help">Os simulados compartilhados com sua conta aparecerão aqui. O acesso permite consultar respostas e espelhos, sem editar os resultados.</p>:<div className="simulado-list">{received.map(simulado=><SimulationCard key={simulado.id} simulado={simulado}/>)}</div>}</section>
      <section className="card"><div className="section-heading"><Clock3 size={20}/><h2>Últimos envios</h2></div>
        {!data?.envios_recentes.length ? <p className="help">Os envios da turma aparecerão aqui.</p> : <div className="recent-list">{data.envios_recentes.map(envio => <Link key={envio.id} href={`/lote/${envio.id}`}><span className="recent-number">#{envio.id}</span><div><strong>{envio.titulo}</strong><span>{dateText(envio.criado_em)} · {envio.total_provas} provas</span></div><ArrowRight size={16}/></Link>)}</div>}
      </section></div>
    </div>
  </>;
}
function SimulationCard({simulado}:{simulado:Simulado}) {
  const editable=simulado.pode_editar!==false;
  return <article className="simulado-item">
    {simulado.expira_em&&<p className="help">Disponível até {dateText(simulado.expira_em)}</p>}<div className="simulado-title"><h3>{simulado.titulo}</h3><span>{dateText(simulado.data_criacao)}</span></div>
    {!editable&&<p className="help"><Share2 size={14}/> Compartilhado por {simulado.compartilhado_por?.nome||simulado.compartilhado_por?.email||'outro usuário'} · Somente leitura</p>}
    <p className="help"><strong>{simulado.total_provas}</strong> provas · {simulado.total_envios} envios · {simulado.total_questoes} questões</p>
    {!simulado.gabarito_valido&&<span className="status alerta_revisao">{editable?'Atualize o gabarito oficial':'Gabarito indisponível; consulte o responsável'}</span>}
    <div className="actions"><Link className="button primary small" href={`/simulado/${simulado.id}/resultados`}>Resultados ({simulado.total_provas})</Link>{editable&&<><Link className="button outline small" href={`/simulado/${simulado.id}/boletins`}>Boletins</Link><Link className="button outline small" href={`/simulado/${simulado.id}/upload`}><Plus size={15}/>Adicionar provas</Link></>}<Link className="button icon-button" href={`/simulado/${simulado.id}`} aria-label={`Ver gabarito de ${simulado.titulo}`}><Eye size={17}/></Link>{editable&&<Link className="button danger-outline small" href={`/simulado/${simulado.id}/deletar`} aria-label={`Excluir simulado ${simulado.titulo}`}><Trash2 size={15}/>Excluir</Link>}</div>
  </article>;
}

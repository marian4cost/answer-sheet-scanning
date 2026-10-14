'use client';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { CheckCheck, History, Save } from 'lucide-react';
import type { AnswerKey, Resultado, Simulado } from '@enem/shared';
import { api, dateText, errorMessage } from '@/lib/api';
import { useResource } from '@/lib/use-resource';
import { Alert, Badge, Loading, useNotice } from './ui';
import styles from './answer-review.module.css';

type ReviewedProof = {resultado: Resultado; simulado: Simulado};
const labels: Record<string, string> = {BNK: 'Em branco', RAS: 'Marcação dupla', INC: 'Leitura incerta'};
const options = ['A', 'B', 'C', 'D', 'E', 'BNK', 'RAS'];
const answerText = (answer?: string) => answer ? labels[answer] || answer : 'Não identificada';

export function AnswerReview({id, showImage = false, onSaved}: {id: number; showImage?: boolean; onSaved: (proof: ReviewedProof) => void}) {
  const {data, loading, error, refresh} = useResource<ReviewedProof>(`/resultados/${id}`);
  const [answers, setAnswers] = useState<AnswerKey>({}), [reason, setReason] = useState('');
  const [onlyUncertain, setOnlyUncertain] = useState(true), [busy, setBusy] = useState(false), [saveError, setSaveError] = useState('');
  const notify = useNotice();
  useEffect(() => {setAnswers({}); setReason(''); setSaveError('');}, [data]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data) return;
    setBusy(true); setSaveError('');
    try {
      const saved = await api<ReviewedProof>(`/resultados/${id}/revisao`, {method: 'PUT', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({versao_esperada: data.resultado.revisao_versao || 0, respostas: answers, motivo: reason})});
      notify(saved.resultado.status === 'ERRO_LEITURA' ? 'Conferência parcial salva. A nota será liberada após revisar todas as questões.'
        : saved.resultado.total_incertas ? 'Conferência salva. A nota permanece provisória enquanto houver respostas incertas.'
        : 'Conferência salva. Notas e desempenho por tema foram recalculados.');
      onSaved(saved); refresh();
    } catch (error) {setSaveError(errorMessage(error));} finally {setBusy(false);}
  }
  if (loading) return <div className={styles.panel}><Loading/></div>;
  if (error || !data) return <div className={styles.panel}><Alert kind="error">{error || 'Não foi possível carregar as respostas.'}</Alert><button type="button" className="button outline" onClick={refresh}>Atualizar respostas</button></div>;
  const {resultado: proof, simulado} = data;
  const questions = Array.from({length: simulado.total_questoes}, (_, i) => String(i + 1));
  const uncertain = questions.filter(q => proof.respostas_detectadas[q] === 'INC');
  const visible = onlyUncertain && uncertain.length ? uncertain : questions;
  const failed = proof.status_original === 'ERRO_LEITURA';
  if(simulado.pode_editar===false)return <section className={styles.panel} aria-label="Respostas compartilhadas do cartão"><div className={styles.heading}><h2><CheckCheck size={21}/>Respostas do cartão</h2><Badge status={proof.status}/></div><p className="help">Acesso somente para leitura. A conferência das respostas é feita pelo responsável pelo simulado.</p><div className={styles.questions}>{questions.map(q=><div key={q} className={`${styles.question} ${proof.respostas_detectadas[q]==='INC'?styles.uncertain:''}`}><strong>Questão {q}<span>Gabarito: {proof.gabarito_do_envio[q]||'Indisponível'}</span></strong><small>Identificador: {answerText(proof.respostas_originais?.[q]||proof.respostas_detectadas[q])}</small><small>Resposta atual: {answerText(proof.respostas_detectadas[q])}{proof.questoes_revisadas?.includes(Number(q))?' · conferida':''}</small></div>)}</div>{!!proof.revisoes?.length&&<details className={styles.history}><summary><History size={17}/>Histórico de conferências ({proof.revisoes.length})</summary>{proof.revisoes.map(review=><article key={review.id}><strong>Revisão {review.versao} · {dateText(review.criado_em)}</strong><p>{review.motivo}</p><p>{Object.entries(review.alteracoes).map(([q,answer])=>`Q${q}: ${answerText(review.respostas_antes[q])} → ${answerText(answer)}`).join(' · ')}</p><small>Revisor: {review.revisor_nome||'Professor responsável'}</small></article>)}</details>}</section>;
  return <section id={`answer-review-${id}`} className={styles.panel} aria-label="Conferência manual das respostas">
    <div className={styles.heading}><div><span className="eyebrow">REVISÃO DO PROFESSOR</span><h2><CheckCheck size={21}/>Conferir respostas do cartão</h2></div><Badge status={proof.status}/></div>
    <p className="help">Confira a marcação na imagem e informe a alternativa realmente escolhida pelo aluno. Os círculos azuis indicam leituras incertas. A nota é calculada pelo gabarito deste envio; a leitura original permanece no histórico.</p>
    {failed && <Alert kind="warning">Esta prova teve falha de leitura. Para concluir a revisão, informe explicitamente a resposta de todas as {simulado.total_questoes} questões. Já conferidas: {proof.questoes_revisadas?.length || 0}/{simulado.total_questoes}. Você pode salvar em etapas.</Alert>}
    <div className={`${styles.workspace} ${showImage ? styles.withImage : ''}`}>
      {showImage && <div className={styles.image}>{proof.imagem_debug ? <><img src={proof.imagem_debug} alt={`Leitura original do cartão da matrícula ${proof.matricula}`}/><p className="help">A imagem preserva o resultado original do identificador. As decisões do professor aparecem nos campos e no boletim atualizado.</p></> : <Alert kind="warning">Imagem de conferência indisponível. Confira o cartão original antes de informar as respostas.</Alert>}</div>}
      <form onSubmit={save} className={styles.form}>
        {!!uncertain.length && <div className={styles.filters}><button type="button" className={`button small ${onlyUncertain ? 'primary' : 'outline'}`} aria-pressed={onlyUncertain} onClick={() => setOnlyUncertain(true)}>Somente incertas ({uncertain.length})</button><button type="button" className={`button small ${!onlyUncertain ? 'primary' : 'outline'}`} aria-pressed={!onlyUncertain} onClick={() => setOnlyUncertain(false)}>Todas as questões</button></div>}
        <div className={styles.questions}>{visible.map(q => <label key={q} className={`${styles.question} ${proof.respostas_detectadas[q] === 'INC' ? styles.uncertain : ''} ${answers[q] ? styles.changed : ''}`}>
          <strong>Questão {q}<span>Gabarito: {proof.gabarito_do_envio[q] || 'Indisponível'}</span></strong>
          <small>Identificador: {answerText(proof.respostas_originais ? proof.respostas_originais[q] : proof.respostas_detectadas[q])}</small>
          <small>Atual: {answerText(proof.respostas_detectadas[q])}{proof.questoes_revisadas?.includes(Number(q)) ? ' · conferida' : ''}</small>
          <select aria-label={`Resposta conferida da questão ${q}`} value={answers[q] || ''} disabled={busy} onChange={event => setAnswers(previous => {
            const next = {...previous}; if (event.target.value) next[q] = event.target.value; else delete next[q]; return next;
          })}><option value="">{failed && !proof.questoes_revisadas?.includes(Number(q)) ? 'Informe a marcação...' : 'Manter resposta atual'}</option>{options.map(answer => <option key={answer} value={answer}>{answerText(answer)}</option>)}</select>
        </label>)}</div>
        <p className="help">{Object.keys(answers).length} questão(ões) selecionada(s) nesta revisão. Selecionar novamente a mesma alternativa registra que ela foi conferida.</p>
        <label className="field-label" htmlFor={`answer-reason-${id}`}>Motivo da conferência</label>
        <textarea id={`answer-reason-${id}`} className={styles.reason} minLength={3} maxLength={1000} required rows={3} value={reason} disabled={busy} placeholder="Ex.: conferi os círculos azuis com o cartão original e confirmei as alternativas." onChange={event => setReason(event.target.value)}/>
        {saveError && <Alert kind="error">{saveError} <button type="button" className="button outline small" disabled={busy} onClick={refresh}>Atualizar espelho</button></Alert>}
        <div className={styles.actions}><span className="help">Revisão atual: {proof.revisao_versao || 0}</span><button type="submit" className="button primary" disabled={busy || !Object.keys(answers).length || reason.trim().length < 3}><Save size={17}/>{busy ? 'Salvando...' : 'Salvar conferência e recalcular'}</button></div>
        <p className={styles.deliveryNote}>Alterar uma resposta exige uma nova prévia de envio. Links de boletins anteriores deixam de abrir se o conteúdo mudar; o histórico de entregas permanece salvo. Nenhum e-mail é reenviado automaticamente.</p>
      </form>
    </div>
    {!!proof.revisoes?.length && <details className={styles.history}><summary><History size={17}/>Histórico de conferências ({proof.revisoes.length})</summary>{proof.revisoes.map(review => <article key={review.id}><strong>Revisão {review.versao} · {dateText(review.criado_em)}</strong><p>{review.motivo}</p><p>{Object.entries(review.alteracoes).map(([q, answer]) => `Q${q}: ${answerText(review.respostas_antes[q])} → ${answerText(answer)}`).join(' · ')}</p><small>Revisor: {review.revisor_nome || 'Professor responsável'}</small></article>)}</details>}
  </section>;
}

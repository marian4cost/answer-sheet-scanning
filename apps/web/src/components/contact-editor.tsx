'use client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Save } from 'lucide-react';
import type { StudentContact } from '@enem/shared/src/reports';
import { api, errorMessage } from '@/lib/api';
import { Alert, Modal } from './ui';
import styles from './contact-editor.module.css';

export function ContactEditor({contact,onClose,onSaved}: {contact:StudentContact;onClose:()=>void;onSaved:(contact:StudentContact)=>void}) {
  const [matricula,setMatricula] = useState(contact.matricula), [email,setEmail] = useState(contact.email);
  const [nome,setNome] = useState(contact.nome), [curso,setCurso] = useState(contact.curso || '');
  const [busy,setBusy] = useState(false), [error,setError] = useState('');
  async function save(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();setError('');setBusy(true);
    try {
      const saved = await api<StudentContact>(`/contatos/${encodeURIComponent(contact.matricula)}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({matricula,email,nome,curso,atualizado_em:contact.atualizado_em})});
      onSaved(saved);
    } catch(error) {setError(errorMessage(error));} finally {setBusy(false);}
  }
  return <Modal title="Editar contato do aluno" closeLabel="Fechar edição do contato" className={styles.dialog} preventClose={busy} onClose={onClose}>
    <form className={styles.form} onSubmit={save}>
      <p className="help">Atualize os dados usados na identificação e no envio do boletim deste aluno.</p>
      <label className="field-label" htmlFor="contact-matricula">Matrícula</label>
      <input id="contact-matricula" type="text" autoComplete="off" required maxLength={100} disabled={busy} value={matricula} onChange={event=>setMatricula(event.target.value)} aria-describedby="contact-matricula-help"/>
      <p id="contact-matricula-help" className="help">Use a matrícula exata da prova, mantendo os zeros iniciais. Alterá-la muda a associação do contato; as matrículas das provas já enviadas permanecem como estão.</p>
      <label className="field-label" htmlFor="contact-nome">Nome completo <span className={styles.optional}>(opcional)</span></label>
      <input id="contact-nome" type="text" autoComplete="off" maxLength={150} disabled={busy} value={nome} onChange={event=>setNome(event.target.value)}/>
      <label className="field-label" htmlFor="contact-email">E-mail</label>
      <input id="contact-email" type="email" autoComplete="off" required maxLength={254} disabled={busy} value={email} onChange={event=>setEmail(event.target.value)}/>
      <label className="field-label" htmlFor="contact-curso">Curso <span className={styles.optional}>(opcional)</span></label>
      <input id="contact-curso" type="text" autoComplete="off" maxLength={150} disabled={busy} value={curso} onChange={event=>setCurso(event.target.value)}/>
      {error&&<Alert kind="error">{error}</Alert>}
      <p className="help">Salvar não envia e-mails. Depois de alterar os dados, confira uma nova prévia dos destinatários antes de enviar os boletins.</p>
      <div className={styles.actions}><button className="button outline" type="button" disabled={busy} onClick={onClose}>Cancelar</button><button className="button primary" type="submit" disabled={busy}><Save size={17}/>{busy?'Salvando...':'Salvar alterações'}</button></div>
    </form>
  </Modal>;
}

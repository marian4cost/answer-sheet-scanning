'use client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import type { StudentContact } from '@enem/shared/src/reports';
import { api, errorMessage } from '@/lib/api';
import { Alert, Modal } from './ui';
import styles from './contact-editor.module.css';

export function ContactDeleter({contact,onClose,onDeleted}:{contact:StudentContact;onClose:()=>void;onDeleted:(message:string)=>void}) {
  const [confirmation,setConfirmation] = useState(''), [busy,setBusy] = useState(false), [error,setError] = useState('');
  async function remove(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || confirmation !== contact.matricula) return;
    setError('');setBusy(true);
    try {
      const result = await api<{matricula:string;message:string}>(`/contatos/${encodeURIComponent(contact.matricula)}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmar:'excluir',matricula:confirmation,atualizado_em:contact.atualizado_em})});
      onDeleted(result.message);
    } catch(error) {setError(errorMessage(error));} finally {setBusy(false);}
  }
  return <Modal title="Excluir aluno da base" closeLabel="Cancelar exclusão do aluno" className={styles.dialog} preventClose={busy} onClose={onClose}>
    <form className={styles.form} onSubmit={remove}>
      <p>Excluir o cadastro de <strong>{contact.nome || 'Aluno sem nome informado'}</strong>?</p>
      <dl className={styles.deleteDetails}><div><dt>Matrícula</dt><dd>{contact.matricula}</dd></div><div><dt>E-mail</dt><dd>{contact.email}</dd></div>{contact.curso&&<div><dt>Curso</dt><dd>{contact.curso}</dd></div>}</dl>
      <Alert kind="warning">O contato será removido desta base. As provas e correções já salvas permanecem no histórico. Para enviar novos boletins a este aluno, cadastre o contato novamente.</Alert>
      <label className="field-label" htmlFor="delete-contact-matricula">Digite a matrícula do aluno para confirmar</label>
      <input id="delete-contact-matricula" type="text" autoComplete="off" required maxLength={100} disabled={busy} value={confirmation} onChange={event=>setConfirmation(event.target.value)} aria-describedby="delete-contact-help"/>
      <p id="delete-contact-help" className="help">Digite exatamente <strong>{contact.matricula}</strong>, incluindo os zeros iniciais.</p>
      {error&&<Alert kind="error">{error}</Alert>}
      <div className={styles.actions}><button className="button outline" type="button" disabled={busy} onClick={onClose}>Cancelar</button><button className="button danger" type="submit" disabled={busy || confirmation!==contact.matricula}><Trash2 size={17}/>{busy?'Excluindo...':'Excluir aluno'}</button></div>
    </form>
  </Modal>;
}

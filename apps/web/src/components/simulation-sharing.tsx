'use client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Share2, UserRound, UserMinus } from 'lucide-react';
import type { SimuladoShare, SimuladoSharesData } from '@enem/shared';
import { api, dateText, errorMessage } from '@/lib/api';
import { useResource } from '@/lib/use-resource';
import { Alert, Loading, Modal } from './ui';
import styles from './simulation-sharing.module.css';

export function SharingPanel({id, onBusyChange}: {id:number; onBusyChange?:(busy:boolean)=>void}) {
  const {data, loading, error, refresh} = useResource<SimuladoSharesData>(`/simulados/${id}/compartilhamentos`);
  const [email,setEmail] = useState(''), [busy,setBusy] = useState(false), [failure,setFailure] = useState(''), [message,setMessage] = useState('');
  const [revoking,setRevoking] = useState<string|null>(null);
  function working(value:boolean) {setBusy(value);onBusyChange?.(value);}
  async function share(event:FormEvent) {
    event.preventDefault();setFailure('');setMessage('');working(true);
    try {
      await api(`/simulados/${id}/compartilhamentos`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});
      setMessage(`Acesso liberado para ${email.trim()}. O simulado aparecerá em “Compartilhados comigo” nessa conta.`);setEmail('');refresh();
    } catch(error) {setFailure(errorMessage(error));} finally {working(false);}
  }
  async function revoke(user:SimuladoShare) {
    setFailure('');setMessage('');working(true);
    try {
      await api(`/simulados/${id}/compartilhamentos/${user.id}`,{method:'DELETE'});
      setMessage(`O acesso de ${user.nome||user.email} foi removido. Os resultados do simulado foram preservados.`);setRevoking(null);refresh();
    } catch(error) {setFailure(errorMessage(error));} finally {working(false);}
  }
  return <section className={styles.panel} aria-label="Compartilhamento do simulado">
    <h2 className={styles.heading}><Share2 size={20}/>Compartilhar simulado</h2>
    <p className="help">Informe o e-mail de um usuário já cadastrado no SIRENIA. Ele poderá consultar as respostas, os espelhos e a planilha deste simulado, em modo de leitura.</p>
    <Alert>O destinatário não poderá editar, excluir ou compartilhar este simulado, nem acessar seus contatos ou enviar boletins. Você pode remover o acesso a qualquer momento.</Alert>
    <form onSubmit={share} className={styles.form}>
      <label className="field-label" htmlFor={`share-email-${id}`}>E-mail do usuário</label>
      <div className={styles.entry}><input id={`share-email-${id}`} type="email" autoComplete="off" maxLength={254} required disabled={busy||loading||!!error} value={email} onChange={event=>setEmail(event.target.value)} placeholder="professor@exemplo.com"/><button className="button primary" disabled={busy||loading||!!error}><Share2 size={17}/>{busy?'Aguarde...':'Liberar acesso'}</button></div>
    </form>
    {failure&&<Alert kind="error">{failure}</Alert>}{message&&<Alert kind="success">{message}</Alert>}
    {loading?<Loading text="Consultando acessos..."/>:error?<><Alert kind="error">{error}</Alert><button type="button" className="button outline" onClick={refresh}>Tentar novamente</button></>:<>
      <h3 className={styles.listHeading}>Quem pode visualizar <span>{data?.compartilhamentos.length||0}</span></h3>
      {!data?.compartilhamentos.length?<p className="help">Este simulado ainda não foi compartilhado.</p>:<ul className={styles.list}>{data.compartilhamentos.map(user=><li key={user.id}>
        <div className={styles.user}><UserRound size={19}/><div><strong>{user.nome||'Usuário cadastrado'}</strong><span>{user.email}</span><small>Acesso liberado em {dateText(user.criado_em)}</small></div></div>
        {revoking===user.id?<div className={styles.confirm}><p>Remover o acesso de <strong>{user.nome||user.email}</strong>?</p><div><button type="button" className="button outline small" disabled={busy} onClick={()=>setRevoking(null)}>Cancelar</button><button type="button" className="button danger-outline small" disabled={busy} onClick={()=>revoke(user)}>Remover acesso</button></div></div>:<button type="button" className="button outline small" disabled={busy} aria-label={`Remover acesso de ${user.nome||user.email}`} onClick={()=>{setRevoking(user.id);setFailure('');setMessage('');}}><UserMinus size={16}/>Remover acesso</button>}
      </li>)}</ul>}
      {data?.expira_em&&<p className={styles.expiry}>O acesso acompanha o prazo do simulado: {dateText(data.expira_em)}.</p>}
    </>}
  </section>;
}
export function SharingDialog({id,onClose}: {id:number;onClose:()=>void}) {
  const [busy,setBusy] = useState(false);
  return <Modal title="Compartilhar simulado" closeLabel="Fechar compartilhamento" className={styles.dialog} preventClose={busy} onClose={onClose}><SharingPanel id={id} onBusyChange={setBusy}/></Modal>;
}

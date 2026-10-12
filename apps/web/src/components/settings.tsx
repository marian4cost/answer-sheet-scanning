'use client';
import { useEffect, useState } from 'react';
import { ShieldCheck, UserRound, UsersRound, UserPlus, LockKeyhole, Check, Trash2 } from 'lucide-react';
import type { AccountProfile, AccountRole, AccountsData } from '@enem/shared/src/accounts';
import { api, dateText, errorMessage } from '@/lib/api';
import { Alert, BackLink, Loading, Modal, useNotice } from './ui';
import styles from './settings.module.css';
const roleLabel = (role:AccountRole) => role==='admin'?'Administrador':'Professor';
function date(value:string|null) {return value && Number.isFinite(new Date(value).getTime()) ? dateText(value) : 'Ainda não registrado';}
export function SettingsView() {
  const [profile,setProfile] = useState<AccountProfile|null>(null), [error,setError] = useState('');
  const [users,setUsers] = useState<AccountProfile[]>([]), [loadingUsers,setLoadingUsers] = useState(false), [usersError,setUsersError] = useState('');
  const [nome,setNome] = useState(''), [saving,setSaving] = useState(false);
  const [deleting,setDeleting] = useState<AccountProfile|null>(null);
  const notice = useNotice();
  useEffect(() => {
    const controller = new AbortController();
    api<AccountProfile>('/auth/me',{signal:controller.signal}).then(value => {if(!controller.signal.aborted){setProfile(value);setNome(value.nome);}}).catch(error => {if(!controller.signal.aborted)setError(errorMessage(error));});
    return () => controller.abort();
  },[]);
  async function loadUsers() {
    setLoadingUsers(true);setUsersError('');
    try {const data=await api<AccountsData>('/contas');setUsers(data.usuarios);}
    catch(error){setUsersError(errorMessage(error));}finally{setLoadingUsers(false);}
  }
  useEffect(() => {
    if(profile?.role!=='admin')return;
    const controller = new AbortController();
    setLoadingUsers(true);
    api<AccountsData>('/contas',{signal:controller.signal}).then(data=>{if(!controller.signal.aborted)setUsers(data.usuarios);}).catch(error=>{if(!controller.signal.aborted)setUsersError(errorMessage(error));}).finally(()=>{if(!controller.signal.aborted)setLoadingUsers(false);});
    return()=>controller.abort();
  },[profile?.role]);
  async function saveProfile(event:React.FormEvent) {
    event.preventDefault();setSaving(true);setError('');
    try {const data=await api<AccountProfile>('/contas/perfil',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome})});setProfile(data);setNome(data.nome);notice('Seu nome foi atualizado.');}
    catch(error){setError(errorMessage(error));}finally{setSaving(false);}
  }
  if(!profile)return <><BackLink/>{error?<Alert kind="error">{error}</Alert>:<Loading text="Carregando seu perfil..."/>}</>;
  return <div className={styles.page}><BackLink/><header className={styles.heading}><div><span className={styles.eyebrow}>Sua conta no SIRENIA</span><h1>Configurações</h1><p>Confira seu perfil e as permissões da sua conta.</p></div><span className={styles.role}><ShieldCheck size={18}/>{roleLabel(profile.role)}</span></header>
    <div className={styles.profileGrid}><section className="card"><h2 className={styles.sectionTitle}><UserRound size={22}/> Meu perfil</h2><div className={styles.email}><span>E-mail de acesso</span><strong>{profile.email}</strong><small><Check size={14}/> E-mail confirmado</small></div>
      <form onSubmit={saveProfile}><label className="field-label" htmlFor="profile-name">Nome de apresentação</label><input id="profile-name" required minLength={2} maxLength={120} value={nome} disabled={saving} onChange={event=>setNome(event.target.value)}/>{error&&<Alert kind="error">{error}</Alert>}<button className="button primary" disabled={saving}>{saving?'Salvando...':'Salvar meu perfil'}</button></form>
      <dl className={styles.facts}><div><dt>Conta criada em</dt><dd>{date(profile.criado_em)}</dd></div><div><dt>Último acesso</dt><dd>{date(profile.ultimo_acesso)}</dd></div></dl>
    </section><aside className={`card ${styles.privacy}`}><h2 className={styles.sectionTitle}><LockKeyhole size={22}/> Seu histórico é privado</h2><p>Os simulados, contatos dos alunos e boletins pertencem à conta que os criou.</p><p>Administradores gerenciam usuários e permissões. Cada conta mantém seu próprio histórico.</p><p>Para usar outra conta, saia e entre novamente com o e-mail correspondente.</p></aside></div>
    {profile.role==='admin'&&<section className={styles.adminSection}><div className={styles.adminHeading}><div><span className={styles.eyebrow}>Apenas administradores</span><h2><UsersRound size={23}/> Gerenciar usuários</h2><p>Crie contas e defina quem pode administrar o SIRENIA.</p></div><button className="button outline" type="button" disabled={loadingUsers} onClick={loadUsers}>{loadingUsers?'Atualizando...':'Atualizar lista'}</button></div>
      <div className={styles.adminGrid}><CreateUser onCreated={async()=>{await loadUsers();}}/><section className="card"><h3>Contas cadastradas <span className={styles.count}>{users.length}</span></h3>{usersError&&<Alert kind="error">{usersError}</Alert>}{loadingUsers?<Loading text="Consultando usuários..."/>:<div className={styles.userList}>{users.map(user=><UserRow key={user.id} user={user} own={user.id===profile.id} onDelete={()=>setDeleting(user)} onUpdated={updated=>setUsers(previous=>previous.map(item=>item.id===updated.id?updated:item))}/>)}</div>}<p className="help">Você não pode excluir sua própria conta nem remover sua permissão de administrador. Sempre haverá ao menos um administrador com acesso ativo.</p></section></div>
    </section>}
    {deleting&&<DeleteUser user={deleting} onClose={()=>setDeleting(null)} onDeleted={id=>{setUsers(previous=>previous.filter(user=>user.id!==id));setDeleting(null);notice('Usuário excluído. O acesso à conta foi encerrado.');}}/>}
  </div>;
}
function CreateUser({onCreated}:{onCreated:()=>Promise<void>}) {
  const [email,setEmail]=useState(''),[nome,setNome]=useState(''),[senha,setSenha]=useState(''),[role,setRole]=useState<AccountRole>('professor');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  async function submit(event:React.FormEvent) {
    event.preventDefault();setBusy(true);setError('');setMessage('');
    try {await api<AccountProfile>('/contas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,nome,senha,role})});setSenha('');setEmail('');setNome('');setRole('professor');setMessage('Conta criada e pronta para uso. O usuário já pode entrar com o e-mail e a senha definidos, sem confirmar um código.');await onCreated();}
    catch(error){setSenha('');setError(errorMessage(error));}finally{setBusy(false);}
  }
  return <section className="card"><h3 className={styles.sectionTitle}><UserPlus size={21}/> Adicionar usuário</h3><form onSubmit={submit} autoComplete="off"><label className="field-label" htmlFor="account-name">Nome completo</label><input id="account-name" minLength={2} maxLength={120} required value={nome} disabled={busy} onChange={event=>setNome(event.target.value)}/><label className="field-label" htmlFor="account-email">E-mail</label><input id="account-email" type="email" maxLength={254} required value={email} disabled={busy} onChange={event=>setEmail(event.target.value)}/><label className="field-label" htmlFor="account-password">Senha inicial</label><input id="account-password" type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={senha} disabled={busy} onChange={event=>setSenha(event.target.value)}/><label className="field-label" htmlFor="account-role">Permissão</label><select id="account-role" value={role} disabled={busy} onChange={event=>setRole(event.target.value as AccountRole)}><option value="professor">Professor</option><option value="admin">Administrador</option></select><p className="help">O acesso é liberado ao criar a conta. O usuário entra com este e-mail e a senha definida pelo administrador.</p>{error&&<Alert kind="error">{error}</Alert>}{message&&<Alert kind="success">{message}</Alert>}<button className="button primary full" disabled={busy}>{busy?'Criando conta...':'Criar usuário'}</button></form></section>;
}
function UserRow({user,own,onUpdated,onDelete}:{user:AccountProfile;own:boolean;onUpdated:(value:AccountProfile)=>void;onDelete:()=>void}) {
  const [selection,setSelection]=useState<AccountRole>(user.role),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>setSelection(user.role),[user.role]);
  async function save() {
    setBusy(true);setError('');
    try {const updated=await api<AccountProfile>('/contas/'+user.id+'/role',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:selection})});onUpdated(updated);}
    catch(error){setSelection(user.role);setError(errorMessage(error));}finally{setBusy(false);}
  }
  return <article className={styles.userRow}><div className={styles.userIdentity}><strong>{user.nome||'Sem nome de apresentação'} {own&&<small>Você</small>}</strong><span>{user.email}</span><small className={user.email_confirmado?styles.confirmed:styles.pending}>{user.email_confirmado?'Acesso liberado':'Conta pendente de confirmação'}</small></div><div className={styles.userControls}><label className={styles.visuallyHidden} htmlFor={'role-'+user.id}>Permissão de {user.nome||user.email}</label><select id={'role-'+user.id} value={selection} disabled={busy||own} onChange={event=>setSelection(event.target.value as AccountRole)}><option value="professor">Professor</option><option value="admin">Administrador</option></select>{!own&&<div className={styles.userActions}><button className="button outline" type="button" disabled={busy||selection===user.role} onClick={save}>{busy?'Salvando...':'Salvar permissão'}</button><button className="button danger-outline" type="button" disabled={busy} onClick={onDelete} aria-label={`Excluir usuário ${user.nome||user.email}`}><Trash2 size={15}/>Excluir usuário</button></div>}</div>{error&&<div className={styles.rowError}><Alert kind="error">{error}</Alert></div>}</article>;
}
function DeleteUser({user,onClose,onDeleted}:{user:AccountProfile;onClose:()=>void;onDeleted:(id:string)=>void}) {
  const [email,setEmail]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function submit(event:React.FormEvent) {
    event.preventDefault();setBusy(true);setError('');
    try {const result=await api<{id:string}>('/contas/'+user.id,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmar:'excluir',email})});onDeleted(result.id);}
    catch(error){setError(errorMessage(error));}finally{setBusy(false);}
  }
  return <Modal title="Excluir usuário" className={styles.deleteModal} closeLabel="Cancelar exclusão" preventClose={busy} onClose={onClose}><form onSubmit={submit} className={styles.deleteForm}>
    <p>Excluir o acesso de <strong>{user.nome||user.email}</strong>?</p><p className={styles.deleteEmail}>{user.email}</p>
    <Alert kind="warning">Esta ação remove a conta de acesso e não pode ser desfeita. O histórico acadêmico permanece privado até vencer o prazo de 30 dias; uma nova conta com o mesmo e-mail não herda esse histórico.</Alert>
    <label className="field-label" htmlFor="delete-account-email">Digite o e-mail do usuário para confirmar</label><input id="delete-account-email" type="email" autoComplete="off" required disabled={busy} value={email} onChange={event=>setEmail(event.target.value)}/>
    {error&&<Alert kind="error">{error}</Alert>}<div className={styles.deleteActions}><button className="button outline" type="button" disabled={busy} onClick={onClose}>Cancelar</button><button className="button danger" type="submit" disabled={busy||email!==user.email}><Trash2 size={17}/>{busy?'Excluindo...':'Excluir definitivamente'}</button></div>
  </form></Modal>;
}

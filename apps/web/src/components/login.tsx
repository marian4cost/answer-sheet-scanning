'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, errorMessage } from '@/lib/api';
import { Alert, Loading } from './ui';
type Mode = 'senha'|'codigo';
export function LoginView() {
  const [email,setEmail] = useState(''), [password,setPassword] = useState(''), [code,setCode] = useState('');
  const [mode,setMode] = useState<Mode>('senha'), [sent,setSent] = useState(false), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const [config,setConfig] = useState<{required:boolean}|null>(null);
  const router = useRouter();
  useEffect(() => {
    api<{required:boolean}>('/auth/config').then(async value => {
      setConfig(value);
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const token = fragment.get('access_token');
      if (token) {
        window.history.replaceState(null,'','/login');setBusy(true);
        try {await api('/auth/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({access_token:token,...(fragment.get('refresh_token')?{refresh_token:fragment.get('refresh_token')}:{})})});router.replace('/');}
        catch(error) {setError(errorMessage(error));} finally {setBusy(false);}
      } else if (fragment.get('error_description')) {window.history.replaceState(null,'','/login');setError('O link expirou. Solicite outro código.');}
    }).catch(error => {setConfig({required:true});setError(errorMessage(error));});
  },[router]);
  function change(next: Mode) {setMode(next);setSent(false);setCode('');setPassword('');setError('');}
  async function submit(event: React.FormEvent) {
    event.preventDefault();setBusy(true);setError('');
    try {
      const path = sent ? '/auth/login' : mode === 'senha' ? '/auth/senha' : '/auth/codigo';
      await api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sent ? {email,codigo:code} : mode==='senha' ? {email,senha:password} : {email})});
      setPassword('');
      if (sent || mode === 'senha') {window.location.assign('/');} else setSent(true);
    } catch(error) {setError(errorMessage(error));} finally {setBusy(false);}
  }
  if (!config) return <Loading/>;
  return <div className="narrow"><section className="card"><h1>Acesso dos professores</h1><p>Instituto Federal de Sergipe - Campus Lagarto</p>
    <p className="help">As contas são criadas pelo administrador do SIRENIA. Entre com o e-mail e a senha que ele definiu para você.</p>
    <form onSubmit={submit}><label className="field-label" htmlFor="email">E-mail</label><input id="email" type="email" autoComplete="email" required value={email} disabled={busy || sent} onChange={event=>setEmail(event.target.value)}/>
      {!sent && mode==='senha' && <><label className="field-label" htmlFor="senha">Senha</label><input id="senha" type="password" autoComplete="current-password" required minLength={8} maxLength={128} disabled={busy} value={password} onChange={event=>setPassword(event.target.value)}/></>}
      {sent && <><p className="help">Enviamos um código para seu e-mail. Confira também a pasta de spam. Solicite outro após um minuto se necessário.</p><label className="field-label" htmlFor="codigo">Código de acesso</label><input id="codigo" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6,10}" required minLength={6} maxLength={10} disabled={busy} value={code} onChange={event=>setCode(event.target.value)}/></>}
      {error && <Alert kind="error">{error}</Alert>}<button className="button primary full" disabled={busy}>{busy?'Aguarde...':sent?'Confirmar e entrar':mode==='senha'?'Entrar':'Receber código por e-mail'}</button>
      {!sent && <button className="button outline full" type="button" disabled={busy} onClick={()=>change(mode==='senha'?'codigo':'senha')}>{mode==='senha'?'Entrar com código de e-mail':'Entrar com senha'}</button>}
      {sent && <button className="button outline full" type="button" disabled={busy} onClick={()=>change(mode)}>Voltar ou solicitar outro código</button>}
    </form></section></div>;
}

'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, errorMessage } from '@/lib/api';
import { Alert, Loading } from './ui';
type Mode = 'senha'|'cadastro'|'codigo';
export function LoginView() {
  const [email,setEmail] = useState(''), [password,setPassword] = useState(''), [confirmation,setConfirmation] = useState(''), [code,setCode] = useState('');
  const [mode,setMode] = useState<Mode>('senha'), [sent,setSent] = useState(false), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const [config,setConfig] = useState<{required:boolean;registration_enabled:boolean}|null>(null);
  const router = useRouter();
  useEffect(() => {
    api<{required:boolean;registration_enabled:boolean}>('/auth/config').then(async value => {
      setConfig(value);
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      if (!value.required) {window.history.replaceState(null,'','/login');router.replace('/');return;}
      const token = fragment.get('access_token');
      if (token) {
        window.history.replaceState(null,'','/login');setBusy(true);
        try {await api('/auth/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({access_token:token})});router.replace('/');}
        catch(error) {setError(errorMessage(error));} finally {setBusy(false);}
      } else if (fragment.get('error_description')) {window.history.replaceState(null,'','/login');setError('O link expirou. Solicite outro código.');}
    }).catch(error => {setConfig({required:true,registration_enabled:false});setError(errorMessage(error));});
  },[router]);
  function change(next: Mode) {setMode(next);setSent(false);setCode('');setPassword('');setConfirmation('');setError('');}
  async function submit(event: React.FormEvent) {
    event.preventDefault();setBusy(true);setError('');
    try {
      if (mode === 'cadastro' && !sent && password !== confirmation) throw new Error('As senhas não coincidem.');
      const path = sent ? '/auth/login' : mode === 'senha' ? '/auth/senha' : mode === 'cadastro' ? '/auth/cadastro' : '/auth/codigo';
      await api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sent ? {email,codigo:code,cadastro:mode==='cadastro'} : {email,senha:password})});
      setPassword('');setConfirmation('');
      if (sent || mode === 'senha') router.replace('/'); else setSent(true);
    } catch(error) {setError(errorMessage(error));} finally {setBusy(false);}
  }
  if (!config?.required) return <Loading/>;
  return <div className="narrow"><section className="card"><h1>{mode==='cadastro' ? 'Criar conta' : 'Acesso dos professores'}</h1><p>Instituto Federal de Sergipe - Campus Lagarto</p>
    <div className="auth-tabs"><button type="button" className={`button ${mode!=='cadastro'?'primary':'outline'}`} disabled={busy} onClick={()=>change('senha')}>Entrar</button>{config.registration_enabled && <button type="button" className={`button ${mode==='cadastro'?'primary':'outline'}`} disabled={busy} onClick={()=>change('cadastro')}>Criar conta</button>}</div>
    <form onSubmit={submit}><label className="field-label" htmlFor="email">E-mail</label><input id="email" type="email" autoComplete="email" required value={email} disabled={busy || sent} onChange={event=>setEmail(event.target.value)}/>
      {!sent && mode!=='codigo' && <><label className="field-label" htmlFor="senha">Senha</label><input id="senha" type="password" autoComplete={mode==='cadastro'?'new-password':'current-password'} required minLength={8} maxLength={128} disabled={busy} value={password} onChange={event=>setPassword(event.target.value)}/>{mode==='cadastro' && <><label className="field-label" htmlFor="confirmacao">Confirmar senha</label><input id="confirmacao" type="password" autoComplete="new-password" required minLength={8} maxLength={128} disabled={busy} value={confirmation} onChange={event=>setConfirmation(event.target.value)}/><p className="help">Você receberá um código por e-mail. Sua conta ficará ativa após a confirmação.</p></>}</>}
      {sent && <><p className="help">Enviamos um código para seu e-mail. Confira também a pasta de spam. Solicite outro após um minuto se necessário.</p><label className="field-label" htmlFor="codigo">Código de confirmação</label><input id="codigo" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6,10}" required minLength={6} maxLength={10} disabled={busy} value={code} onChange={event=>setCode(event.target.value)}/></>}
      {error && <Alert kind="error">{error}</Alert>}<button className="button primary full" disabled={busy}>{busy?'Aguarde...':sent ? mode==='cadastro'?'Confirmar cadastro':'Confirmar e entrar':mode==='senha'?'Entrar':mode==='cadastro'?'Receber código de confirmação':'Receber código por e-mail'}</button>
      {!sent && mode==='senha' && <button className="button outline full" type="button" disabled={busy} onClick={()=>change('codigo')}>Entrar com código de e-mail</button>}
      {sent && <button className="button outline full" type="button" disabled={busy} onClick={()=>change(mode)}>Voltar ou solicitar outro código</button>}
    </form></section></div>;
}

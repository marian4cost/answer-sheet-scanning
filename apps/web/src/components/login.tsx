'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, errorMessage } from '@/lib/api';
import { Alert, Loading } from './ui';
export function LoginView() {
  const [email, setEmail] = useState(''), [code, setCode] = useState(''), [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [requiresLogin, setRequiresLogin] = useState<boolean | null>(null);
  const router = useRouter();
  useEffect(() => {
    api<{required: boolean}>('/auth/config').then(async config => {
      setRequiresLogin(config.required);
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      if (!config.required) {
        window.history.replaceState(null, '', '/login');
        router.replace('/'); return;
      }
      const token = fragment.get('access_token');
      if (token) {
        window.history.replaceState(null, '', '/login'); setBusy(true);
        try {
          await api('/auth/session', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({access_token:token})});
          router.replace('/');
        } catch (error) { setError(errorMessage(error)); }
        finally { setBusy(false); }
      } else if (fragment.get('error_description')) {
        window.history.replaceState(null, '', '/login'); setError('O link expirou ou já foi usado. Solicite outro acesso.');
      }
    }).catch(error => { setRequiresLogin(true); setError(errorMessage(error)); });
  }, [router]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (!sent) {await api('/auth/codigo', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email})}); setSent(true);}
      else {await api('/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email, codigo:code})}); router.replace('/');}
    } catch (error) {setError(errorMessage(error));} finally {setBusy(false);}
  }
  if (!requiresLogin) return <Loading/>;
  return <div className="narrow"><section className="card"><h1>Acesso dos professores</h1><p>Instituto Federal de Sergipe - Campus Lagarto</p><form onSubmit={submit}><label className="field-label" htmlFor="email">E-mail autorizado</label><input id="email" type="email" required value={email} disabled={busy || sent} onChange={event => setEmail(event.target.value)}/>{sent && <><p className="help">Confira seu e-mail e clique no link de acesso. Caso a mensagem contenha um código, você também pode informá-lo abaixo.</p><label className="field-label" htmlFor="codigo">Código de acesso</label><input id="codigo" autoComplete="one-time-code" inputMode="numeric" required minLength={6} maxLength={10} value={code} onChange={event => setCode(event.target.value)}/></>}{error && <Alert kind="error">{error}</Alert>}<button className="button primary full" disabled={busy}>{busy ? 'Aguarde...' : sent ? 'Entrar com código' : 'Receber acesso por e-mail'}</button>{sent && <button className="button outline" type="button" disabled={busy} onClick={() => {setSent(false);setCode('');}}>Trocar e-mail ou solicitar outro acesso</button>}</form></section></div>;
}

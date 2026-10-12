'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard } from 'lucide-react';
export function SiteNavigation() {
  const pathname=usePathname();
  if(pathname==='/boletim')return <span className="nav-link">Boletim individual</span>;
  return <div className="actions"><Link href="/" className="nav-link"><LayoutDashboard size={18}/> Simulados</Link><Link href="/contatos" className="nav-link">Contatos dos alunos</Link><SessionNav/></div>;
}
export function SessionNav() {
  const [required, setRequired] = useState(false);
  const [email, setEmail] = useState('');
  const pathname = usePathname();
  useEffect(() => {api<{required: boolean}>('/auth/config').then(value => setRequired(value.required)).catch(() => {});}, []);
  useEffect(() => {
    const controller = new AbortController();
    setEmail('');
    if (pathname !== '/login') api<{email:string}>('/auth/me',{signal:controller.signal}).then(value => {if(!controller.signal.aborted)setEmail(value.email);}).catch(()=>{});
    return () => controller.abort();
  },[pathname]);
  if (!required) return null;
  return <>{email && <span className="nav-link" title="Conta proprietária deste histórico">{email}</span>}<button className="nav-link" onClick={async () => {await api('/auth/logout',{method:'POST'}); window.location.assign('/login');}}>Sair</button></>;
}

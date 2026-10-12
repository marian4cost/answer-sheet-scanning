'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Settings, LogOut } from 'lucide-react';
import type { AccountProfile } from '@enem/shared/src/accounts';
export function SiteNavigation() {
  const pathname=usePathname();
  if(pathname==='/boletim')return <span className="nav-link">Boletim individual</span>;
  return <div className="actions"><Link href="/" className="nav-link"><LayoutDashboard size={18}/> Simulados</Link><Link href="/contatos" className="nav-link">Contatos dos alunos</Link><SessionNav/></div>;
}
export function SessionNav() {
  const [profile,setProfile] = useState<AccountProfile|null>(null), [busy,setBusy] = useState(false);
  const pathname = usePathname();
  useEffect(() => {
    const controller = new AbortController();
    setProfile(null);
    if(pathname!=='/login') api<AccountProfile>('/auth/me',{signal:controller.signal}).then(value => {if(!controller.signal.aborted)setProfile(value);}).catch(()=>{});
    return () => controller.abort();
  },[pathname]);
  if(!profile)return null;
  return <><Link href="/configuracoes" className="nav-link" title={`Configurações de ${profile.email}`}><Settings size={17}/> Configurações</Link><button className="nav-link" type="button" disabled={busy} onClick={async () => {
    setBusy(true);
    try {await api('/auth/logout',{method:'POST'});window.location.assign('/login');}
    finally {setBusy(false);}
  }}><LogOut size={16}/> {busy?'Saindo...':'Sair'}</button></>;
}

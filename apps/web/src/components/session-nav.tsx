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
  useEffect(() => {api<{required: boolean}>('/auth/config').then(value => setRequired(value.required)).catch(() => {});}, []);
  if (!required) return null;
  return <button className="nav-link" onClick={async () => {await api('/auth/logout',{method:'POST'}); window.location.assign('/login');}}>Sair</button>;
}

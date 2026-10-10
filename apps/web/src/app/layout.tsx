import type { Metadata } from 'next';
import Link from 'next/link';
import { LayoutDashboard } from 'lucide-react';
import { Brand, NoticeProvider } from '@/components/ui';
import { SessionNav } from '@/components/session-nav';
import './globals.css';
export const metadata: Metadata = {title: {default: 'OMR Enem Reader', template: '%s | OMR Enem Reader'}, description: 'Leitura e correção de gabaritos com OpenCV.'};
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html lang="pt-BR"><body><NoticeProvider>
    <header className="topbar"><div className="shell nav"><Brand/><div className="actions"><Link href="/" className="nav-link"><LayoutDashboard size={18}/> Simulados</Link><Link href="/contatos" className="nav-link">Contatos dos alunos</Link><SessionNav/></div></div></header>
    <main className="shell main">{children}</main>
    <footer>Instituto Federal de Sergipe - Campus Lagarto · {new Date().getFullYear()}</footer>
  </NoticeProvider></body></html>;
}

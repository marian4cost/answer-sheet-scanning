import type { Metadata } from 'next';
import { Brand, NoticeProvider } from '@/components/ui';
import { SiteNavigation } from '@/components/session-nav';
import './globals.css';
export const metadata: Metadata = {title: {default: 'OMR Enem Reader', template: '%s | OMR Enem Reader'}, description: 'Leitura e correção de gabaritos com OpenCV.'};
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html lang="pt-BR"><body><NoticeProvider>
    <header className="topbar"><div className="shell nav"><Brand/><SiteNavigation/></div></header>
    <main className="shell main">{children}</main>
    <footer>Instituto Federal de Sergipe - Campus Lagarto · {new Date().getFullYear()}</footer>
  </NoticeProvider></body></html>;
}

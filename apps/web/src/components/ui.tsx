'use client';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft, CheckCircle2, X, LoaderCircle, AlertCircle, Inbox } from 'lucide-react';
import type { ReadingStatus } from '@enem/shared';

const NoticeContext = createContext<(message: string, kind?: 'success' | 'error') => void>(() => {});
export function NoticeProvider({children}: {children: ReactNode}) {
  const [notice, setNotice] = useState<{message: string; kind: string} | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 9000);
    return () => clearTimeout(timer);
  }, [notice]);
  return <NoticeContext.Provider value={(message, kind = 'success') => setNotice({message, kind})}>
    {children}
    {notice && <div className={`toast ${notice.kind}`} role="status"><CheckCircle2 size={20}/><span>{notice.message}</span><button type="button" onClick={() => setNotice(null)} aria-label="Fechar aviso"><X size={18}/></button></div>}
  </NoticeContext.Provider>;
}
export const useNotice = () => useContext(NoticeContext);
export function Brand() {
  return <Link href="/" className="brand" aria-label="SIRENIA — página inicial">
    <Image className="brand-logo" src="/morea-logo.svg" alt="MOREA" width={56} height={56} unoptimized/>
    <span className="brand-copy"><span className="brand-name">SIRENIA</span><span className="brand-description">Simulados e Revisões para o Enem corrigidos com Inteligência Artificial</span></span>
  </Link>;
}
export function BackLink({href = '/', children = 'Voltar ao dashboard'}: {href?: string; children?: ReactNode}) {
  return <Link className="back-link" href={href}><ArrowLeft size={16}/>{children}</Link>;
}
export function Alert({children, kind = 'info'}: {children: ReactNode; kind?: 'info' | 'error' | 'warning' | 'success'}) {
  return <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}><AlertCircle size={19}/><div>{children}</div></div>;
}
export function Loading({text = 'Carregando...'}: {text?: string}) {
  return <div className="loading" role="status"><LoaderCircle className="spin" size={26}/><span>{text}</span></div>;
}
export function Empty({children}: {children: ReactNode}) {
  return <div className="empty"><Inbox size={34}/><p>{children}</p></div>;
}
export function Badge({status}: {status: ReadingStatus}) {
  const labels = {SUCESSO: 'Sucesso', ALERTA_RASURA: 'Marcação dupla', ALERTA_REVISAO: 'Revisão necessária', ERRO_LEITURA: 'Erro de leitura'};
  return <span className={`status ${status.toLowerCase()}`}>{labels[status]}</span>;
}
export function Modal({title, children, onClose, closeLabel = 'Fechar espelho', preventClose = false, className = ''}: {title: string; children: ReactNode; onClose: () => void; closeLabel?: string; preventClose?: boolean; className?: string}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className={`modal ${className}`} onCancel={event => {if (preventClose) event.preventDefault(); else onClose();}} onClick={event => { if (!preventClose && event.target === event.currentTarget) onClose(); }}>
    <header className="modal-header"><h2>{title}</h2><button className="icon-button" type="button" disabled={preventClose} onClick={onClose} aria-label={closeLabel}><X/></button></header>
    {children}
  </dialog>;
}

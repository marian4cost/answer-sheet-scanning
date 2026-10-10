import Link from 'next/link';
export default function NotFound() { return <section className="card"><h1>Página não encontrada</h1><p>Volte ao dashboard para consultar seus simulados.</p><Link className="button primary" href="/">Voltar ao dashboard</Link></section>; }

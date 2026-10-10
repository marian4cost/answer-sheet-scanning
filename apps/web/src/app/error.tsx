'use client';
export default function ErrorPage({reset}: {reset: () => void}) {
  return <section className="card"><h1>Não foi possível carregar esta página</h1><p>Tente novamente para continuar.</p><button className="button primary" onClick={reset}>Tentar novamente</button></section>;
}

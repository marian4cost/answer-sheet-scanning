'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import type { SimuladoDetail } from '@enem/shared';
import { useResource } from '@/lib/use-resource';
import { api, errorMessage } from '@/lib/api';
import { Alert, BackLink, Loading, useNotice } from './ui';
export function DeleteView({id}: {id: number}) {
  const {data, loading, error} = useResource<SimuladoDetail>(`/simulados/${id}`);
  const [busy, setBusy] = useState(false), [deleteError, setDeleteError] = useState('');
  const router = useRouter(), notify = useNotice();
  async function confirm() {
    setBusy(true); setDeleteError('');
    try {
      const result = await api<{message: string}>(`/simulados/${id}`, {method: 'DELETE', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({confirmar: 'sim'})});
      notify(result.message); router.push('/');
    } catch (error) { setDeleteError(errorMessage(error)); setBusy(false); }
  }
  if (loading) return <Loading/>;
  if (error || !data) return <><BackLink/><Alert kind="error">{error || 'Simulado não encontrado.'}</Alert></>;
  if(data.simulado.pode_editar===false)return <><BackLink/><Alert>Somente o responsável pode excluir este simulado. Seu acesso é apenas para leitura.</Alert><Link className="button outline" href={`/simulado/${id}/resultados`}>Ver respostas</Link></>;
  return <div className="delete-wrap"><section className="card"><span className="delete-icon"><Trash2 size={28}/></span><h1>Excluir simulado</h1><p>Você está prestes a excluir <strong>{data.simulado.titulo}</strong>.</p><div className="delete-summary"><p><strong>{data.simulado.total_envios}</strong> envios vinculados</p><p><strong>{data.simulado.total_provas}</strong> provas com resultados armazenados</p></div><Alert kind="error">A exclusão removerá o gabarito oficial, todos os envios e todos os resultados deste simulado. Esta ação não pode ser desfeita.</Alert>{deleteError && <Alert kind="error">{deleteError}</Alert>}<div className="actions end"><Link className="button outline" href="/">Cancelar</Link><button className="button danger" type="button" onClick={confirm} disabled={busy}><Trash2 size={17}/>{busy ? 'Excluindo...' : 'Confirmar exclusão'}</button></div></section></div>;
}

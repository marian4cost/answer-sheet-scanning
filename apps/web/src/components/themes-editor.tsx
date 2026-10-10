'use client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Simulado } from '@enem/shared';
import { api, errorMessage } from '@/lib/api';
import { Alert, useNotice } from './ui';
import { ThemeFields, validateThemes } from './theme-fields';

export function ThemesEditor({simulado, onSaved}: {simulado: Simulado; onSaved: () => void}) {
  const [themes, setThemes] = useState(simulado.temas);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const notify = useNotice();
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    try {
      validateThemes(themes, simulado.total_questoes); setBusy(true);
      await api(`/simulados/${simulado.id}/temas`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({temas: themes})});
      notify('Temas salvos. Os resultados e o Excel já usam esses intervalos.'); onSaved();
    } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  return <section className="card"><h2>Organizar questões por tema</h2><p className="help">Você pode editar os temas sem reenviar o gabarito. A organização vale para todas as provas deste simulado e preserva suas notas.</p>
    <form onSubmit={submit}><ThemeFields count={simulado.total_questoes} value={themes} onChange={setThemes} disabled={busy}/>
      {error && <Alert kind="error">{error}</Alert>}
      <button className="button primary" disabled={busy} type="submit">{busy ? 'Salvando...' : 'Salvar temas'}</button>
    </form>
  </section>;
}

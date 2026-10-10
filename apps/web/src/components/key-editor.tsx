'use client';
import type { AnswerKey } from '@enem/shared';
export function KeyEditor({count, value, onChange, disabled = false}: {count: number; value: AnswerKey; onChange: (key: AnswerKey) => void; disabled?: boolean}) {
  const missing = Array.from({length: count}, (_, index) => index + 1).filter(q => !/^[A-E]$/.test(value[String(q)] || ''));
  return <div className="key-review"><h3>Conferir alternativas</h3><p className="help">Confira cada resposta do professor. Corrija os campos em branco ou sinalizados antes de salvar.</p>
    <label className="field-label" htmlFor="paste-key">Colar sequência A a E (opcional)</label>
    <input id="paste-key" placeholder={`Cole ${count} letras, separadas por espaço ou vírgula`} disabled={disabled} onChange={event => {
      const letters = event.target.value.toUpperCase().replace(/[\s,;]+/g, '');
      if (letters.length === count && /^[A-E]+$/.test(letters)) onChange(Object.fromEntries([...letters].map((letter, index) => [String(index + 1), letter])) as AnswerKey);
    }}/>
    <div className="answer-detail key-inputs">{Array.from({length: count}, (_, index) => String(index + 1)).map(q => <label key={q}><span>Q{q.padStart(2, '0')}</span><select aria-label={`Resposta correta questão ${q}`} value={/^[A-E]$/.test(value[q] || '') ? value[q] : ''} disabled={disabled} onChange={event => onChange({...value, [q]: event.target.value as AnswerKey[string]})}>
      <option value="">{value[q] === 'RAS' ? 'Dupla' : value[q] === 'INC' ? 'Revisar' : '—'}</option>{['A','B','C','D','E'].map(letter => <option key={letter}>{letter}</option>)}</select></label>)}</div>
    {missing.length > 0 && <p className="help">Faltam conferir {missing.length} questões: {missing.join(', ')}.</p>}
  </div>;
}

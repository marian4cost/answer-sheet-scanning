'use client';
import { useId } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { ThemeRange } from '@enem/shared';

export function ThemeFields({count, value, onChange, disabled = false}: {
  count: number; value: ThemeRange[]; onChange: (value: ThemeRange[]) => void; disabled?: boolean;
}) {
  const id = useId();
  function change(index: number, patch: Partial<ThemeRange>) {
    onChange(value.map((range, i) => i === index ? {...range, ...patch} : range));
  }
  return <fieldset className="theme-fields" disabled={disabled}>
    <legend>Temas por intervalo de questões <span>(opcional)</span></legend>
    <p className="help">Ex.: de 1 até 22, Linguagens; de 25 até 30, Ciências da Natureza. Os limites estão incluídos. Questões fora das faixas ficam sem tema.</p>
    <input type="hidden" name="temas" value={JSON.stringify(value)}/>
    {value.map((range, i) => <div className="theme-range" key={i}>
      <div><label htmlFor={`${id}-${i}-start`}>De</label><input id={`${id}-${i}-start`} type="number" min={1} max={count} required value={range.inicio || ''} onChange={event => change(i, {inicio: Number(event.target.value)})}/></div>
      <div><label htmlFor={`${id}-${i}-end`}>Até</label><input id={`${id}-${i}-end`} type="number" min={Math.max(1, range.inicio)} max={count} required value={range.fim || ''} onChange={event => change(i, {fim: Number(event.target.value)})}/></div>
      <div className="theme-name"><label htmlFor={`${id}-${i}-name`}>Tema</label><input id={`${id}-${i}-name`} maxLength={100} required placeholder="Ex.: Linguagens" value={range.tema} onChange={event => change(i, {tema: event.target.value})}/></div>
      <button className="button danger-outline icon-button" type="button" aria-label={`Remover intervalo ${i + 1}`} onClick={() => onChange(value.filter((_, index) => index !== i))}><Trash2 size={16}/></button>
    </div>)}
    <button className="button outline small" type="button" disabled={value.length >= count} onClick={() => {
      const start = Math.min(count, (value.at(-1)?.fim || 0) + 1);
      onChange([...value, {inicio: start, fim: count, tema: ''}]);
    }}><Plus size={15}/>Adicionar intervalo</button>
  </fieldset>;
}

export function validateThemes(themes: ThemeRange[], count: number) {
  const sorted = [...themes].sort((a, b) => a.inicio - b.inicio);
  sorted.forEach((range, i) => {
    if (!Number.isInteger(range.inicio) || !Number.isInteger(range.fim) || range.inicio < 1 || range.fim > count || range.fim < range.inicio || !range.tema.trim()) throw new Error('Preencha os limites e o tema de cada intervalo.');
    if (i && range.inicio <= sorted[i - 1].fim) throw new Error('Os intervalos de temas não podem se sobrepor.');
  });
}

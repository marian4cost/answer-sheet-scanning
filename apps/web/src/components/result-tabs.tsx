'use client';
import { useRef } from 'react';
import type { KeyboardEvent } from 'react';

export function ResultTabs({id, themes, selected, onChange}: {
  id: string; themes: string[]; selected: string | null; onChange: (theme: string | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const values = [null, ...themes];
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') || []);
    const current = buttons.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    onChange(values[next]); buttons[next].focus();
  }
  return <div className="result-tabs" role="tablist" aria-label="Desempenho geral ou por tema" ref={ref} onKeyDown={keyboard}>
    {values.map((theme, i) => <button type="button" role="tab" key={i} id={`${id}-tab-${i}`}
      aria-selected={selected === theme} aria-controls={`${id}-panel`} tabIndex={selected === theme ? 0 : -1}
      onClick={() => onChange(theme)}>{theme === null ? 'Nota geral' : theme}</button>)}
  </div>;
}

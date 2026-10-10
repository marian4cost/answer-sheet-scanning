'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
export function SessionNav() {
  const [required, setRequired] = useState(false);
  useEffect(() => {api<{required: boolean}>('/auth/config').then(value => setRequired(value.required)).catch(() => {});}, []);
  if (!required) return null;
  return <button className="nav-link" onClick={async () => {await api('/auth/logout',{method:'POST'}); window.location.assign('/login');}}>Sair</button>;
}

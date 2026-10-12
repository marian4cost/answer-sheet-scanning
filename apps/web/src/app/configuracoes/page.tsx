import type { Metadata } from 'next';
import { SettingsView } from '@/components/settings';
export const metadata: Metadata = {title:'Configurações'};
export default function Page() { return <SettingsView/>; }

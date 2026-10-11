import type { Metadata } from 'next';
import { PublicReport } from '@/components/public-report';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Boletim individual',
  robots: {index: false, follow: false, nocache: true},
  referrer: 'no-referrer',
};
export default function StudentReportPage() { return <PublicReport/>; }

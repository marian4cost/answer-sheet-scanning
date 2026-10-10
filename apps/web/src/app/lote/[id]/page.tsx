import { ResultsView } from '@/components/results';
export default async function Page({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  return <ResultsView envioId={Number(id)}/>;
}

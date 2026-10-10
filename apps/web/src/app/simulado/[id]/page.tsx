import { DetailView } from '@/components/simulado-detail';
export default async function Page({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  return <DetailView id={Number(id)}/>;
}

import { DeleteView } from '@/components/delete-simulado';
export default async function Page({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  return <DeleteView id={Number(id)}/>;
}

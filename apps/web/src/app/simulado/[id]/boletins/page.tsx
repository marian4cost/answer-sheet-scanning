import { StudentReportsView } from '@/components/student-reports';
export default async function Page({params}:{params:Promise<{id:string}>}) {
  const {id} = await params;
  return <StudentReportsView id={Number(id)}/>;
}

export const dynamic = 'force-dynamic';

import AdminPage from '@/components/client/AdminPage';

interface Props {
  params: { tab: string };
}

export default function AdminTabPage({ params }: Props) {
  return <AdminPage tab={params.tab} />;
}

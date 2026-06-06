import type { Metadata } from 'next';
import ProfilePage from '@/components/client/ProfilePage';

export const dynamic = 'force-dynamic';

interface Props {
  params: { username: string };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return {
    title: `${params.username} on Flaxia`,
    description: `View ${params.username}'s profile on Flaxia`,
    openGraph: {
      title: `Flaxia - ${params.username}`,
      description: `View ${params.username}'s profile on Flaxia`,
    },
  };
}

export default function UsersProfilePage({ params }: { params: { username: string } }) {
  return <ProfilePage username={params.username} />;
}

import type { Metadata } from 'next';
import ThreadPageClient from '@/components/client/ThreadPageClient';

export const dynamic = 'force-dynamic';

interface Props {
  params: { postId: string };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return {
    title: `Post on Flaxia`,
    description: 'View this post on Flaxia',
    openGraph: {
      title: 'Flaxia - Post',
      description: 'View this post on Flaxia',
    },
  };
}

export default function ThreadPage({ params }: { params: { postId: string } }) {
  return <ThreadPageClient postId={params.postId} />;
}

export const dynamic = 'force-dynamic';

import ArcadePage from '@/components/client/ArcadePage';

interface Props {
  params: { gameId: string };
}

export default function ArcadeGamePage({ params }: Props) {
  return <ArcadePage initialGameId={params.gameId} />;
}

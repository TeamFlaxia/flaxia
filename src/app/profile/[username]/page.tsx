import { redirect } from 'next/navigation';

export default function ProfileRedirect({ params }: { params: { username: string } }) {
  redirect(`/users/${params.username}`);
}

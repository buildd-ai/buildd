import { redirect } from 'next/navigation';
import { auth } from '@/auth';

export default async function AppHome() {
  const session = await auth();

  if (session?.user) {
    redirect('/app/dashboard');
  }

  redirect('/app/auth/signin');
}

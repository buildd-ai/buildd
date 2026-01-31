import { redirect } from 'next/navigation';
import { auth } from '@/auth';

const isDevelopment = process.env.NODE_ENV === 'development';

interface AuthGuardProps {
  children: React.ReactNode;
}

export async function AuthGuard({ children }: AuthGuardProps) {
  // Skip auth in development
  if (isDevelopment) {
    return <>{children}</>;
  }

  const session = await auth();
  if (!session?.user) {
    redirect('/auth/signin');
  }

  return <>{children}</>;
}

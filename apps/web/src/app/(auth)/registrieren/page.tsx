import type { Metadata } from 'next';

import { SignUpForm } from '@/components/auth/sign-up-form';

export const metadata: Metadata = { title: 'Registrieren' };

export default function SignUpPage() {
  return <SignUpForm />;
}

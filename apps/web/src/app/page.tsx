import { redirect } from 'next/navigation';

/** Entry point: the shell resolves the active workspace. */
export default function IndexPage(): never {
  redirect('/arbeitsbereich');
}

import { redirect } from 'next/navigation';

/** Preserve bookmarks to the retired single-feature settings page. */
export default function FeaturesSettingsPage() {
  redirect('/app/health/estimates');
}

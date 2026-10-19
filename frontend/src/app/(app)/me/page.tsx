import { MeView } from "@/features/me/me-view";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/me", "My preferences");

export default function MePage() {
  return <MeView />;
}

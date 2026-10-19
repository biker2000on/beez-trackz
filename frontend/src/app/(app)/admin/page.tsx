
import { AdminView } from "@/features/admin/admin-view";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/admin");

export default function AdminPage() {
  return <AdminView />;
}

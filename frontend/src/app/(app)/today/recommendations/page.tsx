import { redirect } from "next/navigation";

/** Retired: the recommendation filter is Today's `?view=all`. */
export default function Page() {
  redirect("/today?view=all");
}

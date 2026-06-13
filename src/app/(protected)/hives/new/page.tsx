import { redirect } from "next/navigation";

// New hives are created via the modal on /hives (and the apiary page).
export default function NewHiveRedirect() {
  redirect("/hives");
}

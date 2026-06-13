import { redirect } from "next/navigation";

// New apiaries are created via the modal on /apiaries.
export default function NewApiaryRedirect() {
  redirect("/apiaries");
}

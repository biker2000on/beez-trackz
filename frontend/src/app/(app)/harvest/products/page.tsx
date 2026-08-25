import { redirect } from "next/navigation";

export default function HarvestProductsRedirect() {
  redirect("/honey/products");
}

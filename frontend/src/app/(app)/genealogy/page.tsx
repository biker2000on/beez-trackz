import { redirect } from "next/navigation";

/**
 * The nav item has always been labelled "Queens" while the route said
 * `/genealogy`. The page now lives at `/queens`; this keeps old links,
 * bookmarks and shared URLs working.
 */
export default function GenealogyRedirect() {
  redirect("/queens");
}

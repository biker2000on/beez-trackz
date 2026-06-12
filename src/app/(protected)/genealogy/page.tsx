import { getAllQueens } from "@/actions/queens";
import { QueenTree } from "@/components/queens/queen-tree";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Plus } from "lucide-react";
import { NavShortcut } from "@/components/keyboard/nav-shortcut";

export default async function GenealogyPage() {
  const queens = await getAllQueens();

  return (
    <div className="p-6">
      <NavShortcut keys="n" href="/genealogy/new" description="New queen" group="Queens" />
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Queen Genealogy</h1>
        <Link href="/genealogy/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Add Queen
          </Button>
        </Link>
      </div>
      <QueenTree queens={queens} />
    </div>
  );
}

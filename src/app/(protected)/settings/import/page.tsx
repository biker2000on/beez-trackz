"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ParsedImportData } from "@/lib/import/parser";
import { FileUpload } from "@/components/import/file-upload";
import { ImportReview } from "@/components/import/import-review";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export default function ImportPage() {
  const router = useRouter();
  const [parsedData, setParsedData] = useState<ParsedImportData | null>(null);

  const handleParsed = (data: ParsedImportData) => {
    setParsedData(data);
  };

  const handleComplete = () => {
    router.push("/settings");
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <Link href="/settings">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Settings
          </Button>
        </Link>
      </div>

      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Import Old Records</h1>
        <p className="text-muted-foreground">
          Upload your old beekeeping records in any format. AI will parse and
          extract structured data for review.
        </p>
      </div>

      {!parsedData ? (
        <FileUpload onParsed={handleParsed} />
      ) : (
        <ImportReview data={parsedData} onComplete={handleComplete} />
      )}
    </div>
  );
}

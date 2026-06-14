"use client";

import { useState } from "react";
import type { ParsedImportData } from "@/lib/import/parser";
import { FileUpload } from "@/components/import/file-upload";
import { ImportReview } from "@/components/import/import-review";

export function ImportRecordsSection() {
  const [parsedData, setParsedData] = useState<ParsedImportData | null>(null);

  return !parsedData ? (
    <FileUpload onParsed={setParsedData} />
  ) : (
    <ImportReview data={parsedData} onComplete={() => setParsedData(null)} />
  );
}

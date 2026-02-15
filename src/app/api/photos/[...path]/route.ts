import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.resolve("./data/photos");

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: pathSegments } = await params;

  if (!pathSegments || pathSegments.length === 0) {
    return NextResponse.json({ error: "Path required" }, { status: 400 });
  }

  // Build file path: ./data/photos/{ownerType}/{ownerId}/{filename}
  const filePath = path.join(DATA_DIR, ...pathSegments);

  // Security: ensure the resolved path is within DATA_DIR
  const resolvedPath = path.resolve(filePath);
  if (!resolvedPath.startsWith(DATA_DIR)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 403 });
  }

  try {
    const fileBuffer = await fs.readFile(resolvedPath);

    // Determine content type based on file extension
    const ext = path.extname(resolvedPath).toLowerCase();
    const contentTypeMap: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
    };
    const contentType = contentTypeMap[ext] || "application/octet-stream";

    // Determine cache headers based on filename pattern
    const isThumbnail = pathSegments[pathSegments.length - 1]?.includes("thumb");
    const cacheControl = isThumbnail
      ? "public, max-age=31536000, immutable" // 1 year for thumbnails
      : "public, max-age=3600"; // 1 hour for originals

    return new NextResponse(fileBuffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": cacheControl,
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
    console.error("Error serving photo:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

import sharp from "sharp";
import path from "path";

export interface ProcessedImage {
  thumbnailPath: string;
  mediumPath: string;
}

/**
 * Process an uploaded image: generate thumbnail (200px wide) and medium (1200px wide) variants.
 * Handles EXIF rotation automatically via sharp's rotate().
 */
export async function processImage(
  inputPath: string,
  outputDir: string
): Promise<ProcessedImage> {
  const ext = path.extname(inputPath);
  const base = path.basename(inputPath, ext);

  const thumbnailFilename = `${base}_thumb${ext}`;
  const mediumFilename = `${base}_medium${ext}`;

  const thumbnailPath = path.join(outputDir, thumbnailFilename);
  const mediumPath = path.join(outputDir, mediumFilename);

  // rotate() with no args auto-orients based on EXIF data
  await sharp(inputPath)
    .rotate()
    .resize({ width: 200, withoutEnlargement: true })
    .toFile(thumbnailPath);

  await sharp(inputPath)
    .rotate()
    .resize({ width: 1200, withoutEnlargement: true })
    .toFile(mediumPath);

  return { thumbnailPath, mediumPath };
}

import { getJarSizes } from "@/actions/jar-sizes";
import { JarSizeSettings } from "@/components/settings/jar-size-settings";

export default async function JarSizesPage() {
  const sizes = await getJarSizes(true);

  return (
    <div className="p-4 md:p-6 max-w-3xl">
      <h1 className="text-2xl font-bold mb-6">Jar Sizes & Prices</h1>
      <JarSizeSettings initialSizes={sizes} />
    </div>
  );
}

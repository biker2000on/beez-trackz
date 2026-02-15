import { getJarSizes } from "@/actions/jar-sizes";
import { JarSizeSettings } from "@/components/settings/jar-size-settings";

export default async function JarSizesPage() {
  const sizes = await getJarSizes();

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-2xl font-bold mb-6">Jar Sizes</h1>
      <JarSizeSettings initialSizes={sizes} />
    </div>
  );
}

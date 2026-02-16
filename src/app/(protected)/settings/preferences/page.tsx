import { getPreferences } from "@/actions/preferences";
import { getApiaries } from "@/actions/apiaries";
import { PreferencesForm } from "@/components/settings/preferences-form";

export default async function PreferencesPage() {
  const preferences = await getPreferences();
  const apiaries = await getApiaries();

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Preferences</h1>
      <PreferencesForm
        preferences={preferences}
        apiaries={apiaries.map((a) => ({ id: a.id, name: a.name }))}
      />
    </div>
  );
}

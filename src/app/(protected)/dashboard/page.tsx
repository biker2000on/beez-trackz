import { WidgetCard } from "@/components/dashboard/widget-card";

export default function DashboardPage() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Dashboard</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <WidgetCard title="Inspections Due">
          <p className="text-muted-foreground text-sm">No hives to inspect</p>
        </WidgetCard>
        <WidgetCard title="AI Recommendations">
          <p className="text-muted-foreground text-sm">No recommendations</p>
        </WidgetCard>
        <WidgetCard title="Recent Inspections">
          <p className="text-muted-foreground text-sm">No recent inspections</p>
        </WidgetCard>
        <WidgetCard title="Frame Shortage">
          <p className="text-muted-foreground text-sm">No equipment tracked</p>
        </WidgetCard>
        <WidgetCard title="Active Feeders">
          <p className="text-muted-foreground text-sm">No active feeders</p>
        </WidgetCard>
        <WidgetCard title="Honey Inventory">
          <p className="text-muted-foreground text-sm">No inventory</p>
        </WidgetCard>
      </div>
    </div>
  );
}

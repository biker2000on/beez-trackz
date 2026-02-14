import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface WidgetCardProps {
  title: string;
  children: React.ReactNode;
}

export function WidgetCard({ title, children }: WidgetCardProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

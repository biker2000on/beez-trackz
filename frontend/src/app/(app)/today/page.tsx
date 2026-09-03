import type { Metadata } from "next";

import { TodayView } from "@/features/work/today-view";

export const metadata: Metadata = { title: "Today" };

export default function TodayPage() {
  return <TodayView />;
}

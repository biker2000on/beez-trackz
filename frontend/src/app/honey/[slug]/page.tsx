import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarDays, ExternalLink, MapPin, PackageCheck, Sprout } from "lucide-react";

import { HoneyStorySignup } from "@/features/commerce/honey-story-signup";
import {
  formatHoneyDual,
  formatHoneyMass,
  resolveUnitsPreference,
} from "@/lib/units";

type StoryPhoto = {
  id: string;
  url: string;
  caption?: string | null;
};

type HoneyStory = {
  slug: string;
  name: string;
  lotCode: string;
  description?: string | null;
  floralSource?: string | null;
  floralClaim?: string | null;
  claimSpecies?: string | null;
  claimYear?: number | null;
  claimApiaryName?: string | null;
  claimElevationM?: number | null;
  apiaryRegion?: string | null;
  harvestDate?: string | null;
  harvestedPounds?: number | null;
  beekeeperNotes?: string | null;
  sourceApiaries: string[];
  photos: StoryPhoto[];
  testingData?: Record<string, unknown> | null;
  bottlingRuns: {
    bottledDate: string;
    jarSizeLabel?: string | null;
    quantity: number;
  }[];
  reorderUrl?: string | null;
  units?: string | null;
  temperatureUnit?: string | null;
};

let warnedAboutLegacyAPIURL = false;

// Server-only: the API host must not be inlined into the public bundle, so
// this reads API_URL. NEXT_PUBLIC_API_URL stays as a fallback for one release
// so an un-migrated deployment keeps working, with a warning (SEAM-022).
function apiOrigin() {
  const configured = process.env.API_URL;
  if (configured) return configured;
  const legacy = process.env.NEXT_PUBLIC_API_URL;
  if (legacy) {
    if (!warnedAboutLegacyAPIURL) {
      warnedAboutLegacyAPIURL = true;
      console.warn(
        "NEXT_PUBLIC_API_URL is deprecated and inlines the API host into the " +
          "public bundle; set API_URL instead. Support will be removed next release.",
      );
    }
    return legacy;
  }
  return "http://localhost:8080";
}

// This is the one public page, so a stored value landing in an href must be
// scheme-checked — a javascript: URL would run for every QR visitor.
function safeReorderUrl(raw: string | null | undefined): string | null {
  return raw && /^https?:\/\//i.test(raw) ? raw : null;
}

// Same rule as parseApiDate (features/hives/lib.ts): the leading YYYY-MM-DD
// of an API date IS the calendar date the beekeeper recorded. Reading the
// string is correct whatever offset the value carries; converting the instant
// through a timezone (even a pinned UTC) shifts dates the server wrote at a
// non-UTC offset.
function formatStoryDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long" }).format(date);
}

async function getStory(slug: string): Promise<HoneyStory | null> {
  const response = await fetch(`${apiOrigin()}/api/v1/public/honey-stories/${encodeURIComponent(slug)}`, {
    cache: "no-store",
  });

  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Unable to load this Honey Story");
  return response.json() as Promise<HoneyStory>;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const story = await getStory(slug);

  if (!story) return { title: "Honey Story" };

  return {
    title: `${story.name} · Honey Story`,
    description:
      story.description ??
      `See where ${story.name} was harvested and meet the apiary behind the jar.`,
  };
}

export default async function HoneyStoryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const story = await getStory(slug);
  if (!story) notFound();

  const region = story.apiaryRegion ?? story.sourceApiaries.join(", ");
  const harvestDate = story.harvestDate ? formatStoryDate(story.harvestDate) : null;
  const latestBottlingDate = story.bottlingRuns[0]?.bottledDate
    ? formatStoryDate(story.bottlingRuns[0].bottledDate)
    : null;
  const reorderUrl = safeReorderUrl(story.reorderUrl);
  // Operator preference, never the viewer's locale. Unset units resolve as
  // US customary so a public QR visitor cannot flip the jar's printed claim.
  const preference = resolveUnitsPreference({
    units: story.units,
    temperatureUnit: story.temperatureUnit,
    locale: "en-US",
  });
  const harvestMass = formatHoneyMass(story.harvestedPounds, preference.units);
  const harvestLabel =
    formatHoneyDual(story.harvestedPounds, preference.units) ?? harvestMass?.text ?? null;
  const floralClaim = story.floralClaim || story.floralSource;

  return (
    <main className="min-h-screen bg-[#fffaf0] text-stone-900">
      <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-16">
        <header className="mb-10 text-center">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.28em] text-amber-700">
            From hive to jar
          </p>
          <h1 className="font-serif text-4xl font-bold tracking-tight sm:text-6xl">{story.name}</h1>
          {story.description && (
            <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-stone-600">
              {story.description}
            </p>
          )}
        </header>

        {story.photos[0] && (
          <figure className="mb-10 overflow-hidden rounded-3xl border border-amber-100 bg-white shadow-sm">
            <div className="relative aspect-[4/3] w-full">
              <Image
                alt={story.photos[0].caption ?? story.name}
                className="object-cover"
                fill
                priority
                sizes="(max-width: 768px) 100vw, 768px"
                src={story.photos[0].url}
                unoptimized
              />
            </div>
            {story.photos[0].caption && (
              <figcaption className="px-5 py-3 text-sm text-stone-500">
                {story.photos[0].caption}
              </figcaption>
            )}
          </figure>
        )}

        <section className="grid gap-3 sm:grid-cols-2">
          <StoryFact
            icon={<PackageCheck />}
            label="Lot"
            value={story.lotCode}
          />
          {region && (
            <StoryFact icon={<MapPin />} label="Grown near" value={region} />
          )}
          {harvestDate && (
            <StoryFact icon={<CalendarDays />} label="Harvested" value={harvestDate} />
          )}
          {floralClaim && (
            <StoryFact icon={<Sprout />} label="Floral source" value={floralClaim} />
          )}
          {harvestLabel && (
            <StoryFact
              icon={<span className="font-serif text-lg font-bold">{harvestMass?.unit ?? "lb"}</span>}
              label="Harvest"
              value={harvestLabel}
            />
          )}
          {latestBottlingDate && (
            <StoryFact
              icon={<CalendarDays />}
              label="Bottled"
              value={latestBottlingDate}
            />
          )}
        </section>

        {story.beekeeperNotes && (
          <section className="my-10 rounded-3xl bg-stone-900 px-7 py-8 text-stone-50 sm:px-10">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-amber-300">
              From the beekeeper
            </p>
            <p className="whitespace-pre-wrap font-serif text-xl leading-8">{story.beekeeperNotes}</p>
          </section>
        )}

        {story.testingData && Object.keys(story.testingData).length > 0 && (
          <section className="my-10 rounded-3xl border border-amber-100 bg-white p-6 sm:p-8">
            <p className="mb-4 text-xs font-semibold uppercase tracking-[0.22em] text-amber-700">
              Lot testing
            </p>
            <dl className="grid gap-4 sm:grid-cols-2">
              {Object.entries(story.testingData).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs uppercase tracking-wide text-stone-400">
                    {label.replaceAll("_", " ")}
                  </dt>
                  <dd className="mt-1 font-medium">
                    {typeof value === "string" || typeof value === "number"
                      ? value
                      : JSON.stringify(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {story.photos.length > 1 && (
          <section className="my-10 grid grid-cols-2 gap-3">
            {story.photos.slice(1).map((photo) => (
              <figure className="overflow-hidden rounded-2xl bg-white" key={photo.id}>
                <div className="relative aspect-square">
                  <Image
                    alt={photo.caption ?? story.name}
                    className="object-cover"
                    fill
                    sizes="(max-width: 768px) 50vw, 384px"
                    src={photo.url}
                    unoptimized
                  />
                </div>
                {photo.caption && (
                  <figcaption className="px-3 py-2 text-xs text-stone-500">
                    {photo.caption}
                  </figcaption>
                )}
              </figure>
            ))}
          </section>
        )}

        <section className="mx-auto mt-12 max-w-lg rounded-3xl border border-amber-200 bg-white p-6 shadow-sm sm:p-8">
          <h2 className="font-serif text-2xl font-bold">Want honey from the next harvest?</h2>
          <p className="mb-5 mt-2 text-sm leading-6 text-stone-600">
            Join the apiary’s opt-in list. No spam—just an occasional note when a new lot is bottled.
          </p>
          <HoneyStorySignup slug={story.slug} />
          {reorderUrl && (
            <ButtonLink href={reorderUrl}>Buy or reorder this honey</ButtonLink>
          )}
        </section>

        <footer className="mt-12 text-center text-xs text-stone-500">
          Traceability powered by{" "}
          <Link className="font-semibold text-amber-700" href="/">
            Beez Trackz
          </Link>
        </footer>
      </div>
    </main>
  );
}

function StoryFact({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-amber-100 bg-white p-5">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-800 [&>svg]:h-5 [&>svg]:w-5">
        {icon}
      </span>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">{label}</p>
        <p className="mt-0.5 font-medium">{value}</p>
      </div>
    </div>
  );
}

function ButtonLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      className="mt-4 flex w-full items-center justify-center rounded-md border border-amber-300 px-4 py-2 text-sm font-semibold text-amber-800 transition hover:bg-amber-50"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {children}
      <ExternalLink className="ml-2 h-4 w-4" />
    </a>
  );
}

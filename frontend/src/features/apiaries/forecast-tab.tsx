"use client";

import {
  CloudRain,
  CloudSun,
  Flower2,
  Thermometer,
  TriangleAlert,
  Wind,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

import { useApiaryWeather, useBloomPredictions } from "./hooks";

function shortDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function ForecastTab({ apiaryId }: { apiaryId: string }) {
  const weather = useApiaryWeather(apiaryId);
  const bloom = useBloomPredictions(apiaryId);

  if (weather.isPending || bloom.isPending) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  if (weather.isError && bloom.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Location needed</CardTitle>
          <CardDescription>
            Set this apiary's location (map pin) to calculate local
            weather and bloom windows.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const forecast = weather.data?.forecast;
  return (
    <div className="grid gap-4">
      {weather.data?.alerts.length ? (
        <div className="grid gap-2">
          {weather.data.alerts.map((alert) => (
            <div
              className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-50"
              key={`${alert.date}-${alert.message}`}
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span>
                <strong>{shortDate(alert.date)}:</strong> {alert.message}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CloudSun className="size-5 text-primary" />
              Apiary weather
            </CardTitle>
            <CardDescription>
              Exact apiary coordinates · 10-day forecast from Open-Meteo
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {forecast ? (
              <>
                <div className="grid grid-cols-3 gap-2 rounded-lg bg-muted/50 p-3 text-center">
                  <div>
                    <Thermometer className="mx-auto size-4 text-muted-foreground" />
                    <p className="mt-1 text-xl font-semibold">
                      {Math.round(forecast.current.temperature_2m)}°
                    </p>
                    <p className="text-xs text-muted-foreground">Now</p>
                  </div>
                  <div>
                    <Wind className="mx-auto size-4 text-muted-foreground" />
                    <p className="mt-1 text-xl font-semibold">
                      {Math.round(forecast.current.wind_speed_10m)}
                    </p>
                    <p className="text-xs text-muted-foreground">mph wind</p>
                  </div>
                  <div>
                    <CloudRain className="mx-auto size-4 text-muted-foreground" />
                    <p className="mt-1 text-xl font-semibold">
                      {forecast.current.relative_humidity_2m}%
                    </p>
                    <p className="text-xs text-muted-foreground">Humidity</p>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <div className="grid min-w-[620px] grid-cols-10 gap-1">
                    {forecast.daily.time.map((date, index) => (
                      <div className="rounded-md border p-2 text-center" key={date}>
                        <p className="text-xs font-medium">{shortDate(date)}</p>
                        <p className="mt-2 text-sm font-semibold">
                          {Math.round(forecast.daily.temperature_2m_max[index])}°
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {Math.round(forecast.daily.temperature_2m_min[index])}°
                        </p>
                        <p className="mt-1 text-[10px] text-sky-700 dark:text-sky-300">
                          {Math.round(
                            forecast.daily.precipitation_probability_max[index] ??
                              0,
                          )}
                          %
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Weather is temporarily unavailable.
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Flower2 className="size-5 text-primary" />
              Bloom calendar
            </CardTitle>
            <CardDescription>
              Predicted from observations within 50 miles, weighted toward this
              apiary and adjusted for the local forecast.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {bloom.data?.predictions.length ? (
              <div className="divide-y">
                {bloom.data.predictions.map((prediction) => (
                  <div className="grid gap-1 py-3 first:pt-0" key={prediction.species}>
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-medium">{prediction.species}</p>
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium capitalize text-primary">
                        {prediction.confidence}
                      </span>
                    </div>
                    <p className="text-sm">
                      Likely {shortDate(prediction.predictedDate)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Window {shortDate(prediction.windowStart)}–
                      {shortDate(prediction.windowEnd)} · {prediction.observations}{" "}
                      observation{prediction.observations === 1 ? "" : "s"}
                      {prediction.weatherShiftDays
                        ? ` · weather shift ${prediction.weatherShiftDays > 0 ? "+" : ""}${prediction.weatherShiftDays} days`
                        : ""}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Add bloom observations over time to build location-specific
                predictions.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

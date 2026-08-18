/**
 * NOAA Solar Calculator (SPA-class) — local, from lat/lng/date.
 * Ground elevation is a separate column; this file only speaks solar altitude.
 *
 * Formulas: https://gml.noaa.gov/grad/solcalc/calcdetails.html
 */

export interface SolarPosition {
  /** Compass degrees, 0 = north, clockwise. */
  azimuth: number;
  /** Solar altitude in degrees (refraction-corrected). Night when <= 0. */
  altitude: number;
  zenith: number;
  /** Minutes from local midnight, or null above the arctic circle. */
  sunriseMinutes: number | null;
  sunsetMinutes: number | null;
  sunriseAzimuth: number | null;
  sunsetAzimuth: number | null;
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

function julianDay(date: Date): number {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d =
    date.getDate() +
    (date.getHours() +
      (date.getMinutes() + date.getSeconds() / 60) / 60) /
      24;
  const tzHours = -date.getTimezoneOffset() / 60;
  if (m <= 2) {
    return julianDayFromParts(y - 1, m + 12, d, tzHours);
  }
  return julianDayFromParts(y, m, d, tzHours);
}

function julianDayFromParts(
  year: number,
  month: number,
  day: number,
  tzHours: number,
): number {
  return (
    Math.floor(365.25 * (year + 4716)) +
    Math.floor(30.6001 * (month + 1)) +
    day +
    tzHours / 24 -
    1524.5
  );
}

function wrap360(d: number): number {
  return ((d % 360) + 360) % 360;
}

function solarAt(
  lat: number,
  lng: number,
  date: Date,
): {
  azimuth: number;
  altitude: number;
  zenith: number;
  declination: number;
  eqTime: number;
  haSunrise: number | null;
} {
  const jd = julianDay(date);
  const jc = (jd - 2451545) / 36525;
  const geomMeanLong = wrap360(
    280.46646 + jc * (36000.76983 + jc * 0.0003032),
  );
  const geomMeanAnom = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const eccent = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const sunEqCtr =
    Math.sin(rad(geomMeanAnom)) *
      (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(rad(2 * geomMeanAnom)) * (0.019993 - 0.000101 * jc) +
    Math.sin(rad(3 * geomMeanAnom)) * 0.000289;
  const sunTrueLong = geomMeanLong + sunEqCtr;
  const sunAppLong =
    sunTrueLong -
    0.00569 -
    0.00478 * Math.sin(rad(125.04 - 1934.136 * jc));
  const meanObliq =
    23 +
    (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813)))) / 60 /
      60;
  const obliqCorr =
    meanObliq + 0.00256 * Math.cos(rad(125.04 - 1934.136 * jc));
  const declination = deg(
    Math.asin(Math.sin(rad(obliqCorr)) * Math.sin(rad(sunAppLong))),
  );
  const y = Math.tan(rad(obliqCorr / 2)) * Math.tan(rad(obliqCorr / 2));
  const eqTime =
    4 *
    deg(
      y * Math.sin(2 * rad(geomMeanLong)) -
        2 * eccent * Math.sin(rad(geomMeanAnom)) +
        4 *
          eccent *
          y *
          Math.sin(rad(geomMeanAnom)) *
          Math.cos(2 * rad(geomMeanLong)) -
        0.5 * y * y * Math.sin(4 * rad(geomMeanLong)) -
        1.25 * eccent * eccent * Math.sin(2 * rad(geomMeanAnom)),
    );

  const tzHours = -date.getTimezoneOffset() / 60;
  const minutesPastMidnight =
    date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
  const trueSolarTime =
    (((minutesPastMidnight + eqTime + 4 * lng - 60 * tzHours) % 1440) +
      1440) %
    1440;
  const hourAngle = trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180;

  const zenith = deg(
    Math.acos(
      Math.sin(rad(lat)) * Math.sin(rad(declination)) +
        Math.cos(rad(lat)) *
          Math.cos(rad(declination)) *
          Math.cos(rad(hourAngle)),
    ),
  );
  let altitude = 90 - zenith;
  // NOAA approx atmospheric refraction
  let refraction = 0;
  if (altitude > 85) refraction = 0;
  else if (altitude > 5) {
    refraction =
      58.1 / Math.tan(rad(altitude)) -
      0.07 / Math.pow(Math.tan(rad(altitude)), 3) +
      0.000086 / Math.pow(Math.tan(rad(altitude)), 5);
  } else if (altitude > -0.575) {
    refraction =
      1735 +
      altitude * (-518.2 + altitude * (103.4 + altitude * (-12.79 + altitude * 0.711)));
  } else {
    refraction = -20.772 / Math.tan(rad(altitude));
  }
  altitude += refraction / 3600;

  const azDenom =
    Math.cos(rad(lat)) * Math.sin(rad(zenith));
  let azimuth: number;
  if (Math.abs(azDenom) > 1e-12) {
    const azArg = Math.min(
      1,
      Math.max(
        -1,
        ((Math.sin(rad(lat)) * Math.cos(rad(zenith)) - Math.sin(rad(declination))) /
          azDenom),
      ),
    );
    azimuth =
      hourAngle > 0
        ? wrap360(deg(Math.acos(azArg)) + 180)
        : wrap360(540 - deg(Math.acos(azArg)));
  } else {
    azimuth = lat > 0 ? 180 : 0;
  }

  const cosHa =
    Math.cos(rad(90.833)) /
      (Math.cos(rad(lat)) * Math.cos(rad(declination))) -
    Math.tan(rad(lat)) * Math.tan(rad(declination));
  const haSunrise = Math.abs(cosHa) <= 1 ? deg(Math.acos(cosHa)) : null;

  return { azimuth, altitude, zenith, declination, eqTime, haSunrise };
}

/** Azimuth at a given local time-of-day (minutes from midnight) on this date. */
function azimuthAtMinutes(
  lat: number,
  lng: number,
  day: Date,
  minutes: number,
): number {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return solarAt(lat, lng, d).azimuth;
}

export function solarPosition(
  lat: number,
  lng: number,
  date: Date,
): SolarPosition {
  const pos = solarAt(lat, lng, date);
  const tzHours = -date.getTimezoneOffset() / 60;
  let sunriseMinutes: number | null = null;
  let sunsetMinutes: number | null = null;
  let sunriseAzimuth: number | null = null;
  let sunsetAzimuth: number | null = null;
  if (pos.haSunrise != null) {
    const solarNoon = (720 - 4 * lng - pos.eqTime + tzHours * 60 + 1440) % 1440;
    sunriseMinutes = (solarNoon - (pos.haSunrise * 4) + 1440) % 1440;
    sunsetMinutes = (solarNoon + pos.haSunrise * 4) % 1440;
    sunriseAzimuth = azimuthAtMinutes(lat, lng, date, sunriseMinutes);
    sunsetAzimuth = azimuthAtMinutes(lat, lng, date, sunsetMinutes);
  }
  return {
    azimuth: pos.azimuth,
    altitude: pos.altitude,
    zenith: pos.zenith,
    sunriseMinutes,
    sunsetMinutes,
    sunriseAzimuth,
    sunsetAzimuth,
  };
}

export function formatClock(minutes: number | null): string {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** Hive-body shadow length in meters. `heightM` is the box, not ground elev. */
export function shadowLengthM(solarAltitudeDeg: number, heightM = 0.6): number {
  if (solarAltitudeDeg <= 0.5) return heightM * 20;
  return heightM / Math.tan(rad(solarAltitudeDeg));
}

export function bearingPoint(
  origin: { x: number; y: number },
  bearingDeg: number,
  lengthPx: number,
): { x: number; y: number } {
  const r = rad(bearingDeg - 90);
  return {
    x: origin.x + Math.cos(r) * lengthPx,
    y: origin.y + Math.sin(r) * lengthPx,
  };
}

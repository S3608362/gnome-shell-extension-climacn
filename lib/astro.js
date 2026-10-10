import { parseClockMinutes, toFiniteOrNull } from './util.js';
export const BAND_RAMP = 0.16;
export const DAY_MINUTES = 24 * 60;
export const MOON_DISC_RADIUS = 7;
export function bandRatio(minutes) {
    const m = toFiniteOrNull(minutes);
    if (m === null)
        return null;
    return Math.min(Math.max(m / DAY_MINUTES, 0), 1);
}
export function bandSkyColorAt(ratio, astro) {
    const sunrise = astro.sunrise / DAY_MINUTES;
    const sunset = astro.sunset / DAY_MINUTES;
    if (ratio >= sunrise && ratio <= sunset)
        return SKY_DAY;

    const d = ratio < sunrise ? sunrise - ratio : ratio - sunset;
    const last = BAND_RAMP_COLORS.length - 1;
    const scaled = Math.min(d / BAND_RAMP, 1) * last;
    const i = Math.min(Math.floor(scaled), last - 1);
    const f = scaled - i;
    const a = BAND_RAMP_COLORS[i];
    const b = BAND_RAMP_COLORS[i + 1];
    const e = f * f * (3 - 2 * f);
    return [
        a[0] + (b[0] - a[0]) * e,
        a[1] + (b[1] - a[1]) * e,
        a[2] + (b[2] - a[2]) * e,
    ];
}
export function moonUpSpans(moon) {
    const spans = [];
    const end = Math.min(moon.moonset, DAY_MINUTES);
    if (end > moon.moonrise)
        spans.push([moon.moonrise, end]);
    if (moon.moonset > DAY_MINUTES)
        spans.push([0, moon.moonset - DAY_MINUTES]);
    return spans;
}
export const SKY_ASTRONOMY = [0.22, 0.26, 0.52];
export const SKY_NAUTICAL  = [0.30, 0.38, 0.68];
export const SKY_CIVIL     = [0.58, 0.52, 0.76];
export const SKY_DAY       = [1.00, 0.72, 0.20];
export const BAND_RAMP_COLORS = [SKY_DAY, SKY_CIVIL, SKY_NAUTICAL, SKY_ASTRONOMY];
export const BAND_DOT_COLORS = {
    astro: [0.3608, 0.4000, 0.6902],
    civil: [0.6353, 0.5843, 0.8000],
    day:   [1.0000, 0.7216, 0.2000],
    moon:  [0.6039, 0.6000, 0.6588],
};
export const SUN_LEGEND = [
    { key: 'astro', label: '天文晨', field: 'astronomicalDawn' },
    { key: 'civil', label: '民用晨', field: 'civilDawn' },
    { key: 'day',   label: '日出',   field: 'sunrise' },
    { key: 'day',   label: '日落',   field: 'sunset' },
    { key: 'civil', label: '民用暮', field: 'civilDusk' },
    { key: 'astro', label: '天文暮', field: 'astronomicalDusk' },
];
export const MOON_LEGEND = [
    { key: 'moon', label: '月出' },
    { key: 'moon', label: '月落' },
    { key: 'moon', label: '月相' },
];
export const MOON_LIT_ALPHA = 0.85;
export const MOON_DARK_ALPHA = 0.16;
export const MOON_PHASES = {
    'new-moon':        { name: '新月',   lit: 0.000, waxing: true  },
    'waxing-crescent': { name: '蛾眉月', lit: 0.146, waxing: true  },
    'first-quarter':   { name: '上弦月', lit: 0.500, waxing: true  },
    'waxing-gibbous':  { name: '盈凸月', lit: 0.854, waxing: true  },
    'full-moon':       { name: '满月',   lit: 1.000, waxing: true  },
    'waning-gibbous':  { name: '亏凸月', lit: 0.854, waxing: false },
    'last-quarter':    { name: '下弦月', lit: 0.500, waxing: false },
    'waning-crescent': { name: '残月',   lit: 0.146, waxing: false },
};
export function parseMoon(astro) {
    let moonrise = parseClockMinutes(astro?.moonrise);
    let moonset = parseClockMinutes(astro?.moonset);
    if (moonrise === null || moonset === null)
        return null;
    if (moonset <= moonrise)
        moonset += 24 * 60;

    const base = MOON_PHASES[astro?.moonPhase] ?? null;
    if (!base)
        return { moonrise, moonset, phase: null };

    const lit = toFiniteOrNull(astro?.moonLit);
    return {
        moonrise, moonset,
        phase: {
            name: base.name,
            waxing: base.waxing,
            lit: lit ?? base.lit,
        },
    };
}
export function parseAstro(days) {
    const astro = Array.isArray(days) ? days[0]?.astro : null;
    if (!astro)
        return null;
    const sunrise = parseClockMinutes(astro.sunrise);
    const sunset = parseClockMinutes(astro.sunset);
    if (sunrise === null || sunset === null || sunset <= sunrise)
        return null;
    return {
        sunrise, sunset,
        civilDawn: parseClockMinutes(astro.civilDawn),
        civilDusk: parseClockMinutes(astro.civilDusk),
        nauticalDawn: parseClockMinutes(astro.nauticalDawn),
        nauticalDusk: parseClockMinutes(astro.nauticalDusk),
        astronomicalDawn: parseClockMinutes(astro.astronomicalDawn),
        astronomicalDusk: parseClockMinutes(astro.astronomicalDusk),
        moon: parseMoon(astro),
    };
}
export function moonArcPosition(nowMinutes, moon) {
    if (!moon)
        return null;
    const now = nowMinutes < moon.moonrise ? nowMinutes + 24 * 60 : nowMinutes;
    const ratio = (now - moon.moonrise) / (moon.moonset - moon.moonrise);
    return {
        ratio: Math.min(Math.max(ratio, 0), 1),
        isUp: now >= moon.moonrise && now <= moon.moonset,
    };
}
export function parseMoonPhases(days) {
    if (!Array.isArray(days))
        return [];
    return days.map(d => MOON_PHASES[d?.astro?.moonPhase] ?? null);
}
export function parseTrendPoints(days) {
    if (!Array.isArray(days))
        return [];
    return days.map(d => {
        const rawMin = d?.temperatureMin?.value;
        const rawMax = d?.temperatureMax?.value;
        if (rawMin === null || rawMin === undefined ||
            rawMax === null || rawMax === undefined)
            return null;
        const min = Number(rawMin);
        const max = Number(rawMax);
        return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
    });
}
export const MOON_PHASE_CENTERS = [
    ['new-moon', 0.000], ['waxing-crescent', 0.125], ['first-quarter', 0.250],
    ['waxing-gibbous', 0.375], ['full-moon', 0.500], ['waning-gibbous', 0.625],
    ['last-quarter', 0.750], ['waning-crescent', 0.875],
];
export function moonPhaseFromFraction(p) {
    const v = toFiniteOrNull(p);
    if (v === null)
        return null;
    const f = ((v % 1) + 1) % 1;
    let name = MOON_PHASE_CENTERS[0][0];
    let best = Infinity;
    for (const [candidate, center] of MOON_PHASE_CENTERS) {
        const raw = Math.abs(center - f);
        const d = Math.min(raw, 1 - raw);
        if (d < best) {
            best = d;
            name = candidate;
        }
    }
    return {
        name,
        lit: (1 - Math.cos(2 * Math.PI * f)) / 2,
        waxing: f < 0.5,
    };
}

import { lastHourlyIndex, toFiniteOrNull } from './util.js';
export const AQI_RING_SIZE = 34;
export const AQI_FONT_PX = 10;
export const AQI_MAX_FAILURES = 2;
export function parseAqiIndex(json) {
    const list = Array.isArray(json?.indexes) ? json.indexes : [];
    if (list.length === 0)
        return null;
    const idx = list.find(i => i?.code === 'qaqi') ?? list[0];
    const aqi = toFiniteOrNull(idx?.aqi);
    if (aqi === null)
        return null;
    const c = idx?.color ?? {};
    const channel = v => (toFiniteOrNull(v) ?? 128);
    const pp = idx?.primaryPollutant;
    const ppCode = String(pp?.code ?? '').trim().toLowerCase();
    return {
        aqi,
        display: idx?.aqiDisplay || String(Math.round(aqi)),
        category: idx?.category || '',
        primary: aqi > 50 && ppCode && ppCode !== 'na'
            ? String(pp?.name ?? '').trim()
            : '',
        color: { r: channel(c.red), g: channel(c.green), b: channel(c.blue) },
    };
}
export function aqiFillRatio(aqi) {
    const n = toFiniteOrNull(aqi);
    if (n === null)
        return 0;
    return Math.min(Math.max(n, 0), 300) / 300;
}
export const AQI_LEVELS = [0, 50, 100, 150, 200, 300, 400, 500];
export const AQI_BREAKPOINTS = {
    pm25: [0, 35, 75, 115, 150, 250, 350, 500],
    pm10: [0, 50, 150, 250, 350, 420, 500, 600],
    so2:  [0, 50, 150, 475, 800, 1600, 2100, 2620],
    no2:  [0, 40, 80, 180, 280, 565, 750, 940],
    co:   [0, 2, 4, 14, 24, 36, 48, 60],
    o3:   [0, 100, 160, 215, 265, 800],
};
export const AQI_POLLUTANT_SHORT = {
    pm25: 'PM2.5',
    pm10: 'PM10',
    so2: 'SO₂',
    no2: 'NO₂',
    co: 'CO',
    o3: 'O₃',
};
export const AQI_CATEGORIES = [
    [50,  '优',       [0.00, 0.89, 0.00]],
    [100, '良',       [1.00, 1.00, 0.00]],
    [150, '轻度污染', [1.00, 0.49, 0.00]],
    [200, '中度污染', [1.00, 0.00, 0.00]],
    [300, '重度污染', [0.56, 0.25, 0.59]],
    [Infinity, '严重污染', [0.49, 0.00, 0.14]],
];
export function aqiCategory(aqi) {
    for (const [limit, name] of AQI_CATEGORIES) {
        if (aqi <= limit)
            return name;
    }
    return AQI_CATEGORIES[AQI_CATEGORIES.length - 1][1];
}
export function aqiColor(aqi) {
    for (const [limit, , rgb] of AQI_CATEGORIES) {
        if (aqi <= limit)
            return { r: rgb[0] * 255, g: rgb[1] * 255, b: rgb[2] * 255 };
    }
    return { r: 126, g: 0, b: 36 };
}
export function iaqiFrom(concentration, table) {
    const c = toFiniteOrNull(concentration);
    if (c === null || c < 0)
        return null;
    for (let i = 1; i < table.length; i++) {
        if (c <= table[i]) {
            const lo = table[i - 1];
            const hi = table[i];
            const loI = AQI_LEVELS[i - 1];
            const hiI = AQI_LEVELS[i];
            return Math.round(loI + (hiI - loI) * (c - lo) / (hi - lo));
        }
    }
    return AQI_LEVELS[table.length - 1];
}
export function meanOf(values) {
    const nums = (Array.isArray(values) ? values : [])
        .map(toFiniteOrNull)
        .filter(v => v !== null);
    if (nums.length === 0)
        return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}
export function chinaAqiFromHourly(nowIso, aq) {
    const hourly = aq?.hourly ?? {};
    const upto = lastHourlyIndex(hourly.time, nowIso);
    if (upto < 0)
        return null;

    const tail = (key, n) => {
        const arr = hourly[key];
        if (!Array.isArray(arr))
            return null;
        return arr.slice(Math.max(0, upto - n + 1), upto + 1);
    };

    const coRaw = meanOf(tail('carbon_monoxide', 24));
    const readings = [
        ['pm25', iaqiFrom(meanOf(tail('pm2_5', 24)), AQI_BREAKPOINTS.pm25)],
        ['pm10', iaqiFrom(meanOf(tail('pm10', 24)), AQI_BREAKPOINTS.pm10)],
        ['so2',  iaqiFrom(meanOf(tail('sulphur_dioxide', 24)), AQI_BREAKPOINTS.so2)],
        ['no2',  iaqiFrom(meanOf(tail('nitrogen_dioxide', 24)), AQI_BREAKPOINTS.no2)],
        ['co',   iaqiFrom(coRaw === null ? null : coRaw / 1000, AQI_BREAKPOINTS.co)],
        ['o3',   iaqiFrom(meanOf(tail('ozone', 8)), AQI_BREAKPOINTS.o3)],
    ].filter(e => e[1] !== null);

    if (readings.length === 0)
        return null;

    const [primaryKey, aqi] = readings.reduce((a, b) => (b[1] > a[1] ? b : a));
    return {
        aqi,
        display: String(aqi),
        category: aqiCategory(aqi),
        primary: aqi > 50 ? (AQI_POLLUTANT_SHORT[primaryKey] ?? '') : '',
        color: aqiColor(aqi),
    };
}

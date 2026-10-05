

import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import Clutter from 'gi://Clutter';
import Cairo from 'gi://cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

const UPDATE_INTERVAL_SEC = 15 * 60;
const BATTERY_INTERVAL_SEC = 30 * 60;
const CACHE_TTL_SEC = 5 * 60;
const MANUAL_COOLDOWN_SEC = 60;
const DAILY_REQUEST_BUDGET = 800;
const AQI_RING_SIZE = 34;
const AQI_FONT_PX = 10;
const AQI_MAX_FAILURES = 2;
const FORECAST_DAYS = 10;
const FORECAST_ROWS = 3;

const CALENDAR_COLS = 4;

const SUN_ARC_HEIGHT = 60;
const MOON_ARC_HEIGHT = 56;
const MOON_DISC_RADIUS = 7;

function arcSideInset(lineWidth, scaleFactor) {
    const lineGap = lineWidth + 3 * scaleFactor;
    const decorR = Math.max(3.5, 4.5 * scaleFactor, MOON_DISC_RADIUS * scaleFactor);
    return lineGap + decorR;
}

const SKY_ASTRONOMY = [0.22, 0.26, 0.52];
const SKY_NAUTICAL  = [0.30, 0.38, 0.68];
const SKY_CIVIL     = [0.58, 0.52, 0.76];
const SKY_DAY       = [1.00, 0.72, 0.20];

const MOON_LIT_ALPHA = 0.85;
const MOON_DARK_ALPHA = 0.16;
const TREND_CHART_HEIGHT = 64;
const TREND_CHART_WIDTH = 400;
const TREND_LABEL_PX = 8;
const MOON_STRIP_HEIGHT = 30;
const TEMP_BAR_HEIGHT = 8;

const TEMP_BAR_WIDTH = 110;

const COLOR_HIGH = [0.95, 0.55, 0.20];
const COLOR_LOW = [0.30, 0.60, 0.95];

const TEMP_RAMP = [
    [0.00, 0.30, 0.60, 0.95],
    [0.35, 0.35, 0.80, 0.85],
    [0.60, 0.95, 0.85, 0.30],
    [1.00, 0.95, 0.55, 0.20],
];

const OPEN_METEO_HOST = 'https://api.open-meteo.com';
const OPEN_METEO_AQI_HOST = 'https://air-quality-api.open-meteo.com';

const OPEN_METEO_FORECAST_DAYS = 16;

const SOURCE_KEYS = ['source-current', 'source-forecast',
                     'source-air-quality', 'source-astronomy'];
const SETTINGS_VERSION = 1;

function migrateSourceSettings(settings) {
    if (settings.get_int('settings-version') >= SETTINGS_VERSION)
        return;
    const legacy = settings.get_user_value('use-open-meteo-fallback');
    const target = legacy && legacy.get_boolean() ? 'auto' : 'qweather';
    for (const key of SOURCE_KEYS)
        settings.set_string(key, target);
    settings.set_int('settings-version', SETTINGS_VERSION);
}

let _debug = false;

function setDebugLogging(enabled) {
    _debug = !!enabled;
}

function logError(...args) {
    if (_debug)
        console.error('[ClimaCN]', ...args);
}

function getWeatherUrl(host, lat, lon) {
    return `${host}/weather/v1/current/${formatCoord(lat)}/${formatCoord(lon)}?localTime=true`;
}

function getForecastUrl(host, lat, lon) {
    return `${host}/weather/v1/daily/${formatCoord(lat)}/${formatCoord(lon)}?days=${FORECAST_DAYS}&localTime=true`;
}

function formatCoord(value) {
    const n = toFiniteOrNull(value);
    return n === null ? '0.00' : n.toFixed(2);
}

function normalizeHost(raw) {
    const host = (raw || '').trim()
        .replace(/^https?:\/\//i, '')
        .split('/')[0];
    if (!host)
        return '';
    return `https://${host}`;
}

const COMPASS_ZH = {
    n: '北风', nne: '东北偏北风', ne: '东北风', ene: '东北偏东风',
    e: '东风', ese: '东南偏东风', se: '东南风', sse: '东南偏南风',
    s: '南风', ssw: '西南偏南风', sw: '西南风', wsw: '西南偏西风',
    w: '西风', wnw: '西北偏西风', nw: '西北风', nnw: '西北偏北风',
    none: '无持续风向', vrb: '风向不定',
};

function compassToChinese(code) {
    return COMPASS_ZH[String(code || '').toLowerCase()] || '--';
}

function toPercent(value) {
    const n = toFiniteOrNull(value);
    return n === null ? '--%' : `${Math.round(n * 100)}%`;
}

function toFiniteOrNull(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === 'string') {
        if (value.trim() === '')
            return null;
    } else if (typeof value !== 'number') {
        return null;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function roundTemp(value) {
    const n = toFiniteOrNull(value);
    return n === null ? '--°' : `${Math.round(n)}°`;
}

function formatMeasure(obj, fallback = '--') {
    const n = toFiniteOrNull(obj?.value);
    if (n === null)
        return fallback;
    return obj?.unit ? `${Math.round(n)} ${obj.unit}` : `${Math.round(n)}`;
}

function safeIconCode(code) {
    const s = String(code ?? '');
    return /^[0-9A-Za-z]+$/.test(s) ? s : '999';
}

function currentRequestCount(storedDate, storedCount, today) {
    return storedDate === today ? storedCount : 0;
}

function nextRequestCount(storedDate, storedCount, today) {
    return storedDate === today ? storedCount + 1 : 1;
}

function getAirQualityUrl(host, lat, lon) {
    return `${host}/airquality/v1/current/${formatCoord(lat)}/${formatCoord(lon)}`;
}

function parseAqiIndex(json) {
    const list = Array.isArray(json?.indexes) ? json.indexes : [];
    if (list.length === 0)
        return null;
    const idx = list.find(i => i?.code === 'qaqi') ?? list[0];
    const aqi = toFiniteOrNull(idx?.aqi);
    if (aqi === null)
        return null;
    const c = idx?.color ?? {};
    const channel = v => (toFiniteOrNull(v) ?? 128);
    return {
        aqi,
        display: idx?.aqiDisplay || String(Math.round(aqi)),
        category: idx?.category || '',
        color: { r: channel(c.red), g: channel(c.green), b: channel(c.blue) },
    };
}

function aqiFillRatio(aqi) {
    const n = toFiniteOrNull(aqi);
    if (n === null)
        return 0;
    return Math.min(Math.max(n, 0), 300) / 300;
}

const AQI_LEVELS = [0, 50, 100, 150, 200, 300, 400, 500];

const AQI_BREAKPOINTS = {
    pm25: [0, 35, 75, 115, 150, 250, 350, 500],
    pm10: [0, 50, 150, 250, 350, 420, 500, 600],
    so2:  [0, 50, 150, 475, 800, 1600, 2100, 2620],
    no2:  [0, 40, 80, 180, 280, 565, 750, 940],
    co:   [0, 2, 4, 14, 24, 36, 48, 60],
    o3:   [0, 100, 160, 215, 265, 800],
};

const AQI_POLLUTANT_ZH = {
    pm25: '细颗粒物（PM2.5）',
    pm10: '可吸入颗粒物（PM10）',
    so2: '二氧化硫',
    no2: '二氧化氮',
    co: '一氧化碳',
    o3: '臭氧',
};

const AQI_CATEGORIES = [
    [50,  '优',       [0.00, 0.89, 0.00]],
    [100, '良',       [1.00, 1.00, 0.00]],
    [150, '轻度污染', [1.00, 0.49, 0.00]],
    [200, '中度污染', [1.00, 0.00, 0.00]],
    [300, '重度污染', [0.56, 0.25, 0.59]],
    [Infinity, '严重污染', [0.49, 0.00, 0.14]],
];

function aqiCategory(aqi) {
    for (const [limit, name] of AQI_CATEGORIES) {
        if (aqi <= limit)
            return name;
    }
    return AQI_CATEGORIES[AQI_CATEGORIES.length - 1][1];
}

function aqiColor(aqi) {
    for (const [limit, , rgb] of AQI_CATEGORIES) {
        if (aqi <= limit)
            return { r: rgb[0] * 255, g: rgb[1] * 255, b: rgb[2] * 255 };
    }
    return { r: 126, g: 0, b: 36 };
}

function iaqiFrom(concentration, table) {
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

function meanOf(values) {
    const nums = (Array.isArray(values) ? values : [])
        .map(toFiniteOrNull)
        .filter(v => v !== null);
    if (nums.length === 0)
        return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function chinaAqiFromHourly(nowIso, aq) {
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
        primary: aqi > 50 ? AQI_POLLUTANT_ZH[primaryKey] : '',
        color: aqiColor(aqi),
    };
}

const PRESSURE_WINDOW_SEC = 3 * 3600;
const PRESSURE_MAX_SAMPLES = 24;
const PRESSURE_STEADY_HPA = 1.0;
const PRESSURE_MIN_SPAN_SEC = 30 * 60;

function parsePressureHistory(raw) {
    try {
        const arr = JSON.parse(raw || '[]');
        if (!Array.isArray(arr))
            return [];
        return arr
            .map(e => ({ t: toFiniteOrNull(e?.t), p: toFiniteOrNull(e?.p) }))
            .filter(e => e.t !== null && e.p !== null)
            .sort((a, b) => a.t - b.t);
    } catch (_e) {
        return [];
    }
}

function appendPressureSample(history, t, p) {
    const cutoff = t - PRESSURE_WINDOW_SEC;
    const kept = history.filter(e => e.t >= cutoff);
    kept.push({ t, p });
    return kept.slice(-PRESSURE_MAX_SAMPLES);
}

function pressureTrend(history, currentP, nowSec) {
    if (!Number.isFinite(currentP) || history.length === 0)
        return null;
    const cutoff = nowSec - PRESSURE_WINDOW_SEC;
    const base = history.find(e => e.t >= cutoff);
    if (!base || nowSec - base.t < PRESSURE_MIN_SPAN_SEC)
        return null;
    const delta = currentP - base.p;
    const dir = Math.abs(delta) < PRESSURE_STEADY_HPA
        ? 'steady'
        : (delta > 0 ? 'rising' : 'falling');
    return { delta, dir };
}

function formatPressureTrend(trend) {
    if (!trend)
        return '';
    if (trend.dir === 'steady')
        return '→';
    return `${trend.dir === 'rising' ? '↑' : '↓'}${Math.abs(trend.delta).toFixed(1)}`;
}

function parseClockMinutes(iso) {
    const m = /T(\d{2}):(\d{2})/.exec(String(iso ?? ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function formatClock(minutes) {
    const n = toFiniteOrNull(minutes);
    if (n === null)
        return '--:--';
    const h = Math.floor(n / 60) % 24;
    const m = Math.round(n % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const MOON_PHASES = {
    'new-moon':        { name: '新月',   lit: 0.000, waxing: true  },
    'waxing-crescent': { name: '蛾眉月', lit: 0.146, waxing: true  },
    'first-quarter':   { name: '上弦月', lit: 0.500, waxing: true  },
    'waxing-gibbous':  { name: '盈凸月', lit: 0.854, waxing: true  },
    'full-moon':       { name: '满月',   lit: 1.000, waxing: true  },
    'waning-gibbous':  { name: '亏凸月', lit: 0.854, waxing: false },
    'last-quarter':    { name: '下弦月', lit: 0.500, waxing: false },
    'waning-crescent': { name: '残月',   lit: 0.146, waxing: false },
};

function parseMoon(astro) {
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

function parseAstro(days) {
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

function sunArcSpan(astro) {
    const { astronomicalDawn: a, astronomicalDusk: b, sunrise, sunset } = astro;
    if (a !== null && b !== null && b > a)
        return { start: a, end: b, hasTwilight: true };
    return { start: sunrise, end: sunset, hasTwilight: false };
}

function sunArcPosition(nowMinutes, astro) {
    if (!astro)
        return null;
    const { start, end } = sunArcSpan(astro);
    const ratio = (nowMinutes - start) / (end - start);
    return {
        ratio: Math.min(Math.max(ratio, 0), 1),
        isDay: nowMinutes >= astro.sunrise && nowMinutes <= astro.sunset,
    };
}

function skyColorAt(minutes, astro) {
    const nodes = [
        [astro.astronomicalDawn, SKY_ASTRONOMY],
        [astro.nauticalDawn,     SKY_NAUTICAL],
        [astro.civilDawn,        SKY_CIVIL],
        [astro.sunrise,          SKY_DAY],
        [astro.sunset,           SKY_DAY],
        [astro.civilDusk,        SKY_CIVIL],
        [astro.nauticalDusk,     SKY_NAUTICAL],
        [astro.astronomicalDusk, SKY_ASTRONOMY],
    ].filter(e => e[0] !== null && e[0] !== undefined)
     .sort((a, b) => a[0] - b[0]);

    if (nodes.length === 0)
        return SKY_DAY;
    if (minutes <= nodes[0][0])
        return nodes[0][1];
    for (let i = 1; i < nodes.length; i++) {
        const [m1, c1] = nodes[i - 1];
        const [m2, c2] = nodes[i];
        if (minutes <= m2) {
            const k = m2 > m1 ? (minutes - m1) / (m2 - m1) : 1;
            return [
                c1[0] + (c2[0] - c1[0]) * k,
                c1[1] + (c2[1] - c1[1]) * k,
                c1[2] + (c2[2] - c1[2]) * k,
            ];
        }
    }
    return nodes[nodes.length - 1][1];
}

function moonArcPosition(nowMinutes, moon) {
    if (!moon)
        return null;
    const now = nowMinutes < moon.moonrise ? nowMinutes + 24 * 60 : nowMinutes;
    const ratio = (now - moon.moonrise) / (moon.moonset - moon.moonrise);
    return {
        ratio: Math.min(Math.max(ratio, 0), 1),
        isUp: now >= moon.moonrise && now <= moon.moonset,
    };
}

function parseMoonPhases(days) {
    if (!Array.isArray(days))
        return [];
    return days.map(d => MOON_PHASES[d?.astro?.moonPhase] ?? null);
}

function parseTrendPoints(days) {
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

const WMO_TO_QWEATHER_DAY = {
    0: '100', 1: '102', 2: '101', 3: '104',
    45: '501', 48: '501',
    51: '309', 53: '309', 55: '309', 56: '313', 57: '313',
    61: '305', 63: '306', 65: '307', 66: '313', 67: '313',
    71: '400', 73: '401', 75: '402', 77: '407',
    80: '300', 81: '301', 82: '310',
    85: '407', 86: '407',
    95: '302', 96: '304', 99: '304',
};

const WMO_TO_QWEATHER_NIGHT = { 0: '150', 1: '152', 2: '151' };

const WMO_TEXT_ZH = {
    0: '晴', 1: '少云', 2: '多云', 3: '阴',
    45: '雾', 48: '雾凇',
    51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
    61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
    80: '阵雨', 81: '强阵雨', 82: '暴雨',
    85: '阵雪', 86: '强阵雪',
    95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹',
};

function wmoToQweatherCode(code, isDay = true) {
    const c = toFiniteOrNull(code);
    if (c === null)
        return '999';
    if (!isDay && WMO_TO_QWEATHER_NIGHT[c])
        return WMO_TO_QWEATHER_NIGHT[c];
    return WMO_TO_QWEATHER_DAY[c] ?? '999';
}

function wmoToText(code) {
    const c = toFiniteOrNull(code);
    return c === null ? '--' : (WMO_TEXT_ZH[c] ?? '--');
}

const COMPASS_CODES = ['n', 'nne', 'ne', 'ene', 'e', 'ese', 'se', 'sse',
                       's', 'ssw', 'sw', 'wsw', 'w', 'wnw', 'nw', 'nnw'];

function degreesToCompass(degrees) {
    const d = toFiniteOrNull(degrees);
    if (d === null)
        return 'none';
    const normalized = ((d % 360) + 360) % 360;
    return COMPASS_CODES[Math.round(normalized / 22.5) % 16];
}

const BEAUFORT_MAX_MS = [0.2, 1.5, 3.3, 5.4, 7.9, 10.7, 13.8, 17.1,
                         20.7, 24.4, 28.4, 32.6];

function beaufortFromMs(ms) {
    const v = toFiniteOrNull(ms);
    if (v === null || v < 0)
        return null;
    for (let i = 0; i < BEAUFORT_MAX_MS.length; i++) {
        if (v <= BEAUFORT_MAX_MS[i])
            return i;
    }
    return 12;
}

function lastHourlyIndex(times, nowIso) {
    if (!Array.isArray(times) || !nowIso)
        return -1;
    const key = String(nowIso).slice(0, 13);
    let idx = -1;
    for (let i = 0; i < times.length; i++) {
        if (String(times[i]).slice(0, 13) <= key)
            idx = i;
        else
            break;
    }
    return idx;
}

function getOpenMeteoUrl(lat, lon) {
    const query = [
        'current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,' +
            'precipitation,weather_code,cloud_cover,pressure_msl,' +
            'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
        'hourly=dew_point_2m,visibility,uv_index',
        'daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,' +
            'uv_index_max,moonrise,moonset,moon_phase',
        'wind_speed_unit=ms',
        `forecast_days=${OPEN_METEO_FORECAST_DAYS}`,
        'timezone=auto',
    ].join('&');
    return `${OPEN_METEO_HOST}/v1/forecast?latitude=${formatCoord(lat)}&longitude=${formatCoord(lon)}&${query}`;
}

function getOpenMeteoAirQualityUrl(lat, lon) {
    const query = [
        'hourly=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone',
        'past_days=1',
        'forecast_days=1',
        'timezone=auto',
    ].join('&');
    return `${OPEN_METEO_AQI_HOST}/v1/air-quality?latitude=${formatCoord(lat)}&longitude=${formatCoord(lon)}&${query}`;
}

function openMeteoAsQweatherCurrent(json, nowIso) {
    const cur = json?.current ?? {};
    const hourly = json?.hourly ?? {};
    const hi = lastHourlyIndex(hourly.time, nowIso);
    const at = key => (hi >= 0 && Array.isArray(hourly[key]) ? hourly[key][hi] : null);
    const num = v => toFiniteOrNull(v);
    const humidity = num(cur.relative_humidity_2m);
    const cloud = num(cur.cloud_cover);

    return {
        condition: {
            code: wmoToQweatherCode(cur.weather_code, cur.is_day !== 0),
            text: wmoToText(cur.weather_code),
        },
        temperature: { value: num(cur.temperature_2m) },
        feelsLike: { value: num(cur.apparent_temperature) },
        humidity: humidity === null ? null : humidity / 100,
        cloudCover: cloud === null ? null : cloud / 100,
        wind: {
            direction: { compass: degreesToCompass(cur.wind_direction_10m) },
            scale: beaufortFromMs(cur.wind_speed_10m),
        },
        pressure: { value: num(cur.pressure_msl), unit: 'hPa' },
        visibility: { value: num(at('visibility')), unit: 'm' },
        dewPoint: { value: num(at('dew_point_2m')) },
        uvIndex: num(at('uv_index')),
        windGust: { value: num(cur.wind_gusts_10m), unit: 'm/s' },
        precipitation: { amount: { value: num(cur.precipitation), unit: 'mm' } },
    };
}

const MOON_PHASE_CENTERS = [
    ['new-moon', 0.000], ['waxing-crescent', 0.125], ['first-quarter', 0.250],
    ['waxing-gibbous', 0.375], ['full-moon', 0.500], ['waning-gibbous', 0.625],
    ['last-quarter', 0.750], ['waning-crescent', 0.875],
];

function moonPhaseFromFraction(p) {
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

function openMeteoAsQweatherDaily(json) {
    const d = json?.daily ?? {};
    const times = Array.isArray(d.time) ? d.time : [];
    const num = v => toFiniteOrNull(v);
    return times.map((date, i) => {
        const phase = moonPhaseFromFraction(d.moon_phase?.[i]);
        return {
            astro: {
                sunrise: d.sunrise?.[i],
                sunset: d.sunset?.[i],
                moonrise: d.moonrise?.[i],
                moonset: d.moonset?.[i],
                moonPhase: phase?.name ?? null,
                moonLit: phase?.lit ?? null,
            },
            daytime: {
                condition: {
                    code: wmoToQweatherCode(d.weather_code?.[i], true),
                    text: wmoToText(d.weather_code?.[i]),
                },
            },
            temperatureMin: { value: num(d.temperature_2m_min?.[i]) },
            temperatureMax: { value: num(d.temperature_2m_max?.[i]) },
            _date: date,
        };
    });
}

function cairoFontDescription(themeFont, sizePx, scaleFactor) {
    let font = null;
    try {
        font = themeFont?.copy() ?? null;
    } catch (_e) {
        font = null;
    }
    if (!font || !font.get_family())
        font = Pango.FontDescription.from_string('Sans');
    font.set_absolute_size(Math.round(sizePx * scaleFactor) * Pango.SCALE);
    return font;
}

function drawCenteredText(cr, layout, text, x, y) {
    layout.set_text(String(text), -1);
    const [textW, textH] = layout.get_pixel_size();
    cr.moveTo(Math.round(x - textW / 2), Math.round(y - textH / 2));
    PangoCairo.show_layout(cr, layout);
}

function parseCsvLine(line) {
    const fields = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch !== '"') {
                field += ch;
            } else if (line[i + 1] === '"') {
                field += '"';
                i++;
            } else {
                inQuotes = false;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            fields.push(field);
            field = '';
        } else {
            field += ch;
        }
    }
    fields.push(field);
    return fields;
}

const CMA_ALERT_HOST = 'https://weather.cma.cn';
const ALERT_MAX_FAILURES = 3;

const ALERT_DETAIL_WIDTH = 400;

const ALERT_DETAIL_FAILED = { failed: true };

const ALERT_MAX_DISTANCE_KM = 150;

const ALERT_LEVELS = {
    BLUE:   { key: 'blue',   zh: '蓝色', rank: 1 },
    YELLOW: { key: 'yellow', zh: '黄色', rank: 2 },
    ORANGE: { key: 'orange', zh: '橙色', rank: 3 },
    RED:    { key: 'red',    zh: '红色', rank: 4 },
};
const ALERT_LEVEL_UNKNOWN = { key: 'unknown', zh: '', rank: 0 };

function alertLevel(severity) {
    return ALERT_LEVELS[String(severity ?? '').toUpperCase()] ?? ALERT_LEVEL_UNKNOWN;
}

function getCmaAlertsUrl(stationId) {
    return `${CMA_ALERT_HOST}/api/weather/view?stationid=${encodeURIComponent(stationId)}`;
}

function getCmaAlertDetailUrl(alertId) {
    return `${CMA_ALERT_HOST}/api/alarm/${encodeURIComponent(alertId)}`;
}

function parseStationList(csvText) {
    const out = [];
    for (const line of String(csvText ?? '').split('\n')) {
        if (!line || line.startsWith('#') || line.startsWith('Station_ID'))
            continue;
        const [rawId, rawName, rawLat, rawLon] = line.split(',');
        const lat = toFiniteOrNull(rawLat);
        const lon = toFiniteOrNull(rawLon);
        if (!rawId?.trim() || lat === null || lon === null)
            continue;
        out.push({ id: rawId.trim(), name: (rawName ?? '').trim(), lat, lon });
    }
    return out;
}

function findNearestStation(stations, lat, lon, maxKm = ALERT_MAX_DISTANCE_KM) {
    const la = toFiniteOrNull(lat);
    const lo = toFiniteOrNull(lon);
    if (!Array.isArray(stations) || stations.length === 0 || la === null || lo === null)
        return null;

    const kx = Math.cos(la * Math.PI / 180);
    let best = null;
    for (const s of stations) {
        const dy = s.lat - la;
        const dx = (s.lon - lo) * kx;
        const d2 = dx * dx + dy * dy;
        if (!best || d2 < best.d2)
            best = { d2, station: s };
    }
    const km = Math.sqrt(best.d2) * 111.0;
    return km <= maxKm ? { ...best.station, km } : null;
}

function parseAlerts(json) {
    const list = json?.data?.alarm;
    if (!Array.isArray(list))
        return [];
    return list
        .filter(a => a && typeof a.title === 'string' && a.title.trim())
        .map(a => {
            const level = alertLevel(a.severity);
            return {
                title: a.title.trim(),
                level,
                type: String(a.signaltype ?? '').trim(),
                effective: String(a.effective ?? '').trim(),
            };
        })
        .sort((a, b) => b.level.rank - a.level.rank);
}

function parseAlertDetail(json) {
    const d = json?.data;
    if (!d || typeof d !== 'object')
        return null;
    const text = v => (typeof v === 'string' ? v.trim() : '');
    return {
        sender: text(d.sender),
        effective: text(d.effective),
        description: text(d.description),
        guide: text(d.guide),
    };
}

export default class ClimaCNExtension extends Extension {
    enable() {
        this._enabled = true;

        this._indicator = null;
        this._timeoutId = 0;
        this._searchTimeoutId = 0;
        this._configDebounceId = 0;
        this._searchActivateId = 0;
        this._searchTextChangedId = 0;
        this._debugLoggingId = 0;
        this._sourceCurrentId = 0;
        this._sourceForecastId = 0;
        this._sourceAirQualityId = 0;
        this._sourceAstronomyId = 0;
        this._sunArcRepaintId = 0;
        this._moonArcRepaintId = 0;
        this._aqiRepaintId = 0;
        this._trendRepaintId = 0;
        this._trendMoonRepaintId = 0;
        this._refreshActivateId = 0;
        this._calendarClickedId = 0;
        this._showInCalendarId = 0;
        this._showAlertsId = 0;
        this._alertGen = 0;
        this._alertFailCount = 0;
        this._alertItem = null;
        this._alertLabel = null;
        this._alertDot = null;
        this._alertDetailBox = null;
        this._alertExpandId = 0;
        this._alerts = [];
        this._alertDetails = new Map();
        this._cmaStations = null;
        this._loadingStations = false;
        this._stationWaiters = [];
        this._calendarCard = null;
        this._calendarGrid = null;
        this._calendarCityLabel = null;
        this._session = new Soup.Session();
        this._cancellable = new Gio.Cancellable();

        this._cityData = null;
        this._isLoadingCities = false;
        this._iconExistsCache = new Map();
        this._requestSeq = 0;
        this._lastFetchAt = 0;
        this._onBattery = false;
        this._upower = null;
        this._upowerSignalId = 0;

        this._settings = this.getSettings();
        migrateSourceSettings(this._settings);
        this._apiKey = this._settings.get_string('api-key') || '';
        this._host = normalizeHost(this._settings.get_string('api-base-url'));

        this._latitude = this._settings.get_double('latitude');
        this._longitude = this._settings.get_double('longitude');
        this._currentCityName = this._settings.get_string('city-name');

        this._pressureHistory = parsePressureHistory(this._settings.get_string('pressure-history'));
        this._aqi = null;
        this._aqiFailCount = 0;
        this._sunPosition = null;
        this._astro = null;
        this._moonPosition = null;
        this._trendPoints = [];
        this._moonPhases = [];
        this._lastForecast = null;
        this._attributionText = '';
        this._errorShown = false;

        this._writingSettings = false;

        const onConfigChanged = () => {
            if (!this._enabled) return;
            if (this._configDebounceId) {
                GLib.Source.remove(this._configDebounceId);
                this._configDebounceId = 0;
            }
            this._configDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                this._configDebounceId = 0;
                if (!this._enabled) return GLib.SOURCE_REMOVE;
                this._startAutoRefresh();
                this._fetchWeather();
                return GLib.SOURCE_REMOVE;
            });
        };
        this._apiKeyChangedId = this._settings.connect('changed::api-key', () => {
            this._apiKey = this._settings.get_string('api-key') || '';
            onConfigChanged();
        });
        this._hostChangedId = this._settings.connect('changed::api-base-url', () => {
            this._host = normalizeHost(this._settings.get_string('api-base-url'));
            onConfigChanged();
        });
        const onLocationChanged = () => {
            if (!this._enabled || this._writingSettings) return;
            this._alertGen++;
            this._updateAlerts([]);
            const lat = this._settings.get_double('latitude');
            const lon = this._settings.get_double('longitude');
            if (lat === this._latitude && lon === this._longitude) return;
            this._latitude = lat;
            this._longitude = lon;
            this._fetchWeather();
        };
        this._latitudeChangedId = this._settings.connect('changed::latitude', onLocationChanged);
        this._longitudeChangedId = this._settings.connect('changed::longitude', onLocationChanged);
        this._cityNameChangedId = this._settings.connect('changed::city-name', () => {
            if (!this._enabled || this._writingSettings) return;
            const name = this._settings.get_string('city-name');
            if (name === this._currentCityName) return;
            this._currentCityName = name;
            if (this._cityLabel) this._cityLabel.text = name;
            if (this._calendarCityLabel) {
                const short = this._shortCityName(name);
                this._calendarCityLabel.text = short;
                this._calendarCard.accessible_name = `${_('天气')} ${short}`;
            }
        });

        const onSourceChanged = () => onConfigChanged();
        this._sourceCurrentId = this._settings.connect('changed::source-current', onSourceChanged);
        this._sourceForecastId = this._settings.connect('changed::source-forecast', onSourceChanged);
        this._sourceAirQualityId = this._settings.connect('changed::source-air-quality', onSourceChanged);
        this._sourceAstronomyId = this._settings.connect('changed::source-astronomy', onSourceChanged);

        this._showInCalendarId = this._settings.connect('changed::show-in-calendar', () => {
            if (!this._enabled) return;
            if (this._settings.get_boolean('show-in-calendar'))
                this._buildCalendarSection();
            else
                this._destroyCalendarSection();
        });

        this._showAlertsId = this._settings.connect('changed::show-alerts', () => {
            if (!this._enabled) return;
            this._alertGen++;
            if (this._settings.get_boolean('show-alerts')) {
                this._alertFailCount = 0;
                this._refreshAlerts();
            } else {
                this._updateAlerts([]);
            }
        });

        this._debugLoggingId = this._settings.connect('changed::debug-logging', () => {
            setDebugLogging(this._settings.get_boolean('debug-logging'));
        });
        setDebugLogging(this._settings.get_boolean('debug-logging'));

        this._stylesheetPath = this.path + '/stylesheet.css';
        this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        this._theme.load_stylesheet(Gio.File.new_for_path(this._stylesheetPath));

        this._createIndicator();
        this._buildCalendarSection();
        this._initPowerMonitor();
        this._fetchWeather();
        this._startAutoRefresh();
    }

    _initPowerMonitor() {
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SYSTEM,
            Gio.DBusProxyFlags.NONE,
            null,
            'org.freedesktop.UPower',
            '/org/freedesktop/UPower',
            'org.freedesktop.UPower',
            null,
            (source, result) => {
                if (!this._enabled) return;
                try {
                    this._upower = Gio.DBusProxy.new_for_bus_finish(result);
                } catch (e) {
                    this._upower = null;
                    return;
                }
                this._onBattery = this._upower.get_cached_property('OnBattery')?.get_boolean() ?? false;
                this._upowerSignalId = this._upower.connect('g-properties-changed', () => {
                    if (!this._enabled) return;
                    const onBattery = this._upower?.get_cached_property('OnBattery')?.get_boolean() ?? false;
                    if (onBattery === this._onBattery) return;
                    this._onBattery = onBattery;
                    this._restartAutoRefresh();
                });
                this._restartAutoRefresh();
            }
        );
    }

    disable() {
        this._enabled = false;

        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._searchTimeoutId) {
            GLib.Source.remove(this._searchTimeoutId);
            this._searchTimeoutId = 0;
        }
        if (this._configDebounceId) {
            GLib.Source.remove(this._configDebounceId);
            this._configDebounceId = 0;
        }

        if (this._cancellable && !this._cancellable.is_cancelled())
            this._cancellable.cancel();
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        if (this._stylesheetPath && this._theme) {
            const file = Gio.File.new_for_path(this._stylesheetPath);
            try { this._theme.unload_stylesheet(file); } catch (e) { logError(e); }
        }

        this._destroyUI();

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        if (this._settings && this._debugLoggingId) {
            this._settings.disconnect(this._debugLoggingId);
            this._debugLoggingId = 0;
        }
        setDebugLogging(false);
        if (this._settings) {
            if (this._sourceCurrentId) {
                this._settings.disconnect(this._sourceCurrentId);
                this._sourceCurrentId = 0;
            }
            if (this._sourceForecastId) {
                this._settings.disconnect(this._sourceForecastId);
                this._sourceForecastId = 0;
            }
            if (this._sourceAirQualityId) {
                this._settings.disconnect(this._sourceAirQualityId);
                this._sourceAirQualityId = 0;
            }
            if (this._sourceAstronomyId) {
                this._settings.disconnect(this._sourceAstronomyId);
                this._sourceAstronomyId = 0;
            }
            if (this._apiKeyChangedId) {
                this._settings.disconnect(this._apiKeyChangedId);
                this._apiKeyChangedId = 0;
            }
            if (this._hostChangedId) {
                this._settings.disconnect(this._hostChangedId);
                this._hostChangedId = 0;
            }
            if (this._latitudeChangedId) {
                this._settings.disconnect(this._latitudeChangedId);
                this._latitudeChangedId = 0;
            }
            if (this._longitudeChangedId) {
                this._settings.disconnect(this._longitudeChangedId);
                this._longitudeChangedId = 0;
            }
            if (this._cityNameChangedId) {
                this._settings.disconnect(this._cityNameChangedId);
                this._cityNameChangedId = 0;
            }
            if (this._showInCalendarId) {
                this._settings.disconnect(this._showInCalendarId);
                this._showInCalendarId = 0;
            }
            if (this._showAlertsId) {
                this._settings.disconnect(this._showAlertsId);
                this._showAlertsId = 0;
            }
            this._settings = null;
        }

        if (this._upower) {
            if (this._upowerSignalId) {
                this._upower.disconnect(this._upowerSignalId);
                this._upowerSignalId = 0;
            }
            this._upower = null;
        }

        this._cityData = null;
        this._isLoadingCities = false;
        this._iconExistsCache = null;
        this._requestSeq = 0;
        this._apiKey = null;
        this._host = null;
        this._latitude = 0;
        this._longitude = 0;
        this._currentCityName = null;
        this._writingSettings = false;
        this._aqi = null;
        this._aqiFailCount = 0;
        this._pressureHistory = [];
        this._sunPosition = null;
        this._astro = null;
        this._moonPosition = null;
        this._trendPoints = [];
        this._moonPhases = [];
        this._lastForecast = null;
        this._alertGen = 0;
        this._alertFailCount = 0;
        this._alerts = [];
        this._alertDetails = null;
        this._alertDetailBox = null;
        this._alertExpandId = 0;
        this._cmaStations = null;
        this._loadingStations = false;
        this._stationWaiters = [];
        this._attributionText = '';
        this._errorShown = false;
        this._lastFetchAt = 0;
        this._onBattery = false;
        this._upowerSignalId = 0;
        this._stylesheetPath = null;
        this._theme = null;
        this._cancellable = null;
    }

    _destroyUI() {
        if (this._searchEntry) {
            const clutterText = this._searchEntry.clutter_text;
            if (this._searchActivateId) {
                clutterText.disconnect(this._searchActivateId);
                this._searchActivateId = 0;
            }
            if (this._searchTextChangedId) {
                clutterText.disconnect(this._searchTextChangedId);
                this._searchTextChangedId = 0;
            }
        }
        if (this._sunArcRepaintId) {
            this._sunArcArea?.disconnect(this._sunArcRepaintId);
            this._sunArcRepaintId = 0;
        }
        if (this._moonArcRepaintId) {
            this._moonArcArea?.disconnect(this._moonArcRepaintId);
            this._moonArcRepaintId = 0;
        }
        if (this._trendMoonRepaintId) {
            this._trendMoonArea?.disconnect(this._trendMoonRepaintId);
            this._trendMoonRepaintId = 0;
        }
        if (this._aqiRepaintId) {
            this._aqiArea?.disconnect(this._aqiRepaintId);
            this._aqiRepaintId = 0;
        }
        if (this._trendRepaintId) {
            this._trendArea?.disconnect(this._trendRepaintId);
            this._trendRepaintId = 0;
        }
        if (this._refreshActivateId) {
            this._refreshItem?.disconnect(this._refreshActivateId);
            this._refreshActivateId = 0;
        }

        this._destroyCalendarSection();

        this._destroyAlerts();

        this._sunriseLabel?.destroy();
        this._sunriseLabel = null;
        this._sunArcArea?.destroy();
        this._sunArcArea = null;
        this._sunsetLabel?.destroy();
        this._sunsetLabel = null;
        this._sunArcItem?.destroy();
        this._sunArcItem = null;

        this._moonriseLabel?.destroy();
        this._moonriseLabel = null;
        this._moonArcArea?.destroy();
        this._moonArcArea = null;
        this._moonsetLabel?.destroy();
        this._moonsetLabel = null;
        this._moonPhaseLabel?.destroy();
        this._moonPhaseLabel = null;
        this._moonArcItem?.destroy();
        this._moonArcItem = null;

        this._aqiArea?.destroy();
        this._aqiArea = null;
        this._aqiGroup?.destroy();
        this._aqiGroup = null;

        this._headerIcon?.destroy();
        this._headerIcon = null;
        this._headerTemp?.destroy();
        this._headerTemp = null;
        this._headerCondition?.destroy();
        this._headerCondition = null;
        this._cityLabel?.destroy();
        this._cityLabel = null;

        this._noticeLabel?.destroy();
        this._noticeLabel = null;
        this._noticeItem?.destroy();
        this._noticeItem = null;
        this._attributionLabel?.destroy();
        this._attributionLabel = null;
        this._attributionItem?.destroy();
        this._attributionItem = null;
        this._refreshItem?.destroy();
        this._refreshItem = null;

        this._forecastTitle?.destroy();
        this._forecastTitle = null;
        this._forecastRowsBox?.destroy();
        this._forecastRowsBox = null;
        this._forecastContainer?.destroy();
        this._forecastContainer = null;
        this._trendArea?.destroy();
        this._trendArea = null;
        this._trendMoonArea?.destroy();
        this._trendMoonArea = null;
        this._trendItem?.destroy();
        this._trendItem = null;

        this._searchEntry?.destroy();
        this._searchEntry = null;
        this._searchStatusLabel?.destroy();
        this._searchStatusLabel = null;
        this._searchStatusItem?.destroy();
        this._searchStatusItem = null;
        this._searchResultsSection?.destroy();
        this._searchResultsSection = null;

        this._weatherIcon?.destroy();
        this._weatherIcon = null;
        this._tempLabel?.destroy();
        this._tempLabel = null;

        this._feelsLikeLabel = null;
        this._humidityLabel = null;
        this._windLabel = null;
        this._updateTimeLabel = null;
        this._pressureLabel = null;
        this._visibilityLabel = null;
        this._dewPointLabel = null;
        this._cloudCoverLabel = null;
        this._uvIndexLabel = null;
        this._windGustLabel = null;
        this._precipLabel = null;
    }

    _createIndicator() {
        this._indicator = new PanelMenu.Button(0.0, 'ClimaCN', false);
        const box = new St.BoxLayout({
            style_class: 'climacn-indicator-box',
            y_align: Clutter.ActorAlign.CENTER
        });
        this._weatherIcon = new St.Icon({
            style_class: 'system-status-icon climacn-panel-icon',
            icon_name: 'weather-few-clouds-symbolic',
            icon_size: 18,
            y_align: Clutter.ActorAlign.CENTER
        });
        box.add_child(this._weatherIcon);
        this._tempLabel = new St.Label({
            style_class: 'climacn-temperature',
            text: '--°',
            y_align: Clutter.ActorAlign.CENTER
        });
        box.add_child(this._tempLabel);
        this._indicator.add_child(box);
        this._indicator.menu.box.add_style_class_name('climacn-menu');
        this._buildMenu();
        Main.panel.addToStatusArea('climacn', this._indicator);
    }

    _buildCalendarSection() {
        if (this._calendarCard) return;
        if (!this._settings.get_boolean('show-in-calendar')) return;

        let host = null;
        try {
            const dm = Main.panel.statusArea?.dateMenu;
            host = dm?._weatherItem?.get_parent() ?? dm?._displaysSection?.child ?? null;
        } catch (_e) {
            host = null;
        }
        if (!host || typeof host.add_child !== 'function')
            return;

        for (const child of host.get_children()) {
            if (child.name === 'climacn-calendar-card')
                child.destroy();
        }

        const card = new St.Button({
            style_class: 'weather-button',
            can_focus: true,
            x_expand: true,
            name: 'climacn-calendar-card'
        });

        const box = new St.BoxLayout({
            style_class: 'weather-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true
        });
        card.child = box;

        const titleBox = new St.BoxLayout({ style_class: 'weather-header-box' });
        const titleLabel = new St.Label({
            text: _('天气'),
            style_class: 'weather-header',
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_align: Clutter.ActorAlign.END
        });
        titleBox.add_child(titleLabel);

        this._calendarCityLabel = new St.Label({
            text: this._shortCityName(this._currentCityName),
            style_class: 'weather-header location',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END
        });
        titleBox.add_child(this._calendarCityLabel);
        box.add_child(titleBox);

        const layout = new Clutter.GridLayout({ orientation: Clutter.Orientation.VERTICAL });
        this._calendarGrid = new St.Widget({
            style_class: 'weather-grid',
            layout_manager: layout
        });
        layout.hookup_style(this._calendarGrid);
        box.add_child(this._calendarGrid);

        card.labelActor = titleLabel;
        card.accessible_name = `${_('天气')} ${this._shortCityName(this._currentCityName)}`;

        this._calendarClickedId = card.connect('clicked', () => this._activateFromCalendar());

        this._calendarCard = card;
        host.add_child(card);

        this._updateCalendarSection(this._lastForecast);
    }

    _activateFromCalendar() {
        Main.overview.hide();
        Main.panel.closeCalendar();
        this._indicator?.menu.toggle();
    }

    _shortCityName(name) {
        const s = String(name ?? '');
        const i = s.indexOf('，');
        return i > 0 ? s.slice(0, i) : s;
    }

    _calendarDayName(today, offset) {
        if (offset === 0) return _('今天');
        if (offset === 1) return _('明天');
        const names = [_('周日'), _('周一'), _('周二'), _('周三'),
                       _('周四'), _('周五'), _('周六')];
        return names[today.add_days(offset).get_day_of_week() % 7];
    }

    _updateCalendarSection(forecast) {
        if (!this._calendarGrid) return;

        this._calendarGrid.destroy_all_children();

        const layout = this._calendarGrid.layout_manager;
        const days = Array.isArray(forecast) ? forecast.slice(0, CALENDAR_COLS) : [];

        if (days.length === 0) {
            layout.attach(new St.Label({ text: _('暂无预报数据') }), 0, 0, 1, 1);
            return;
        }

        const today = GLib.DateTime.new_now_local();

        for (let i = 0; i < CALENDAR_COLS; i++) {
            const day = days[i] ?? null;

            const nameLabel = new St.Label({
                text: day ? this._calendarDayName(today, i) : '--',
                style_class: 'weather-forecast-time',
                x_align: Clutter.ActorAlign.CENTER
            });
            nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

            const icon = new St.Icon({
                style_class: 'weather-forecast-icon',
                x_align: Clutter.ActorAlign.CENTER,
                x_expand: true
            });
            if (day) {
                this._applyIcon(icon, this._createFileIcon(
                    `${this.path}/icons/${safeIconCode(day.daytime?.condition?.code)}-symbolic.svg`));
            } else {
                this._applyIcon(icon, null, 'weather-few-clouds-symbolic');
            }

            const tempLabel = new St.Label({
                text: `${roundTemp(day?.temperatureMin?.value)}/${roundTemp(day?.temperatureMax?.value)}`,
                style_class: 'weather-forecast-temp',
                x_align: Clutter.ActorAlign.CENTER
            });
            tempLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

            layout.attach(nameLabel, i, 0, 1, 1);
            layout.attach(icon, i, 1, 1, 1);
            layout.attach(tempLabel, i, 2, 1, 1);
        }
    }

    _destroyCalendarSection() {
        if (this._calendarClickedId) {
            this._calendarCard?.disconnect(this._calendarClickedId);
            this._calendarClickedId = 0;
        }

        this._calendarGrid?.destroy();
        this._calendarGrid = null;
        this._calendarCityLabel?.destroy();
        this._calendarCityLabel = null;

        const card = this._calendarCard;
        this._calendarCard = null;

        try {
            card?.destroy();
        } catch (e) {
            logError(`Failed to destroy calendar card: ${e}`);
        }
    }

    _buildMenu() {
        this._indicator.menu.removeAll();

        this._buildHeader();
        this._buildAlerts();

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._buildSearchUI();
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._buildDetails();
        this._buildSunArc();
        this._buildMoonArc();
        this._buildForecast();
        this._buildFooter();
    }

    _buildSunArc() {
        const box = new St.BoxLayout({
            style_class: 'climacn-sun-arc',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true
        });

        this._sunriseLabel = new St.Label({
            text: '--:--',
            style_class: 'climacn-sun-time',
            y_align: Clutter.ActorAlign.CENTER
        });
        box.add_child(this._sunriseLabel);

        this._sunArcArea = new St.DrawingArea({
            style_class: 'climacn-sun-arc-canvas',
            x_expand: true,
            height: SUN_ARC_HEIGHT,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._sunArcRepaintId = this._sunArcArea.connect('repaint', () => this._drawSunArc());
        box.add_child(this._sunArcArea);

        this._sunsetLabel = new St.Label({
            text: '--:--',
            style_class: 'climacn-sun-time',
            y_align: Clutter.ActorAlign.CENTER
        });
        box.add_child(this._sunsetLabel);

        this._sunArcItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        this._sunArcItem.add_child(box);
        this._sunArcItem.visible = false;
        this._indicator.menu.addMenuItem(this._sunArcItem);
    }

    _buildMoonArc() {
        const outer = new St.BoxLayout({
            style_class: 'climacn-moon-arc',
            vertical: true,
            x_expand: true
        });

        const row = new St.BoxLayout({
            style_class: 'climacn-sun-arc',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true
        });

        this._moonriseLabel = new St.Label({
            text: '--:--',
            style_class: 'climacn-sun-time',
            y_align: Clutter.ActorAlign.CENTER
        });
        row.add_child(this._moonriseLabel);

        this._moonArcArea = new St.DrawingArea({
            style_class: 'climacn-sun-arc-canvas',
            x_expand: true,
            height: MOON_ARC_HEIGHT,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._moonArcRepaintId = this._moonArcArea.connect('repaint', () => this._drawMoonArc());
        row.add_child(this._moonArcArea);

        this._moonsetLabel = new St.Label({
            text: '--:--',
            style_class: 'climacn-sun-time',
            y_align: Clutter.ActorAlign.CENTER
        });
        row.add_child(this._moonsetLabel);
        outer.add_child(row);

        this._moonPhaseLabel = new St.Label({
            text: '',
            style_class: 'climacn-moon-phase',
            x_align: Clutter.ActorAlign.CENTER
        });
        outer.add_child(this._moonPhaseLabel);

        this._moonArcItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        this._moonArcItem.add_child(outer);
        this._moonArcItem.visible = false;
        this._indicator.menu.addMenuItem(this._moonArcItem);
    }

    _buildAlerts() {
        this._alertItem = new PopupMenu.PopupSubMenuMenuItem('', false);
        this._alertItem.add_style_class_name('climacn-alert-row');

        this._alertDot = new St.Widget({
            style_class: 'climacn-alert-dot alert-unknown',
            y_align: Clutter.ActorAlign.CENTER
        });
        this._alertItem.insert_child_at_index(this._alertDot, 0);
        this._alertLabel = this._alertItem.label;
        this._alertLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        this._alertDetailBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'climacn-alert-detail-box'
        });
        const detailItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        detailItem.add_child(this._alertDetailBox);
        this._alertItem.menu.addMenuItem(detailItem);

        this._alertExpandId = this._alertItem.menu.connect('open-state-changed', (menu, open) => {
            if (open)
                this._onAlertExpanded();
        });

        this._alertItem.visible = false;
        this._indicator.menu.addMenuItem(this._alertItem);
    }

    _wrappedAlertLabel(text, styleClass) {
        const label = new St.Label({ text, style_class: styleClass });
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.set_width(ALERT_DETAIL_WIDTH);
        return label;
    }

    _onAlertExpanded() {
        if (!this._alertItem || this._alerts.length === 0)
            return;

        const missing = this._alerts.filter(a => !this._alertDetails.has(a.id));
        this._renderAlertDetails();
        for (const alert of missing) {
            this._alertDetails.set(alert.id, null);
            this._fetchAlertDetail(alert.id, this._alertGen);
        }
    }

    _fetchAlertDetail(alertId, gen) {
        const message = Soup.Message.new('GET', getCmaAlertDetailUrl(alertId));
        if (!message)
            return;
        this._session.send_and_read_async(
            message,
            Soup.MessagePriority.NORMAL,
            this._cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (!this._enabled || this._cancellable?.is_cancelled())
                        return;
                    if (gen !== this._alertGen)
                        return;
                    if (message.status_code !== Soup.Status.OK) {
                        logError(`预警详情 HTTP ${message.status_code}`);
                        this._alertDetails.set(alertId, ALERT_DETAIL_FAILED);
                    } else {
                        this._alertDetails.set(alertId, parseAlertDetail(
                            JSON.parse(new TextDecoder().decode(bytes.get_data())))
                            ?? ALERT_DETAIL_FAILED);
                    }
                    if (this._alertItem?.menu.isOpen)
                        this._renderAlertDetails();
                } catch (e) {
                    if (!this._enabled)
                        return;
                    logError(`预警详情解析失败: ${e}`);
                    this._alertDetails.set(alertId, ALERT_DETAIL_FAILED);
                }
            });
    }

    _renderAlertDetails() {
        if (!this._alertDetailBox)
            return;
        this._alertDetailBox.destroy_all_children();

        for (const alert of this._alerts) {
            const box = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'climacn-alert-detail'
            });

            const head = new St.BoxLayout({ style_class: 'climacn-alert-detail-head' });
            const dot = new St.Widget({
                style_class: `climacn-alert-dot alert-${alert.level.key}`,
                y_align: Clutter.ActorAlign.CENTER
            });
            head.add_child(dot);
            head.add_child(this._wrappedAlertLabel(alert.title, 'climacn-alert-detail-title'));
            box.add_child(head);

            const detail = this._alertDetails.get(alert.id);
            if (!detail || detail === ALERT_DETAIL_FAILED) {
                box.add_child(new St.Label({
                    text: detail === ALERT_DETAIL_FAILED ? _('详情暂时取不到') : _('详情加载中…'),
                    style_class: 'climacn-alert-detail-pending'
                }));
                this._alertDetailBox.add_child(box);
                continue;
            }

            if (detail.effective) {
                box.add_child(new St.Label({
                    text: `${_('发布时间')} ${detail.effective}`,
                    style_class: 'climacn-alert-detail-meta'
                }));
            }
            if (detail.description)
                box.add_child(this._wrappedAlertLabel(detail.description, 'climacn-alert-detail-text'));

            if (detail.guide) {
                box.add_child(new St.Label({
                    text: _('防御指南'),
                    style_class: 'climacn-alert-detail-heading'
                }));
                box.add_child(this._wrappedAlertLabel(detail.guide, 'climacn-alert-detail-text'));
            }

            this._alertDetailBox.add_child(box);
        }
    }

    _loadStationData(callback) {
        if (this._cmaStations) {
            callback();
            return;
        }
        if (this._loadingStations) {
            this._stationWaiters.push(callback);
            return;
        }
        this._loadingStations = true;
        this._stationWaiters.push(callback);

        const file = Gio.File.new_for_path(`${this.path}/data/CMA-Station-List.csv`);
        file.load_contents_async(null, (f, result) => {
            const waiters = this._stationWaiters;
            this._stationWaiters = [];
            this._loadingStations = false;
            if (!this._enabled)
                return;
            try {
                const [ok, contents] = f.load_contents_finish(result);
                if (!ok)
                    throw new Error('load failed');
                this._cmaStations = parseStationList(new TextDecoder().decode(contents));
            } catch (e) {
                logError(`站点表加载失败: ${e}`);
                this._cmaStations = [];
            }
            for (const fn of waiters) {
                if (this._enabled)
                    fn();
            }
        });
    }

    _refreshAlerts() {
        if (!this._enabled || !this._settings?.get_boolean('show-alerts'))
            return;
        if (this._alertFailCount >= ALERT_MAX_FAILURES)
            return;

        this._loadStationData(() => {
            if (!this._enabled || !this._settings?.get_boolean('show-alerts'))
                return;
            if (this._alertFailCount >= ALERT_MAX_FAILURES)
                return;

            const station = findNearestStation(
                this._cmaStations, this._latitude, this._longitude);
            if (!station) {
                this._updateAlerts([]);
                return;
            }
            this._fetchAlerts(station.id, this._alertGen);
        });
    }

    _fetchAlerts(stationId, gen) {
        const message = Soup.Message.new('GET', getCmaAlertsUrl(stationId));
        if (!message) {
            this._alertFailCount++;
            this._updateAlerts([]);
            return;
        }
        this._session.send_and_read_async(
            message,
            Soup.MessagePriority.NORMAL,
            this._cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (!this._enabled || this._cancellable?.is_cancelled())
                        return;
                    if (gen !== this._alertGen)
                        return;
                    if (message.status_code !== Soup.Status.OK) {
                        this._alertFailCount++;
                        logError(`预警请求 HTTP ${message.status_code}`);
                        this._updateAlerts([]);
                        return;
                    }
                    this._alertFailCount = 0;
                    this._updateAlerts(parseAlerts(
                        JSON.parse(new TextDecoder().decode(bytes.get_data()))));
                } catch (e) {
                    if (!this._enabled)
                        return;
                    this._alertFailCount++;
                    logError(`预警解析失败: ${e}`);
                    this._updateAlerts([]);
                }
            });
    }

    _updateAlerts(alerts) {
        if (!this._alertItem)
            return;
        const list = Array.isArray(alerts) ? alerts : [];
        this._alerts = list;

        if (list.length === 0) {
            this._alertItem.visible = false;
            return;
        }
        const top = list[0];
        this._alertLabel.text = list.length > 1
            ? `${top.title}（等 ${list.length} 条）`
            : top.title;
        this._alertDot.style_class = `climacn-alert-dot alert-${top.level.key}`;
        this._alertItem.visible = true;

        const sameSet = list.length === this._alertDetails.size &&
            list.every(a => this._alertDetails.has(a.id));
        if (!sameSet) {
            this._alertDetails.clear();
            this._alertDetailBox?.destroy_all_children();
            if (this._alertItem.menu.isOpen)
                this._onAlertExpanded();
        }
    }

    _destroyAlerts() {
        if (this._alertExpandId) {
            this._alertItem?.menu.disconnect(this._alertExpandId);
            this._alertExpandId = 0;
        }
        this._alertLabel = null;
        this._alertDot?.destroy();
        this._alertDot = null;
        this._alertDetailBox?.destroy();
        this._alertDetailBox = null;
        this._alertItem?.destroy();
        this._alertItem = null;
        this._alerts = [];
        this._alertDetails?.clear();
        this._alertDetails = null;
    }

    _buildHeader() {
        const box = new St.BoxLayout({
            style_class: 'climacn-header-box',
            vertical: true,
            x_expand: true
        });

        const row = new St.BoxLayout({
            style_class: 'climacn-header-row',
            y_align: Clutter.ActorAlign.CENTER
        });
        this._headerIcon = new St.Icon({
            style_class: 'climacn-header-icon',
            icon_size: 40,
            y_align: Clutter.ActorAlign.CENTER
        });
        row.add_child(this._headerIcon);

        this._headerTemp = new St.Label({
            style_class: 'climacn-header-temp',
            text: '--°',
            y_align: Clutter.ActorAlign.CENTER
        });
        row.add_child(this._headerTemp);

        this._headerCondition = new St.Label({
            style_class: 'climacn-header-condition',
            text: '--',
            y_align: Clutter.ActorAlign.CENTER
        });
        row.add_child(this._headerCondition);

        row.add_child(new St.Widget({ x_expand: true }));
        this._aqiGroup = new St.BoxLayout({
            style_class: 'climacn-aqi-group',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false
        });
        this._aqiGroup.add_child(new St.Label({
            text: 'AQI',
            style_class: 'climacn-aqi-label',
            y_align: Clutter.ActorAlign.CENTER
        }));
        this._aqiArea = new St.DrawingArea({
            style_class: 'climacn-aqi-ring',
            width: AQI_RING_SIZE,
            height: AQI_RING_SIZE,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._aqiRepaintId = this._aqiArea.connect('repaint', () => this._drawAqiRing());
        this._aqiGroup.add_child(this._aqiArea);
        row.add_child(this._aqiGroup);

        box.add_child(row);

        this._cityLabel = new St.Label({
            text: this._currentCityName,
            style_class: 'climacn-city-label',
            x_align: Clutter.ActorAlign.CENTER
        });
        box.add_child(this._cityLabel);

        const item = new PopupMenu.PopupBaseMenuItem({ activate: false });
        item.add_child(box);
        this._indicator.menu.addMenuItem(item);
    }

    _buildDetails() {
        const grid = new St.BoxLayout({
            style_class: 'climacn-details-grid',
            vertical: true,
            x_expand: true
        });

        const row1 = this._createGridRow(grid);
        this._feelsLikeLabel  = this._createGridCell(row1, '体感', '--°');
        this._humidityLabel   = this._createGridCell(row1, '湿度', '--%');

        const row2 = this._createGridRow(grid);
        this._windLabel       = this._createGridCell(row2, '风向', '--');
        this._updateTimeLabel = this._createGridCell(row2, '上次更新', '--:--');

        const item = new PopupMenu.PopupBaseMenuItem({ activate: false });
        item.add_child(grid);
        this._indicator.menu.addMenuItem(item);

        const extra = new PopupMenu.PopupSubMenuMenuItem(_('更多数据'), false);
        this._pressureLabel   = this._createExtraRow(extra.menu, '气压');
        this._visibilityLabel = this._createExtraRow(extra.menu, '能见度');
        this._dewPointLabel   = this._createExtraRow(extra.menu, '露点');
        this._cloudCoverLabel = this._createExtraRow(extra.menu, '云量');
        this._uvIndexLabel    = this._createExtraRow(extra.menu, '紫外线');
        this._windGustLabel   = this._createExtraRow(extra.menu, '阵风');
        this._precipLabel     = this._createExtraRow(extra.menu, '降水量');
        this._indicator.menu.addMenuItem(extra);
    }

    _createGridRow(grid) {
        const row = new St.BoxLayout({
            style_class: 'climacn-detail-row',
            y_align: Clutter.ActorAlign.CENTER
        });
        grid.add_child(row);
        return row;
    }

    _createGridCell(row, title, initialValue) {
        const cell = new St.BoxLayout({
            style_class: 'climacn-detail-cell',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        cell.add_child(new St.Label({
            text: title,
            style_class: 'climacn-detail-label',
            y_align: Clutter.ActorAlign.CENTER
        }));
        const value = new St.Label({
            text: initialValue,
            style_class: 'climacn-detail-value',
            y_align: Clutter.ActorAlign.CENTER
        });
        cell.add_child(value);
        row.add_child(cell);
        return value;
    }

    _createExtraRow(menu, title) {
        const row = new St.BoxLayout({
            style_class: 'climacn-detail-row',
            y_align: Clutter.ActorAlign.CENTER
        });
        row.add_child(new St.Label({
            text: title,
            style_class: 'climacn-detail-label',
            y_align: Clutter.ActorAlign.CENTER
        }));
        const value = new St.Label({
            text: '--',
            style_class: 'climacn-detail-value',
            y_align: Clutter.ActorAlign.CENTER
        });
        row.add_child(value);

        const item = new PopupMenu.PopupBaseMenuItem({ activate: false });
        item.add_child(row);
        menu.addMenuItem(item);
        return value;
    }

    _buildForecast() {
        this._forecastContainer = new St.BoxLayout({
            style_class: 'climacn-forecast-box',
            vertical: true,
            x_expand: true
        });
        this._forecastTitle = new St.Label({
            text: _('未来 3 天预报'),
            style_class: 'climacn-forecast-title'
        });
        this._forecastContainer.add_child(this._forecastTitle);
        this._forecastRowsBox = new St.BoxLayout({
            style_class: 'climacn-forecast-rows',
            vertical: true
        });
        this._forecastContainer.add_child(this._forecastRowsBox);

        this._buildTrendSubmenu();

        const item = new PopupMenu.PopupBaseMenuItem({ activate: false });
        item.add_child(this._forecastContainer);
        this._indicator.menu.addMenuItem(item);
    }

    _buildTrendSubmenu() {
        this._trendItem = new PopupMenu.PopupSubMenuMenuItem(_('10 天趋势'), false);
        this._trendItem.visible = false;

        this._trendArea = new St.DrawingArea({
            style_class: 'climacn-trend-chart',
            width: TREND_CHART_WIDTH,
            height: TREND_CHART_HEIGHT
        });
        this._trendRepaintId = this._trendArea.connect('repaint', () => this._drawTrendChart());

        const box = new St.BoxLayout({
            style_class: 'climacn-trend-box',
            vertical: true
        });
        box.add_child(this._trendArea);

        this._trendMoonArea = new St.DrawingArea({
            style_class: 'climacn-trend-moons',
            width: TREND_CHART_WIDTH,
            height: MOON_STRIP_HEIGHT
        });
        this._trendMoonRepaintId =
            this._trendMoonArea.connect('repaint', () => this._drawTrendMoons());
        box.add_child(this._trendMoonArea);

        const item = new PopupMenu.PopupBaseMenuItem({ activate: false });
        item.add_child(box);
        this._trendItem.menu.addMenuItem(item);
        this._indicator.menu.addMenuItem(this._trendItem);
    }

    _drawTrendMoons() {
        const area = this._trendMoonArea;
        const phases = this._moonPhases;
        if (!area || !Array.isArray(phases) || phases.length === 0)
            return;
        const [width, height] = area.get_surface_size();
        if (width <= 0 || height <= 0)
            return;
        const cr = area.get_context();
        try {
            const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);
            const fg = this._themeColor(area);
            const r = Math.max(3, 6 * scaleFactor);
            const cy = r + 2 * scaleFactor;

            const padX = 10 * scaleFactor;
            const step = phases.length > 1
                ? (width - 2 * padX) / (phases.length - 1)
                : 0;
            const cxAt = i => phases.length > 1 ? padX + step * i : width / 2;

            const layout = PangoCairo.create_layout(cr);
            let themeFont = null;
            try {
                themeFont = area.get_theme_node().get_font();
            } catch (_e) {
                themeFont = null;
            }
            layout.set_font_description(cairoFontDescription(themeFont, 7, scaleFactor));

            for (let i = 0; i < phases.length; i++) {
                const phase = phases[i];
                if (!phase)
                    continue;
                const cx = cxAt(i);
                this._drawMoonDisc(cr, cx, cy, r, phase, fg, 0.95);
                cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.6);
                drawCenteredText(cr, layout, `${Math.round(phase.lit * 100)}%`,
                                 cx, height - 5 * scaleFactor);
            }
        } finally {
            cr.$dispose();
        }
    }

    _buildFooter() {
        this._noticeLabel = new St.Label({
            style_class: 'climacn-notice',
            text: ''
        });
        this._noticeItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        this._noticeItem.add_child(this._noticeLabel);
        this._noticeItem.visible = false;
        this._indicator.menu.addMenuItem(this._noticeItem);

        this._attributionLabel = new St.Label({
            style_class: 'climacn-attribution',
            text: ''
        });
        this._attributionItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        this._attributionItem.add_child(this._attributionLabel);
        this._attributionItem.visible = false;
        this._indicator.menu.addMenuItem(this._attributionItem);

        this._refreshItem = new PopupMenu.PopupImageMenuItem(_('刷新'), 'view-refresh-symbolic');
        this._refreshActivateId = this._refreshItem.connect('activate', () => this._onManualRefresh());
        this._indicator.menu.addMenuItem(this._refreshItem);
    }

    _updateNotice() {
        if (!this._noticeItem)
            return;
        const exhausted = this._requestBudgetExhausted();
        this._noticeItem.visible = exhausted;
        if (exhausted)
            this._noticeLabel.text = _('今日请求已达上限，自动刷新已暂停');
    }

    _buildSearchUI() {
        this._searchEntry = new St.Entry({
            x_expand: true,
            track_hover: true,
            can_focus: true,
            style_class: 'climacn-search-entry'
        });
        this._searchActivateId = this._searchEntry.clutter_text.connect('activate', () => this._onSearchActivate());
        this._searchTextChangedId = this._searchEntry.clutter_text.connect('text-changed', () => this._onSearchTextChanged());

        const entryItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        entryItem.add_style_class_name('climacn-search-row');
        entryItem.add_child(this._searchEntry);
        this._indicator.menu.addMenuItem(entryItem);

        this._searchStatusLabel = new St.Label({
            style_class: 'climacn-search-status'
        });
        this._searchStatusItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        this._searchStatusItem.add_style_class_name('climacn-search-row');
        this._searchStatusItem.add_style_class_name('climacn-search-status-row');
        this._searchStatusItem.add_child(this._searchStatusLabel);
        this._searchStatusItem.visible = false;
        this._indicator.menu.addMenuItem(this._searchStatusItem);

        this._searchResultsSection = new PopupMenu.PopupMenuSection();
        this._indicator.menu.addMenuItem(this._searchResultsSection);
        this._searchResultsSection.actor.hide();
        this._updateSearchHint();
    }

    _updateSearchHint() {
        if (!this._searchEntry || this._searchEntry.text.trim())
            return;
        this._showSearchStatus(_('搜索城市，例：北京 / 海淀 / 朝阳'));
    }

    _loadCityData() {
        if (this._cityData || this._isLoadingCities) return;
        this._isLoadingCities = true;
        const csvFile = Gio.File.new_for_path(`${this.path}/data/China-City-List-latest.csv`);
        csvFile.load_contents_async(null, (file, result) => {
            if (!this._enabled) return;
            try {
                const [success, contents] = file.load_contents_finish(result);
                if (!success) throw new Error('load failed');
                this._parseCSV(new TextDecoder().decode(contents));
                this._isLoadingCities = false;
            } catch (e) {
                logError(`Failed to load city data: ${e}`);
                this._cityData = [];
                this._isLoadingCities = false;
                this._showSearchStatus(_('本地城市库加载失败，请检查文件路径'));
            }
        });
    }

    _parseCSV(csvText) {
        const cities = [];
        let col = null;
        for (const rawLine of csvText.split('\n')) {
            const line = rawLine.trim();
            if (!line) continue;
            const cols = parseCsvLine(line);
            if (cols.length < 10) continue;

            if (!col) {
                const names = cols.map(c => c.trim());
                if (!names.includes('Location_ID')) continue;
                col = {
                    id: names.indexOf('Location_ID'),
                    name: names.indexOf('Location_Name_ZH'),
                    adm1: names.indexOf('Adm1_Name_ZH'),
                    adm2: names.indexOf('Adm2_Name_ZH'),
                    lat: names.indexOf('Latitude'),
                    lon: names.indexOf('Longitude'),
                };
                if (col.name < 0 || col.adm1 < 0 || col.lat < 0 || col.lon < 0) {
                    logError('城市库表头缺少必要列，已放弃解析');
                    break;
                }
                continue;
            }

            const id = cols[col.id].trim();
            const name = cols[col.name].trim();
            const adm1 = cols[col.adm1].trim();
            const adm2 = col.adm2 < 0 ? '' : cols[col.adm2].trim();
            const lat = toFiniteOrNull(cols[col.lat]);
            const lon = toFiniteOrNull(cols[col.lon]);
            if (!name || !adm1) continue;
            if (lat === null || lon === null) continue;
            cities.push({ id, name, adm1, adm2, lat, lon });
        }
        this._cityData = cities;
    }

    _onSearchTextChanged() {
        if (this._searchTimeoutId) {
            GLib.Source.remove(this._searchTimeoutId);
            this._searchTimeoutId = 0;
        }
        const text = this._searchEntry.text.trim();
        if (!text) {
            this._clearSearchResults();
            return;
        }
        if (!this._cityData && !this._isLoadingCities) this._loadCityData();
        this._searchTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._searchTimeoutId = 0;
            this._performLocalSearch(text);
            return GLib.SOURCE_REMOVE;
        });
    }

    _onSearchActivate() {
        if (this._searchTimeoutId) {
            GLib.Source.remove(this._searchTimeoutId);
            this._searchTimeoutId = 0;
        }
        const text = this._searchEntry.text.trim();
        if (text) this._performLocalSearch(text);
    }

    _performLocalSearch(query) {
        this._clearSearchResults();
        if (!this._cityData) {
            if (this._isLoadingCities)
                this._showSearchStatus(_('正在加载城市库...'));
            else
                this._showSearchStatus(_('城市库未就绪，请稍后重试'));
            return;
        }
        if (this._cityData.length === 0) {
            this._showSearchStatus(_('本地城市库为空，请检查文件'));
            return;
        }
        const q = query.toLowerCase();
        const results = [];
        for (const city of this._cityData) {
            const fields = [city.name, city.adm1, city.adm2].join(' ').toLowerCase();
            if (fields.includes(q)) {
                results.push(city);
                if (results.length >= 15) break;
            }
        }
        if (results.length === 0) {
            this._showSearchStatus(_('未找到相关城市'));
            return;
        }
        this._clearSearchStatus();
        this._searchResultsSection.actor.show();
        for (const city of results) {
            let display = city.name;
            if (city.adm2 && city.adm2 !== city.name && city.adm2 !== city.adm1)
                display += `, ${city.adm2}`;
            display += ` - ${city.adm1}`;
            const item = new PopupMenu.PopupMenuItem(display);
            item.connect('activate', () => this._selectCity(city));
            this._searchResultsSection.addMenuItem(item);
        }
    }

    _showSearchStatus(text) {
        this._searchResultsSection?.actor.hide();
        if (!this._searchStatusLabel || !this._searchStatusItem)
            return;
        this._searchStatusLabel.text = text;
        this._searchStatusItem.visible = true;
    }

    _clearSearchStatus() {
        if (this._searchStatusItem)
            this._searchStatusItem.visible = false;
    }

    _clearSearchResults() {
        if (this._searchResultsSection) {
            this._searchResultsSection.removeAll();
            this._searchResultsSection.actor.hide();
        }
        this._clearSearchStatus();
        this._updateSearchHint();
    }

    _selectCity(city) {
        this._latitude = city.lat;
        this._longitude = city.lon;
        this._currentCityName = `${city.name}，${city.adm1}`;
        this._cityLabel.text = this._currentCityName;

        this._writingSettings = true;
        this._settings.set_double('latitude', this._latitude);
        this._settings.set_double('longitude', this._longitude);
        this._settings.set_string('city-name', this._currentCityName);
        this._writingSettings = false;

        this._searchEntry.text = '';
        this._clearSearchResults();
        this._fetchWeather();
    }

    _intervalSec() {
        return this._onBattery ? BATTERY_INTERVAL_SEC : UPDATE_INTERVAL_SEC;
    }

    _startAutoRefresh() {
        if (this._timeoutId)
            return;
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._intervalSec(), () => {
            this._autoRefreshTick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _restartAutoRefresh() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (!this._enabled)
            return;
        this._startAutoRefresh();
    }

    _autoRefreshTick() {
        if (this._requestBudgetExhausted() && !this._anyOpenMeteoSource()) {
            this._refreshAlerts();
            this._updateNotice();
            return;
        }
        if (this._secondsSinceFetch() < CACHE_TTL_SEC)
            return;
        this._fetchWeather();
    }

    _onManualRefresh() {
        if (!this._enabled)
            return;
        if (this._secondsSinceFetch() < MANUAL_COOLDOWN_SEC)
            return;
        this._fetchWeather();
    }

    _secondsSinceFetch() {
        return GLib.get_monotonic_time() / 1e6 - this._lastFetchAt;
    }

    _todayLocal() {
        return GLib.DateTime.new_now_local().format('%Y-%m-%d');
    }

    _dailyCount() {
        if (!this._settings)
            return 0;
        return currentRequestCount(
            this._settings.get_string('daily-request-date'),
            this._settings.get_int('daily-request-count'),
            this._todayLocal());
    }

    _requestBudgetExhausted() {
        return this._dailyCount() >= DAILY_REQUEST_BUDGET;
    }

    _countRequest() {
        if (!this._settings)
            return;
        const today = this._todayLocal();
        const next = nextRequestCount(
            this._settings.get_string('daily-request-date'),
            this._settings.get_int('daily-request-count'),
            today);
        this._settings.set_string('daily-request-date', today);
        this._settings.set_int('daily-request-count', next);
    }

    _handleHttpError(message, bytes) {
        const status = message.status_code;
        let body = '';
        try {
            body = new TextDecoder().decode(bytes.get_data()).slice(0, 300);
        } catch (_e) {
        }
        logError(`HTTP ${status}: ${body}`);

        if (status === Soup.Status.UNAUTHORIZED || status === Soup.Status.FORBIDDEN) {
            if (this._timeoutId) {
                GLib.Source.remove(this._timeoutId);
                this._timeoutId = 0;
            }
            this._showError(_('API Key 无效或无权访问，已停止更新'), 'auth');
            return;
        }
        if (status === Soup.Status.NOT_FOUND) {
            this._showError(_('API Host 或接口路径不正确'), 'config');
            return;
        }
        this._showError(`请求失败（HTTP ${status}）`, 'network');
    }

    _qweatherConfigured() {
        return !!(this._apiKey && this._apiKey.trim() && this._host);
    }

    _qweatherUsable() {
        return this._qweatherConfigured() && !this._requestBudgetExhausted();
    }

    _sourceFor(category) {
        let mode = 'auto';
        try {
            mode = this._settings?.get_string(`source-${category}`) || 'auto';
        } catch (_e) {
            mode = 'auto';
        }
        if (mode === 'qweather' || mode === 'openmeteo')
            return mode;
        return this._qweatherUsable() ? 'qweather' : 'openmeteo';
    }

    _buildFetchPlan() {
        const src = {
            current: this._sourceFor('current'),
            forecast: this._sourceFor('forecast'),
            airQuality: this._sourceFor('air-quality'),
            astronomy: this._sourceFor('astronomy'),
        };
        return {
            src,
            qwCurrent: src.current === 'qweather',
            qwDaily: src.forecast === 'qweather' || src.astronomy === 'qweather',
            qwAqi: src.airQuality === 'qweather',
            omForecast: src.current === 'openmeteo' || src.forecast === 'openmeteo' ||
                        src.astronomy === 'openmeteo',
            omAqi: src.airQuality === 'openmeteo',
        };
    }

    _attributionFor(plan) {
        const names = [];
        if (plan.qwCurrent || plan.qwDaily || plan.qwAqi)
            names.push(_('和风天气'));
        if (plan.omForecast || plan.omAqi)
            names.push('Open-Meteo');
        return names.join(' + ');
    }

    _anyOpenMeteoSource() {
        const plan = this._buildFetchPlan();
        return plan.omForecast || plan.omAqi;
    }

    _sendJson(message, seq, label, onText) {
        this._session.send_and_read_async(
            message,
            Soup.MessagePriority.NORMAL,
            this._cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (!this._enabled || this._cancellable?.is_cancelled())
                        return;
                    if (seq !== this._requestSeq)
                        return;
                    if (message.status_code !== Soup.Status.OK) {
                        logError(`${label} HTTP ${message.status_code}`);
                        return onText(null);
                    }
                    return onText(JSON.parse(new TextDecoder().decode(bytes.get_data())));
                } catch (e) {
                    if (!this._enabled)
                        return;
                    logError(`${label} error: ${e}`);
                    return onText(null);
                }
            }
        );
    }

    _fetchOpenMeteoForecast(seq, callback) {
        const message = Soup.Message.new('GET',
            getOpenMeteoUrl(this._latitude, this._longitude));
        if (!message) {
            callback(null);
            return;
        }
        const nowIso = GLib.DateTime.new_now_local().format('%Y-%m-%dT%H:00');
        this._sendJson(message, seq, 'Open-Meteo', json => {
            if (!json) {
                this._showError(_('备用数据源请求失败'), 'network');
                callback(null);
                return;
            }
            const daily = openMeteoAsQweatherDaily(json);
            if (daily.length === 0) {
                this._showError(_('备用数据源返回数据不完整'), 'data');
                callback(null);
                return;
            }
            callback({
                current: openMeteoAsQweatherCurrent(json, nowIso),
                daily,
            });
        });
    }

    _fetchOpenMeteoAirQuality(seq, callback) {
        const message = Soup.Message.new('GET',
            getOpenMeteoAirQualityUrl(this._latitude, this._longitude));
        if (!message) {
            callback(null);
            return;
        }
        const nowIso = GLib.DateTime.new_now_local().format('%Y-%m-%dT%H:00');
        this._sendJson(message, seq, 'Open-Meteo AQI', json => {
            callback(json ? chinaAqiFromHourly(nowIso, json) : null);
        });
    }

    _fetchWeather() {
        if (!this._enabled)
            return;

        this._refreshAlerts();

        const plan = this._buildFetchPlan();

        if ((plan.qwCurrent || plan.qwDaily || plan.qwAqi) && !this._qweatherConfigured()) {
            this._showError(this._apiKey?.trim()
                ? _('请在设置中配置 API Host')
                : _('请在设置中配置 API Key'), 'config');
            return;
        }

        if (this._cancellable.is_cancelled())
            this._cancellable = new Gio.Cancellable();

        this._lastFetchAt = GLib.get_monotonic_time() / 1e6;
        this._errorShown = false;

        const seq = ++this._requestSeq;

        const needed = [];
        if (plan.qwCurrent) needed.push('qwCurrent');
        if (plan.qwDaily) needed.push('qwDaily');
        if (plan.qwAqi) needed.push('qwAqi');
        if (plan.omForecast) needed.push('omForecast');
        if (plan.omAqi) needed.push('omAqi');

        const pending = {};
        let settled = false;
        const settle = () => {
            if (settled || !needed.every(k => k in pending))
                return;
            settled = true;
            if (!this._enabled || seq !== this._requestSeq)
                return;
            this._applyPlan(plan, pending);
        };
        const done = (key, value) => {
            pending[key] = value;
            settle();
        };

        if (plan.qwCurrent)
            this._fetchQweatherCurrent(seq, v => done('qwCurrent', v));
        if (plan.qwDaily)
            this._fetchForecast(seq, v => done('qwDaily', v));
        if (plan.qwAqi)
            this._fetchAirQuality(seq, v => done('qwAqi', v));
        if (plan.omForecast)
            this._fetchOpenMeteoForecast(seq, v => done('omForecast', v));
        if (plan.omAqi)
            this._fetchOpenMeteoAirQuality(seq, v => done('omAqi', v));
    }

    _fetchQweatherCurrent(seq, callback) {
        const message = Soup.Message.new('GET',
            getWeatherUrl(this._host, this._latitude, this._longitude));
        if (!message) {
            callback(null);
            return;
        }
        message.request_headers.append('X-Qw-Api-Key', this._apiKey);
        this._countRequest();
        this._sendJson(message, seq, '和风实时', json => {
            if (json && (!json.condition || !json.temperature)) {
                logError(`响应缺少预期字段: ${JSON.stringify(json).slice(0, 300)}`);
                json = null;
            }
            callback(json);
        });
    }

    _applyPlan(plan, pending) {
        const om = pending.omForecast ?? null;
        const omDays = Array.isArray(om?.daily) ? om.daily : null;

        const now = plan.src.current === 'qweather'
            ? (pending.qwCurrent ?? null)
            : (om?.current ?? null);

        const baseDays = plan.src.forecast === 'qweather'
            ? (pending.qwDaily ?? null)
            : omDays;
        const astroDays = plan.src.astronomy === 'qweather'
            ? (pending.qwDaily ?? null)
            : omDays;

        let forecast = baseDays;
        if (Array.isArray(baseDays) && Array.isArray(astroDays) && baseDays !== astroDays) {
            forecast = baseDays.map((d, i) =>
                astroDays[i]?.astro ? { ...d, astro: astroDays[i].astro } : d);
        } else if (!Array.isArray(baseDays) && Array.isArray(astroDays)) {
            forecast = astroDays.map(d => ({ astro: d.astro }));
        }

        const aqi = plan.src.airQuality === 'qweather'
            ? (pending.qwAqi ?? null)
            : (pending.omAqi ?? null);

        if (!now) {
            if (!this._errorShown)
                this._showError(_('获取失败'), 'network');
            return;
        }
        if (now.temperature?.value === null || now.temperature?.value === undefined) {
            this._showError(_('数据格式异常'), 'data');
            return;
        }

        this._attributionText = this._attributionFor(plan);
        this._updateUI(now, forecast, aqi);
    }

    _fetchForecast(seq, callback) {
        const url = getForecastUrl(this._host, this._latitude, this._longitude);
        const message = Soup.Message.new('GET', url);
        if (!message) {
            callback(null);
            return;
        }
        message.request_headers.append('X-Qw-Api-Key', this._apiKey);
        this._countRequest();

        this._session.send_and_read_async(
            message,
            Soup.MessagePriority.NORMAL,
            this._cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (!this._enabled) return;
                    if (seq !== this._requestSeq) return;
                    if (this._cancellable?.is_cancelled()) {
                        callback(null);
                        return;
                    }
                    if (message.status_code !== Soup.Status.OK) {
                        logError(`预报请求 HTTP ${message.status_code}`);
                        callback(null);
                        return;
                    }
                    const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    callback(Array.isArray(json.days) ? json.days : null);
                } catch (e) {
                    if (!this._enabled) return;
                    logError(`Forecast parse error: ${e}`);
                    callback(null);
                }
            }
        );
    }

    _fetchAirQuality(seq, callback) {
        if (this._aqiFailCount >= AQI_MAX_FAILURES) {
            callback(null);
            return;
        }
        const url = getAirQualityUrl(this._host, this._latitude, this._longitude);
        const message = Soup.Message.new('GET', url);
        if (!message) {
            callback(null);
            return;
        }
        message.request_headers.append('X-Qw-Api-Key', this._apiKey);
        this._countRequest();

        this._session.send_and_read_async(
            message,
            Soup.MessagePriority.NORMAL,
            this._cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (!this._enabled || seq !== this._requestSeq) return;
                    if (this._cancellable?.is_cancelled()) {
                        callback(null);
                        return;
                    }
                    if (message.status_code !== Soup.Status.OK) {
                        this._aqiFailCount++;
                        logError(`空气质量请求 HTTP ${message.status_code}`);
                        callback(null);
                        return;
                    }
                    const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    this._aqiFailCount = 0;
                    callback(parseAqiIndex(json));
                } catch (e) {
                    if (!this._enabled) return;
                    logError(`Air quality parse error: ${e}`);
                    callback(null);
                }
            }
        );
    }

    _createFileIcon(filePath) {
        try {
            let exists = this._iconExistsCache?.get(filePath);
            if (exists === undefined) {
                exists = Gio.File.new_for_path(filePath).query_exists(null);
                this._iconExistsCache?.set(filePath, exists);
            }
            if (exists)
                return new Gio.FileIcon({ file: Gio.File.new_for_path(filePath) });
        } catch (e) {
            logError(`Failed to create icon from ${filePath}: ${e}`);
        }
        return null;
    }
    _applyIcon(widget, gicon, fallbackName = 'weather-severe-alert-symbolic') {
        if (gicon) {
            widget.gicon = gicon;
            widget.icon_name = null;
        } else {
            widget.gicon = null;
            widget.icon_name = fallbackName;
        }
    }

    _drawAqiRing() {
        const area = this._aqiArea;
        if (!area)
            return;
        const [width, height] = area.get_surface_size();
        const cr = area.get_context();
        try {
            const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);
            const cx = width / 2;
            const cy = height / 2;
            const lineWidth = Math.max(2, 3.5 * scaleFactor);
            const radius = Math.min(width, height) / 2 - lineWidth / 2 - scaleFactor;
            if (radius <= 0)
                return;

            const start = -Math.PI / 2;
            const sweep = Math.PI * 1.5;

            cr.setLineWidth(lineWidth);
            cr.setLineCap(Cairo.LineCap.ROUND);

            cr.setSourceRGBA(0.5, 0.5, 0.5, 0.25);
            cr.arc(cx, cy, radius, start, start + sweep);
            cr.stroke();

            const aqi = this._aqi;
            if (!aqi)
                return;

            const ratio = aqiFillRatio(aqi.aqi);
            if (ratio > 0) {
                cr.setSourceRGBA(aqi.color.r / 255, aqi.color.g / 255, aqi.color.b / 255, 1);
                cr.arc(cx, cy, radius, start, start + sweep * ratio);
                cr.stroke();
            }

            const [hasColor, color] = area.get_theme_node().lookup_color('color', false);
            if (hasColor)
                cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, 1);
            else
                cr.setSourceRGBA(0.5, 0.5, 0.5, 1);

            let themeFont = null;
            try {
                themeFont = area.get_theme_node().get_font();
            } catch (_e) {
                themeFont = null;
            }
            const layout = PangoCairo.create_layout(cr);
            layout.set_font_description(cairoFontDescription(themeFont, AQI_FONT_PX, scaleFactor));
            layout.set_text(aqi.display, -1);
            const [textW, textH] = layout.get_pixel_size();
            cr.moveTo(Math.round(cx - textW / 2), Math.round(cy - textH / 2));
            PangoCairo.show_layout(cr, layout);
        } finally {
            cr.$dispose();
        }
    }

    _arcTheta(ratio) {
        return Math.PI + Math.min(Math.max(ratio, 0), 1) * Math.PI;
    }

    _themeColor(area) {
        const [hasFg, fg] = area.get_theme_node().lookup_color('color', false);
        return hasFg ? [fg.red / 255, fg.green / 255, fg.blue / 255] : [0.5, 0.5, 0.5];
    }

    _drawSunArc() {
        const area = this._sunArcArea;
        const astro = this._astro;
        if (!area || !astro)
            return;
        const [width, height] = area.get_surface_size();
        if (width <= 0 || height <= 0)
            return;
        const cr = area.get_context();
        try {
            const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);
            const lineWidth = Math.max(1.5, 2 * scaleFactor);
            const pad = lineWidth + 4 * scaleFactor;
            const rx = (width - 2 * arcSideInset(lineWidth, scaleFactor)) / 2;
            const ry = height - 2 * pad;
            if (rx <= 0 || ry <= 0)
                return;
            const cx = width / 2;
            const cy = height - pad;
            const rxAt = ratio => cx + rx * Math.cos(this._arcTheta(ratio));
            const ryAt = ratio => cy + ry * Math.sin(this._arcTheta(ratio));

            const ellipsePath = () => {
                cr.save();
                cr.translate(cx, cy);
                cr.scale(rx, ry);
                cr.arc(0, 0, 1, Math.PI, 2 * Math.PI);
                cr.restore();
            };

            cr.setLineWidth(lineWidth);
            cr.setLineCap(Cairo.LineCap.ROUND);

            cr.setSourceRGBA(0.5, 0.5, 0.5, 0.25);
            ellipsePath();
            cr.stroke();

            const span = sunArcSpan(astro);
            const total = span.end - span.start;
            if (total <= 0)
                return;
            const ratioAt = m => Math.min(Math.max((m - span.start) / total, 0), 1);

            if (span.hasTwilight) {
                const SEGMENTS = 96;
                let prev = null;
                for (let i = 0; i <= SEGMENTS; i++) {
                    const ratio = i / SEGMENTS;
                    const px = rxAt(ratio);
                    const py = ryAt(ratio);
                    if (prev) {
                        const mid = span.start + (ratio - 0.5 / SEGMENTS) * total;
                        const c = skyColorAt(mid, astro);
                        cr.setSourceRGBA(c[0], c[1], c[2], 1);
                        cr.moveTo(prev[0], prev[1]);
                        cr.lineTo(px, py);
                        cr.stroke();
                    }
                    prev = [px, py];
                }
            } else {
                cr.setSourceRGBA(SKY_DAY[0], SKY_DAY[1], SKY_DAY[2], 0.9);
                ellipsePath();
                cr.stroke();
            }

            const fg = this._themeColor(area);
            cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.5);
            cr.setLineWidth(Math.max(1, 1.2 * scaleFactor));
            const tick = 3.5 * scaleFactor;
            for (const m of [astro.sunrise, astro.sunset]) {
                const r = ratioAt(m);
                const px = rxAt(r), py = ryAt(r);
                const dx = (px - cx) / rx, dy = (py - cy) / ry;
                const len = Math.hypot(dx, dy) || 1;
                cr.moveTo(px - dx / len * tick, py - dy / len * tick);
                cr.lineTo(px + dx / len * tick, py + dy / len * tick);
            }
            cr.stroke();

            const pos = this._sunPosition;
            if (!pos)
                return;
            const alpha = pos.isDay ? 1 : 0.45;
            cr.setSourceRGBA(SKY_DAY[0], SKY_DAY[1], SKY_DAY[2], alpha);
            cr.arc(rxAt(pos.ratio), ryAt(pos.ratio),
                   Math.max(3.5, 4.5 * scaleFactor), 0, 2 * Math.PI);
            cr.fill();
        } finally {
            cr.$dispose();
        }
    }

    _drawMoonDisc(cr, cx, cy, r, phase, fg, alpha = 1) {
        if (!(r > 0))
            return;
        const lit = Math.min(Math.max(phase?.lit ?? 0, 0), 1);

        cr.setSourceRGBA(fg[0], fg[1], fg[2], MOON_DARK_ALPHA * alpha);
        cr.arc(cx, cy, r, 0, 2 * Math.PI);
        cr.fill();

        if (lit > 0.001) {
            cr.save();
            if (!(phase?.waxing ?? true)) {
                cr.translate(cx, cy);
                cr.scale(-1, 1);
                cr.translate(-cx, -cy);
            }
            const a = Math.max(Math.abs(1 - 2 * lit), 0.001);
            cr.newSubPath();
            cr.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2);
            cr.save();
            cr.translate(cx, cy);
            cr.scale(a, 1);
            if (lit > 0.5)
                cr.arc(0, 0, r, Math.PI / 2, 3 * Math.PI / 2);
            else
                cr.arcNegative(0, 0, r, Math.PI / 2, -Math.PI / 2);
            cr.restore();
            cr.closePath();
            cr.setSourceRGBA(fg[0], fg[1], fg[2], MOON_LIT_ALPHA * alpha);
            cr.fill();
            cr.restore();
        }

        cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.45 * alpha);
        cr.setLineWidth(Math.max(0.8, r * 0.14));
        cr.arc(cx, cy, r, 0, 2 * Math.PI);
        cr.stroke();
    }

    _drawMoonArc() {
        const area = this._moonArcArea;
        const moon = this._astro?.moon;
        if (!area || !moon)
            return;
        const [width, height] = area.get_surface_size();
        if (width <= 0 || height <= 0)
            return;
        const cr = area.get_context();
        try {
            const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);
            const lineWidth = Math.max(1.5, 2 * scaleFactor);
            const pad = lineWidth + 3 * scaleFactor;
            const discR = MOON_DISC_RADIUS * scaleFactor;
            const rx = (width - 2 * arcSideInset(lineWidth, scaleFactor)) / 2;
            const ry = height - 2 * pad - 2 * discR;
            if (rx <= 0 || ry <= 0)
                return;
            const cx = width / 2;
            const cy = height - pad - discR;
            const fg = this._themeColor(area);
            const pxAt = ratio => cx + rx * Math.cos(this._arcTheta(ratio));
            const pyAt = ratio => cy + ry * Math.sin(this._arcTheta(ratio));

            cr.setLineWidth(lineWidth);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.25);
            cr.save();
            cr.translate(cx, cy);
            cr.scale(rx, ry);
            cr.arc(0, 0, 1, Math.PI, 2 * Math.PI);
            cr.restore();
            cr.stroke();

            const pos = this._moonPosition;
            if (!pos) {
                this._drawMoonDisc(cr, cx, cy - ry, discR, moon.phase, fg, 0.6);
                return;
            }
            const alpha = pos.isUp ? 1 : 0.4;
            cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.85 * alpha);
            cr.save();
            cr.translate(cx, cy);
            cr.scale(rx, ry);
            cr.arc(0, 0, 1, Math.PI, this._arcTheta(pos.ratio));
            cr.restore();
            cr.stroke();

            this._drawMoonDisc(cr, pxAt(pos.ratio), pyAt(pos.ratio),
                               discR, moon.phase, fg, alpha);
        } finally {
            cr.$dispose();
        }
    }

    _roundedBarPath(cr, x, y, w, h) {
        const r = Math.min(h / 2, w / 2);
        if (r <= 0)
            return;
        cr.newSubPath();
        cr.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5);
        cr.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
        cr.closePath();
    }

    _drawTempBar(area) {
        const range = area?._climacnRange;
        if (!range)
            return;
        const [width, height] = area.get_surface_size();
        if (width <= 0 || height <= 0)
            return;
        const cr = area.get_context();
        try {
            const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);
            const barH = Math.min(height, Math.max(3, TEMP_BAR_HEIGHT * scaleFactor));
            const y = (height - barH) / 2;
            const { min, max, lo, hi } = range;
            const span = (hi - lo) || 1;

            const [hasFg, fg] = area.get_theme_node().lookup_color('color', false);
            const track = hasFg
                ? [fg.red / 255, fg.green / 255, fg.blue / 255]
                : [0.5, 0.5, 0.5];
            cr.setSourceRGBA(track[0], track[1], track[2], 0.18);
            this._roundedBarPath(cr, 0, y, width, barH);
            cr.fill();

            const x0 = width * Math.min(Math.max(min - lo, 0), span) / span;
            const x1 = width * Math.min(Math.max(max - lo, 0), span) / span;
            const segW = Math.max(x1 - x0, barH);

            const grad = new Cairo.LinearGradient(0, 0, width, 0);
            for (const [off, r, g, b] of TEMP_RAMP)
                grad.addColorStopRGBA(off, r, g, b, 0.95);
            cr.setSource(grad);
            this._roundedBarPath(cr, x0, y, Math.min(segW, width - x0), barH);
            cr.fill();
        } finally {
            cr.$dispose();
        }
    }

    _createTempBar(range) {
        const area = new St.DrawingArea({
            style_class: 'climacn-temp-bar',
            width: TEMP_BAR_WIDTH,
            height: TEMP_BAR_HEIGHT,
            y_align: Clutter.ActorAlign.CENTER
        });
        area._climacnRange = range;
        area.connect('repaint', () => this._drawTempBar(area));
        return area;
    }

    _drawTrendChart() {
        const area = this._trendArea;
        if (!area)
            return;
        const points = this._trendPoints;
        if (!Array.isArray(points) || points.length < 2)
            return;
        const [width, height] = area.get_surface_size();
        const cr = area.get_context();
        try {
            const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);
            const themeNode = area.get_theme_node();
            const dotR = Math.max(1.5, 1.8 * scaleFactor);
            const labelH = TREND_LABEL_PX * scaleFactor + 2;
            const padX = 10 * scaleFactor;
            const plotTop = dotR + labelH + 2;
            const plotBottom = height - dotR - labelH - 2;
            const plotW = width - 2 * padX;
            const plotH = plotBottom - plotTop;
            if (plotW <= 0 || plotH <= 0)
                return;

            const days = points.filter(Boolean);
            if (days.length < 2)
                return;
            const lo = Math.min(...days.map(p => p.min));
            const hi = Math.max(...days.map(p => p.max));
            const span = hi - lo || 1;

            const xAt = i => padX + (plotW * i) / (points.length - 1);
            const yAt = v => plotTop + plotH * (1 - (v - lo) / span);

            const segments = [];
            let seg = null;
            for (let i = 0; i < points.length; i++) {
                if (points[i]) {
                    if (!seg)
                        segments.push(seg = []);
                    seg.push(i);
                } else {
                    seg = null;
                }
            }

            const HIGH = [...COLOR_HIGH, 0.95];
            const LOW = [...COLOR_LOW, 0.95];

            cr.newSubPath();
            for (const s of segments) {
                cr.moveTo(xAt(s[0]), yAt(points[s[0]].max));
                for (const i of s)
                    cr.lineTo(xAt(i), yAt(points[i].max));
                for (let k = s.length - 1; k >= 0; k--)
                    cr.lineTo(xAt(s[k]), yAt(points[s[k]].min));
                cr.closePath();
            }
            const bandGrad = new Cairo.LinearGradient(0, plotTop, 0, plotBottom);
            for (const [off, r, g, b] of TEMP_RAMP)
                bandGrad.addColorStopRGBA(1 - off, r, g, b, 0.30);
            cr.setSource(bandGrad);
            cr.fill();

            cr.newSubPath();
            for (const s of segments) {
                cr.moveTo(xAt(s[0]), yAt(points[s[0]].min));
                for (const i of s)
                    cr.lineTo(xAt(i), yAt(points[i].min));
                cr.lineTo(xAt(s[s.length - 1]), plotBottom);
                cr.lineTo(xAt(s[0]), plotBottom);
                cr.closePath();
            }
            const groundGrad = new Cairo.LinearGradient(0, plotTop, 0, plotBottom);
            groundGrad.addColorStopRGBA(0, COLOR_LOW[0], COLOR_LOW[1], COLOR_LOW[2], 0.18);
            groundGrad.addColorStopRGBA(1, COLOR_LOW[0], COLOR_LOW[1], COLOR_LOW[2], 0.0);
            cr.setSource(groundGrad);
            cr.fill();

            const polyline = (key, rgba) => {
                cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], rgba[3]);
                cr.setLineWidth(Math.max(1.2, 1.6 * scaleFactor));
                cr.setLineJoin(Cairo.LineJoin.ROUND);
                cr.newSubPath();
                for (const s of segments) {
                    cr.moveTo(xAt(s[0]), yAt(points[s[0]][key]));
                    for (const i of s)
                        cr.lineTo(xAt(i), yAt(points[i][key]));
                }
                cr.stroke();
            };

            polyline('max', HIGH);
            polyline('min', LOW);

            const layout = PangoCairo.create_layout(cr);
            let themeFont = null;
            try {
                themeFont = themeNode.get_font();
            } catch (_e) {
                themeFont = null;
            }
            layout.set_font_description(cairoFontDescription(themeFont, TREND_LABEL_PX, scaleFactor));

            for (const s of segments) {
                for (const i of s) {
                    const p = points[i];
                    cr.setSourceRGBA(HIGH[0], HIGH[1], HIGH[2], 1);
                    cr.arc(xAt(i), yAt(p.max), dotR, 0, 2 * Math.PI);
                    cr.fill();
                    cr.setSourceRGBA(LOW[0], LOW[1], LOW[2], 1);
                    cr.arc(xAt(i), yAt(p.min), dotR, 0, 2 * Math.PI);
                    cr.fill();

                    cr.setSourceRGBA(HIGH[0], HIGH[1], HIGH[2], 0.95);
                    drawCenteredText(cr, layout, `${Math.round(p.max)}°`,
                                     xAt(i), yAt(p.max) - dotR - labelH / 2);
                    cr.setSourceRGBA(LOW[0], LOW[1], LOW[2], 0.95);
                    drawCenteredText(cr, layout, `${Math.round(p.min)}°`,
                                     xAt(i), yAt(p.min) + dotR + labelH / 2);
                }
            }
        } finally {
            cr.$dispose();
        }
    }

    _updateUI(now, forecast, aqi) {
        const iconCode = safeIconCode(now.condition?.code);
        const icon = this._createFileIcon(`${this.path}/icons/${iconCode}-symbolic.svg`);
        const tempText = roundTemp(now.temperature?.value);

        this._applyIcon(this._weatherIcon, icon);
        this._tempLabel.text = tempText;
        this._applyIcon(this._headerIcon, icon);
        this._headerTemp.text = tempText;
        this._headerCondition.text = now.condition?.text || '--';

        this._aqi = aqi ?? null;
        if (this._aqiGroup) {
            this._aqiGroup.visible = this._aqi !== null;
            if (this._aqi)
                this._aqiArea.queue_repaint();
        }

        this._feelsLikeLabel.text = roundTemp(now.feelsLike?.value);
        this._humidityLabel.text = toPercent(now.humidity);
        this._windLabel.text =
            `${compassToChinese(now.wind?.direction?.compass)} ${now.wind?.scale ?? '--'}级`;
        this._updateTimeLabel.text = GLib.DateTime.new_now_local().format('%H:%M');

        const pressureValue = toFiniteOrNull(now.pressure?.value);
        const nowSec = Math.floor(Date.now() / 1000);
        let trendText = '';
        if (pressureValue !== null) {
            this._pressureHistory = appendPressureSample(this._pressureHistory, nowSec, pressureValue);
            this._settings.set_string('pressure-history', JSON.stringify(this._pressureHistory));
            trendText = formatPressureTrend(
                pressureTrend(this._pressureHistory, pressureValue, nowSec));
        }
        this._pressureLabel.text = trendText
            ? `${formatMeasure(now.pressure)} ${trendText}`
            : formatMeasure(now.pressure);

        this._visibilityLabel.text = formatMeasure(now.visibility);
        this._dewPointLabel.text   = roundTemp(now.dewPoint?.value);
        this._cloudCoverLabel.text = toPercent(now.cloudCover);
        const uvIndex = toFiniteOrNull(now.uvIndex);
        this._uvIndexLabel.text    = uvIndex === null ? '--' : `${Math.round(uvIndex)}`;
        this._windGustLabel.text   = formatMeasure(now.windGust);
        this._precipLabel.text     = formatMeasure(now.precipitation?.amount);

        if (this._attributionItem) {
            this._attributionLabel.text = this._attributionText || '';
            this._attributionItem.visible = true;
        }

        this._updateNotice();

        if (this._forecastRowsBox) {
            this._forecastRowsBox.remove_all_children();
        }

        this._astro = parseAstro(forecast);
        const nowMinutes = (() => {
            const n = GLib.DateTime.new_now_local();
            return n.get_hour() * 60 + n.get_minute();
        })();
        this._sunPosition = this._astro ? sunArcPosition(nowMinutes, this._astro) : null;
        this._moonPosition = this._astro?.moon
            ? moonArcPosition(nowMinutes, this._astro.moon) : null;

        if (this._astro) {
            this._sunriseLabel.text = formatClock(this._astro.sunrise);
            this._sunsetLabel.text = formatClock(this._astro.sunset);
        }
        if (this._sunArcItem) {
            this._sunArcItem.visible = this._astro !== null;
            if (this._astro)
                this._sunArcArea.queue_repaint();
        }

        const moon = this._astro?.moon ?? null;
        if (this._moonArcItem) {
            this._moonArcItem.visible = moon !== null;
            if (moon) {
                this._moonriseLabel.text = formatClock(moon.moonrise);
                this._moonsetLabel.text = formatClock(moon.moonset % (24 * 60));
                this._moonPhaseLabel.text = moon.phase?.name ?? '';
                this._moonArcArea.queue_repaint();
            }
        }

        this._trendPoints = parseTrendPoints(forecast);
        this._moonPhases = parseMoonPhases(forecast);
        const showTrend = this._trendPoints.filter(Boolean).length >= 2;
        if (this._trendItem) {
            this._trendItem.visible = showTrend;
            if (showTrend) {
                this._trendArea.queue_repaint();
                this._trendMoonArea.queue_repaint();
            }
        }

        if (forecast && Array.isArray(forecast) && forecast.length > 0) {
            const dayNames = ['今天', '明天', '后天'];
            const count = Math.min(forecast.length, FORECAST_ROWS);

            const lowsAll = forecast.map(d => toFiniteOrNull(d.temperatureMin?.value))
                                    .filter(v => v !== null);
            const highsAll = forecast.map(d => toFiniteOrNull(d.temperatureMax?.value))
                                     .filter(v => v !== null);
            const barLo = lowsAll.length ? Math.min(...lowsAll) : 0;
            const barHi = highsAll.length ? Math.max(...highsAll) : 1;
            for (let i = 0; i < count; i++) {
                const day = forecast[i];
                const row = new St.BoxLayout({
                    style_class: 'climacn-forecast-row',
                    y_align: Clutter.ActorAlign.CENTER
                });

                const dayLabel = new St.Label({
                    text: dayNames[i],
                    style_class: 'climacn-forecast-day',
                    y_align: Clutter.ActorAlign.CENTER
                });
                row.add_child(dayLabel);

                const iconCodeFore = safeIconCode(day.daytime?.condition?.code);
                const iconPathFore = `${this.path}/icons/${iconCodeFore}-symbolic.svg`;
                const iconFore = this._createFileIcon(iconPathFore);
                let iconWidget;
                if (iconFore) {
                    iconWidget = new St.Icon({
                        gicon: iconFore,
                        style_class: 'climacn-forecast-icon',
                        y_align: Clutter.ActorAlign.CENTER
                    });
                } else {
                    iconWidget = new St.Icon({
                        icon_name: 'weather-severe-alert-symbolic',
                        style_class: 'climacn-forecast-icon',
                        y_align: Clutter.ActorAlign.CENTER
                    });
                }
                row.add_child(iconWidget);

                const tempLabel = new St.Label({
                    text: `${roundTemp(day.temperatureMin?.value)} / ${roundTemp(day.temperatureMax?.value)}`,
                    style_class: 'climacn-forecast-temp',
                    y_align: Clutter.ActorAlign.CENTER
                });
                row.add_child(tempLabel);

                const dayMin = toFiniteOrNull(day.temperatureMin?.value);
                const dayMax = toFiniteOrNull(day.temperatureMax?.value);
                if (dayMin !== null && dayMax !== null) {
                    row.add_child(this._createTempBar(
                        { min: dayMin, max: dayMax, lo: barLo, hi: barHi }));
                } else {
                    row.add_child(new St.Widget({ width: TEMP_BAR_WIDTH }));
                }

                const conditionLabel = new St.Label({
                    text: day.daytime?.condition?.text || '--',
                    style_class: 'climacn-forecast-condition',
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER
                });
                row.add_child(conditionLabel);

                this._forecastRowsBox.add_child(row);
            }
            this._forecastContainer.show();
        } else {
            const noDataLabel = new St.Label({
                text: _('暂无预报数据'),
                style_class: 'climacn-forecast-no-data'
            });
            this._forecastRowsBox.add_child(noDataLabel);
            this._forecastContainer.show();
        }

        this._lastForecast = Array.isArray(forecast) ? forecast : null;
        this._updateCalendarSection(this._lastForecast);
    }

    _errorIconName(kind) {
        switch (kind) {
        case 'network': return 'network-error-symbolic';
        case 'auth':    return 'dialog-password-symbolic';
        case 'config':  return 'preferences-system-symbolic';
        case 'data':    return 'dialog-warning-symbolic';
        default:        return 'weather-severe-alert-symbolic';
        }
    }

    _showError(message = _('获取失败'), kind = 'error') {
        this._errorShown = true;
        const iconName = this._errorIconName(kind);
        this._applyIcon(this._weatherIcon, null, iconName);
        this._applyIcon(this._headerIcon, null, iconName);
        this._tempLabel.text = 'N/A';
        this._headerTemp.text = 'N/A';
        this._headerCondition.text = message;

        for (const label of [this._feelsLikeLabel, this._humidityLabel, this._windLabel,
                             this._updateTimeLabel, this._pressureLabel, this._visibilityLabel,
                             this._dewPointLabel, this._cloudCoverLabel, this._uvIndexLabel,
                             this._windGustLabel, this._precipLabel]) {
            if (label)
                label.text = '--';
        }

        if (this._attributionItem)
            this._attributionItem.visible = false;
        this._aqi = null;
        if (this._aqiGroup)
            this._aqiGroup.visible = false;

        this._sunPosition = null;
        this._astro = null;
        this._moonPosition = null;
        if (this._sunArcItem)
            this._sunArcItem.visible = false;
        if (this._moonArcItem)
            this._moonArcItem.visible = false;
        this._trendPoints = [];
        this._moonPhases = [];
        if (this._trendItem)
            this._trendItem.visible = false;

        if (this._forecastRowsBox) {
            this._forecastRowsBox.remove_all_children();
            const errLabel = new St.Label({
                text: _('无法加载预报'),
                style_class: 'climacn-forecast-no-data'
            });
            this._forecastRowsBox.add_child(errLabel);
        }

        this._lastForecast = null;
        this._updateCalendarSection(null);
    }
}

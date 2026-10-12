export const UPDATE_INTERVAL_SEC = 15 * 60;
export const BATTERY_INTERVAL_SEC = 30 * 60;
export const CACHE_TTL_SEC = 5 * 60;

export const REQUEST_TIMEOUT_SEC = 15;

export const FETCH_WATCHDOG_SEC = 30;

export const RETRY_DELAYS_SEC = [5, 15, 45, 120, 300];
export const MANUAL_COOLDOWN_SEC = 60;
export const DAILY_REQUEST_BUDGET = 800;
export const FORECAST_DAYS = 10;
export const FORECAST_ROWS = 3;
export const CALENDAR_COLS = 4;
export const OPEN_METEO_HOST = 'https://api.open-meteo.com';
export const OPEN_METEO_AQI_HOST = 'https://air-quality-api.open-meteo.com';
export const OPEN_METEO_FORECAST_DAYS = 16;
export const SOURCE_KEYS = ['source-current', 'source-forecast',
                     'source-air-quality', 'source-astronomy'];
export const SETTINGS_VERSION = 1;
export function migrateSourceSettings(settings) {
    if (settings.get_int('settings-version') >= SETTINGS_VERSION)
        return;
    const legacy = settings.get_user_value('use-open-meteo-fallback');
    const target = legacy && legacy.get_boolean() ? 'auto' : 'qweather';
    for (const key of SOURCE_KEYS)
        settings.set_string(key, target);
    settings.set_int('settings-version', SETTINGS_VERSION);
}
export let _debug = false;
export function setDebugLogging(enabled) {
    _debug = !!enabled;
}
export function logError(...args) {
    if (_debug)
        console.error('[ClimaCN]', ...args);
}
export function getWeatherUrl(host, lat, lon) {
    return `${host}/weather/v1/current/${formatCoord(lat)}/${formatCoord(lon)}?localTime=true`;
}
export function getForecastUrl(host, lat, lon) {
    return `${host}/weather/v1/daily/${formatCoord(lat)}/${formatCoord(lon)}?days=${FORECAST_DAYS}&localTime=true`;
}
export function formatCoord(value) {
    const n = toFiniteOrNull(value);
    return n === null ? '0.00' : n.toFixed(2);
}
export function normalizeHost(raw) {
    const host = (raw || '').trim()
        .replace(/^https?:\/\//i, '')
        .split('/')[0];
    if (!host)
        return '';
    return `https://${host}`;
}
export const COMPASS_ZH = {
    n: '北风', nne: '东北偏北风', ne: '东北风', ene: '东北偏东风',
    e: '东风', ese: '东南偏东风', se: '东南风', sse: '东南偏南风',
    s: '南风', ssw: '西南偏南风', sw: '西南风', wsw: '西南偏西风',
    w: '西风', wnw: '西北偏西风', nw: '西北风', nnw: '西北偏北风',
    none: '无持续风向', vrb: '风向不定',
};
export function compassToChinese(code) {
    return COMPASS_ZH[String(code || '').toLowerCase()] || '--';
}
export function toPercent(value) {
    const n = toFiniteOrNull(value);
    return n === null ? '--%' : `${Math.round(n * 100)}%`;
}
export function toFiniteOrNull(value) {
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
export function roundTemp(value) {
    const n = toFiniteOrNull(value);
    return n === null ? '--°' : `${Math.round(n)}°`;
}
export function formatMeasure(obj, fallback = '--') {
    const n = toFiniteOrNull(obj?.value);
    if (n === null)
        return fallback;
    return obj?.unit ? `${Math.round(n)} ${obj.unit}` : `${Math.round(n)}`;
}
export function safeIconCode(code) {
    const s = String(code ?? '');
    return /^[0-9A-Za-z]+$/.test(s) ? s : '999';
}
export function currentRequestCount(storedDate, storedCount, today) {
    return storedDate === today ? storedCount : 0;
}
export function nextRequestCount(storedDate, storedCount, today) {
    return storedDate === today ? storedCount + 1 : 1;
}
export function getAirQualityUrl(host, lat, lon) {
    return `${host}/airquality/v1/current/${formatCoord(lat)}/${formatCoord(lon)}`;
}
export function parseClockMinutes(iso) {
    const m = /T(\d{2}):(\d{2})/.exec(String(iso ?? ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
export function formatClock(minutes) {
    const n = toFiniteOrNull(minutes);
    if (n === null)
        return '--:--';
    const h = Math.floor(n / 60) % 24;
    const m = Math.round(n % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
export function lastHourlyIndex(times, nowIso) {
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
export function parseCsvLine(line) {
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

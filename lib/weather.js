import { moonPhaseFromFraction } from './astro.js';
import {
    OPEN_METEO_AQI_HOST,
    OPEN_METEO_FORECAST_DAYS,
    OPEN_METEO_HOST,
    formatCoord,
    lastHourlyIndex,
    toFiniteOrNull
} from './util.js';
export const PRESSURE_WINDOW_SEC = 3 * 3600;
export const PRESSURE_MAX_SAMPLES = 24;
export const PRESSURE_STEADY_HPA = 1.0;
export const PRESSURE_MIN_SPAN_SEC = 30 * 60;
export function parsePressureHistory(raw) {
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
export function appendPressureSample(history, t, p) {
    const cutoff = t - PRESSURE_WINDOW_SEC;
    const kept = history.filter(e => e.t >= cutoff);
    kept.push({ t, p });
    return kept.slice(-PRESSURE_MAX_SAMPLES);
}
export function pressureTrend(history, currentP, nowSec) {
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
export function formatPressureTrend(trend) {
    if (!trend)
        return '';
    if (trend.dir === 'steady')
        return '→';
    return `${trend.dir === 'rising' ? '↑' : '↓'}${Math.abs(trend.delta).toFixed(1)}`;
}
export const WMO_TO_QWEATHER_DAY = {
    0: '100', 1: '102', 2: '101', 3: '104',
    45: '501', 48: '501',
    51: '309', 53: '309', 55: '309', 56: '313', 57: '313',
    61: '305', 63: '306', 65: '307', 66: '313', 67: '313',
    71: '400', 73: '401', 75: '402', 77: '407',
    80: '300', 81: '301', 82: '310',
    85: '407', 86: '407',
    95: '302', 96: '304', 99: '304',
};
export const WMO_TO_QWEATHER_NIGHT = { 0: '150', 1: '152', 2: '151' };
export const WMO_TEXT_ZH = {
    0: '晴', 1: '少云', 2: '多云', 3: '阴',
    45: '雾', 48: '雾凇',
    51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
    61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
    80: '阵雨', 81: '强阵雨', 82: '暴雨',
    85: '阵雪', 86: '强阵雪',
    95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹',
};
export function wmoToQweatherCode(code, isDay = true) {
    const c = toFiniteOrNull(code);
    if (c === null)
        return '999';
    if (!isDay && WMO_TO_QWEATHER_NIGHT[c])
        return WMO_TO_QWEATHER_NIGHT[c];
    return WMO_TO_QWEATHER_DAY[c] ?? '999';
}
export function wmoToText(code) {
    const c = toFiniteOrNull(code);
    return c === null ? '--' : (WMO_TEXT_ZH[c] ?? '--');
}
export const COMPASS_CODES = ['n', 'nne', 'ne', 'ene', 'e', 'ese', 'se', 'sse',
                       's', 'ssw', 'sw', 'wsw', 'w', 'wnw', 'nw', 'nnw'];
export function degreesToCompass(degrees) {
    const d = toFiniteOrNull(degrees);
    if (d === null)
        return 'none';
    const normalized = ((d % 360) + 360) % 360;
    return COMPASS_CODES[Math.round(normalized / 22.5) % 16];
}
export const BEAUFORT_MAX_MS = [0.2, 1.5, 3.3, 5.4, 7.9, 10.7, 13.8, 17.1,
                         20.7, 24.4, 28.4, 32.6];
export function beaufortFromMs(ms) {
    const v = toFiniteOrNull(ms);
    if (v === null || v < 0)
        return null;
    for (let i = 0; i < BEAUFORT_MAX_MS.length; i++) {
        if (v <= BEAUFORT_MAX_MS[i])
            return i;
    }
    return 12;
}
export function getOpenMeteoUrl(lat, lon) {
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
export function getOpenMeteoAirQualityUrl(lat, lon) {
    const query = [
        'hourly=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone',
        'past_days=1',
        'forecast_days=1',
        'timezone=auto',
    ].join('&');
    return `${OPEN_METEO_AQI_HOST}/v1/air-quality?latitude=${formatCoord(lat)}&longitude=${formatCoord(lon)}&${query}`;
}
export function openMeteoAsQweatherCurrent(json, nowIso) {
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
export function openMeteoAsQweatherDaily(json) {
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

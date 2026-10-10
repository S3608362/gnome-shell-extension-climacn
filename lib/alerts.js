import { toFiniteOrNull } from './util.js';
export const CMA_ALERT_HOST = 'https://weather.cma.cn';
export const ALERT_MAX_FAILURES = 3;
export const ALERT_DETAIL_WIDTH = 400;
export const ALERT_DETAIL_FAILED = { failed: true };
export const ALERT_MAX_DISTANCE_KM = 150;
export const ALERT_LEVELS = {
    BLUE:   { key: 'blue',   zh: '蓝色', rank: 1 },
    YELLOW: { key: 'yellow', zh: '黄色', rank: 2 },
    ORANGE: { key: 'orange', zh: '橙色', rank: 3 },
    RED:    { key: 'red',    zh: '红色', rank: 4 },
};
export const ALERT_LEVEL_UNKNOWN = { key: 'unknown', zh: '', rank: 0 };
export function alertLevel(severity) {
    return ALERT_LEVELS[String(severity ?? '').toUpperCase()] ?? ALERT_LEVEL_UNKNOWN;
}
export function getCmaAlertsUrl(stationId) {
    return `${CMA_ALERT_HOST}/api/weather/view?stationid=${encodeURIComponent(stationId)}`;
}
export function getCmaAlertDetailUrl(alertId) {
    return `${CMA_ALERT_HOST}/api/alarm/${encodeURIComponent(alertId)}`;
}
export function parseStationList(csvText) {
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
export function findNearestStation(stations, lat, lon, maxKm = ALERT_MAX_DISTANCE_KM) {
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
export function parseAlerts(json) {
    const list = json?.data?.alarm;
    if (!Array.isArray(list))
        return [];
    return list
        .filter(a => a && typeof a.title === 'string' && a.title.trim())
        .map(a => {
            const level = alertLevel(a.severity);
            return {
                id: String(a.id ?? '').trim(),
                title: a.title.trim(),
                level,
                type: String(a.signaltype ?? '').trim(),
                effective: String(a.effective ?? '').trim(),
            };
        })
        .sort((a, b) => b.level.rank - a.level.rank);
}
export function parseAlertDetail(json) {
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

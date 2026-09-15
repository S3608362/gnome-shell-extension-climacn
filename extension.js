/* extension.js - ClimaCN GNOME Shell Extension (local CSV city search + 3-day forecast) */

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

/* =====================================================================
 * 刷新与配额策略
 * 和风天气免费额度为每日 1000 次、每月 50000 次。每次刷新消耗 3 次请求
 * （实时 + 预报 + 空气质量），15 分钟间隔下约 288 次/天，余量充足。
 * 以下策略用于防止连点、缩短间隔或长时间挂机把额度吃掉。
 * ===================================================================== */
const UPDATE_INTERVAL_SEC = 15 * 60;      // 插电时的自动刷新间隔
const BATTERY_INTERVAL_SEC = 30 * 60;     // 电池供电时拉长，减少唤醒与请求
const CACHE_TTL_SEC = 5 * 60;             // 数据新鲜期，期内自动刷新不再请求
const MANUAL_COOLDOWN_SEC = 60;           // 手动刷新最小间隔，防止连点
const DAILY_REQUEST_BUDGET = 800;         // 每日请求上限（限额 1000，留出余量）
const AQI_RING_SIZE = 34;                 // AQI 色环的逻辑像素尺寸（绘制时按缩放比放大）
const AQI_FONT_PX = 10;                   // 色环中心数值的字号（逻辑像素）
const AQI_MAX_FAILURES = 2;               // 连续失败几次后不再请求空气质量
const FORECAST_DAYS = 10;                 // 和风每日预报上限即 10 天，趋势折线用它
const FORECAST_ROWS = 3;                  // 逐日行只展开前 3 天
const SUN_ARC_HEIGHT = 46;                // 日出日落弧线的高度（逻辑像素）
const TREND_CHART_HEIGHT = 64;            // 折线高度：上下各留一行数字的位置
const TREND_CHART_WIDTH = 300;            // 折线宽度：放在子菜单里，需显式指定
const TREND_LABEL_PX = 8;                 // 折线数值标注的字号（逻辑像素）
const OPEN_METEO_HOST = 'https://api.open-meteo.com';

/* =====================================================================
 * 和风天气 v1 接口
 * 定位由城市 ID 改为经纬度，认证仍走 API Key 请求头。
 * 旧的公共地址（devapi.qweather.com 等）自 2026 年起逐步停止服务。
 * ===================================================================== */
function getWeatherUrl(host, lat, lon) {
    return `${host}/weather/v1/current/${formatCoord(lat)}/${formatCoord(lon)}?localTime=true`;
}

/* 一次取满 10 天：界面只用前 3 天做逐日行，其余用于 10 天趋势折线；
 * 日出日落也从同一个响应的 astro 取，不额外增加请求。 */
function getForecastUrl(host, lat, lon) {
    return `${host}/weather/v1/daily/${formatCoord(lat)}/${formatCoord(lon)}?days=${FORECAST_DAYS}&localTime=true`;
}

/* 文档要求经纬度最多两位小数 */
function formatCoord(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

/* API Host 由用户从控制台复制，形如 abcxyz.qweatherapi.com（不含协议）。
 * 也容忍粘贴带协议的完整地址、结尾斜杠或多余路径。
 * 一律强制 https：接口文档写明"scheme 仅支持 HTTPS 协议"，
 * 若沿用用户输入的 http:// 会让 API Key 明文传输。 */
function normalizeHost(raw) {
    const host = (raw || '').trim()
        .replace(/^https?:\/\//i, '')   // 去掉协议
        .split('/')[0];                 // 只取主机名，丢掉路径与尾斜杠
    if (!host)
        return '';
    return `https://${host}`;
}

/* v1 的风向是方位代码（nw / nne），旧接口直接给中文（西北风） */
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

/* v1 的湿度、云量、降水概率都是 0–1 的小数，直接拼 % 会显示成 0.65% */
function toPercent(value) {
    const n = Number(value);
    return Number.isFinite(n) ? `${Math.round(n * 100)}%` : '--%';
}

/* 温度是浮点数（如 31.7），显示前取整。
 * 统一显示为 22°，不跟随接口返回的 "c" 单位，避免与 °C 混用。 */
function roundTemp(value) {
    const n = Number(value);
    return Number.isFinite(n) ? `${Math.round(n)}°` : '--°';
}

/* 其余量值沿用接口给的单位（hPa / km / mm 等），形如 {value, unit} */
function formatMeasure(obj, fallback = '--') {
    const n = Number(obj?.value);
    if (!Number.isFinite(n))
        return fallback;
    return obj?.unit ? `${Math.round(n)} ${obj.unit}` : `${Math.round(n)}`;
}

/* 天气图标代码直接来自服务端响应，要拼进文件路径，必须校验。
 * 不校验的话，形如 "../../../x" 的代码会构成路径穿越。 */
function safeIconCode(code) {
    const s = String(code ?? '');
    return /^[0-9A-Za-z]+$/.test(s) ? s : '999';
}

/* 每日请求计数的归零规则。抽成纯函数，便于脱离 Shell 环境验证。 */
function currentRequestCount(storedDate, storedCount, today) {
    return storedDate === today ? storedCount : 0;
}

function nextRequestCount(storedDate, storedCount, today) {
    return storedDate === today ? storedCount + 1 : 1;
}

/* =====================================================================
 * 空气质量
 * ===================================================================== */
function getAirQualityUrl(host, lat, lon) {
    return `${host}/airquality/v1/current/${formatCoord(lat)}/${formatCoord(lon)}`;
}

/* 响应里的 indexes 可能同时含当地标准与和风通用 AQI，
 * 优先取和风通用（code 为 qaqi），取不到再退回第一项。 */
function parseAqiIndex(json) {
    const list = Array.isArray(json?.indexes) ? json.indexes : [];
    if (list.length === 0)
        return null;
    const idx = list.find(i => i?.code === 'qaqi') ?? list[0];
    const aqi = Number(idx?.aqi);
    if (!Number.isFinite(aqi))
        return null;
    const c = idx?.color ?? {};
    const channel = v => (Number.isFinite(Number(v)) ? Number(v) : 128);
    return {
        aqi,
        display: idx?.aqiDisplay || String(Math.round(aqi)),
        category: idx?.category || '',
        color: { r: channel(c.red), g: channel(c.green), b: channel(c.blue) },
    };
}

/* 色环填充比例。国标 300 以上即严重污染，以 300 为满量程。 */
function aqiFillRatio(aqi) {
    const n = Number(aqi);
    if (!Number.isFinite(n))
        return 0;
    return Math.min(Math.max(n, 0), 300) / 300;
}

/* =====================================================================
 * 气压历史与趋势
 * 和风只给当前气压，趋势要靠本地按时间采样后自行比较，
 * 采样写入 GSettings，重启 Shell 后依然可用。
 * ===================================================================== */
const PRESSURE_WINDOW_SEC = 3 * 3600;   // 比较窗口：3 小时
const PRESSURE_MAX_SAMPLES = 24;
const PRESSURE_STEADY_HPA = 1.0;        // 变化小于 1 hPa 视为平稳
const PRESSURE_MIN_SPAN_SEC = 30 * 60;  // 历史不足半小时不给趋势，避免误导

function parsePressureHistory(raw) {
    try {
        const arr = JSON.parse(raw || '[]');
        if (!Array.isArray(arr))
            return [];
        return arr
            .filter(e => Number.isFinite(Number(e?.t)) && Number.isFinite(Number(e?.p)))
            .map(e => ({ t: Number(e.t), p: Number(e.p) }))
            .sort((a, b) => a.t - b.t);
    } catch (_e) {
        return [];   // 数据损坏时按空历史处理，不影响主流程
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

/* 趋势的紧凑表示，例如 "↑2.1" */
function formatPressureTrend(trend) {
    if (!trend)
        return '';
    if (trend.dir === 'steady')
        return '→';
    return `${trend.dir === 'rising' ? '↑' : '↓'}${Math.abs(trend.delta).toFixed(1)}`;
}

/* =====================================================================
 * 日出日落
 * 时间取自每日预报的 astro 字段，形如 "2026-09-15T06:12+08:00"。
 * ===================================================================== */
function parseClockMinutes(iso) {
    const m = /T(\d{2}):(\d{2})/.exec(String(iso ?? ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/* 分钟数 → HH:MM。
 * 必须先挡掉 null：Number(null) 是 0 且有限，会被当成 00:00。 */
function formatClock(minutes) {
    if (minutes === null || minutes === undefined || minutes === '')
        return '--:--';
    const n = Number(minutes);
    if (!Number.isFinite(n))
        return '--:--';
    const h = Math.floor(n / 60) % 24;
    const m = Math.round(n % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/* 取当天的日出日落（分钟数）。日落早于日出说明数据异常，按无数据处理。 */
function parseSunTimes(days) {
    const astro = Array.isArray(days) ? days[0]?.astro : null;
    const sunrise = parseClockMinutes(astro?.sunrise);
    const sunset = parseClockMinutes(astro?.sunset);
    if (sunrise === null || sunset === null || sunset <= sunrise)
        return null;
    return { sunrise, sunset };
}

/* 太阳在日出日落之间的位置：0 = 日出，1 = 日落。
 * 夜间把位置夹到两端并标记 isDay=false，界面据此弱化显示。 */
function sunArcPosition(nowMinutes, sunTimes) {
    if (!sunTimes)
        return null;
    const { sunrise, sunset } = sunTimes;
    const ratio = (nowMinutes - sunrise) / (sunset - sunrise);
    return {
        ratio: Math.min(Math.max(ratio, 0), 1),
        isDay: nowMinutes >= sunrise && nowMinutes <= sunset,
    };
}

/* 折线取值：每天的最高/最低温。缺数据的日子跳过。 */
function parseTrendPoints(days) {
    if (!Array.isArray(days))
        return [];
    return days
        .map(d => ({
            min: Number(d?.temperatureMin?.value),
            max: Number(d?.temperatureMax?.value),
        }))
        .filter(p => Number.isFinite(p.min) && Number.isFinite(p.max));
}

/* =====================================================================
 * Open-Meteo 兜底
 * 仅在用户于首选项中开启、且和风不可用（未配置 Key 或额度用尽）时启用。
 * 它用的是 WMO 天气代码，而本地图标是和风代码，需要转换。
 * ===================================================================== */
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

/* 夜间只有晴/少云/多云有专门图标，其余沿用白天图标 */
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
    const c = Number(code);
    if (!isDay && WMO_TO_QWEATHER_NIGHT[c])
        return WMO_TO_QWEATHER_NIGHT[c];
    return WMO_TO_QWEATHER_DAY[c] ?? '999';
}

function wmoToText(code) {
    return WMO_TEXT_ZH[Number(code)] ?? '--';
}

const COMPASS_CODES = ['n', 'nne', 'ne', 'ene', 'e', 'ese', 'se', 'sse',
                       's', 'ssw', 'sw', 'wsw', 'w', 'wnw', 'nw', 'nnw'];

/* Open-Meteo 给的是风向角度，和风给的是方位代码，这里换算过去 */
function degreesToCompass(degrees) {
    const d = Number(degrees);
    if (!Number.isFinite(d))
        return 'none';
    const normalized = ((d % 360) + 360) % 360;
    return COMPASS_CODES[Math.round(normalized / 22.5) % 16];
}

function getOpenMeteoUrl(lat, lon) {
    const query = [
        'current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,' +
            'wind_speed_10m,wind_direction_10m,surface_pressure,is_day',
        'daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset',
        `forecast_days=${FORECAST_DAYS}`,
        'timezone=auto',
    ].join('&');
    return `${OPEN_METEO_HOST}/v1/forecast?latitude=${formatCoord(lat)}&longitude=${formatCoord(lon)}&${query}`;
}

/* 把 Open-Meteo 的响应整理成和风 v1 的形状。
 * 这样 _updateUI 只认一种数据结构，不必在界面代码里到处判断来源；
 * 代价是多一层转换，但比在每个字段处分叉要清楚得多。 */
function openMeteoAsQweatherCurrent(json) {
    const cur = json?.current ?? {};
    const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
    return {
        condition: {
            code: wmoToQweatherCode(cur.weather_code, cur.is_day !== 0),
            text: wmoToText(cur.weather_code),
        },
        temperature: { value: num(cur.temperature_2m) },
        feelsLike: { value: num(cur.apparent_temperature) },
        // Open-Meteo 的湿度已是 0–100，转成和风的 0–1 以免下游重复换算
        humidity: num(cur.relative_humidity_2m) === null ? null : num(cur.relative_humidity_2m) / 100,
        wind: {
            direction: { compass: degreesToCompass(cur.wind_direction_10m) },
            scale: null,   // Open-Meteo 不提供蒲福风级，界面显示 --
        },
        pressure: { value: num(cur.surface_pressure), unit: 'hPa' },
    };
}

function openMeteoAsQweatherDaily(json) {
    const d = json?.daily ?? {};
    const times = Array.isArray(d.time) ? d.time : [];
    return times.map((date, i) => {
        const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
        return {
            astro: { sunrise: d.sunrise?.[i], sunset: d.sunset?.[i] },
            daytime: {
                condition: {
                    code: wmoToQweatherCode(d.weather_code?.[i], true),
                    text: wmoToText(d.weather_code?.[i]),
                },
            },
            temperatureMin: { value: num(d.temperature_2m_min?.[i]) },
            temperatureMax: { value: num(d.temperature_2m_max?.[i]) },
            _date: date,   // 保留原始日期，趋势折线用它标注
        };
    });
}

/* Cairo 里画文字所用的字体描述。两个坑都在这里：
 * 1. 必须带字体族——只用 FontDescription.new() 得到的描述没有族；
 * 2. set_absolute_size 的单位是 Pango 单位，须乘 PANGO_SCALE。
 *    传裸像素值会得到 0.02pt 的字号，实测测量宽度为 0，文字完全不可见。
 * 优先继承主题字体，取不到时退回 fontconfig 的通用族名。 */
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

/* 以 (x, y) 为中心画一段文字。y 用文字高度的一半做基线校正。 */
function drawCenteredText(cr, layout, text, x, y) {
    layout.set_text(String(text), -1);
    const [textW, textH] = layout.get_pixel_size();
    cr.moveTo(Math.round(x - textW / 2), Math.round(y - textH / 2));
    PangoCairo.show_layout(cr, layout);
}

/* =====================================================================
 * CSV 行解析
 * 城市库中部分字段被引号包裹且内含逗号（如 "Taiwan, Province of China"），
 * 直接用 split(',') 会导致后续字段整体错位，故按 CSV 规则逐字符解析。
 * 引号内的 "" 表示一个字面量引号。
 * ===================================================================== */
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

export default class ClimaCNExtension extends Extension {
    enable() {
        // 所有异步回调的统一守卫：disable() 置为 false，在途回调据此提前返回。
        // 不复用 _cancellable 兼任哨兵，以免「请求令牌」与「是否已禁用」两个语义相互干扰。
        this._enabled = true;

        this._indicator = null;
        this._timeoutId = 0;
        this._searchTimeoutId = 0;
        this._configDebounceId = 0;
        this._searchActivateId = 0;
        this._searchTextChangedId = 0;
        this._session = new Soup.Session();
        this._cancellable = new Gio.Cancellable();

        this._cityData = null;
        this._isLoadingCities = false;
        // 图标存在性缓存：图标只有几十个，缓存后可避免每次刷新都去 stat 磁盘
        this._iconExistsCache = new Map();
        this._requestSeq = 0;
        this._lastFetchAt = 0;      // 上次发起请求的时刻（单调时钟，秒）
        this._onBattery = false;
        this._upower = null;
        this._upowerSignalId = 0;

        this._settings = this.getSettings();
        this._apiKey = this._settings.get_string('api-key') || '';
        this._host = normalizeHost(this._settings.get_string('api-base-url'));

        // 当前城市：默认值由 GSettings schema 提供
        this._latitude = this._settings.get_double('latitude');
        this._longitude = this._settings.get_double('longitude');
        this._currentCityName = this._settings.get_string('city-name');

        this._pressureHistory = parsePressureHistory(this._settings.get_string('pressure-history'));
        this._aqi = null;
        this._aqiFailCount = 0;
        this._sunPosition = null;
        this._trendPoints = [];
        this._usingFallback = false;

        // _selectCity() 会连续写三个键，期间置位以免监听器重复发起请求
        this._writingSettings = false;

        // 首选项里每敲一个字符就会触发一次 changed，必须防抖：
        // 否则打到服务端的是一串用半截 Key 发出的无效请求，还会连累触发 401。
        const onConfigChanged = () => {
            if (!this._enabled) return;
            if (this._configDebounceId) {
                GLib.Source.remove(this._configDebounceId);
                this._configDebounceId = 0;
            }
            this._configDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                this._configDebounceId = 0;
                if (!this._enabled) return GLib.SOURCE_REMOVE;
                // 此前若因 401/403 停掉了自动刷新，配置改好后在这里恢复
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
        // 城市也可由外部（dconf-editor / gsettings）修改
        const onLocationChanged = () => {
            if (!this._enabled || this._writingSettings) return;
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
        });

        this._stylesheetPath = this.path + '/stylesheet.css';
        this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        this._theme.load_stylesheet(Gio.File.new_for_path(this._stylesheetPath));

        this._createIndicator();
        this._initPowerMonitor();
        this._fetchWeather();
        this._startAutoRefresh();
    }

    /* 监听电源状态：电池供电时拉长刷新间隔，减少唤醒与请求。
     * 走 UPower 的 D-Bus 属性，全程异步，不阻塞 Shell。
     * 台式机或容器里没有 UPower 时静默按插电处理。 */
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
                // 回调期间扩展可能已被禁用
                if (!this._enabled) return;
                try {
                    this._upower = Gio.DBusProxy.new_for_bus_finish(result);
                } catch (e) {
                    // 没有 UPower（台式机 / 容器）不是错误，按插电处理即可
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
                // 拿到真实电源状态后按新间隔重建定时器
                this._restartAutoRefresh();
            }
        );
    }

    disable() {
        // 最先置位：任何在途回调此后都会立即返回，不再触碰已释放的引用
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

        // 信号必须在 actor 销毁前断开：destroy() 之后 clutter_text 已不可访问
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

        if (this._cancellable && !this._cancellable.is_cancelled())
            this._cancellable.cancel();
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        if (this._stylesheetPath && this._theme) {
            const file = Gio.File.new_for_path(this._stylesheetPath);
            try { this._theme.unload_stylesheet(file); } catch (e) { console.error(`[ClimaCN] ${e}`); }
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        if (this._settings) {
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
            this._settings = null;
        }

        if (this._upower) {
            if (this._upowerSignalId) {
                this._upower.disconnect(this._upowerSignalId);
                this._upowerSignalId = 0;
            }
            this._upower = null;
        }

        // 释放全部 UI 引用，避免反复 enable/disable 后残留 actor 导致内存泄漏
        this._weatherIcon = null;
        this._tempLabel = null;
        this._headerIcon = null;
        this._headerTemp = null;
        this._headerCondition = null;
        this._aqiGroup = null;
        this._aqiArea = null;
        this._sunriseLabel = null;
        this._sunArcArea = null;
        this._sunsetLabel = null;
        this._sunArcItem = null;
        this._cityLabel = null;
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
        this._attributionLabel = null;
        this._attributionItem = null;
        this._noticeLabel = null;
        this._noticeItem = null;
        this._refreshItem = null;
        this._forecastContainer = null;
        this._forecastTitle = null;
        this._forecastRowsBox = null;
        this._trendItem = null;
        this._trendArea = null;
        this._searchEntry = null;
        this._searchStatusLabel = null;
        this._searchResultsSection = null;

        // 释放状态数据
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
        this._trendPoints = [];
        this._usingFallback = false;
        this._lastFetchAt = 0;
        this._onBattery = false;
        this._upowerSignalId = 0;
        this._stylesheetPath = null;
        this._theme = null;
        this._cancellable = null;
    }

    _createIndicator() {
        this._indicator = new PanelMenu.Button(0.0, 'ClimaCN', false);
        const box = new St.BoxLayout({
            style_class: 'climacn-indicator-box',
            y_align: Clutter.ActorAlign.CENTER
        });
        this._weatherIcon = new St.Icon({
            style_class: 'system-status-icon climacn-panel-icon',
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
        this._buildMenu();
        Main.panel.addToStatusArea('climacn', this._indicator);
    }

    _buildMenu() {
        this._indicator.menu.removeAll();

        this._buildHeader();

        // 分隔线只保留搜索框上下两条，其余靠间距区分，避免菜单被切得太碎
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._buildSearchUI();
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._buildDetails();
        this._buildSunArc();
        this._buildForecast();
        this._buildFooter();
    }

    /* 日出日落弧线：半圆轨道 + 太阳位置圆点，两侧标出日出日落时刻。
     * 数据来自每日预报的 astro，不需要额外请求。 */
    _buildSunArc() {
        const box = new St.BoxLayout({
            style_class: 'climacn-sun-arc',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true   // 关键：否则绘图区宽度为 0，弧线画不出来
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
        this._sunArcArea.connect('repaint', () => this._drawSunArc());
        box.add_child(this._sunArcArea);

        this._sunsetLabel = new St.Label({
            text: '--:--',
            style_class: 'climacn-sun-time',
            y_align: Clutter.ActorAlign.CENTER
        });
        box.add_child(this._sunsetLabel);

        this._sunArcItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        this._sunArcItem.add_child(box);
        this._sunArcItem.visible = false;   // 没有 astro 数据时整行隐藏
        this._indicator.menu.addMenuItem(this._sunArcItem);
    }

    /* 卡片头：大图标 + 大号温度 + 天气状况，城市名降为下方小字。
     * 打开菜单第一眼就该读到“现在多少度、什么天”，而不是先看一串标签。 */
    _buildHeader() {
        const box = new St.BoxLayout({
            style_class: 'climacn-header-box',
            vertical: true,
            x_expand: true   // 不撑满的话内部 x_expand 的部件拿不到宽度
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

        // 弹性留白把 AQI 推到行尾；取不到空气质量数据时整组隐藏
        row.add_child(new St.Widget({ x_expand: true }));
        this._aqiGroup = new St.BoxLayout({
            style_class: 'climacn-aqi-group',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false
        });
        // 图标主题里没有语义正确的空气质量图标，用 "AQI" 三个字母更易辨识
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
        this._aqiArea.connect('repaint', () => this._drawAqiRing());
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

    /* 详情区：4 项常用数据排成两列网格；其余字段收进“更多数据”子菜单。
     * 单列平铺的话，字段一多菜单会被拉得很长。 */
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

        // 10 天趋势折线放在子菜单里，默认收起——直接铺在菜单里会让
        // popup 过长，而它属于"想看才展开"的信息
        this._buildTrendSubmenu();

        const item = new PopupMenu.PopupBaseMenuItem({ activate: false });
        item.add_child(this._forecastContainer);
        this._indicator.menu.addMenuItem(item);
    }

    /* 10 天趋势折线。数据来自同一个每日预报响应（days=10），
     * 逐日行只展开前 3 天，剩下的走势在这里看。
     * 子菜单按内容定宽，没有可撑开的余量，因此绘图区要显式给宽度。 */
    _buildTrendSubmenu() {
        this._trendItem = new PopupMenu.PopupSubMenuMenuItem(_('10 天趋势'), false);
        this._trendItem.visible = false;   // 数据不足 2 天时整项隐藏

        this._trendArea = new St.DrawingArea({
            style_class: 'climacn-trend-chart',
            width: TREND_CHART_WIDTH,
            height: TREND_CHART_HEIGHT
        });
        this._trendArea.connect('repaint', () => this._drawTrendChart());

        const item = new PopupMenu.PopupBaseMenuItem({ activate: false });
        item.add_child(this._trendArea);
        this._trendItem.menu.addMenuItem(item);
        this._indicator.menu.addMenuItem(this._trendItem);
    }

    _buildFooter() {
        // 额度用尽等状态提示，平时隐藏
        this._noticeLabel = new St.Label({
            style_class: 'climacn-notice',
            text: ''
        });
        this._noticeItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        this._noticeItem.add_child(this._noticeLabel);
        this._noticeItem.visible = false;
        this._indicator.menu.addMenuItem(this._noticeItem);

        // 数据归因：和风天气条款要求必须与数据共同显示
        this._attributionLabel = new St.Label({
            style_class: 'climacn-attribution',
            text: ''
        });
        this._attributionItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        this._attributionItem.add_child(this._attributionLabel);
        this._attributionItem.visible = false;
        this._indicator.menu.addMenuItem(this._attributionItem);

        // PopupImageMenuItem 把图标放在文字左侧，比手动 add_child 更规整
        this._refreshItem = new PopupMenu.PopupImageMenuItem(_('刷新'), 'view-refresh-symbolic');
        this._refreshItem.connect('activate', () => this._onManualRefresh());
        this._indicator.menu.addMenuItem(this._refreshItem);
    }

    /* 预算用尽时给出提示，避免用户以为扩展坏了 */
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
            hint_text: _('搜索城市 (例: 北京/海淀/朝阳)...'),
            track_hover: true,
            can_focus: true,
            style_class: 'climacn-search-entry'
        });
        this._searchActivateId = this._searchEntry.clutter_text.connect('activate', () => this._onSearchActivate());
        this._searchTextChangedId = this._searchEntry.clutter_text.connect('text-changed', () => this._onSearchTextChanged());

        const entryItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        entryItem.add_child(this._searchEntry);
        this._indicator.menu.addMenuItem(entryItem);

        // 独立的类：climacn-detail-label 有固定宽度，会把状态文字挤变形
        this._searchStatusLabel = new St.Label({
            style_class: 'climacn-search-status'
        });
        this._searchStatusLabel.hide();
        const statusItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        statusItem.add_child(this._searchStatusLabel);
        this._indicator.menu.addMenuItem(statusItem);

        this._searchResultsSection = new PopupMenu.PopupMenuSection();
        this._indicator.menu.addMenuItem(this._searchResultsSection);
        this._searchResultsSection.actor.hide();
    }

    _loadCityData() {
        if (this._cityData || this._isLoadingCities) return;
        this._isLoadingCities = true;
        const csvFile = Gio.File.new_for_path(`${this.path}/data/China-City-List-latest.csv`);
        csvFile.load_contents_async(null, (file, result) => {
            // disable() 已执行：UI 引用已释放，不可再触碰
            if (!this._enabled) return;
            try {
                const [success, contents] = file.load_contents_finish(result);
                if (!success) throw new Error('load failed');
                this._parseCSV(new TextDecoder().decode(contents));
                this._isLoadingCities = false;
            } catch (e) {
                console.error(`[ClimaCN] Failed to load city data: ${e}`);
                this._cityData = [];
                this._isLoadingCities = false;
                this._showSearchStatus(_('本地城市库加载失败，请检查文件路径'));
            }
        });
    }

    _parseCSV(csvText) {
        const cities = [];
        // 列序号由表头按列名解析而非写死：和风若调整列顺序，
        // 写死的序号会静默解析出错误数据而不报错。
        let col = null;
        for (const rawLine of csvText.split('\n')) {
            const line = rawLine.trim();
            if (!line) continue;
            const cols = parseCsvLine(line);
            if (cols.length < 10) continue;

            if (!col) {
                const names = cols.map(c => c.trim());
                if (!names.includes('Location_ID')) continue;   // 版本行
                col = {
                    id: names.indexOf('Location_ID'),
                    name: names.indexOf('Location_Name_ZH'),
                    adm1: names.indexOf('Adm1_Name_ZH'),
                    adm2: names.indexOf('Adm2_Name_ZH'),
                    lat: names.indexOf('Latitude'),
                    lon: names.indexOf('Longitude'),
                };
                // adm2 仅用于显示，缺失不算致命；经纬度是 v1 接口的定位依据，必须有
                if (col.name < 0 || col.adm1 < 0 || col.lat < 0 || col.lon < 0) {
                    console.error('[ClimaCN] 城市库表头缺少必要列，已放弃解析');
                    break;
                }
                continue;
            }

            const id = cols[col.id].trim();
            const name = cols[col.name].trim();
            const adm1 = cols[col.adm1].trim();
            const adm2 = col.adm2 < 0 ? '' : cols[col.adm2].trim();
            const lat = Number(cols[col.lat]);
            const lon = Number(cols[col.lon]);
            if (!name || !adm1) continue;
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
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
        this._searchStatusLabel.hide();
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
        this._searchResultsSection.actor.hide();
        this._searchStatusLabel.text = text;
        this._searchStatusLabel.show();
    }

    _clearSearchResults() {
        if (this._searchResultsSection) {
            this._searchResultsSection.removeAll();
            this._searchResultsSection.actor.hide();
        }
        if (this._searchStatusLabel) {
            this._searchStatusLabel.hide();
        }
    }

    _selectCity(city) {
        this._latitude = city.lat;
        this._longitude = city.lon;
        this._currentCityName = `${city.name}，${city.adm1}`;
        this._cityLabel.text = this._currentCityName;

        // 三个键连续写入，期间挡住监听器，避免重复发起请求
        this._writingSettings = true;
        this._settings.set_double('latitude', this._latitude);
        this._settings.set_double('longitude', this._longitude);
        this._settings.set_string('city-name', this._currentCityName);
        this._writingSettings = false;

        this._searchEntry.text = '';
        this._clearSearchResults();
        this._fetchWeather();
    }

    /* 当前生效的自动刷新间隔：电池供电时拉长 */
    _intervalSec() {
        return this._onBattery ? BATTERY_INTERVAL_SEC : UPDATE_INTERVAL_SEC;
    }

    /* 幂等：已有定时器就不重复创建。
     * 配置变更后也会调用它，用来恢复此前被 401/403 停掉的定时器。 */
    _startAutoRefresh() {
        if (this._timeoutId)
            return;
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._intervalSec(), () => {
            this._autoRefreshTick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    /* 间隔会随电源状态变化，切换时重建定时器 */
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
        // 今日额度用尽：不再自动请求，等次日归零或用户手动刷新
        if (this._requestBudgetExhausted()) {
            this._updateNotice();
            return;
        }
        // 数据仍在新鲜期内就不请求。15 分钟间隔下不会触发，
        // 这是防止间隔被改小或系统时间回拨的兜底。
        if (this._secondsSinceFetch() < CACHE_TTL_SEC)
            return;
        this._fetchWeather();
    }

    /* 手动刷新：60 秒内忽略，防止连点把额度刷掉。
     * 改 API Key / Host 走的是配置变更那条路径，不受此限，改完能立刻生效。 */
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

    /* ---- 每日请求预算 ---- */

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

    /* 每发出一个请求就记一次。计数写入 GSettings，重启 Shell 后仍有效。 */
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

    /* v1 不再用响应体里的 code 字段表示结果，改看 HTTP 状态码。
     * 401/403 说明凭据无效，继续轮询没有意义，直接停掉自动刷新。 */
    _handleHttpError(message, bytes) {
        const status = message.status_code;
        let body = '';
        try {
            body = new TextDecoder().decode(bytes.get_data()).slice(0, 300);
        } catch (_e) {
            // 响应体读不出来不影响错误提示
        }
        console.error(`[ClimaCN] HTTP ${status}: ${body}`);

        if (status === Soup.Status.UNAUTHORIZED || status === Soup.Status.FORBIDDEN) {
            if (this._timeoutId) {
                GLib.Source.remove(this._timeoutId);
                this._timeoutId = 0;
            }
            this._showError(_('API Key 无效或无权访问，已停止更新'));
            return;
        }
        if (status === Soup.Status.NOT_FOUND) {
            this._showError(_('API Host 或接口路径不正确'));
            return;
        }
        this._showError(`请求失败（HTTP ${status}）`);
    }

    /* 是否改走 Open-Meteo：需用户在首选项里显式开启，且和风确实不可用
     * （凭据缺失或当日额度已用尽）。默认关闭，不做无谓的第三方请求。 */
    _shouldUseFallback() {
        if (!this._settings?.get_boolean('use-open-meteo-fallback'))
            return false;
        return !this._apiKey || !this._host || this._requestBudgetExhausted();
    }

    /* Open-Meteo 不需要凭据，响应先归一化成和风的形状再交给 _updateUI。
     * 它不消耗和风额度，因此不计入每日请求数。 */
    _fetchFromOpenMeteo() {
        const seq = ++this._requestSeq;
        this._lastFetchAt = GLib.get_monotonic_time() / 1e6;

        const message = Soup.Message.new('GET', getOpenMeteoUrl(this._latitude, this._longitude));
        if (!message)
            return;

        this._session.send_and_read_async(
            message,
            Soup.MessagePriority.NORMAL,
            this._cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (!this._enabled || this._cancellable?.is_cancelled()) return;
                    if (seq !== this._requestSeq) return;

                    if (message.status_code !== Soup.Status.OK) {
                        console.error(`[ClimaCN] Open-Meteo HTTP ${message.status_code}`);
                        this._showError(_('备用数据源请求失败'));
                        return;
                    }
                    const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    const current = openMeteoAsQweatherCurrent(json);
                    const daily = openMeteoAsQweatherDaily(json);
                    if (daily.length === 0) {
                        this._showError(_('备用数据源返回数据不完整'));
                        return;
                    }
                    this._usingFallback = true;
                    this._updateUI(current, daily, null);   // 兜底不提供 AQI
                } catch (e) {
                    if (!this._enabled) return;
                    console.error(`[ClimaCN] Open-Meteo parse error: ${e}`);
                    this._showError();
                }
            }
        );
    }

    _fetchWeather() {
        if (!this._enabled) return;

        // 和风不可用且用户允许兜底时，改走 Open-Meteo
        if (this._shouldUseFallback()) {
            this._fetchFromOpenMeteo();
            return;
        }

        if (!this._apiKey || this._apiKey.trim() === '') {
            this._showError(_('请在设置中配置 API Key'));
            return;
        }
        if (!this._host) {
            this._showError(_('请在设置中配置 API Host'));
            return;
        }
        // _enabled 为真即保证 enable() 已跑完，_cancellable 必定存在
        if (this._cancellable.is_cancelled())
            this._cancellable = new Gio.Cancellable();

        const url = getWeatherUrl(this._host, this._latitude, this._longitude);
        const message = Soup.Message.new('GET', url);
        if (!message) return;
        message.request_headers.append('X-Qw-Api-Key', this._apiKey);

        this._lastFetchAt = GLib.get_monotonic_time() / 1e6;
        this._countRequest();

        // 请求序号：快速连续切换城市时，先发的请求可能后返回，
        // 若不丢弃过期响应，会出现"标题是新城市、数据是旧城市"的错配
        const seq = ++this._requestSeq;

        this._session.send_and_read_async(
            message,
            Soup.MessagePriority.NORMAL,
            this._cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    // disable() 之后 UI 引用均已释放，不可再触碰
                    if (!this._enabled || this._cancellable?.is_cancelled()) return;
                    // 已有更新的请求发出，本次结果作废
                    if (seq !== this._requestSeq) return;

                    if (message.status_code !== Soup.Status.OK) {
                        this._handleHttpError(message, bytes);
                        return;
                    }

                    const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    if (!json.condition || !json.temperature) {
                        console.error(`[ClimaCN] 响应缺少预期字段: ${JSON.stringify(json).slice(0, 300)}`);
                        this._showError();
                        return;
                    }
                    // 预报与空气质量并行拉取，两个都回来再更新界面。
                    // 串行的话，空气质量接口慢或不可用会把整个界面拖住。
                    const pending = {};
                    const settle = () => {
                        if (!('forecast' in pending) || !('aqi' in pending)) return;
                        if (!this._enabled || seq !== this._requestSeq) return;
                        this._usingFallback = false;   // 本次数据来自和风
                        this._updateUI(json, pending.forecast, pending.aqi);
                    };
                    this._fetchForecast(seq, (forecast) => {
                        pending.forecast = forecast;
                        settle();
                    });
                    this._fetchAirQuality(seq, (aqi) => {
                        pending.aqi = aqi;
                        settle();
                    });
                } catch (e) {
                    if (!this._enabled) return;
                    console.error(`[ClimaCN] Network/parse error: ${e}`);
                    this._showError();
                }
            }
        );
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
                    // disable() 后不再回调，否则调用方会去更新已释放的 UI
                    if (!this._enabled) return;
                    // 期间已切换到别的城市，本次预报作废
                    if (seq !== this._requestSeq) return;
                    if (this._cancellable?.is_cancelled()) {
                        callback(null);
                        return;
                    }
                    if (message.status_code !== Soup.Status.OK) {
                        console.error(`[ClimaCN] 预报请求 HTTP ${message.status_code}`);
                        callback(null);
                        return;
                    }
                    const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    // v1 的数组字段名是 days，不再是 daily
                    callback(Array.isArray(json.days) ? json.days : null);
                } catch (e) {
                    if (!this._enabled) return;
                    console.error(`[ClimaCN] Forecast parse error: ${e}`);
                    callback(null);
                }
            }
        );
    }

    /* 空气质量是第三个请求。若该接口不可用（凭据未授权、套餐不含等），
     * 连续失败 AQI_MAX_FAILURES 次后就不再请求，免得白白消耗额度。
     * 任何失败路径都会回调 null，保证调用方的并行汇合不会卡住。 */
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
                        console.error(`[ClimaCN] 空气质量请求 HTTP ${message.status_code}`);
                        callback(null);
                        return;
                    }
                    const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    this._aqiFailCount = 0;
                    callback(parseAqiIndex(json));
                } catch (e) {
                    if (!this._enabled) return;
                    console.error(`[ClimaCN] Air quality parse error: ${e}`);
                    callback(null);
                }
            }
        );
    }

    // 辅助函数：安全地创建 Gio.FileIcon
    /* query_exists() 是同步 stat，每次刷新都会对同一批图标反复调用。
     * 图标集合是固定的几十个文件，把结果缓存下来之后，
     * 扩展在稳定状态下不再产生任何同步 I/O。 */
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
            console.error(`[ClimaCN] Failed to create icon from ${filePath}: ${e}`);
        }
        return null;
    }
    /* 统一切换图标：gicon 与 icon_name 互斥，切换时必须清空另一个，
     * 否则从本地 SVG 换回内置图标时旧图标仍会显示。 */
    _applyIcon(widget, gicon, fallbackName = 'weather-severe-alert-symbolic') {
        if (gicon) {
            widget.gicon = gicon;
            widget.icon_name = null;
        } else {
            widget.gicon = null;
            widget.icon_name = fallbackName;
        }
    }

    /* AQI 色环：灰色底环 + 按 AQI 比例填充的彩环，中心写数值。
     * 尺寸取自 surface（已含 HiDPI 缩放），线宽与字号按 scaleFactor 放大。 */
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

            const start = -Math.PI / 2;    // 从正上方起笔
            const sweep = Math.PI * 1.5;   // 270° 的量表弧

            cr.setLineWidth(lineWidth);
            cr.setLineCap(Cairo.LineCap.ROUND);

            // 底环
            cr.setSourceRGBA(0.5, 0.5, 0.5, 0.25);
            cr.arc(cx, cy, radius, start, start + sweep);
            cr.stroke();

            const aqi = this._aqi;
            if (!aqi)
                return;

            // 数据环，颜色由接口给出
            const ratio = aqiFillRatio(aqi.aqi);
            if (ratio > 0) {
                cr.setSourceRGBA(aqi.color.r / 255, aqi.color.g / 255, aqi.color.b / 255, 1);
                cr.arc(cx, cy, radius, start, start + sweep * ratio);
                cr.stroke();
            }

            // 中心数值用主题前景色，深浅主题下都能看清
            const [hasColor, color] = area.get_theme_node().lookup_color('color', false);
            if (hasColor)
                cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, 1);
            else
                cr.setSourceRGBA(0.5, 0.5, 0.5, 1);

            // 主题字体取不到时不能让绘制失败，交给 cairoFontDescription 兜底
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
            // repaint 每次都给一个新的 context，不释放会持续泄漏
            cr.$dispose();
        }
    }

    /* 日出日落弧线：上半圆轨道 + 已走过的弧段高亮 + 太阳圆点。
     * 夜间把太阳点弱化并夹在两端。 */
    _drawSunArc() {
        const area = this._sunArcArea;
        if (!area)
            return;
        const [width, height] = area.get_surface_size();
        const cr = area.get_context();
        try {
            const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);
            const lineWidth = Math.max(1.5, 2 * scaleFactor);
            const pad = lineWidth + 3 * scaleFactor;
            const radius = Math.min((width - 2 * pad) / 2, height - 2 * pad);
            if (radius <= 0)
                return;
            const cx = width / 2;
            const cy = height - pad;   // 圆心落在底边，画出来就是上半圆

            cr.setLineWidth(lineWidth);
            cr.setLineCap(Cairo.LineCap.ROUND);

            // 整条轨道。cairo 的角度以 y 轴向下为正，Math.PI→2*Math.PI 即上半圆
            cr.setSourceRGBA(0.5, 0.5, 0.5, 0.25);
            cr.arc(cx, cy, radius, Math.PI, 2 * Math.PI);
            cr.stroke();

            const pos = this._sunPosition;
            if (!pos)
                return;
            const theta = Math.PI + pos.ratio * Math.PI;
            const alpha = pos.isDay ? 1 : 0.3;

            // 已经走过的弧段
            cr.setSourceRGBA(1.0, 0.72, 0.2, alpha * 0.9);
            cr.arc(cx, cy, radius, Math.PI, theta);
            cr.stroke();

            // 太阳圆点
            cr.setSourceRGBA(1.0, 0.72, 0.2, alpha);
            cr.arc(cx + radius * Math.cos(theta), cy + radius * Math.sin(theta),
                   Math.max(3.5, 4.5 * scaleFactor), 0, 2 * Math.PI);
            cr.fill();
        } finally {
            cr.$dispose();
        }
    }

    /* 10 天趋势折线：最高温与最低温两条线，每个点带圆点和温度数字。
     * 最高温的数字画在点的上方，最低温画在下方，两者不会互相压住。
     * 上下各预留一行文字的高度，纵向绘图区据此收缩。 */
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
            // 上下各留出「圆点半径 + 一行数字」，避免数字被裁掉
            const plotTop = dotR + labelH + 2;
            const plotBottom = height - dotR - labelH - 2;
            const plotW = width - 2 * padX;
            const plotH = plotBottom - plotTop;
            if (plotW <= 0 || plotH <= 0)
                return;

            const lows = points.map(p => p.min);
            const highs = points.map(p => p.max);
            const lo = Math.min(...lows);
            const hi = Math.max(...highs);
            const span = hi - lo || 1;   // 全平的时候避免除零

            const xAt = i => padX + (plotW * i) / (points.length - 1);
            const yAt = v => plotTop + plotH * (1 - (v - lo) / span);

            const HIGH = [0.95, 0.55, 0.20, 0.95];
            const LOW = [0.30, 0.60, 0.95, 0.95];

            const polyline = (values, rgba) => {
                cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], rgba[3]);
                cr.setLineWidth(Math.max(1.2, 1.6 * scaleFactor));
                cr.setLineJoin(Cairo.LineJoin.ROUND);
                cr.moveTo(xAt(0), yAt(values[0]));
                for (let i = 1; i < values.length; i++)
                    cr.lineTo(xAt(i), yAt(values[i]));
                cr.stroke();
            };

            polyline(highs, HIGH);
            polyline(lows, LOW);

            // 数据点
            for (const [values, rgba] of [[highs, HIGH], [lows, LOW]]) {
                cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], 1);
                for (let i = 0; i < values.length; i++) {
                    cr.arc(xAt(i), yAt(values[i]), dotR, 0, 2 * Math.PI);
                    cr.fill();
                }
            }

            // 数字标注与折线同色，读起来能直接对应到是哪条线
            const layout = PangoCairo.create_layout(cr);
            let themeFont = null;
            try {
                themeFont = themeNode.get_font();
            } catch (_e) {
                themeFont = null;
            }
            layout.set_font_description(cairoFontDescription(themeFont, TREND_LABEL_PX, scaleFactor));

            for (let i = 0; i < points.length; i++) {
                cr.setSourceRGBA(HIGH[0], HIGH[1], HIGH[2], 0.95);
                drawCenteredText(cr, layout, `${Math.round(highs[i])}°`,
                                 xAt(i), yAt(highs[i]) - dotR - labelH / 2);
                cr.setSourceRGBA(LOW[0], LOW[1], LOW[2], 0.95);
                drawCenteredText(cr, layout, `${Math.round(lows[i])}°`,
                                 xAt(i), yAt(lows[i]) + dotR + labelH / 2);
            }
        } finally {
            cr.$dispose();
        }
    }

    /* now 是 v1 /weather/v1/current 的完整响应体（含 metadata）；
     * aqi 来自空气质量接口，取不到时为 null。 */
    _updateUI(now, forecast, aqi) {
        // ---- 当前天气 ----
        const iconCode = safeIconCode(now.condition?.code);
        const icon = this._createFileIcon(`${this.path}/icons/${iconCode}-symbolic.svg`);
        const tempText = roundTemp(now.temperature?.value);

        // 顶栏
        this._applyIcon(this._weatherIcon, icon);
        this._tempLabel.text = tempText;
        // 卡片头
        this._applyIcon(this._headerIcon, icon);
        this._headerTemp.text = tempText;
        this._headerCondition.text = now.condition?.text || '--';

        // 空气质量色环：取不到数据就整块隐藏，不留空环
        this._aqi = aqi ?? null;
        if (this._aqiGroup) {
            this._aqiGroup.visible = this._aqi !== null;
            if (this._aqi)
                this._aqiArea.queue_repaint();
        }

        // ---- 常用数据（两列网格）----
        this._feelsLikeLabel.text = roundTemp(now.feelsLike?.value);
        this._humidityLabel.text = toPercent(now.humidity);
        this._windLabel.text =
            `${compassToChinese(now.wind?.direction?.compass)} ${now.wind?.scale ?? '--'}级`;
        // v1 的实时天气不再返回观测时间，这里显示本次拉取成功的本地时间
        this._updateTimeLabel.text = GLib.DateTime.new_now_local().format('%H:%M');

        // ---- 折叠区数据 ----
        // 气压趋势：接口只给当前值，趋势要靠本地按时间累积采样后自行比较
        const pressureValue = Number(now.pressure?.value);
        const nowSec = Math.floor(Date.now() / 1000);
        let trendText = '';
        if (Number.isFinite(pressureValue)) {
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
        this._uvIndexLabel.text    = Number.isFinite(Number(now.uvIndex))
            ? `${Math.round(Number(now.uvIndex))}` : '--';
        this._windGustLabel.text   = formatMeasure(now.windGust);
        this._precipLabel.text     = formatMeasure(now.precipitation?.amount);

        // ---- 数据归因 ----
        // 和风天气条款要求归因与数据共同显示，此处保留极简来源一行，
        // 完整的说明与链接放在首选项的“数据来源”分组里
        if (this._attributionItem) {
            // 走兜底时必须标明来源，否则用户会以为数据仍来自和风
            this._attributionLabel.text = this._usingFallback ? 'Open-Meteo' : _('和风天气');
            this._attributionItem.visible = true;
        }

        // 跨天后额度恢复，提示需要跟着消失
        this._updateNotice();

        // ---- 未来3天预报 ----
        if (this._forecastRowsBox) {
            this._forecastRowsBox.remove_all_children();
        }

        // ---- 日出日落弧线 ----
        const sunTimes = parseSunTimes(forecast);
        this._sunPosition = null;
        if (sunTimes) {
            const now = GLib.DateTime.new_now_local();
            this._sunPosition = sunArcPosition(now.get_hour() * 60 + now.get_minute(), sunTimes);
            this._sunriseLabel.text = formatClock(sunTimes.sunrise);
            this._sunsetLabel.text = formatClock(sunTimes.sunset);
        }
        if (this._sunArcItem) {
            this._sunArcItem.visible = sunTimes !== null;
            if (sunTimes)
                this._sunArcArea.queue_repaint();
        }

        // ---- 10 天趋势折线（收在子菜单里）----
        this._trendPoints = parseTrendPoints(forecast);
        const showTrend = this._trendPoints.length >= 2;
        if (this._trendItem) {
            this._trendItem.visible = showTrend;
            if (showTrend)
                this._trendArea.queue_repaint();
        }

        if (forecast && Array.isArray(forecast) && forecast.length > 0) {
            const dayNames = ['今天', '明天', '后天'];
            const count = Math.min(forecast.length, FORECAST_ROWS);
            for (let i = 0; i < count; i++) {
                const day = forecast[i];
                const row = new St.BoxLayout({
                    style_class: 'climacn-forecast-row',
                    y_align: Clutter.ActorAlign.CENTER
                });

                // 日期
                const dayLabel = new St.Label({
                    text: dayNames[i],
                    style_class: 'climacn-forecast-day',
                    y_align: Clutter.ActorAlign.CENTER
                });
                row.add_child(dayLabel);

                // 天气图标（使用本地 SVG）。v1 把白天/夜间拆成两个对象，取白天
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

                // 温度范围（单位与卡片头保持一致，不再单独写 °C）
                const tempLabel = new St.Label({
                    text: `${roundTemp(day.temperatureMin?.value)} / ${roundTemp(day.temperatureMax?.value)}`,
                    style_class: 'climacn-forecast-temp',
                    y_align: Clutter.ActorAlign.CENTER
                });
                row.add_child(tempLabel);

                // 天气状况
                const conditionLabel = new St.Label({
                    text: day.daytime?.condition?.text || '--',
                    style_class: 'climacn-forecast-condition',
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
    }

    _showError(message = _('获取失败')) {
        this._applyIcon(this._weatherIcon, null, 'dialog-error-symbolic');
        this._applyIcon(this._headerIcon, null, 'dialog-error-symbolic');
        this._tempLabel.text = 'N/A';
        this._headerTemp.text = 'N/A';
        this._headerCondition.text = message;

        // 出错时把数值全部清空，避免残留上次的旧数据误导用户
        for (const label of [this._feelsLikeLabel, this._humidityLabel, this._windLabel,
                             this._updateTimeLabel, this._pressureLabel, this._visibilityLabel,
                             this._dewPointLabel, this._cloudCoverLabel, this._uvIndexLabel,
                             this._windGustLabel, this._precipLabel]) {
            if (label)
                label.text = '--';
        }

        // 数据已失效，归因行与空气质量色环一并隐藏
        if (this._attributionItem)
            this._attributionItem.visible = false;
        this._aqi = null;
        if (this._aqiGroup)
            this._aqiGroup.visible = false;

        // 日出日落与趋势同样基于失效的数据，一并隐藏
        this._sunPosition = null;
        if (this._sunArcItem)
            this._sunArcItem.visible = false;
        this._trendPoints = [];
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
    }
}

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
const SUN_ARC_HEIGHT = 60;                // 天空弧线的高度（逻辑像素，弧线上还要留出刻度）
const MOON_ARC_HEIGHT = 56;               // 月亮弧线的高度
const MOON_DISC_RADIUS = 7;               // 弧上月相圆盘的半径（逻辑像素）

/* 天空色阶：夜 → 天文暮光 → 航海暮光 → 民用暮光 → 白天。
 * 三段暮光分别对应太阳位于地平线下 18°~12°、12°~6°、6°~0°，
 * 和风把它们各自的起止时刻都给了，所以色带能落在真实时间上。 */
const SKY_ASTRONOMY = [0.22, 0.26, 0.52];
const SKY_NAUTICAL  = [0.30, 0.38, 0.68];
const SKY_CIVIL     = [0.58, 0.52, 0.76];
const SKY_DAY       = [1.00, 0.72, 0.20];

/* 月亮弧线用主题前景色画：亮面用较高透明度、暗面用很低的一层，
 * 这样深色与浅色主题下都不需要额外的配色分支。 */
const MOON_LIT_ALPHA = 0.85;
const MOON_DARK_ALPHA = 0.16;
const TREND_CHART_HEIGHT = 64;            // 折线高度：上下各留一行数字的位置
const TREND_CHART_WIDTH = 400;            // 折线宽度：放在子菜单里，需显式指定
const TREND_LABEL_PX = 8;                 // 折线数值标注的字号（逻辑像素）
const MOON_STRIP_HEIGHT = 30;             // 折线下方逐日月相条的高度
const TEMP_BAR_HEIGHT = 8;                // 预报行温度条的高度（逻辑像素）
/* 宽度必须是固定的：若让它弹性伸缩，各行的天气状况文字长短不同，
 * 条长就会不一样，"长度代表温差"这个编码立刻失效。 */
const TEMP_BAR_WIDTH = 110;

/* 冷暖两色，温度条的两端与趋势折线的两条线共用，
 * 保证同一份数据在两处颜色对得上。取中间明度的橙与蓝：
 * 浅色和深色主题下都看得清，不像纯红/纯蓝那样在某个主题里糊掉。 */
const COLOR_HIGH = [0.95, 0.55, 0.20];
const COLOR_LOW = [0.30, 0.60, 0.95];

/* 温度色阶（冷 → 暖），按气象图惯用的蓝→青→黄→橙。
 * 不能在蓝与橙之间直接做 RGB 插值：中点约为 (0.63, 0.58, 0.58)，
 * 是个去饱和的灰紫，"温和"的那几天会糊成一团看不出颜色。
 * 每项为 [位置, r, g, b]。 */
const TEMP_RAMP = [
    [0.00, 0.30, 0.60, 0.95],
    [0.35, 0.35, 0.80, 0.85],
    [0.60, 0.95, 0.85, 0.30],
    [1.00, 0.95, 0.55, 0.20],
];

const OPEN_METEO_HOST = 'https://api.open-meteo.com';
const OPEN_METEO_AQI_HOST = 'https://air-quality-api.open-meteo.com';
/* Open-Meteo 免费给到 16 天，比和风的 10 天多，没必要跟着和风砍 */
const OPEN_METEO_FORECAST_DAYS = 16;

/* =====================================================================
 * 设置迁移
 *
 * 旧版本只有一个布尔开关 use-open-meteo-fallback（默认关闭），现在被四个
 * source-* 下拉取代。**不能把旧默认当成 auto** —— 那等于让从没同意过
 * 第三方请求的用户，在升级后不知情地开始把城市坐标发给 Open-Meteo。
 *
 * 用 get_user_value 而不是 get_boolean：前者在用户从未改过时返回 null，
 * 后者会返回 schema 默认值，两者区分不开「显式关掉」和「从没设过」。
 *
 * 首选项里有一份同样的逻辑。两边都要有：用户可能从不打开首选项，
 * 那时只有扩展自己跑得到；也可能在扩展被禁用时打开首选项。
 * settings-version 保证只生效一次，重复执行无副作用。
 * ===================================================================== */
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

/* =====================================================================
 * 诊断日志
 * 扩展运行在 GNOME Shell 进程里，往系统日志刷屏会拖慢整个桌面会话，
 * 因此默认不输出任何日志。排查问题（凭据错误、接口返回异常等）时，
 * 在首选项里打开「输出调试日志」，再用
 *     journalctl -f -o cat /usr/bin/gnome-shell
 * 查看。失败信息同时也会显示在菜单里，日常使用不需要看日志。
 * ===================================================================== */
let _debug = false;

function setDebugLogging(enabled) {
    _debug = !!enabled;
}

function logError(...args) {
    if (_debug)
        console.error('[ClimaCN]', ...args);
}

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
 * 中国国标 AQI（HJ 633-2012）
 *
 * 和风直接返回空气质量指数；Open-Meteo 只给六项污染物浓度，指数要自己算。
 * 之所以自己算而不是用 Open-Meteo 的 us_aqi：同一时刻同一地点，美标实测 187
 * 而国标约 62，切换数据源时数字会从 62 跳到 187，看上去像坏了。
 *
 * 注意这是**计算值**：HJ 633 要求 PM2.5/PM10/SO2/NO2/CO 取 24 小时均值、
 * O3 取 8 小时滑动均值，而 Open-Meteo 的 current 只有约 15 分钟的瞬时值，
 * 因此这里取末尾若干小时的逐时数据自行平均。方向正确，但与官方发布口径
 * 仍可能有偏差，界面上不应声称等同官方数值。
 * ===================================================================== */

const AQI_LEVELS = [0, 50, 100, 150, 200, 300, 400, 500];

/* 各污染物与 AQI_LEVELS 对应的浓度阈值。单位：μg/m³（CO 为 mg/m³）。
 * O3 只到 300 档——国标未定义 8 小时滑动平均在 300 以上的分级。 */
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

/* 国标六档的等级名与推荐配色 */
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

/* 单项 IAQI：在分段表里找到浓度所在区间后线性内插 */
function iaqiFrom(concentration, table) {
    const c = Number(concentration);
    if (!Number.isFinite(c) || c < 0)
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
    return AQI_LEVELS[table.length - 1];   // 超出表顶，按该表上限处理
}

function meanOf(values) {
    const nums = (Array.isArray(values) ? values : [])
        .map(Number)
        .filter(Number.isFinite);
    if (nums.length === 0)
        return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/* Open-Meteo 空气质量响应 → 国标 AQI。
 * nowIso 由调用方传入，便于脱离 Shell 环境测试。 */
function chinaAqiFromHourly(nowIso, aq) {
    const hourly = aq?.hourly ?? {};
    const upto = lastHourlyIndex(hourly.time, nowIso);
    if (upto < 0)
        return null;

    // 取截止到现在的末尾 n 个样本——绝不能用未来数据算"当前"均值
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
        // Open-Meteo 的 CO 单位是 μg/m³，国标分段表用的是 mg/m³
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
        // 国标规定 AQI ≤ 50 不报首要污染物
        primary: aqi > 50 ? AQI_POLLUTANT_ZH[primaryKey] : '',
        color: aqiColor(aqi),
    };
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

/* 八个主导月相。waxing = 亮面在右（盈月）。
 *
 * lit 是被照亮的比例，按 (1-cos θ)/2 算，θ 是相位角：
 * 八个主相位相隔 45°，于是依次是 0、0.146、0.5、0.854、1，而不是
 * 想当然的 0、0.25、0.5、0.75、1 —— 后者画出来的蛾眉月会偏胖、
 * 盈凸月偏瘦。这里取每个区间的中点（θ = 45°/135°），
 * 因为和风返回的是当天的主导相位，落在以主相位为中心的 ±22.5° 里。 */
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

/* 月出月落。月落常常落在次日（界面按 00:03(+1) 理解），
 * 这时分钟数反而比月出小，补上一天再比较，弧线才不会左右颠倒。
 * 极地或当天不升不落时字段缺失，返回 null，整行隐藏。 */
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

    /* Open-Meteo 额外给出连续的照亮比例（moonLit），比八相名的步进更准，
     * 有就覆盖 lit；中文名与盈亏方向仍由八相名决定，两个源下文字一致。 */
    const lit = Number(astro?.moonLit);
    return {
        moonrise, moonset,
        phase: {
            name: base.name,
            waxing: base.waxing,
            lit: Number.isFinite(lit) ? lit : base.lit,
        },
    };
}

/* 当天全部天文事件（分钟数）。时间形如 "2026-09-15T06:12+08:00"，只取时刻。
 * 和风 v1 的 astro 同时给了三段曙暮光、月出月落和月相，全都在这一个每日
 * 预报响应里，所以把这些内容画出来不会增加任何请求。 */
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

/* 弧线的时间跨度。优先用天文晨光始→天文暮光终，这样三段曙暮光都能画进去；
 * 取不到时退回日出→日落，弧线本身照常显示，只是少了暮光段。 */
function sunArcSpan(astro) {
    const { astronomicalDawn: a, astronomicalDusk: b, sunrise, sunset } = astro;
    if (a !== null && b !== null && b > a)
        return { start: a, end: b, hasTwilight: true };
    return { start: sunrise, end: sunset, hasTwilight: false };
}

/* 太阳在弧上的位置：0 = 弧线起点，1 = 终点。
 * isDay 表示太阳是否在地平线以上，用来决定圆点是否弱化。 */
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

/* 天空色阶在某时刻的取色：在相邻两个节点之间线性插值。
 * 节点形如「航海晨光始 → 航海暮光色」，缺字段的节点先过滤掉，
 * 这样兜底数据源只有日出日落时也能正常工作。 */
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

/* 月亮在月出→月落这条弧上的位置。
 * 月落可能跨过午夜，所以要把「现在」也放到同一条时间轴上比较：
 * 比月出早的时刻加一天，才不会把它误判成"已经落下"。 */
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

/* 逐日主导月相。取不到的填 null，绘制时跳过该格但保留位置。 */
function parseMoonPhases(days) {
    if (!Array.isArray(days))
        return [];
    return days.map(d => MOON_PHASES[d?.astro?.moonPhase] ?? null);
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

/* 蒲福风级的上限风速（m/s），用于把 Open-Meteo 的风速换算成风级。
 * 和风直接返回级数，Open-Meteo 只给风速，界面上的「N 级」靠这张表补。 */
const BEAUFORT_MAX_MS = [0.2, 1.5, 3.3, 5.4, 7.9, 10.7, 13.8, 17.1,
                         20.7, 24.4, 28.4, 32.6];

function beaufortFromMs(ms) {
    const v = Number(ms);
    if (!Number.isFinite(v) || v < 0)
        return null;
    for (let i = 0; i < BEAUFORT_MAX_MS.length; i++) {
        if (v <= BEAUFORT_MAX_MS[i])
            return i;
    }
    return 12;
}

/* 逐时数组里最后一个不晚于 nowIso 的下标。
 * 时间戳是 ISO 本地时间串（形如 2026-09-20T10:00），同格式下字符串比较
 * 等价于时间比较。用来从逐时数据里取"当前"那一格——露点、能见度、
 * 紫外线只在 hourly 里，current 块没有。 */
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
        // 这三项 current 里没有，只能从逐时数据按当前小时取
        'hourly=dew_point_2m,visibility,uv_index',
        'daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,' +
            'uv_index_max,moonrise,moonset,moon_phase',
        // 和风用 m/s，这里显式对齐，免得界面单位随数据源跳变
        'wind_speed_unit=ms',
        `forecast_days=${OPEN_METEO_FORECAST_DAYS}`,
        'timezone=auto',
    ].join('&');
    return `${OPEN_METEO_HOST}/v1/forecast?latitude=${formatCoord(lat)}&longitude=${formatCoord(lon)}&${query}`;
}

/* 国标 AQI 要按 24 小时均值算，只取 current 不够，所以把逐时数据
 * 也拉下来自行平均（past_days=1 提供算均值所需的历史小时）。 */
function getOpenMeteoAirQualityUrl(lat, lon) {
    const query = [
        'hourly=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone',
        'past_days=1',
        'forecast_days=1',
        'timezone=auto',
    ].join('&');
    return `${OPEN_METEO_AQI_HOST}/v1/air-quality?latitude=${formatCoord(lat)}&longitude=${formatCoord(lon)}&${query}`;
}

/* 把 Open-Meteo 的响应整理成和风 v1 的形状。
 * 这样 _updateUI 只认一种数据结构，不必在界面代码里到处判断来源；
 * 代价是多一层转换，但比在每个字段处分叉要清楚得多。 */
function openMeteoAsQweatherCurrent(json, nowIso) {
    const cur = json?.current ?? {};
    const hourly = json?.hourly ?? {};
    const hi = lastHourlyIndex(hourly.time, nowIso);
    const at = key => (hi >= 0 && Array.isArray(hourly[key]) ? hourly[key][hi] : null);
    const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
    const humidity = num(cur.relative_humidity_2m);
    const cloud = num(cur.cloud_cover);

    return {
        condition: {
            code: wmoToQweatherCode(cur.weather_code, cur.is_day !== 0),
            text: wmoToText(cur.weather_code),
        },
        temperature: { value: num(cur.temperature_2m) },
        feelsLike: { value: num(cur.apparent_temperature) },
        // Open-Meteo 的湿度与云量都是 0–100，转成和风的 0–1 以免下游重复换算
        humidity: humidity === null ? null : humidity / 100,
        cloudCover: cloud === null ? null : cloud / 100,
        wind: {
            direction: { compass: degreesToCompass(cur.wind_direction_10m) },
            // 和风直接给级数，这里由风速换算，否则界面恒显示「--级」
            scale: beaufortFromMs(cur.wind_speed_10m),
        },
        // 用海平面气压而不是站点气压：和风给的也是海平面气压，
        // 两者口径一致才能在切换数据源时读数不跳
        pressure: { value: num(cur.pressure_msl), unit: 'hPa' },
        visibility: { value: num(at('visibility')), unit: 'm' },
        dewPoint: { value: num(at('dew_point_2m')) },
        uvIndex: num(at('uv_index')),
        windGust: { value: num(cur.wind_gusts_10m), unit: 'm/s' },
        precipitation: { amount: { value: num(cur.precipitation), unit: 'mm' } },
    };
}

/* Open-Meteo 的 moon_phase 是 0–1 的相位进度：0 新月、0.25 上弦、
 * 0.5 满月、0.75 下弦。照亮比例按 (1-cos(2πp))/2 算——这比和风给的
 * 八相名精细得多，月相圆盘可以直接按这个比例画。
 * 中文名仍按八个主相位分档，保证两个数据源下界面文字一致。 */
const MOON_PHASE_CENTERS = [
    ['new-moon', 0.000], ['waxing-crescent', 0.125], ['first-quarter', 0.250],
    ['waxing-gibbous', 0.375], ['full-moon', 0.500], ['waning-gibbous', 0.625],
    ['last-quarter', 0.750], ['waning-crescent', 0.875],
];

function moonPhaseFromFraction(p) {
    const v = Number(p);
    if (!Number.isFinite(v))
        return null;
    const f = ((v % 1) + 1) % 1;
    let name = MOON_PHASE_CENTERS[0][0];
    let best = Infinity;
    for (const [candidate, center] of MOON_PHASE_CENTERS) {
        /* 相位是环形的：f=0.99 与新月只差 0.01，线性距离却会把它判成
         * 残月。取正向与回绕两条路径里近的那条。 */
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
    const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
    return times.map((date, i) => {
        const phase = moonPhaseFromFraction(d.moon_phase?.[i]);
        return {
            astro: {
                sunrise: d.sunrise?.[i],
                sunset: d.sunset?.[i],
                moonrise: d.moonrise?.[i],
                moonset: d.moonset?.[i],
                moonPhase: phase?.name ?? null,
                // 连续照亮比例，parseMoon 会用它覆盖八相名的离散值
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
        this._debugLoggingId = 0;
        this._sourceCurrentId = 0;
        this._sourceForecastId = 0;
        this._sourceAirQualityId = 0;
        this._sourceAstronomyId = 0;
        // 自绘图表的 repaint、刷新按钮的 activate 信号 ID，
        // 同样要在 disable() 里断开
        this._sunArcRepaintId = 0;
        this._moonArcRepaintId = 0;
        this._aqiRepaintId = 0;
        this._trendRepaintId = 0;
        this._trendMoonRepaintId = 0;
        this._refreshActivateId = 0;
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
        // 升级路径上的一次性迁移，放在读取任何设置之前
        migrateSourceSettings(this._settings);
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
        this._astro = null;
        this._moonPosition = null;
        this._trendPoints = [];
        this._moonPhases = [];
        // 本次数据实际来自哪些源，由 _applyPlan 按计划拼好供归因行显示
        this._attributionText = '';
        // 本轮是否已经报过错，避免通用文案盖掉具体原因
        this._errorShown = false;

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

        /* 数据源按类别切换会改变抓取计划，与改凭据同类，走同一个防抖：
         * 首选项里连点下拉不该打出一串半途状态的请求。 */
        const onSourceChanged = () => onConfigChanged();
        this._sourceCurrentId = this._settings.connect('changed::source-current', onSourceChanged);
        this._sourceForecastId = this._settings.connect('changed::source-forecast', onSourceChanged);
        this._sourceAirQualityId = this._settings.connect('changed::source-air-quality', onSourceChanged);
        this._sourceAstronomyId = this._settings.connect('changed::source-astronomy', onSourceChanged);

        // 调试日志默认关闭，开启状态跟随设置实时变化，无需重载扩展
        this._debugLoggingId = this._settings.connect('changed::debug-logging', () => {
            setDebugLogging(this._settings.get_boolean('debug-logging'));
        });
        setDebugLogging(this._settings.get_boolean('debug-logging'));

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
        // 设置对象即将释放，日志开关一并复位
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
            this._settings = null;
        }

        if (this._upower) {
            if (this._upowerSignalId) {
                this._upower.disconnect(this._upowerSignalId);
                this._upowerSignalId = 0;
            }
            this._upower = null;
        }

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
        this._astro = null;
        this._moonPosition = null;
        this._trendPoints = [];
        this._moonPhases = [];
        this._attributionText = '';
        this._errorShown = false;
        this._lastFetchAt = 0;
        this._onBattery = false;
        this._upowerSignalId = 0;
        this._stylesheetPath = null;
        this._theme = null;
        this._cancellable = null;
    }

    /* 释放 enable() 里创建的每一个 UI 对象。
     * 它们都是 indicator 的子节点，会随 indicator 一起销毁，但逐个显式释放
     * 更清楚，也让创建点与销毁点一一对应，便于检查是否漏掉了哪个。
     *
     * 顺序：先断信号再销毁对象 —— destroy() 之后对象的方法不再可用；
     * 而逐个 destroy() 时子节点会先脱离父节点，因此随后再销毁父容器
     * 不会重复销毁，重复调用 destroy() 本身也是安全的空操作。 */
    _destroyUI() {
        // 1. 断开 UI 对象上的信号
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

        // 2. 销毁对象并清空引用
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

        // 面板指示器上的图标与温度
        this._weatherIcon?.destroy();
        this._weatherIcon = null;
        this._tempLabel?.destroy();
        this._tempLabel = null;

        /* 详情区的值标签由 _createGridCell / _createExtraRow 创建，
         * 父容器随 indicator 一并销毁，这里只需清空引用 */
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
            /* 首帧的占位图标：不设的话第一次取到数据之前顶栏是空的，
             * 断网时看上去就像扩展坏了。中性云朵比空白友好。 */
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
        /* 菜单宽度由这个样式类控制（见 stylesheet.css 的 .climacn-menu）。
         * box 是 PopupMenuBase 的公开属性，直接加类比 set_style_class_name
         * 安全——后者会把 Shell 自带的 popup-menu-content 一起覆盖掉。 */
        this._indicator.menu.box.add_style_class_name('climacn-menu');
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
        this._buildMoonArc();
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
        this._sunArcItem.visible = false;   // 没有 astro 数据时整行隐藏
        this._indicator.menu.addMenuItem(this._sunArcItem);
    }

    /* 月亮弧线：月出月落时刻 + 弧上的月相圆盘 + 月相名称。
     * 和太阳弧线用的是同一个每日预报响应，不额外发请求。
     * 极地等取不到月出月落的情况下整行隐藏。 */
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
        this._trendRepaintId = this._trendArea.connect('repaint', () => this._drawTrendChart());

        /* 折线下面再放一排每日月相。数据和折线同源（同一个每日预报响应），
         * 但含义不同：折线看冷暖走势，月相看这十天里月亮怎么圆缺。 */
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

    /* 逐日月相条：每格一个圆盘 + 照亮百分比，横向排开看圆缺变化。
     * 格宽取自控件宽度，因此点和数据一一对应，缺数据的那格留白不占位。 */
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
            const cellW = width / phases.length;
            const r = Math.max(3, 6 * scaleFactor);
            const cy = r + 2 * scaleFactor;

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
                const cx = cellW * (i + 0.5);
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
        this._refreshActivateId = this._refreshItem.connect('activate', () => this._onManualRefresh());
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
        /* 这里刻意不设 hint_text。St.Entry 的提示只在 text 为空时隐藏，
         * 而输入法预编辑期间 text 仍然是空的——提示不会让位，拼音会和它
         * 叠在同一位置。所以把说明文字整行搬到输入框外面去，
         * 位置固定，无论输入法处于什么状态都不可能重叠。 */
        this._searchEntry = new St.Entry({
            /* 必须显式撑开：St.Entry 的宽度是由内容撑出来的，
             * 没有 hint_text、内容又为空时它会缩成一个小方块。 */
            x_expand: true,
            track_hover: true,
            can_focus: true,
            style_class: 'climacn-search-entry'
        });
        this._searchActivateId = this._searchEntry.clutter_text.connect('activate', () => this._onSearchActivate());
        this._searchTextChangedId = this._searchEntry.clutter_text.connect('text-changed', () => this._onSearchTextChanged());

        /* 搜索区这两行不是可点的菜单动作，加个类让 CSS 去掉菜单项的
         * 悬停/选中底色——否则整行会糊上一大块灰，把输入框衬得很难看。
         * PopupBaseMenuItem 会忽略构造参数里的 style_class，只能事后加。 */
        const entryItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        entryItem.add_style_class_name('climacn-search-row');
        entryItem.add_child(this._searchEntry);
        this._indicator.menu.addMenuItem(entryItem);

        // 独立的类：climacn-detail-label 有固定宽度，会把状态文字挤变形
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

    /* 输入框为空时，在下面一行给出用法示例。
     * 输入框自己不放提示文字（原因见 _buildSearchUI），这里就是它唯一的说明。 */
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
            // disable() 已执行：UI 引用已释放，不可再触碰
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
                    logError('城市库表头缺少必要列，已放弃解析');
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
        // 有结果时状态行让位给结果列表，整行隐藏
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

    /* 显隐控制整行而不是那个标签。之前只 hide 标签，空菜单项仍旧留在菜单里
     * 占着高度、还会响应悬停变出一条灰色横杠。 */
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
        /* 今日额度用尽就停自动刷新，但只有四类内容**全都**依赖和风时才停。
         * 之前这里无条件 return，导致「额度用尽 + 已把某类指给 Open-Meteo」
         * 时自动刷新也一并停摆——而那一类其实还能照常供数。 */
        if (this._requestBudgetExhausted() && !this._anyOpenMeteoSource()) {
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

    /* -----------------------------------------------------------------
     * 数据源选择
     * 四类内容各自独立选源。之所以分四类而不是一个总开关：两个源各有
     * 长短——和风提供天文/航海/民用三段曙暮光，Open-Meteo 免凭据、
     * 逐日预报多 6 天、月相是连续的照亮比例而非八相名。
     * ----------------------------------------------------------------- */

    _qweatherConfigured() {
        return !!(this._apiKey && this._apiKey.trim() && this._host);
    }

    _qweatherUsable() {
        return this._qweatherConfigured() && !this._requestBudgetExhausted();
    }

    /* 'auto' 在和风可用时用和风，否则退回 Open-Meteo。
     * 读设置失败也按 auto 处理，不让一个坏值把界面弄空。 */
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

    /* 四个类别 → 需要发哪些请求。同一源的多个类别共用一次请求：
     * Open-Meteo 的 /v1/forecast 一次就给出实时 + 逐日 + 天文。 */
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
        // Open-Meteo 是产品名，不翻译
        if (plan.omForecast || plan.omAqi)
            names.push('Open-Meteo');
        return names.join(' + ');
    }

    /* 是否有任何一类内容会走 Open-Meteo。额度用尽时用它决定要不要停自动刷新。 */
    _anyOpenMeteoSource() {
        const plan = this._buildFetchPlan();
        return plan.omForecast || plan.omAqi;
    }

    /* 共用的请求收尾：四个 fetch 函数的守卫与错误处理完全一样，
     * 抽出来避免四份拷贝各自漂移。onText 返回解析后的 JSON，失败返回 null。 */
    _sendJson(message, seq, label, onText) {
        this._session.send_and_read_async(
            message,
            Soup.MessagePriority.NORMAL,
            this._cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    // disable() 之后 UI 引用均已释放，不可再触碰
                    if (!this._enabled || this._cancellable?.is_cancelled())
                        return;
                    // 已有更新的请求发出，本次结果作废
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

    /* Open-Meteo 不需要凭据，也不消耗和风额度，因此不计入每日请求数。
     * 一次请求同时拿到实时、逐日与天文三块，回调里一并交出去。 */
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

    /* 空气质量单独一个端点。拉逐时数据是为了按国标算 24 小时均值。 */
    _fetchOpenMeteoAirQuality(seq, callback) {
        const message = Soup.Message.new('GET',
            getOpenMeteoAirQualityUrl(this._latitude, this._longitude));
        if (!message) {
            callback(null);
            return;
        }
        const nowIso = GLib.DateTime.new_now_local().format('%Y-%m-%dT%H:00');
        this._sendJson(message, seq, 'Open-Meteo AQI', json => {
            // 空气质量取不到不算致命：色环整块隐藏，其它数据照常显示
            callback(json ? chinaAqiFromHourly(nowIso, json) : null);
        });
    }

    _fetchWeather() {
        if (!this._enabled)
            return;

        const plan = this._buildFetchPlan();

        /* 用户显式把某一类指给和风、凭据却不全时，给出配置提示。
         * auto 走不到这里——凭据不全时它已经退回 Open-Meteo 了。 */
        if ((plan.qwCurrent || plan.qwDaily || plan.qwAqi) && !this._qweatherConfigured()) {
            this._showError(this._apiKey?.trim()
                ? _('请在设置中配置 API Host')
                : _('请在设置中配置 API Key'), 'config');
            return;
        }

        // _enabled 为真即保证 enable() 已跑完，_cancellable 必定存在
        if (this._cancellable.is_cancelled())
            this._cancellable = new Gio.Cancellable();

        this._lastFetchAt = GLib.get_monotonic_time() / 1e6;
        this._errorShown = false;   // 每轮重置，用来避免通用错误盖掉具体原因

        // 请求序号：快速连续切换城市时，先发的请求可能后返回，
        // 若不丢弃过期响应，会出现"标题是新城市、数据是旧城市"的错配
        const seq = ++this._requestSeq;

        // 这一轮要等哪些结果到齐。没被计划到的请求根本不发、也不等。
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

        /* 各路并行发出。原来是「实时先探路，成功了再发另外两个」的两段式；
         * 现在四类内容各自独立选源、彼此没有依赖，串行只会白白拉长等待。 */
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

    /* 把各路结果按计划合并成 _updateUI 认的三个对象。
     * 逐日与天文可能来自不同源，所以要用天文源的 astro 覆盖逐日数组里的
     * astro 块——parseAstro 只看第 0 天，parseMoonPhases 每天都要读。 */
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
            // 逐日预报失败但天文献成功：保住日月弧线，温度行自然显示 --
            forecast = astroDays.map(d => ({ astro: d.astro }));
        }

        const aqi = plan.src.airQuality === 'qweather'
            ? (pending.qwAqi ?? null)
            : (pending.omAqi ?? null);

        if (!now) {
            // 具体原因各路已经报过，这里不再用通用文案盖掉
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
                    // disable() 后不再回调，否则调用方会去更新已释放的 UI
                    if (!this._enabled) return;
                    // 期间已切换到别的城市，本次预报作废
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
                    // v1 的数组字段名是 days，不再是 daily
                    callback(Array.isArray(json.days) ? json.days : null);
                } catch (e) {
                    if (!this._enabled) return;
                    logError(`Forecast parse error: ${e}`);
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
            logError(`Failed to create icon from ${filePath}: ${e}`);
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

    /* 弧线上某时刻的位置比例 → 圆心角。cairo 以 y 轴向下为正，
     * Math.PI→2*Math.PI 即上半圆，从左端走到右端。 */
    _arcTheta(ratio) {
        return Math.PI + Math.min(Math.max(ratio, 0), 1) * Math.PI;
    }

    /* 取主题前景色。绘制的图形跟着主题文字色走，
     * 深色与浅色主题都不需要另写一套配色。 */
    _themeColor(area) {
        const [hasFg, fg] = area.get_theme_node().lookup_color('color', false);
        return hasFg ? [fg.red / 255, fg.green / 255, fg.blue / 255] : [0.5, 0.5, 0.5];
    }

    /* 日出日落弧线。上半圆代表从天文晨光始到天文暮光终的一整天，
     * 弧体按三段曙暮光着色：夜 → 天文 → 航海 → 民用 → 白天。
     * 日出日落处打刻度（弧线现在跨得比昼长更宽，这两个时刻要看得出来），
     * 太阳圆点标出当前时刻，落到地平线以下时弱化。 */
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
            /* 用椭圆而不是正圆。正圆的半径被 min(宽/2, 高) 卡死，菜单加宽后
             * 它只会缩在中间一小块，两侧留一大片空白。让横轴铺满可用宽度、
             * 纵轴取高度预算，弧线就随菜单宽度自然变宽，也更接近天气应用里
             * 那条横向时间轴的形状。 */
            const rx = (width - 2 * pad) / 2;
            const ry = height - 2 * pad;
            if (rx <= 0 || ry <= 0)
                return;
            const cx = width / 2;
            const cy = height - pad;   // 圆心落在底边，画出来就是上半弧
            const rxAt = ratio => cx + rx * Math.cos(this._arcTheta(ratio));
            const ryAt = ratio => cy + ry * Math.sin(this._arcTheta(ratio));

            // 上半椭圆路径。在缩放后的坐标系里画单位圆，路径落进设备空间后
            // 再 restore，这样描边宽度不会被横纵比拉变形。
            const ellipsePath = () => {
                cr.save();
                cr.translate(cx, cy);
                cr.scale(rx, ry);
                cr.arc(0, 0, 1, Math.PI, 2 * Math.PI);
                cr.restore();
            };

            cr.setLineWidth(lineWidth);
            cr.setLineCap(Cairo.LineCap.ROUND);

            // 底层轨道：没有曙暮光数据时它就是最终形态
            cr.setSourceRGBA(0.5, 0.5, 0.5, 0.25);
            ellipsePath();
            cr.stroke();

            const span = sunArcSpan(astro);
            const total = span.end - span.start;
            if (total <= 0)
                return;
            const ratioAt = m => Math.min(Math.max((m - span.start) / total, 0), 1);

            /* 按角度分段上色，而不是用横向的线性渐变。
             * 弧是半圆，黎明黄昏那两段几乎是竖直的：一天里 10% 的时间只对应
             * x 方向 2% 的宽度，渐变会把整段曙暮光压成两三个像素，色标位置
             * 算得再准也看不出来。角度才与时间线性对应，所以逐段取色。 */
            if (span.hasTwilight) {
                const SEGMENTS = 96;
                let prev = null;
                for (let i = 0; i <= SEGMENTS; i++) {
                    const ratio = i / SEGMENTS;
                    const px = rxAt(ratio);
                    const py = ryAt(ratio);
                    if (prev) {
                        // 用该段中点时刻取色，段与段之间自然过渡
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
                // 兜底数据源只有日出日落，画一条纯色弧
                cr.setSourceRGBA(SKY_DAY[0], SKY_DAY[1], SKY_DAY[2], 0.9);
                ellipsePath();
                cr.stroke();
            }

            /* 日出、日落刻度。沿"圆心→弧上点"的方向朝内外各探出一截。
             * 对椭圆来说这个方向只在长短轴端点处才是真正的法线，中间会略偏，
             * 但刻度很短，看上去仍然垂直于弧线。 */
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

    /* 月相圆盘。先铺一层低透明度的整圆当暗面，再把被照亮的部分填实。
     * 亮区由「外侧半圆 + 内侧终止线半椭圆」围成：终止线在凸月时向暗面
     * 鼓出、在蛾眉月时向亮面凹进，半宽为 |1-2k|·r（k 是照亮比例）。
     * 亏月整体水平镜像一下即可，不必再推一套反向公式。 */
    _drawMoonDisc(cr, cx, cy, r, phase, fg, alpha = 1) {
        if (!(r > 0))
            return;
        const lit = Math.min(Math.max(phase?.lit ?? 0, 0), 1);

        cr.setSourceRGBA(fg[0], fg[1], fg[2], MOON_DARK_ALPHA * alpha);
        cr.arc(cx, cy, r, 0, 2 * Math.PI);
        cr.fill();

        if (lit > 0.001) {
            cr.save();
            if (!(phase?.waxing ?? true)) {   // 亏月：镜像后与盈月共用同一套路径
                cr.translate(cx, cy);
                cr.scale(-1, 1);
                cr.translate(-cx, -cy);
            }
            // 凸月/满月时半宽趋近 r，蛾眉/新月时趋近 0；
            // 完全取 0 会让路径退化，留一个极小值
            const a = Math.max(Math.abs(1 - 2 * lit), 0.001);
            cr.newSubPath();
            cr.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2);   // 外侧：右半圆
            cr.save();
            cr.translate(cx, cy);
            cr.scale(a, 1);
            if (lit > 0.5)
                cr.arc(0, 0, r, Math.PI / 2, 3 * Math.PI / 2);       // 凸月：向左鼓
            else
                cr.arcNegative(0, 0, r, Math.PI / 2, -Math.PI / 2);  // 蛾眉：向右凹
            cr.restore();
            cr.closePath();
            cr.setSourceRGBA(fg[0], fg[1], fg[2], MOON_LIT_ALPHA * alpha);
            cr.fill();
            cr.restore();
        }

        // 描边：满月与新月光靠填充分不出边界
        cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.45 * alpha);
        cr.setLineWidth(Math.max(0.8, r * 0.14));
        cr.arc(cx, cy, r, 0, 2 * Math.PI);
        cr.stroke();
    }

    /* 月亮弧线：月出 → 月落，弧上放一个随当前月相变化的圆盘。
     * 结构与太阳弧线相同，只是把「白天」换成「月亮在地平线上」。 */
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
            // 与太阳弧线同样用椭圆铺满宽度；圆盘骑在弧上，纵轴要留出它的高度
            const rx = (width - 2 * pad) / 2;
            const ry = height - pad - discR - pad;
            if (rx <= 0 || ry <= 0)
                return;
            const cx = width / 2;
            const cy = height - pad;
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
                // 拿不到当前时刻（例如刚启用还没算），把月相画在弧顶
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

    /* 10 天趋势折线：最高温与最低温两条线，每个点带圆点和温度数字。
     * 最高温的数字画在点的上方，最低温画在下方，两者不会互相压住。
     * 上下各预留一行文字的高度，纵向绘图区据此收缩。 */
    /* 圆角横条路径。左右两端各一个半圆，中间由 closePath 连成一条。
     * 半径收缩到不超过高度的一半，条太矮时不会画成畸形。 */
    _roundedBarPath(cr, x, y, w, h) {
        const r = Math.min(h / 2, w / 2);
        if (r <= 0)
            return;
        cr.newSubPath();
        cr.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5);        // 左端
        cr.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);     // 右端
        cr.closePath();
    }

    /* 预报行的温度条：把当天的最低~最高温放进未来 10 天的整体温区里，
     * 位置和长度表示冷暖。纯文字看不出"哪天更冷"，横向一比就清楚了。
     * 渐变的定义域是整条轨道（0 → width），所以颜色只取决于温度本身，
     * 不同行之间可以直接比色，而不是各自从蓝渐变到橙。 */
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

            // 轨道用主题前景色的低透明度，浅色与深色主题都不需要额外适配
            const [hasFg, fg] = area.get_theme_node().lookup_color('color', false);
            const track = hasFg
                ? [fg.red / 255, fg.green / 255, fg.blue / 255]
                : [0.5, 0.5, 0.5];
            cr.setSourceRGBA(track[0], track[1], track[2], 0.18);
            this._roundedBarPath(cr, 0, y, width, barH);
            cr.fill();

            const x0 = width * Math.min(Math.max(min - lo, 0), span) / span;
            const x1 = width * Math.min(Math.max(max - lo, 0), span) / span;
            // 温区极窄（昼夜温差 < 1°）时给个最小可见长度，否则看不见
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

    /* 温度条随预报数据重建，因此不存字段引用：行被 remove_all_children()
     * 销毁时，绘图区与其 repaint 信号一并消失。 */
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

            const HIGH = [...COLOR_HIGH, 0.95];
            const LOW = [...COLOR_LOW, 0.95];

            /* 面积填充必须画在折线之前，否则会盖住线。
             * 分两层：高温线与低温线之间是昼夜温区；低温线以下再做一层
             * 向下淡出的底色，两条线才不会显得悬空。 */
            cr.newSubPath();
            cr.moveTo(xAt(0), yAt(highs[0]));
            for (let i = 1; i < highs.length; i++)
                cr.lineTo(xAt(i), yAt(highs[i]));
            for (let i = lows.length - 1; i >= 0; i--)
                cr.lineTo(xAt(i), yAt(lows[i]));
            cr.closePath();
            // 纵向就是温度轴，同样用色阶；上暖下冷，位置要反过来
            const bandGrad = new Cairo.LinearGradient(0, plotTop, 0, plotBottom);
            for (const [off, r, g, b] of TEMP_RAMP)
                bandGrad.addColorStopRGBA(1 - off, r, g, b, 0.30);
            cr.setSource(bandGrad);
            cr.fill();

            cr.newSubPath();
            cr.moveTo(xAt(0), yAt(lows[0]));
            for (let i = 1; i < lows.length; i++)
                cr.lineTo(xAt(i), yAt(lows[i]));
            cr.lineTo(xAt(lows.length - 1), plotBottom);
            cr.lineTo(xAt(0), plotBottom);
            cr.closePath();
            const groundGrad = new Cairo.LinearGradient(0, plotTop, 0, plotBottom);
            groundGrad.addColorStopRGBA(0, COLOR_LOW[0], COLOR_LOW[1], COLOR_LOW[2], 0.18);
            groundGrad.addColorStopRGBA(1, COLOR_LOW[0], COLOR_LOW[1], COLOR_LOW[2], 0.0);
            cr.setSource(groundGrad);
            cr.fill();

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
            // 四类内容可能来自不同源，文案由 _applyPlan 按实际计划拼好
            this._attributionLabel.text = this._attributionText || '';
            this._attributionItem.visible = true;
        }

        // 跨天后额度恢复，提示需要跟着消失
        this._updateNotice();

        // ---- 未来3天预报 ----
        if (this._forecastRowsBox) {
            this._forecastRowsBox.remove_all_children();
        }

        // ---- 天空：太阳弧线 + 月亮弧线 ----
        // 两组数据都来自同一个每日预报响应的 astro，不额外发请求
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
                // 月落跨过午夜时补了 24 小时，显示要取回当天的时刻
                this._moonsetLabel.text = formatClock(moon.moonset % (24 * 60));
                this._moonPhaseLabel.text = moon.phase?.name ?? '';
                this._moonArcArea.queue_repaint();
            }
        }

        // ---- 10 天趋势折线 + 逐日月相（收在子菜单里）----
        this._trendPoints = parseTrendPoints(forecast);
        this._moonPhases = parseMoonPhases(forecast);
        const showTrend = this._trendPoints.length >= 2;
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

            /* 温度条的归一化区间取整个 10 天，而不是逐日各画各的——
             * 用同一个基准，行与行之间才能横向比较冷暖。 */
            const lowsAll = forecast.map(d => Number(d.temperatureMin?.value))
                                    .filter(Number.isFinite);
            const highsAll = forecast.map(d => Number(d.temperatureMax?.value))
                                     .filter(Number.isFinite);
            const barLo = lowsAll.length ? Math.min(...lowsAll) : 0;
            const barHi = highsAll.length ? Math.max(...highsAll) : 1;
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

                /* 温度条：位置与长度表示当天温区在未来 10 天里的相对冷暖。
                 * 数据缺失时放一个弹性空白，保证各行的状况文字仍然对齐。 */
                const dayMin = Number(day.temperatureMin?.value);
                const dayMax = Number(day.temperatureMax?.value);
                if (Number.isFinite(dayMin) && Number.isFinite(dayMax)) {
                    row.add_child(this._createTempBar(
                        { min: dayMin, max: dayMax, lo: barLo, hi: barHi }));
                } else {
                    // 占位宽度与温度条一致，缺数据的那行不会让状况文字错位
                    row.add_child(new St.Widget({ width: TEMP_BAR_WIDTH }));
                }

                /* 天气状况占掉行尾的剩余宽度。
                 * 让这一列弹性伸缩、而温度条保持固定宽度，是因为条长代表温差：
                 * 若改成条去抢占剩余空间，各行的状况文字长短不同，条长就会
                 * 参差不齐，那个编码就废了。 */
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
    }

    /* 顶栏出错时显示哪个图标。以前一律用通用错误框，用户看不出该去
     * 检查网络、还是去改配置。分开之后一眼能定位到方向。
     * 这些名字都在 Adwaita 里存在，且是 symbolic 单色，跟随主题着色。 */
    _errorIconName(kind) {
        switch (kind) {
        case 'network': return 'network-error-symbolic';
        case 'auth':    return 'dialog-password-symbolic';
        case 'config':  return 'preferences-system-symbolic';
        case 'data':    return 'dialog-warning-symbolic';
        default:        return 'weather-severe-alert-symbolic';
        }
    }

    /* kind 见 _errorIconName：network / auth / config / data，缺省为通用 */
    _showError(message = _('获取失败'), kind = 'error') {
        /* 记下这一轮已经报过错。各路请求并行返回，晚到的通用错误
         * 不该把先前那条更具体的原因（如 401 凭据无效）盖掉。 */
        this._errorShown = true;
        const iconName = this._errorIconName(kind);
        this._applyIcon(this._weatherIcon, null, iconName);
        this._applyIcon(this._headerIcon, null, iconName);
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

        // 天文弧线、月相与趋势同样基于失效的数据，一并隐藏
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
    }
}

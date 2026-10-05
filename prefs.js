
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SOURCE_VALUES = ['auto', 'qweather', 'openmeteo'];
const SOURCE_LABELS = ['自动', '和风天气', 'Open-Meteo'];

const SOURCE_ROWS = [
    {
        key: 'source-current',
        title: '实时天气',
        subtitle: '自动：填了和风凭据就用和风，否则用 Open-Meteo（会把城市经纬度发给它）。',
    },
    {
        key: 'source-forecast',
        title: '逐日预报',
        subtitle: '和风提供 10 天，Open-Meteo 提供 16 天。',
    },
    {
        key: 'source-air-quality',
        title: '空气质量',
        subtitle: '和风直接返回指数；Open-Meteo 只给六项污染物浓度，由扩展按中国国标（HJ 633）' +
            '自行计算，因此是计算值，与官方发布口径可能有偏差。',
    },
    {
        key: 'source-astronomy',
        title: '天文（日出日落 · 月相 · 曙暮光）',
        subtitle: '两者差异最大：和风有天文/航海/民用三段曙暮光；Open-Meteo 没有曙暮光，' +
            '但月相是连续的照亮比例而非八相名称，圆盘画得更准。',
    },
];

const SETTINGS_VERSION = 1;

function migrateSettings(settings) {
    if (settings.get_int('settings-version') >= SETTINGS_VERSION)
        return;

    const legacy = settings.get_user_value('use-open-meteo-fallback');
    const target = legacy && legacy.get_boolean() ? 'auto' : 'qweather';
    for (const { key } of SOURCE_ROWS)
        settings.set_string(key, target);

    settings.set_int('settings-version', SETTINGS_VERSION);
}

function addSourceRow(settings, group, { key, title, subtitle }) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(SOURCE_LABELS),
    });
    const current = SOURCE_VALUES.indexOf(settings.get_string(key));
    row.selected = current >= 0 ? current : 0;
    row.connect('notify::selected', (widget) => {
        const value = SOURCE_VALUES[widget.selected];
        if (value && settings.get_string(key) !== value)
            settings.set_string(key, value);
    });
    group.add(row);
}

export default class ClimaCNPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        migrateSettings(settings);

        const page = new Adw.PreferencesPage({
            title: 'ClimaCN 设置',
            icon_name: 'weather-clear-symbolic',
        });
        window.add(page);

        const apiGroup = new Adw.PreferencesGroup({
            title: 'API 设置',
            description: '两项均可在和风天气控制台获取。公共 API 地址（devapi.qweather.com 等）自 2026 年起停止服务，请务必填写你自己的 API Host。',
        });
        page.add(apiGroup);

        const apiKeyRow = new Adw.EntryRow({
            title: 'API Key',
            text: settings.get_string('api-key') || '',
        });
        apiKeyRow.connect('changed', (widget) => {
            settings.set_string('api-key', widget.text);
        });
        apiGroup.add(apiKeyRow);

        const apiHostRow = new Adw.EntryRow({
            title: 'API Host',
            text: settings.get_string('api-base-url') || '',
        });
        apiHostRow.connect('changed', (widget) => {
            settings.set_string('api-base-url', widget.text);
        });
        apiGroup.add(apiHostRow);

        const sourcePickGroup = new Adw.PreferencesGroup({
            title: '数据源',
            description: '四类内容可以分别选择来源。选「自动」时，填了和风凭据就用和风，' +
                '否则改用 Open-Meteo。Open-Meteo 是第三方免费服务，无需注册，' +
                '用它时扩展会把所选城市的经纬度发送过去。',
        });
        page.add(sourcePickGroup);

        for (const spec of SOURCE_ROWS)
            addSourceRow(settings, sourcePickGroup, spec);

        const displayGroup = new Adw.PreferencesGroup({ title: '显示' });
        page.add(displayGroup);

        const calendarRow = new Adw.SwitchRow({
            title: '在日历菜单里显示天气',
            subtitle: '点顶栏时钟弹出的面板右侧，会多出一张与「事件」「世界时钟」并列的' +
                '天气卡片。与顶栏图标互不影响，两处用的是同一份数据，不会增加请求次数。' +
                '该卡片依赖 GNOME Shell 的内部结构，若某个版本不再兼容，卡片会自行隐藏，' +
                '扩展其余部分不受影响。',
        });
        settings.bind('show-in-calendar', calendarRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(calendarRow);

        const alertRow = new Adw.SwitchRow({
            title: '显示天气预警',
            subtitle: '菜单里显示当前城市的天气预警（如「雷电黄色预警」），没有预警时不占位置。' +
                '数据来自中国气象局官网的内部接口，仅在中国大陆可用，且没有稳定性承诺，' +
                '取不到时静默隐藏。开启后扩展会把解析出的站点编号发给该接口。',
        });
        settings.bind('show-alerts', alertRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(alertRow);

        const debugGroup = new Adw.PreferencesGroup({
            title: '排查问题',
            description: '获取数据失败时菜单里会给出提示。若要知道更具体的原因，' +
                '可打开下面的开关，再用 journalctl -f -o cat /usr/bin/gnome-shell 查看输出。',
        });
        page.add(debugGroup);

        const debugRow = new Adw.SwitchRow({
            title: '输出调试日志',
            subtitle: '默认关闭。扩展运行在 GNOME Shell 进程内，持续输出日志会拖慢整个桌面会话，' +
                '只在排查问题时临时打开。',
        });
        settings.bind('debug-logging', debugRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        debugGroup.add(debugRow);

        const infoGroup = new Adw.PreferencesGroup({
            title: '说明',
            description: 'API Host 形如 abcxyz.qweatherapi.com，无需填写 https://。城市搜索使用本地数据库（data/China-City-List-latest.csv），图标使用本地 SVG。',
        });
        page.add(infoGroup);

        const sourceGroup = new Adw.PreferencesGroup({
            title: '数据来源',
            description: '和风天气（QWeather）\n' +
                '归因说明：https://developer.qweather.com/attribution.html\n' +
                'Open-Meteo（https://open-meteo.com/）：免 Key 的第三方服务，' +
                '其预报数据来自各国气象机构的开放数据\n' +
                '空气质量选 Open-Meteo 时，指数由扩展按中国国标 HJ 633 从六项污染物浓度计算得出，' +
                '非官方发布值\n' +
                '天气图标来源于和风天气图标库（https://icons.qweather.com/），采用 CC BY 4.0 许可',
        });
        page.add(sourceGroup);
    }
}

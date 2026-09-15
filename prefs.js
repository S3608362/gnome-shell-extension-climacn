// prefs.js
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClimaCNPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'ClimaCN 设置',
            icon_name: 'weather-clear-symbolic',
        });
        window.add(page);

        // --- API 设置分组 ---
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

        // --- 备用数据源分组 ---
        const fallbackGroup = new Adw.PreferencesGroup({
            title: '备用数据源',
            description: '和风天气不可用时（未填凭据，或当日请求额度用尽），可自动改用 Open-Meteo 获取数据，避免界面空白。',
        });
        page.add(fallbackGroup);

        const fallbackRow = new Adw.SwitchRow({
            title: '启用 Open-Meteo 兜底',
            subtitle: 'Open-Meteo 是第三方免费服务，无需注册。开启后扩展会把所选城市的经纬度发送给它。',
        });
        settings.bind('use-open-meteo-fallback', fallbackRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        fallbackGroup.add(fallbackRow);

        // --- 排查问题分组 ---
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

        // --- 说明分组 ---
        const infoGroup = new Adw.PreferencesGroup({
            title: '说明',
            description: 'API Host 形如 abcxyz.qweatherapi.com，无需填写 https://。城市搜索使用本地数据库（data/China-City-List-latest.csv），图标使用本地 SVG。',
        });
        page.add(infoGroup);

        // --- 数据来源分组 ---
        // 和风天气条款要求数据归因与数据共同显示：菜单里保留一行“和风天气”，
        // 完整的说明与链接集中放在这里
        const sourceGroup = new Adw.PreferencesGroup({
            title: '数据来源',
            description: '天气数据默认由和风天气（QWeather）提供\n' +
                '归因说明：https://developer.qweather.com/attribution.html\n' +
                '启用备用数据源时，数据改由 Open-Meteo（https://open-meteo.com/）提供\n' +
                '天气图标来源于和风天气图标库（https://icons.qweather.com/），采用 CC BY 4.0 许可',
        });
        page.add(sourceGroup);
    }
}
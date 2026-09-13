// prefs.js
import Adw from 'gi://Adw';

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
            description: '配置和风天气 API（Key 与 Base URL 可在和风天气控制台获取）',
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

        const apiUrlRow = new Adw.EntryRow({
            title: 'API Base URL',
            text: settings.get_string('api-base-url') || '',
        });
        apiUrlRow.connect('changed', (widget) => {
            settings.set_string('api-base-url', widget.text);
        });
        apiGroup.add(apiUrlRow);

        // --- 说明分组 ---
        const infoGroup = new Adw.PreferencesGroup({
            title: '说明',
            description: '城市搜索使用本地数据库（data/China-City-List-latest.csv），图标使用本地 SVG，无需额外配置。',
        });
        page.add(infoGroup);
    }
}
// prefs.js
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClimaCNPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // 获取 GSettings 对象
        const settings = this.getSettings();

        // 创建一个新的设置页面
        const page = new Adw.PreferencesPage({
            title: 'ClimaCN 设置',
            icon_name: 'weather-clear-symbolic',
        });
        window.add(page);

        // --- API 设置分组 ---
        const apiGroup = new Adw.PreferencesGroup({
            title: 'API 设置',
            description: '配置和风天气 API',
        });
        page.add(apiGroup);

        // API Key 输入行
        const apiKeyRow = new Adw.EntryRow({
            title: 'API Key',
            text: settings.get_string('api-key') || '',
        });
        apiKeyRow.connect('changed', (widget) => {
            settings.set_string('api-key', widget.text);
        });
        apiGroup.add(apiKeyRow);

        // API Base URL 输入行
        const apiUrlRow = new Adw.EntryRow({
            title: 'API Base URL',
            text: settings.get_string('api-base-url') || '',
        });
        apiUrlRow.connect('changed', (widget) => {
            settings.set_string('api-base-url', widget.text);
        });
        apiGroup.add(apiUrlRow);
    }
}
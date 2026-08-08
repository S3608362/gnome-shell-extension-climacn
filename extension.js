/* extension.js - ClimaCN GNOME Shell Extension (local CSV city search) */

import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

/* =====================================================================
 * 默认配置（这些将被 GSettings 覆盖，仅作后备）
 * ===================================================================== */
const DEFAULT_LOCATION_ID = '101010100';                      // 默认城市 Location ID
const DEFAULT_CITY_NAME = '北京，北京市';                      // 默认城市显示名称
const UPDATE_INTERVAL_SEC = 15 * 60;                          // 自动刷新间隔（秒）

/* =====================================================================
 * 和风天气 API 基础 URL（用于构建请求，URL 从 GSettings 读取）
 * ===================================================================== */
function getWeatherUrl(baseUrl, locationId) {
    return `${baseUrl}/v7/weather/now?location=${locationId}`;
}

export default class ClimaCNExtension extends Extension {
    enable() {
        this._indicator = null;
        this._timeoutId = 0;
        this._searchTimeoutId = 0;
        this._session = new Soup.Session();
        this._cancellable = new Gio.Cancellable();

        // 本地城市数据缓存
        this._cityData = null;
        this._isLoadingCities = false;

        // ---- 读取 GSettings 配置 ----
        this._settings = this.getSettings();
        this._apiKey = this._settings.get_string('api-key') || '';
        this._baseUrl = this._settings.get_string('api-base-url') || 'https://devapi.qweather.com';

        // 监听设置变化
        this._apiKeyChangedId = this._settings.connect('changed::api-key', () => {
            this._apiKey = this._settings.get_string('api-key') || '';
            log('[ClimaCN] API Key updated');
            // 可选：自动刷新天气
            // this._fetchWeather();
        });
        this._baseUrlChangedId = this._settings.connect('changed::api-base-url', () => {
            this._baseUrl = this._settings.get_string('api-base-url') || 'https://devapi.qweather.com';
            log('[ClimaCN] API Base URL updated');
            // 可选：自动刷新天气
            // this._fetchWeather();
        });

        // 加载持久化设置（城市）
        this._settingsFile = Gio.File.new_for_path(this.path + '/settings.json');
        this._currentLocationId = DEFAULT_LOCATION_ID;
        this._currentCityName = DEFAULT_CITY_NAME;
        this._loadSettings();

        // 加载样式表
        this._stylesheetPath = this.path + '/stylesheet.css';
        this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        this._theme.load_stylesheet(Gio.File.new_for_path(this._stylesheetPath));

        // 创建面板指示器
        this._createIndicator();

        // 立即获取天气
        this._fetchWeather();

        // 启动定时轮询
        this._startAutoRefresh();
    }

    disable() {
        // 清理定时器
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._searchTimeoutId) {
            GLib.Source.remove(this._searchTimeoutId);
            this._searchTimeoutId = 0;
        }

        // 取消进行中的请求
        if (this._cancellable && !this._cancellable.is_cancelled())
            this._cancellable.cancel();

        // 关闭会话
        if (this._session) {
            this._session.abort();
            this._session = null;
        }

        // 移除样式
        if (this._stylesheetPath) {
            const file = Gio.File.new_for_path(this._stylesheetPath);
            try { this._theme.unload_stylesheet(file); } catch (e) { log(e); }
        }

        // 销毁面板
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        // 清理 GSettings 连接
        if (this._settings) {
            if (this._apiKeyChangedId) {
                this._settings.disconnect(this._apiKeyChangedId);
                this._apiKeyChangedId = 0;
            }
            if (this._baseUrlChangedId) {
                this._settings.disconnect(this._baseUrlChangedId);
                this._baseUrlChangedId = 0;
            }
            this._settings = null;
        }

        this._cancellable = null;
        this._cityData = null;
    }

    /* ---- 持久化设置读写（城市信息） ---- */
    _loadSettings() {
        try {
            if (this._settingsFile.query_exists(null)) {
                const [success, contents] = this._settingsFile.load_contents(null);
                if (success) {
                    const data = JSON.parse(new TextDecoder().decode(contents));
                    if (data.locationId) this._currentLocationId = data.locationId;
                    if (data.cityName) this._currentCityName = data.cityName;
                }
            }
        } catch (e) { log(`[ClimaCN] _loadSettings: ${e}`); }
    }

    _saveSettings() {
        try {
            const data = JSON.stringify({
                locationId: this._currentLocationId,
                cityName: this._currentCityName
            });
            this._settingsFile.replace_contents(
                new TextEncoder().encode(data),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (e) { log(`[ClimaCN] _saveSettings: ${e}`); }
    }

    /* ---- 面板指示器 ---- */
    _createIndicator() {
        this._indicator = new PanelMenu.Button(0.0, 'ClimaCN', false);

        const box = new St.BoxLayout({ style_class: 'climacn-indicator-box' });

        // 图标：通过 -symbolic 命名自动主题化
        this._weatherIcon = new St.Icon({
            style_class: 'system-status-icon climacn-panel-icon',
            icon_size: 18
        });
        box.add_child(this._weatherIcon);

        this._tempLabel = new St.Label({
            style_class: 'climacn-temperature',
            text: '--°'
        });
        box.add_child(this._tempLabel);

        this._indicator.add_child(box);
        this._buildMenu();
        Main.panel.addToStatusArea('climacn', this._indicator);
    }

    /* ---- 下拉菜单 ---- */
    _buildMenu() {
        this._indicator.menu.removeAll();

        // 当前城市名（颜色继承系统菜单主题）
        this._cityLabel = new St.Label({
            text: this._currentCityName,
            x_align: Clutter.ActorAlign.CENTER
        });
        const cityItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        cityItem.add_child(this._cityLabel);
        this._indicator.menu.addMenuItem(cityItem);

        // 搜索区域（包含输入框、状态标签、结果容器）
        this._buildSearchUI();

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // 天气详情（所有颜色继承系统主题）
        const detailsBox = new St.BoxLayout({
            style_class: 'climacn-details-box',
            vertical: true
        });
        this._weatherDescLabel = this._createDetailRow(detailsBox, '天气', '--');
        this._feelsLikeLabel   = this._createDetailRow(detailsBox, '体感温度', '--°');
        this._humidityLabel    = this._createDetailRow(detailsBox, '湿度', '--%');
        this._windLabel        = this._createDetailRow(detailsBox, '风向风力', '--');
        this._updateTimeLabel  = this._createDetailRow(detailsBox, '更新时间', '--:--');

        const detailsItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        detailsItem.add_child(detailsBox);
        this._indicator.menu.addMenuItem(detailsItem);

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // 手动刷新按钮
        const refreshItem = new PopupMenu.PopupMenuItem(_('刷新'));
        const refreshIcon = new St.Icon({
            icon_name: 'view-refresh-symbolic',
            style_class: 'climacn-refresh-icon'
        });
        refreshItem.add_child(refreshIcon);
        refreshItem.connect('activate', () => this._fetchWeather());
        this._indicator.menu.addMenuItem(refreshItem);
    }

    _createDetailRow(parentBox, title, initialValue) {
        const row = new St.BoxLayout({ style_class: 'climacn-detail-row' });
        const titleLabel = new St.Label({
            text: `${title}:`,
            style_class: 'climacn-detail-label'
        });
        const valueLabel = new St.Label({
            text: initialValue,
            style_class: 'climacn-detail-value'
        });
        row.add_child(titleLabel);
        row.add_child(valueLabel);
        parentBox.add_child(row);
        return valueLabel;
    }

    /* ---- 搜索 UI 构建（修复空白块 & hint_text） ---- */
    _buildSearchUI() {
        // 搜索输入框：使用 hint_text 而非 set_text，防止占位文字不消失
        this._searchEntry = new St.Entry({
            hint_text: _('搜索城市 (例: 北京/海淀/朝阳)...'),
            track_hover: true,
            can_focus: true,
            style_class: 'climacn-search-entry'
        });
        this._searchEntry.clutter_text.connect('activate', () => this._onSearchActivate());
        this._searchEntry.clutter_text.connect('text-changed', () => this._onSearchTextChanged());

        const entryItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        entryItem.add_child(this._searchEntry);
        this._indicator.menu.addMenuItem(entryItem);

        // 搜索状态标签（初始隐藏，当需要提示时才显示）
        this._searchStatusLabel = new St.Label({
            style_class: 'climacn-detail-label'
        });
        this._searchStatusLabel.hide();
        const statusItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        statusItem.add_child(this._searchStatusLabel);
        this._indicator.menu.addMenuItem(statusItem);

        // 搜索结果容器（初始隐藏，有结果时才显示）
        this._searchResultsSection = new PopupMenu.PopupMenuSection();
        this._indicator.menu.addMenuItem(this._searchResultsSection);
        this._searchResultsSection.actor.hide(); // 关键：初始隐藏，防止空白占位
    }

    /* ---- 城市数据加载（本地 CSV） ---- */
    _loadCityData() {
        if (this._cityData || this._isLoadingCities) return;
        this._isLoadingCities = true;
        const csvFile = Gio.File.new_for_path(`${this.path}/data/China-City-List-latest.csv`);
        csvFile.load_contents_async(null, (file, result) => {
            try {
                const [success, contents] = file.load_contents_finish(result);
                if (!success) throw new Error('load failed');
                this._parseCSV(new TextDecoder().decode(contents));
                this._isLoadingCities = false;
                log('[ClimaCN] City data loaded successfully');
            } catch (e) {
                log(`[ClimaCN] Failed to load city data: ${e}`);
                this._cityData = [];
                this._isLoadingCities = false;
                this._showSearchStatus(_('本地城市库加载失败，请检查文件路径'));
            }
        });
    }

    _parseCSV(csvText) {
        const lines = csvText.split('\n');
        if (lines.length < 2) {
            this._cityData = [];
            return;
        }
        const cities = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const cols = line.split(',');
            if (cols.length < 10) continue;
            const id = cols[0].trim();
            const name = cols[2].trim();
            const adm1 = cols[7].trim();
            const adm2 = cols[9].trim();
            if (id && name && adm1) cities.push({ id, name, adm1, adm2 });
        }
        this._cityData = cities;
        log(`[ClimaCN] Parsed ${cities.length} cities`);
    }

    /* ---- 搜索防抖 ---- */
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
        this._clearSearchResults(); // 每次搜索前清空并隐藏结果区

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

        // 有结果：隐藏状态标签，显示结果容器，并填充项目
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
        // 显示状态信息时，确保结果容器隐藏
        this._searchResultsSection.actor.hide();
        this._searchStatusLabel.text = text;
        this._searchStatusLabel.show();
    }

    _clearSearchResults() {
        // 清空结果项、隐藏结果容器和状态标签
        if (this._searchResultsSection) {
            this._searchResultsSection.removeAll();
            this._searchResultsSection.actor.hide();
        }
        if (this._searchStatusLabel) {
            this._searchStatusLabel.hide();
        }
    }

    /* ---- 选中城市 ---- */
    _selectCity(city) {
        this._currentLocationId = city.id;
        this._currentCityName = `${city.name}，${city.adm1}`;
        this._cityLabel.text = this._currentCityName;
        this._saveSettings();
        this._searchEntry.text = '';
        this._clearSearchResults();
        this._fetchWeather();
    }

    /* ---- 定时刷新 ---- */
    _startAutoRefresh() {
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, UPDATE_INTERVAL_SEC, () => {
            this._fetchWeather();
            return GLib.SOURCE_CONTINUE;
        });
    }

    /* ---- 获取天气（Header 鉴权 + 错误处理） ---- */
    _fetchWeather() {
        // 检查 API Key 是否已配置
        if (!this._apiKey || this._apiKey.trim() === '') {
            this._showError(_('请在设置中配置 API Key'));
            return;
        }
        if (!this._baseUrl || this._baseUrl.trim() === '') {
            this._showError(_('请在设置中配置 API Base URL'));
            return;
        }

        if (this._cancellable?.is_cancelled())
            this._cancellable = new Gio.Cancellable();

        const url = getWeatherUrl(this._baseUrl, this._currentLocationId);
        const message = Soup.Message.new('GET', url);
        if (!message) return;

        // Header 认证
        message.request_headers.append('X-Qw-Api-Key', this._apiKey);

        log(`[ClimaCN] Fetching weather for ${this._currentLocationId}`);

        this._session.send_and_read_async(
            message,
            Soup.MessagePriority.NORMAL,
            this._cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (this._cancellable?.is_cancelled()) return;

                    const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));

                    if (json.code === '200' && json.now) {
                        this._updateUI(json.now);
                    } else {
                        const errCode = json.code || 'unknown';
                        console.error(`[ClimaCN] API error: code=${errCode}, response=${JSON.stringify(json)}`);

                        if (errCode === '401' || errCode === '403') {
                            if (this._timeoutId) {
                                GLib.Source.remove(this._timeoutId);
                                this._timeoutId = 0;
                            }
                            this._showError(_('API 密钥无效或无权访问，已停止更新'));
                        } else {
                            this._showError();
                        }
                    }
                } catch (e) {
                    console.error(`[ClimaCN] Network/parse error: ${e}`);
                    this._showError();
                }
            }
        );
    }
    
    /* ---- UI 更新（使用 obsTime 修正更新时间） ---- */
    _updateUI(now) {
        const iconCode = now.icon || '999';
        const temp = now.temp || '--';
        const iconPath = `${this.path}/icons/${iconCode}-symbolic.svg`;
        const iconFile = Gio.File.new_for_path(iconPath);

        try {
            if (iconFile.query_exists(null))
                this._weatherIcon.gicon = new Gio.FileIcon({ file: iconFile });
            else
                this._weatherIcon.icon_name = 'weather-severe-alert-symbolic';
        } catch (e) {
            this._weatherIcon.icon_name = 'weather-severe-alert-symbolic';
        }

        this._tempLabel.text = `${temp}°`;

        this._weatherDescLabel.text = now.text || '--';
        this._feelsLikeLabel.text = now.feelsLike ? `${now.feelsLike}°` : '--°';
        this._humidityLabel.text = now.humidity ? `${now.humidity}%` : '--%';

        const windDir = now.windDir || '--';
        const windScale = now.windScale || '--';
        this._windLabel.text = `${windDir} ${windScale}级`;

        // 正确的更新时间字段：obsTime
        const obsTime = now.obsTime || '';
        const timeStr = obsTime ? obsTime.substring(11, 16) : '--:--';
        this._updateTimeLabel.text = timeStr;
    }

    _showError(message = _('获取失败')) {
        this._tempLabel.text = 'N/A';
        this._weatherIcon.icon_name = 'dialog-error-symbolic';
        this._weatherDescLabel.text = message;
        this._feelsLikeLabel.text = '--°';
        this._humidityLabel.text = '--%';
        this._windLabel.text = '--';
        this._updateTimeLabel.text = '--:--';
    }
}
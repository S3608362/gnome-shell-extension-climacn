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

import { ALERT_DETAIL_FAILED, ALERT_DETAIL_WIDTH, ALERT_MAX_FAILURES, findNearestStation, getCmaAlertDetailUrl, getCmaAlertsUrl, parseAlertDetail, parseAlerts, parseStationList } from './lib/alerts.js';
import { AQI_FONT_PX, AQI_MAX_FAILURES, AQI_RING_SIZE, aqiFillRatio, chinaAqiFromHourly, parseAqiIndex } from './lib/aqi.js';
import { parseAstro, parseMoonPhases, parseTrendPoints } from './lib/astro.js';
import { TEMP_BAR_HEIGHT, TEMP_BAR_WIDTH, TEMP_RAMP, cairoFontDescription, roundedBarPath } from './lib/drawing.js';
import { BATTERY_INTERVAL_SEC, CACHE_TTL_SEC, CALENDAR_COLS, DAILY_REQUEST_BUDGET, FORECAST_ROWS, MANUAL_COOLDOWN_SEC, UPDATE_INTERVAL_SEC, compassToChinese, currentRequestCount, formatMeasure, getAirQualityUrl, getForecastUrl, getWeatherUrl, logError, migrateSourceSettings, nextRequestCount, normalizeHost, parseCsvLine, roundTemp, safeIconCode, setDebugLogging, toFiniteOrNull, toPercent } from './lib/util.js';
import { SunMoonBands } from './ui/sunMoonBands.js';
import { TrendChart } from './ui/trendChart.js';
import { appendPressureSample, formatPressureTrend, getOpenMeteoAirQualityUrl, getOpenMeteoUrl, openMeteoAsQweatherCurrent, openMeteoAsQweatherDaily, parsePressureHistory, pressureTrend } from './lib/weather.js';

export default class ClimaCNExtension extends Extension {
    _isActive() {
        return !!this._cancellable && !this._cancellable.is_cancelled();
    }

    enable() {
        this._cancellable = new Gio.Cancellable();

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
        this._aqiRepaintId = 0;
        this._refreshActivateId = 0;
        this._calendarClickedId = 0;
        this._showInCalendarId = 0;
        this._showAlertsId = 0;
        this._alertGen = 0;
        this._alertFailCount = 0;
        this._alertItem = null;
        this._alertLabel = null;
        this._alertDot = null;
        this._alertDetailBox = null;
        this._alertExpandId = 0;
        this._alerts = [];
        this._alertDetails = new Map();
        this._cmaStations = null;
        this._loadingStations = false;
        this._stationWaiters = [];
        this._calendarCard = null;
        this._calendarGrid = null;
        this._calendarCityLabel = null;
        this._session = new Soup.Session();

        this._cityData = null;
        this._isLoadingCities = false;
        this._iconExistsCache = new Map();
        this._requestSeq = 0;
        this._lastFetchAt = 0;
        this._onBattery = false;
        this._upower = null;
        this._upowerSignalId = 0;

        this._settings = this.getSettings();
        migrateSourceSettings(this._settings);
        this._apiKey = this._settings.get_string('api-key') || '';
        this._host = normalizeHost(this._settings.get_string('api-base-url'));

        this._latitude = this._settings.get_double('latitude');
        this._longitude = this._settings.get_double('longitude');
        this._currentCityName = this._settings.get_string('city-name');

        this._pressureHistory = parsePressureHistory(this._settings.get_string('pressure-history'));
        this._aqi = null;
        this._aqiFailCount = 0;
        this._lastForecast = null;
        this._attributionText = '';
        this._errorShown = false;

        this._writingSettings = false;

        const onConfigChanged = () => {
            if (!this._isActive()) return;
            if (this._configDebounceId) {
                GLib.Source.remove(this._configDebounceId);
                this._configDebounceId = 0;
            }
            this._configDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                this._configDebounceId = 0;
                if (!this._isActive()) return GLib.SOURCE_REMOVE;
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
        const onLocationChanged = () => {
            if (!this._isActive() || this._writingSettings) return;
            this._alertGen++;
            this._updateAlerts([]);
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
            if (!this._isActive() || this._writingSettings) return;
            const name = this._settings.get_string('city-name');
            if (name === this._currentCityName) return;
            this._currentCityName = name;
            if (this._cityLabel) this._cityLabel.text = name;
            if (this._calendarCityLabel) {
                const short = this._shortCityName(name);
                this._calendarCityLabel.text = short;
                this._calendarCard.accessible_name = `${_('天气')} ${short}`;
            }
        });

        const onSourceChanged = () => onConfigChanged();
        this._sourceCurrentId = this._settings.connect('changed::source-current', onSourceChanged);
        this._sourceForecastId = this._settings.connect('changed::source-forecast', onSourceChanged);
        this._sourceAirQualityId = this._settings.connect('changed::source-air-quality', onSourceChanged);
        this._sourceAstronomyId = this._settings.connect('changed::source-astronomy', onSourceChanged);

        this._showInCalendarId = this._settings.connect('changed::show-in-calendar', () => {
            if (!this._isActive()) return;
            if (this._settings.get_boolean('show-in-calendar'))
                this._buildCalendarSection();
            else
                this._destroyCalendarSection();
        });

        this._showAlertsId = this._settings.connect('changed::show-alerts', () => {
            if (!this._isActive()) return;
            this._alertGen++;
            if (this._settings.get_boolean('show-alerts')) {
                this._alertFailCount = 0;
                this._refreshAlerts();
            } else {
                this._updateAlerts([]);
            }
        });

        this._debugLoggingId = this._settings.connect('changed::debug-logging', () => {
            setDebugLogging(this._settings.get_boolean('debug-logging'));
        });
        setDebugLogging(this._settings.get_boolean('debug-logging'));

        this._stylesheetPath = this.path + '/stylesheet.css';
        this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        this._theme.load_stylesheet(Gio.File.new_for_path(this._stylesheetPath));

        this._createIndicator();
        this._buildCalendarSection();
        this._initPowerMonitor();
        this._fetchWeather();
        this._startAutoRefresh();
    }

    disable() {
        if (this._cancellable && !this._cancellable.is_cancelled())
            this._cancellable.cancel();

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
            if (this._showInCalendarId) {
                this._settings.disconnect(this._showInCalendarId);
                this._showInCalendarId = 0;
            }
            if (this._showAlertsId) {
                this._settings.disconnect(this._showAlertsId);
                this._showAlertsId = 0;
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
        this._lastForecast = null;
        this._alertGen = 0;
        this._alertFailCount = 0;
        this._alerts = [];
        this._alertDetails = null;
        this._alertDetailBox = null;
        this._alertExpandId = 0;
        this._cmaStations = null;
        this._loadingStations = false;
        this._stationWaiters = [];
        this._attributionText = '';
        this._errorShown = false;
        this._lastFetchAt = 0;
        this._onBattery = false;
        this._upowerSignalId = 0;
        this._stylesheetPath = null;
        this._theme = null;
        this._cancellable = null;
    }

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
                if (!this._isActive()) return;
                try {
                    this._upower = Gio.DBusProxy.new_for_bus_finish(result);
                } catch (e) {
                    this._upower = null;
                    return;
                }
                this._onBattery = this._upower.get_cached_property('OnBattery')?.get_boolean() ?? false;
                this._upowerSignalId = this._upower.connect('g-properties-changed', () => {
                    if (!this._isActive()) return;
                    const onBattery = this._upower?.get_cached_property('OnBattery')?.get_boolean() ?? false;
                    if (onBattery === this._onBattery) return;
                    this._onBattery = onBattery;
                    this._restartAutoRefresh();
                });
                this._restartAutoRefresh();
            }
        );
    }

    

    _destroyUI() {
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
        if (this._aqiRepaintId) {
            this._aqiArea?.disconnect(this._aqiRepaintId);
            this._aqiRepaintId = 0;
        }
        if (this._refreshActivateId) {
            this._refreshItem?.disconnect(this._refreshActivateId);
            this._refreshActivateId = 0;
        }

        this._destroyCalendarSection();

        this._destroyAlerts();

        this._bands?.destroy();
        this._bands = null;

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
        this._trend?.destroy();
        this._trend = null;

        this._searchEntry?.destroy();
        this._searchEntry = null;
        this._searchStatusLabel?.destroy();
        this._searchStatusLabel = null;
        this._searchStatusItem?.destroy();
        this._searchStatusItem = null;
        this._searchResultsSection?.destroy();
        this._searchResultsSection = null;

        this._weatherIcon?.destroy();
        this._weatherIcon = null;
        this._tempLabel?.destroy();
        this._tempLabel = null;

        this._feelsLikeLabel = null;
        this._humidityLabel = null;
        this._windLabel = null;
        this._updateTimeLabel = null;
        this._aqiCategoryLabel = null;
        this._aqiPrimaryLabel = null;
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
        this._indicator.menu.box.add_style_class_name('climacn-menu');
        this._bands = new SunMoonBands(this);
        this._trend = new TrendChart(this);
        this._buildMenu();
        Main.panel.addToStatusArea('climacn', this._indicator);
    }

    _buildCalendarSection() {
        if (this._calendarCard) return;
        if (!this._settings.get_boolean('show-in-calendar')) return;

        let host = null;
        try {
            const dm = Main.panel.statusArea?.dateMenu;
            host = dm?._weatherItem?.get_parent() ?? dm?._displaysSection?.child ?? null;
        } catch (_e) {
            host = null;
        }
        if (!host || typeof host.add_child !== 'function')
            return;

        for (const child of host.get_children()) {
            if (child.name === 'climacn-calendar-card')
                child.destroy();
        }

        const card = new St.Button({
            style_class: 'weather-button',
            can_focus: true,
            x_expand: true,
            name: 'climacn-calendar-card'
        });

        const box = new St.BoxLayout({
            style_class: 'weather-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true
        });
        card.child = box;

        const titleBox = new St.BoxLayout({ style_class: 'weather-header-box' });
        const titleLabel = new St.Label({
            text: _('天气'),
            style_class: 'weather-header',
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_align: Clutter.ActorAlign.END
        });
        titleBox.add_child(titleLabel);

        this._calendarCityLabel = new St.Label({
            text: this._shortCityName(this._currentCityName),
            style_class: 'weather-header location',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END
        });
        titleBox.add_child(this._calendarCityLabel);
        box.add_child(titleBox);

        const layout = new Clutter.GridLayout({ orientation: Clutter.Orientation.VERTICAL });
        this._calendarGrid = new St.Widget({
            style_class: 'weather-grid',
            layout_manager: layout
        });
        layout.hookup_style(this._calendarGrid);
        box.add_child(this._calendarGrid);

        card.labelActor = titleLabel;
        card.accessible_name = `${_('天气')} ${this._shortCityName(this._currentCityName)}`;

        this._calendarClickedId = card.connect('clicked', () => this._activateFromCalendar());

        this._calendarCard = card;
        host.add_child(card);

        this._updateCalendarSection(this._lastForecast);
    }

    _activateFromCalendar() {
        Main.overview.hide();
        Main.panel.closeCalendar();
        this._indicator?.menu.toggle();
    }

    _shortCityName(name) {
        const s = String(name ?? '');
        const i = s.indexOf('，');
        return i > 0 ? s.slice(0, i) : s;
    }

    _calendarDayName(today, offset) {
        if (offset === 0) return _('今天');
        if (offset === 1) return _('明天');
        const names = [_('周日'), _('周一'), _('周二'), _('周三'),
                       _('周四'), _('周五'), _('周六')];
        return names[today.add_days(offset).get_day_of_week() % 7];
    }

    _updateCalendarSection(forecast) {
        if (!this._calendarGrid) return;

        this._calendarGrid.destroy_all_children();

        const layout = this._calendarGrid.layout_manager;
        const days = Array.isArray(forecast) ? forecast.slice(0, CALENDAR_COLS) : [];

        if (days.length === 0) {
            layout.attach(new St.Label({ text: _('暂无预报数据') }), 0, 0, 1, 1);
            return;
        }

        const today = GLib.DateTime.new_now_local();

        for (let i = 0; i < CALENDAR_COLS; i++) {
            const day = days[i] ?? null;

            const nameLabel = new St.Label({
                text: day ? this._calendarDayName(today, i) : '--',
                style_class: 'weather-forecast-time',
                x_align: Clutter.ActorAlign.CENTER
            });
            nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

            const icon = new St.Icon({
                style_class: 'weather-forecast-icon',
                x_align: Clutter.ActorAlign.CENTER,
                x_expand: true
            });
            if (day) {
                this._applyIcon(icon, this._createFileIcon(
                    `${this.path}/icons/${safeIconCode(day.daytime?.condition?.code)}-symbolic.svg`));
            } else {
                this._applyIcon(icon, null, 'weather-few-clouds-symbolic');
            }

            const tempLabel = new St.Label({
                text: `${roundTemp(day?.temperatureMin?.value)}/${roundTemp(day?.temperatureMax?.value)}`,
                style_class: 'weather-forecast-temp',
                x_align: Clutter.ActorAlign.CENTER
            });
            tempLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

            layout.attach(nameLabel, i, 0, 1, 1);
            layout.attach(icon, i, 1, 1, 1);
            layout.attach(tempLabel, i, 2, 1, 1);
        }
    }

    _destroyCalendarSection() {
        if (this._calendarClickedId) {
            this._calendarCard?.disconnect(this._calendarClickedId);
            this._calendarClickedId = 0;
        }

        this._calendarGrid?.destroy();
        this._calendarGrid = null;
        this._calendarCityLabel?.destroy();
        this._calendarCityLabel = null;

        const card = this._calendarCard;
        this._calendarCard = null;
        card?.destroy();
    }

    _buildMenu() {
        this._indicator.menu.removeAll();

        this._buildHeader();
        this._buildAlerts();

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._buildSearchUI();
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._buildDetails();
        this._bands.build();
        this._buildForecast();
        this._buildFooter();
    }

    

    

    

    _buildAlerts() {
        this._alertItem = new PopupMenu.PopupSubMenuMenuItem('', false);
        this._alertItem.add_style_class_name('climacn-alert-row');

        this._alertDot = new St.Widget({
            style_class: 'climacn-alert-dot alert-unknown',
            y_align: Clutter.ActorAlign.CENTER
        });
        this._alertItem.insert_child_at_index(this._alertDot, 0);
        this._alertLabel = this._alertItem.label;
        this._alertLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        this._alertDetailBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'climacn-alert-detail-box'
        });
        const detailItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        detailItem.add_child(this._alertDetailBox);
        this._alertItem.menu.addMenuItem(detailItem);

        this._alertExpandId = this._alertItem.menu.connect('open-state-changed', (menu, open) => {
            if (open)
                this._onAlertExpanded();
        });

        this._alertItem.visible = false;
        this._indicator.menu.addMenuItem(this._alertItem);
    }

    _wrappedAlertLabel(text, styleClass) {
        const label = new St.Label({ text, style_class: styleClass });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.set_width(ALERT_DETAIL_WIDTH);
        return label;
    }

    _onAlertExpanded() {
        if (!this._alertItem || this._alerts.length === 0)
            return;

        const missing = this._alerts.filter(a => a.id && !this._alertDetails.has(a.id));
        this._renderAlertDetails();
        for (const alert of missing) {
            this._alertDetails.set(alert.id, null);
            this._fetchAlertDetail(alert.id, this._alertGen);
        }
    }

    _fetchAlertDetail(alertId, gen) {
        const message = Soup.Message.new('GET', getCmaAlertDetailUrl(alertId));
        if (!message)
            return;
        this._session.send_and_read_async(
            message,
            Soup.MessagePriority.NORMAL,
            this._cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (!this._isActive())
                        return;
                    if (gen !== this._alertGen)
                        return;
                    if (message.status_code !== Soup.Status.OK) {
                        logError(`预警详情 HTTP ${message.status_code}`);
                        this._alertDetails.set(alertId, ALERT_DETAIL_FAILED);
                    } else {
                        this._alertDetails.set(alertId, parseAlertDetail(
                            JSON.parse(new TextDecoder().decode(bytes.get_data())))
                            ?? ALERT_DETAIL_FAILED);
                    }
                    if (this._alertItem?.menu.isOpen)
                        this._renderAlertDetails();
                } catch (e) {
                    if (!this._isActive())
                        return;
                    logError(`预警详情解析失败: ${e}`);
                    this._alertDetails.set(alertId, ALERT_DETAIL_FAILED);
                }
            });
    }

    _renderAlertDetails() {
        if (!this._alertDetailBox)
            return;
        this._alertDetailBox.destroy_all_children();

        for (const alert of this._alerts) {
            const box = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'climacn-alert-detail'
            });

            if (this._alerts.length > 1) {
                const head = new St.BoxLayout({ style_class: 'climacn-alert-detail-head' });
                const dot = new St.Widget({
                    style_class: `climacn-alert-dot alert-${alert.level.key}`,
                    y_align: Clutter.ActorAlign.CENTER
                });
                head.add_child(dot);
                head.add_child(this._wrappedAlertLabel(alert.title, 'climacn-alert-detail-title'));
                box.add_child(head);
            }

            const detail = alert.id ? this._alertDetails.get(alert.id) : ALERT_DETAIL_FAILED;
            if (!detail || detail === ALERT_DETAIL_FAILED) {
                box.add_child(new St.Label({
                    text: detail === ALERT_DETAIL_FAILED ? _('详情暂时取不到') : _('详情加载中…'),
                    style_class: 'climacn-alert-detail-pending'
                }));
                this._alertDetailBox.add_child(box);
                continue;
            }

            if (detail.effective) {
                box.add_child(new St.Label({
                    text: `${_('发布时间')} ${detail.effective}`,
                    style_class: 'climacn-alert-detail-meta'
                }));
            }
            if (detail.description)
                box.add_child(this._wrappedAlertLabel(detail.description, 'climacn-alert-detail-text'));

            if (detail.guide) {
                box.add_child(new St.Label({
                    text: _('防御指南'),
                    style_class: 'climacn-alert-detail-heading'
                }));
                box.add_child(this._wrappedAlertLabel(detail.guide, 'climacn-alert-detail-text'));
            }

            this._alertDetailBox.add_child(box);
        }
    }

    _loadStationData(callback) {
        if (this._cmaStations) {
            callback();
            return;
        }
        if (this._loadingStations) {
            this._stationWaiters.push(callback);
            return;
        }
        this._loadingStations = true;
        this._stationWaiters.push(callback);

        const file = Gio.File.new_for_path(`${this.path}/data/CMA-Station-List.csv`);
        file.load_contents_async(null, (f, result) => {
            const waiters = this._stationWaiters;
            this._stationWaiters = [];
            this._loadingStations = false;
            if (!this._isActive())
                return;
            try {
                const [ok, contents] = f.load_contents_finish(result);
                if (!ok)
                    throw new Error('load failed');
                this._cmaStations = parseStationList(new TextDecoder().decode(contents));
            } catch (e) {
                logError(`站点表加载失败: ${e}`);
                this._cmaStations = [];
            }
            for (const fn of waiters) {
                if (this._isActive())
                    fn();
            }
        });
    }

    _refreshAlerts() {
        if (!this._isActive() || !this._settings?.get_boolean('show-alerts'))
            return;
        if (this._alertFailCount >= ALERT_MAX_FAILURES)
            return;

        this._loadStationData(() => {
            if (!this._isActive() || !this._settings?.get_boolean('show-alerts'))
                return;
            if (this._alertFailCount >= ALERT_MAX_FAILURES)
                return;

            const station = findNearestStation(
                this._cmaStations, this._latitude, this._longitude);
            if (!station) {
                this._updateAlerts([]);
                return;
            }
            this._fetchAlerts(station.id, this._alertGen);
        });
    }

    _fetchAlerts(stationId, gen) {
        const message = Soup.Message.new('GET', getCmaAlertsUrl(stationId));
        if (!message) {
            this._alertFailCount++;
            this._updateAlerts([]);
            return;
        }
        this._session.send_and_read_async(
            message,
            Soup.MessagePriority.NORMAL,
            this._cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (!this._isActive())
                        return;
                    if (gen !== this._alertGen)
                        return;
                    if (message.status_code !== Soup.Status.OK) {
                        this._alertFailCount++;
                        logError(`预警请求 HTTP ${message.status_code}`);
                        this._updateAlerts([]);
                        return;
                    }
                    this._alertFailCount = 0;
                    this._updateAlerts(parseAlerts(
                        JSON.parse(new TextDecoder().decode(bytes.get_data()))));
                } catch (e) {
                    if (!this._isActive())
                        return;
                    this._alertFailCount++;
                    logError(`预警解析失败: ${e}`);
                    this._updateAlerts([]);
                }
            });
    }

    _updateAlerts(alerts) {
        if (!this._alertItem)
            return;
        const list = Array.isArray(alerts) ? alerts : [];
        this._alerts = list;

        if (list.length === 0) {
            this._alertItem.visible = false;
            return;
        }
        const top = list[0];
        this._alertLabel.text = list.length > 1
            ? `${top.title}（等 ${list.length} 条）`
            : top.title;
        this._alertDot.style_class = `climacn-alert-dot alert-${top.level.key}`;
        this._alertItem.visible = true;

        const sameSet = list.length === this._alertDetails.size &&
            list.every(a => this._alertDetails.has(a.id));
        if (!sameSet) {
            this._alertDetails.clear();
            this._alertDetailBox?.destroy_all_children();
            if (this._alertItem.menu.isOpen)
                this._onAlertExpanded();
        }
    }

    _destroyAlerts() {
        if (this._alertExpandId) {
            this._alertItem?.menu.disconnect(this._alertExpandId);
            this._alertExpandId = 0;
        }
        this._alertLabel = null;
        this._alertDot?.destroy();
        this._alertDot = null;
        this._alertDetailBox?.destroy();
        this._alertDetailBox = null;
        this._alertItem?.destroy();
        this._alertItem = null;
        this._alerts = [];
        this._alertDetails?.clear();
        this._alertDetails = null;
    }

    _buildHeader() {
        const box = new St.BoxLayout({
            style_class: 'climacn-header-box',
            vertical: true,
            x_expand: true
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

        row.add_child(new St.Widget({ x_expand: true }));
        this._aqiGroup = new St.BoxLayout({
            style_class: 'climacn-aqi-group',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false
        });
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

    _buildDetails() {
        const grid = new St.BoxLayout({
            style_class: 'climacn-details-grid',
            vertical: true,
            x_expand: true
        });

        const row1 = this._createGridRow(grid);
        this._feelsLikeLabel   = this._createGridCell(row1, '体感', '--°');
        this._humidityLabel    = this._createGridCell(row1, '湿度', '--%');
        this._windLabel        = this._createGridCell(row1, '风向', '--');

        const row2 = this._createGridRow(grid);
        this._updateTimeLabel  = this._createGridCell(row2, '更新时间', '--:--');
        this._aqiCategoryLabel = this._createGridCell(row2, '空气质量', '--');
        this._aqiPrimaryLabel  = this._createGridCell(row2, '首要污染物', '--');

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

        this._trend.build();

        const item = new PopupMenu.PopupBaseMenuItem({ activate: false });
        item.add_child(this._forecastContainer);
        this._indicator.menu.addMenuItem(item);
    }

    

    

    _buildFooter() {
        this._noticeLabel = new St.Label({
            style_class: 'climacn-notice',
            text: ''
        });
        this._noticeItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        this._noticeItem.add_child(this._noticeLabel);
        this._noticeItem.visible = false;
        this._indicator.menu.addMenuItem(this._noticeItem);

        this._attributionLabel = new St.Label({
            style_class: 'climacn-attribution',
            text: ''
        });
        this._attributionItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        this._attributionItem.add_child(this._attributionLabel);
        this._attributionItem.visible = false;
        this._indicator.menu.addMenuItem(this._attributionItem);

        this._refreshItem = new PopupMenu.PopupImageMenuItem(_('刷新'), 'view-refresh-symbolic');
        this._refreshActivateId = this._refreshItem.connect('activate', () => this._onManualRefresh());
        this._indicator.menu.addMenuItem(this._refreshItem);
    }

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
            x_expand: true,
            track_hover: true,
            can_focus: true,
            style_class: 'climacn-search-entry'
        });
        this._searchActivateId = this._searchEntry.clutter_text.connect('activate', () => this._onSearchActivate());
        this._searchTextChangedId = this._searchEntry.clutter_text.connect('text-changed', () => this._onSearchTextChanged());

        const entryItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        entryItem.add_style_class_name('climacn-search-row');
        entryItem.add_child(this._searchEntry);
        this._indicator.menu.addMenuItem(entryItem);

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
            if (!this._isActive()) return;
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
        let col = null;
        for (const rawLine of csvText.split('\n')) {
            const line = rawLine.trim();
            if (!line) continue;
            const cols = parseCsvLine(line);
            if (cols.length < 10) continue;

            if (!col) {
                const names = cols.map(c => c.trim());
                if (!names.includes('Location_Name_ZH')) continue;
                col = {
                    name: names.indexOf('Location_Name_ZH'),
                    adm1: names.indexOf('Adm1_Name_ZH'),
                    adm2: names.indexOf('Adm2_Name_ZH'),
                    lat: names.indexOf('Latitude'),
                    lon: names.indexOf('Longitude'),
                };
                if (col.name < 0 || col.adm1 < 0 || col.lat < 0 || col.lon < 0) {
                    logError('城市库表头缺少必要列，已放弃解析');
                    break;
                }
                continue;
            }

            const name = cols[col.name].trim();
            const adm1 = cols[col.adm1].trim();
            const adm2 = col.adm2 < 0 ? '' : cols[col.adm2].trim();
            const lat = toFiniteOrNull(cols[col.lat]);
            const lon = toFiniteOrNull(cols[col.lon]);
            if (!name || !adm1) continue;
            if (lat === null || lon === null) continue;
            cities.push({ name, adm1, adm2, lat, lon });
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

        this._writingSettings = true;
        this._settings.set_double('latitude', this._latitude);
        this._settings.set_double('longitude', this._longitude);
        this._settings.set_string('city-name', this._currentCityName);
        this._writingSettings = false;

        this._searchEntry.text = '';
        this._clearSearchResults();
        this._fetchWeather();
    }

    _intervalSec() {
        return this._onBattery ? BATTERY_INTERVAL_SEC : UPDATE_INTERVAL_SEC;
    }

    _startAutoRefresh() {
        if (this._timeoutId)
            return;
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._intervalSec(), () => {
            this._autoRefreshTick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _restartAutoRefresh() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (!this._isActive())
            return;
        this._startAutoRefresh();
    }

    _autoRefreshTick() {
        if (this._requestBudgetExhausted() && !this._anyOpenMeteoSource()) {
            this._refreshAlerts();
            this._updateNotice();
            return;
        }
        if (this._secondsSinceFetch() < CACHE_TTL_SEC)
            return;
        this._fetchWeather();
    }

    _onManualRefresh() {
        if (!this._isActive())
            return;
        if (this._secondsSinceFetch() < MANUAL_COOLDOWN_SEC)
            return;
        this._fetchWeather();
    }

    _secondsSinceFetch() {
        return GLib.get_monotonic_time() / 1e6 - this._lastFetchAt;
    }

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

    _handleHttpError(message, bytes) {
        const status = message.status_code;
        let body = '';
        try {
            body = new TextDecoder().decode(bytes.get_data()).slice(0, 300);
        } catch (_e) {
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

    _qweatherConfigured() {
        return !!(this._apiKey && this._apiKey.trim() && this._host);
    }

    _qweatherUsable() {
        return this._qweatherConfigured() && !this._requestBudgetExhausted();
    }

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
        if (plan.omForecast || plan.omAqi)
            names.push('Open-Meteo');
        return names.join(' + ');
    }

    _anyOpenMeteoSource() {
        const plan = this._buildFetchPlan();
        return plan.omForecast || plan.omAqi;
    }

    _sendJson(message, seq, label, onText) {
        this._session.send_and_read_async(
            message,
            Soup.MessagePriority.NORMAL,
            this._cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (!this._isActive())
                        return;
                    if (seq !== this._requestSeq)
                        return;
                    if (message.status_code !== Soup.Status.OK) {
                        logError(`${label} HTTP ${message.status_code}`);
                        return onText(null);
                    }
                    return onText(JSON.parse(new TextDecoder().decode(bytes.get_data())));
                } catch (e) {
                    if (!this._isActive())
                        return;
                    logError(`${label} error: ${e}`);
                    return onText(null);
                }
            }
        );
    }

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

    _fetchOpenMeteoAirQuality(seq, callback) {
        const message = Soup.Message.new('GET',
            getOpenMeteoAirQualityUrl(this._latitude, this._longitude));
        if (!message) {
            callback(null);
            return;
        }
        const nowIso = GLib.DateTime.new_now_local().format('%Y-%m-%dT%H:00');
        this._sendJson(message, seq, 'Open-Meteo AQI', json => {
            callback(json ? chinaAqiFromHourly(nowIso, json) : null);
        });
    }

    _fetchWeather() {
        if (!this._isActive())
            return;

        this._refreshAlerts();

        const plan = this._buildFetchPlan();

        if ((plan.qwCurrent || plan.qwDaily || plan.qwAqi) && !this._qweatherConfigured()) {
            this._showError(this._apiKey?.trim()
                ? _('请在设置中配置 API Host')
                : _('请在设置中配置 API Key'), 'config');
            return;
        }

        if (this._cancellable.is_cancelled())
            this._cancellable = new Gio.Cancellable();

        this._lastFetchAt = GLib.get_monotonic_time() / 1e6;
        this._errorShown = false;

        const seq = ++this._requestSeq;

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
            if (!this._isActive() || seq !== this._requestSeq)
                return;
            this._applyPlan(plan, pending);
        };
        const done = (key, value) => {
            pending[key] = value;
            settle();
        };

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
            forecast = astroDays.map(d => ({ astro: d.astro }));
        }

        const aqi = plan.src.airQuality === 'qweather'
            ? (pending.qwAqi ?? null)
            : (pending.omAqi ?? null);

        if (!now) {
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
                    if (!this._isActive()) return;
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
                    callback(Array.isArray(json.days) ? json.days : null);
                } catch (e) {
                    if (!this._isActive()) return;
                    logError(`Forecast parse error: ${e}`);
                    callback(null);
                }
            }
        );
    }

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
                    if (!this._isActive() || seq !== this._requestSeq) return;
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
                    if (!this._isActive()) return;
                    logError(`Air quality parse error: ${e}`);
                    callback(null);
                }
            }
        );
    }

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
    _applyIcon(widget, gicon, fallbackName = 'weather-severe-alert-symbolic') {
        if (gicon) {
            widget.gicon = gicon;
            widget.icon_name = null;
        } else {
            widget.gicon = null;
            widget.icon_name = fallbackName;
        }
    }

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

            const start = -Math.PI / 2;
            const sweep = Math.PI * 1.5;

            cr.setLineWidth(lineWidth);
            cr.setLineCap(Cairo.LineCap.ROUND);

            cr.setSourceRGBA(0.5, 0.5, 0.5, 0.25);
            cr.arc(cx, cy, radius, start, start + sweep);
            cr.stroke();

            const aqi = this._aqi;
            if (!aqi)
                return;

            const ratio = aqiFillRatio(aqi.aqi);
            if (ratio > 0) {
                cr.setSourceRGBA(aqi.color.r / 255, aqi.color.g / 255, aqi.color.b / 255, 1);
                cr.arc(cx, cy, radius, start, start + sweep * ratio);
                cr.stroke();
            }

            const [hasColor, color] = area.get_theme_node().lookup_color('color', false);
            if (hasColor)
                cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, 1);
            else
                cr.setSourceRGBA(0.5, 0.5, 0.5, 1);

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
            cr.$dispose();
        }
    }

    

    

    

    

    

    

    

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

            const [hasFg, fg] = area.get_theme_node().lookup_color('color', false);
            const track = hasFg
                ? [fg.red / 255, fg.green / 255, fg.blue / 255]
                : [0.5, 0.5, 0.5];
            cr.setSourceRGBA(track[0], track[1], track[2], 0.18);
            roundedBarPath(cr, 0, y, width, barH);
            cr.fill();

            const x0 = width * Math.min(Math.max(min - lo, 0), span) / span;
            const x1 = width * Math.min(Math.max(max - lo, 0), span) / span;
            const segW = Math.max(x1 - x0, barH);

            const grad = new Cairo.LinearGradient(0, 0, width, 0);
            for (const [off, r, g, b] of TEMP_RAMP)
                grad.addColorStopRGBA(off, r, g, b, 0.95);
            cr.setSource(grad);
            roundedBarPath(cr, x0, y, Math.min(segW, width - x0), barH);
            cr.fill();
        } finally {
            cr.$dispose();
        }
    }

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

    

    _updateUI(now, forecast, aqi) {
        const iconCode = safeIconCode(now.condition?.code);
        const icon = this._createFileIcon(`${this.path}/icons/${iconCode}-symbolic.svg`);
        const tempText = roundTemp(now.temperature?.value);

        this._applyIcon(this._weatherIcon, icon);
        this._tempLabel.text = tempText;
        this._applyIcon(this._headerIcon, icon);
        this._headerTemp.text = tempText;
        this._headerCondition.text = now.condition?.text || '--';

        this._aqi = aqi ?? null;
        if (this._aqiGroup) {
            this._aqiGroup.visible = this._aqi !== null;
            if (this._aqi)
                this._aqiArea.queue_repaint();
        }

        this._feelsLikeLabel.text = roundTemp(now.feelsLike?.value);
        this._humidityLabel.text = toPercent(now.humidity);
        this._windLabel.text =
            `${compassToChinese(now.wind?.direction?.compass)} ${now.wind?.scale ?? '--'}级`;
        this._updateTimeLabel.text = GLib.DateTime.new_now_local().format('%H:%M');
        this._aqiCategoryLabel.text = this._aqi?.category || '--';
        this._aqiPrimaryLabel.text = this._aqi ? (this._aqi.primary || '—') : '--';

        const pressureValue = toFiniteOrNull(now.pressure?.value);
        const nowSec = Math.floor(Date.now() / 1000);
        let trendText = '';
        if (pressureValue !== null) {
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
        const uvIndex = toFiniteOrNull(now.uvIndex);
        this._uvIndexLabel.text    = uvIndex === null ? '--' : `${Math.round(uvIndex)}`;
        this._windGustLabel.text   = formatMeasure(now.windGust);
        this._precipLabel.text     = formatMeasure(now.precipitation?.amount);

        if (this._attributionItem) {
            this._attributionLabel.text = this._attributionText || '';
            this._attributionItem.visible = true;
        }

        this._updateNotice();

        if (this._forecastRowsBox) {
            this._forecastRowsBox.remove_all_children();
        }

        this._bands.setData(parseAstro(forecast));

        this._trend.setData(parseTrendPoints(forecast), parseMoonPhases(forecast));

        if (forecast && Array.isArray(forecast) && forecast.length > 0) {
            const dayNames = ['今天', '明天', '后天'];
            const count = Math.min(forecast.length, FORECAST_ROWS);

            const lowsAll = forecast.map(d => toFiniteOrNull(d.temperatureMin?.value))
                                    .filter(v => v !== null);
            const highsAll = forecast.map(d => toFiniteOrNull(d.temperatureMax?.value))
                                     .filter(v => v !== null);
            const barLo = lowsAll.length ? Math.min(...lowsAll) : 0;
            const barHi = highsAll.length ? Math.max(...highsAll) : 1;
            for (let i = 0; i < count; i++) {
                const day = forecast[i];
                const row = new St.BoxLayout({
                    style_class: 'climacn-forecast-row',
                    y_align: Clutter.ActorAlign.CENTER
                });

                const dayLabel = new St.Label({
                    text: dayNames[i],
                    style_class: 'climacn-forecast-day',
                    y_align: Clutter.ActorAlign.CENTER
                });
                row.add_child(dayLabel);

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

                const tempLabel = new St.Label({
                    text: `${roundTemp(day.temperatureMin?.value)} / ${roundTemp(day.temperatureMax?.value)}`,
                    style_class: 'climacn-forecast-temp',
                    y_align: Clutter.ActorAlign.CENTER
                });
                row.add_child(tempLabel);

                const dayMin = toFiniteOrNull(day.temperatureMin?.value);
                const dayMax = toFiniteOrNull(day.temperatureMax?.value);
                if (dayMin !== null && dayMax !== null) {
                    row.add_child(this._createTempBar(
                        { min: dayMin, max: dayMax, lo: barLo, hi: barHi }));
                } else {
                    row.add_child(new St.Widget({ width: TEMP_BAR_WIDTH }));
                }

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

        this._lastForecast = Array.isArray(forecast) ? forecast : null;
        this._updateCalendarSection(this._lastForecast);
    }

    _errorIconName(kind) {
        switch (kind) {
        case 'network': return 'network-error-symbolic';
        case 'auth':    return 'dialog-password-symbolic';
        case 'config':  return 'preferences-system-symbolic';
        case 'data':    return 'dialog-warning-symbolic';
        default:        return 'weather-severe-alert-symbolic';
        }
    }

    _showError(message = _('获取失败'), kind = 'error') {
        this._errorShown = true;
        const iconName = this._errorIconName(kind);
        this._applyIcon(this._weatherIcon, null, iconName);
        this._applyIcon(this._headerIcon, null, iconName);
        this._tempLabel.text = 'N/A';
        this._headerTemp.text = 'N/A';
        this._headerCondition.text = message;

        for (const label of [this._feelsLikeLabel, this._humidityLabel, this._windLabel,
                             this._updateTimeLabel, this._aqiCategoryLabel, this._aqiPrimaryLabel,
                             this._pressureLabel, this._visibilityLabel,
                             this._dewPointLabel, this._cloudCoverLabel, this._uvIndexLabel,
                             this._windGustLabel, this._precipLabel]) {
            if (label)
                label.text = '--';
        }

        if (this._attributionItem)
            this._attributionItem.visible = false;
        this._aqi = null;
        if (this._aqiGroup)
            this._aqiGroup.visible = false;

        this._bands.clear();
        this._trend.clear();

        if (this._forecastRowsBox) {
            this._forecastRowsBox.remove_all_children();
            const errLabel = new St.Label({
                text: _('无法加载预报'),
                style_class: 'climacn-forecast-no-data'
            });
            this._forecastRowsBox.add_child(errLabel);
        }

        this._lastForecast = null;
        this._updateCalendarSection(null);
    }
}

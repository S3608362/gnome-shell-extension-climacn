import {
    ALERT_DETAIL_FAILED,
    ALERT_DETAIL_WIDTH,
    ALERT_MAX_FAILURES,
    findNearestStation,
    getCmaAlertDetailUrl,
    getCmaAlertsUrl,
    parseAlertDetail,
    parseAlerts,
    parseStationList
} from '../lib/alerts.js';
import { logError } from '../lib/util.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import St from 'gi://St';
import Soup from 'gi://Soup?version=3.0';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import Gio from 'gi://Gio';

export class AlertsSection {
    constructor(owner) {
        this._owner = owner;
        this._item = null;
        this._label = null;
        this._dot = null;
        this._detailBox = null;
        this._expandId = 0;
        this._details = new Map();
        this._list = [];
        this._gen = 0;
        this._failCount = 0;
        this._stations = null;
        this._stationsLoading = false;
        this._stationWaiters = [];
    }

    setEnabled(on) {
        this._gen++;
        if (on) {
            this._failCount = 0;
            this.refresh();
        } else {
            this._update([]);
        }
    }

    reset() {
        this._gen++;
        this._update([]);
    }

    build() {
        this._item = new PopupMenu.PopupSubMenuMenuItem('', false);
        this._item.add_style_class_name('climacn-alert-row');

        this._dot = new St.Widget({
            style_class: 'climacn-alert-dot alert-unknown',
            y_align: Clutter.ActorAlign.CENTER
        });
        this._item.insert_child_at_index(this._dot, 0);
        this._label = this._item.label;
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        this._detailBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'climacn-alert-detail-box'
        });
        const detailItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        detailItem.add_child(this._detailBox);
        this._item.menu.addMenuItem(detailItem);

        this._expandId = this._item.menu.connect('open-state-changed', (menu, open) => {
            if (open)
                this._onAlertExpanded();
        });

        this._item.visible = false;
        this._owner._indicator.menu.addMenuItem(this._item);
    }

    refresh() {
        if (!this._owner._isActive() || !this._owner._settings?.get_boolean('show-alerts'))
            return;
        if (this._failCount >= ALERT_MAX_FAILURES)
            return;

        this._loadStationData(() => {
            if (!this._owner._isActive() || !this._owner._settings?.get_boolean('show-alerts'))
                return;
            if (this._failCount >= ALERT_MAX_FAILURES)
                return;

            const station = findNearestStation(
                this._stations, this._owner._latitude, this._owner._longitude);
            if (!station) {
                this._update([]);
                return;
            }
            this._fetchAlerts(station.id, this._gen);
        });
    }

_loadStationData(callback) {
        if (this._stations) {
            callback();
            return;
        }
        if (this._stationsLoading) {
            this._stationWaiters.push(callback);
            return;
        }
        this._stationsLoading = true;
        this._stationWaiters.push(callback);

        const file = Gio.File.new_for_path(`${this._owner.path}/data/CMA-Station-List.csv`);
        file.load_contents_async(null, (f, result) => {
            const waiters = this._stationWaiters;
            this._stationWaiters = [];
            this._stationsLoading = false;
            if (!this._owner._isActive())
                return;
            try {
                const [ok, contents] = f.load_contents_finish(result);
                if (!ok)
                    throw new Error('load failed');
                this._stations = parseStationList(new TextDecoder().decode(contents));
            } catch (e) {
                logError(`站点表加载失败: ${e}`);
                this._stations = [];
            }
            for (const fn of waiters) {
                if (this._owner._isActive())
                    fn();
            }
        });
    }

    _fetchAlerts(stationId, gen) {
        const message = Soup.Message.new('GET', getCmaAlertsUrl(stationId));
        if (!message) {
            this._failCount++;
            this._update([]);
            return;
        }
        this._owner._session.send_and_read_async(
            message,
            Soup.MessagePriority.NORMAL,
            this._owner._cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (!this._owner._isActive())
                        return;
                    if (gen !== this._gen)
                        return;
                    if (message.status_code !== Soup.Status.OK) {
                        this._failCount++;
                        logError(`预警请求 HTTP ${message.status_code}`);
                        this._update([]);
                        return;
                    }
                    this._failCount = 0;
                    this._update(parseAlerts(
                        JSON.parse(new TextDecoder().decode(bytes.get_data()))));
                } catch (e) {
                    if (!this._owner._isActive())
                        return;
                    this._failCount++;
                    logError(`预警解析失败: ${e}`);
                    this._update([]);
                }
            });
    }

    _update(alerts) {
        if (!this._item)
            return;
        const list = Array.isArray(alerts) ? alerts : [];
        this._list = list;

        if (list.length === 0) {
            this._item.visible = false;
            return;
        }
        const top = list[0];
        this._label.text = list.length > 1
            ? `${top.title}（等 ${list.length} 条）`
            : top.title;
        this._dot.style_class = `climacn-alert-dot alert-${top.level.key}`;
        this._item.visible = true;

        const sameSet = list.length === this._details.size &&
            list.every(a => this._details.has(a.id));
        if (!sameSet) {
            this._details.clear();
            this._detailBox?.destroy_all_children();
            if (this._item.menu.isOpen)
                this._onAlertExpanded();
        }
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
        if (!this._item || this._list.length === 0)
            return;

        const missing = this._list.filter(a => a.id && !this._details.has(a.id));
        this._renderAlertDetails();
        for (const alert of missing) {
            this._details.set(alert.id, null);
            this._fetchAlertDetail(alert.id, this._gen);
        }
    }

    _fetchAlertDetail(alertId, gen) {
        const message = Soup.Message.new('GET', getCmaAlertDetailUrl(alertId));
        if (!message)
            return;
        this._owner._session.send_and_read_async(
            message,
            Soup.MessagePriority.NORMAL,
            this._owner._cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (!this._owner._isActive())
                        return;
                    if (gen !== this._gen)
                        return;
                    if (message.status_code !== Soup.Status.OK) {
                        logError(`预警详情 HTTP ${message.status_code}`);
                        this._details.set(alertId, ALERT_DETAIL_FAILED);
                    } else {
                        this._details.set(alertId, parseAlertDetail(
                            JSON.parse(new TextDecoder().decode(bytes.get_data())))
                            ?? ALERT_DETAIL_FAILED);
                    }
                    if (this._item?.menu.isOpen)
                        this._renderAlertDetails();
                } catch (e) {
                    if (!this._owner._isActive())
                        return;
                    logError(`预警详情解析失败: ${e}`);
                    this._details.set(alertId, ALERT_DETAIL_FAILED);
                }
            });
    }

    _renderAlertDetails() {
        if (!this._detailBox)
            return;
        this._detailBox.destroy_all_children();

        for (const alert of this._list) {
            const box = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'climacn-alert-detail'
            });

            if (this._list.length > 1) {
                const head = new St.BoxLayout({ style_class: 'climacn-alert-detail-head' });
                const dot = new St.Widget({
                    style_class: `climacn-alert-dot alert-${alert.level.key}`,
                    y_align: Clutter.ActorAlign.CENTER
                });
                head.add_child(dot);
                head.add_child(this._wrappedAlertLabel(alert.title, 'climacn-alert-detail-title'));
                box.add_child(head);
            }

            const detail = alert.id ? this._details.get(alert.id) : ALERT_DETAIL_FAILED;
            if (!detail || detail === ALERT_DETAIL_FAILED) {
                box.add_child(new St.Label({
                    text: detail === ALERT_DETAIL_FAILED ? _('详情暂时取不到') : _('详情加载中…'),
                    style_class: 'climacn-alert-detail-pending'
                }));
                this._detailBox.add_child(box);
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

            this._detailBox.add_child(box);
        }
    }

    destroy() {
        if (this._expandId) {
            this._item?.menu.disconnect(this._expandId);
            this._expandId = 0;
        }
        this._label = null;
        this._dot?.destroy();
        this._dot = null;
        this._detailBox?.destroy();
        this._detailBox = null;
        this._item?.destroy();
        this._item = null;
        this._list = [];
        this._details?.clear();
        this._details = null;
        this._stations = null;
        this._stationsLoading = false;
        this._stationWaiters = [];
    }
}

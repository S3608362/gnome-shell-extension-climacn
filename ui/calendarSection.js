import { CALENDAR_COLS, roundTemp, safeIconCode } from '../lib/util.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class CalendarSection {
    constructor(owner) {
        this._owner = owner;
        this._card = null;
        this._grid = null;
        this._cityLabel = null;
        this._clickedId = 0;
        this._forecast = null;
    }

    setForecast(forecast) {
        this._forecast = Array.isArray(forecast) ? forecast : null;
        this._update(this._forecast);
    }

    setCityName(name) {
        if (!this._cityLabel)
            return;
        const short = shortCityName(name);
        this._cityLabel.text = short;
        this._card.accessible_name = `${_('天气')} ${short}`;
    }

    build() {
        if (this._card) return;
        if (!this._owner._settings.get_boolean('show-in-calendar')) return;

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

        this._cityLabel = new St.Label({
            text: shortCityName(this._owner._currentCityName),
            style_class: 'weather-header location',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END
        });
        titleBox.add_child(this._cityLabel);
        box.add_child(titleBox);

        const layout = new Clutter.GridLayout({ orientation: Clutter.Orientation.VERTICAL });
        this._grid = new St.Widget({
            style_class: 'weather-grid',
            layout_manager: layout
        });
        layout.hookup_style(this._grid);
        box.add_child(this._grid);

        card.labelActor = titleLabel;
        card.accessible_name = `${_('天气')} ${shortCityName(this._owner._currentCityName)}`;

        this._clickedId = card.connect('clicked', () => this._activate());

        this._card = card;
        host.add_child(card);

        this._update(this._forecast);
    }

    _activate() {
        Main.overview.hide();
        Main.panel.closeCalendar();
        this._owner._indicator?.menu.toggle();
    }

    _update(forecast) {
        if (!this._grid) return;

        this._grid.destroy_all_children();

        const layout = this._grid.layout_manager;
        const days = Array.isArray(forecast) ? forecast.slice(0, CALENDAR_COLS) : [];

        if (days.length === 0) {
            layout.attach(new St.Label({ text: _('暂无预报数据') }), 0, 0, 1, 1);
            return;
        }

        const today = GLib.DateTime.new_now_local();

        for (let i = 0; i < CALENDAR_COLS; i++) {
            const day = days[i] ?? null;

            const nameLabel = new St.Label({
                text: day ? calendarDayName(today, i) : '--',
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
                this._owner._applyIcon(icon, this._owner._createFileIcon(
                    `${this._owner.path}/icons/${safeIconCode(day.daytime?.condition?.code)}-symbolic.svg`));
            } else {
                this._owner._applyIcon(icon, null, 'weather-few-clouds-symbolic');
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

    destroy() {
        if (this._clickedId) {
            this._card?.disconnect(this._clickedId);
            this._clickedId = 0;
        }

        this._grid?.destroy();
        this._grid = null;
        this._cityLabel?.destroy();
        this._cityLabel = null;

        const card = this._card;
        this._card = null;
        card?.destroy();
    }
}

function shortCityName(name) {
    const s = String(name ?? '');
    const i = s.indexOf('，');
    return i > 0 ? s.slice(0, i) : s;
}

function calendarDayName(today, offset) {
    if (offset === 0) return _('今天');
    if (offset === 1) return _('明天');
    const names = [_('周日'), _('周一'), _('周二'), _('周三'),
                   _('周四'), _('周五'), _('周六')];
    return names[today.add_days(offset).get_day_of_week() % 7];
}

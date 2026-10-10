import { logError, parseCsvLine, toFiniteOrNull } from '../lib/util.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export class CitySearchSection {
    constructor(owner) {
        this._owner = owner;
        this._entry = null;
        this._statusLabel = null;
        this._statusItem = null;
        this._results = null;
        this._activateId = 0;
        this._changedId = 0;
        this._timeoutId = 0;
        this._cities = null;
        this._loading = false;
    }

    destroy() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._entry) {
            const clutterText = this._entry.clutter_text;
            if (this._activateId) {
                clutterText.disconnect(this._activateId);
                this._activateId = 0;
            }
            if (this._changedId) {
                clutterText.disconnect(this._changedId);
                this._changedId = 0;
            }
        }
        this._entry?.destroy();
        this._entry = null;
        this._statusLabel?.destroy();
        this._statusLabel = null;
        this._statusItem?.destroy();
        this._statusItem = null;
        this._results?.destroy();
        this._results = null;
        this._cities = null;
        this._loading = false;
    }

    build() {
        this._entry = new St.Entry({
            x_expand: true,
            track_hover: true,
            can_focus: true,
            style_class: 'climacn-search-entry'
        });
        this._activateId = this._entry.clutter_text.connect('activate', () => this._onSearchActivate());
        this._changedId = this._entry.clutter_text.connect('text-changed', () => this._onSearchTextChanged());

        const entryItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        entryItem.add_style_class_name('climacn-search-row');
        entryItem.add_child(this._entry);
        this._owner._indicator.menu.addMenuItem(entryItem);

        this._statusLabel = new St.Label({
            style_class: 'climacn-search-status'
        });
        this._statusItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        this._statusItem.add_style_class_name('climacn-search-row');
        this._statusItem.add_style_class_name('climacn-search-status-row');
        this._statusItem.add_child(this._statusLabel);
        this._statusItem.visible = false;
        this._owner._indicator.menu.addMenuItem(this._statusItem);

        this._results = new PopupMenu.PopupMenuSection();
        this._owner._indicator.menu.addMenuItem(this._results);
        this._results.actor.hide();
        this._updateSearchHint();
    }

    _updateSearchHint() {
        if (!this._entry || this._entry.text.trim())
            return;
        this._showSearchStatus(_('搜索城市，例：北京 / 海淀 / 朝阳'));
    }

    _loadCityData() {
        if (this._cities || this._loading) return;
        this._loading = true;
        const csvFile = Gio.File.new_for_path(`${this._owner.path}/data/China-City-List-latest.csv`);
        csvFile.load_contents_async(null, (file, result) => {
            if (!this._owner._isActive()) return;
            try {
                const [success, contents] = file.load_contents_finish(result);
                if (!success) throw new Error('load failed');
                this._parseCSV(new TextDecoder().decode(contents));
                this._loading = false;
            } catch (e) {
                logError(`Failed to load city data: ${e}`);
                this._cities = [];
                this._loading = false;
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
        this._cities = cities;
    }

    _onSearchTextChanged() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        const text = this._entry.text.trim();
        if (!text) {
            this._clearSearchResults();
            return;
        }
        if (!this._cities && !this._loading) this._loadCityData();
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._timeoutId = 0;
            this._performLocalSearch(text);
            return GLib.SOURCE_REMOVE;
        });
    }

    _onSearchActivate() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        const text = this._entry.text.trim();
        if (text) this._performLocalSearch(text);
    }

    _performLocalSearch(query) {
        this._clearSearchResults();
        if (!this._cities) {
            if (this._loading)
                this._showSearchStatus(_('正在加载城市库...'));
            else
                this._showSearchStatus(_('城市库未就绪，请稍后重试'));
            return;
        }
        if (this._cities.length === 0) {
            this._showSearchStatus(_('本地城市库为空，请检查文件'));
            return;
        }
        const q = query.toLowerCase();
        const results = [];
        for (const city of this._cities) {
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
        this._results.actor.show();
        for (const city of results) {
            let display = city.name;
            if (city.adm2 && city.adm2 !== city.name && city.adm2 !== city.adm1)
                display += `, ${city.adm2}`;
            display += ` - ${city.adm1}`;
            const item = new PopupMenu.PopupMenuItem(display);
            item.connect('activate', () => this._selectCity(city));
            this._results.addMenuItem(item);
        }
    }

    _showSearchStatus(text) {
        this._results?.actor.hide();
        if (!this._statusLabel || !this._statusItem)
            return;
        this._statusLabel.text = text;
        this._statusItem.visible = true;
    }

    _clearSearchStatus() {
        if (this._statusItem)
            this._statusItem.visible = false;
    }

    _clearSearchResults() {
        if (this._results) {
            this._results.removeAll();
            this._results.actor.hide();
        }
        this._clearSearchStatus();
        this._updateSearchHint();
    }

    _selectCity(city) {
        this._owner._latitude = city.lat;
        this._owner._longitude = city.lon;
        this._owner._currentCityName = `${city.name}，${city.adm1}`;
        this._owner._cityLabel.text = this._owner._currentCityName;

        this._owner._writingSettings = true;
        this._owner._settings.set_double('latitude', this._owner._latitude);
        this._owner._settings.set_double('longitude', this._owner._longitude);
        this._owner._settings.set_string('city-name', this._owner._currentCityName);
        this._owner._writingSettings = false;

        this._entry.text = '';
        this._clearSearchResults();
        this._owner._fetchWeather();
    }
}

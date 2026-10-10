import St from 'gi://St';
import GLib from 'gi://GLib';
import Cairo from 'gi://cairo';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { BAND_DOT_COLORS, DAY_MINUTES, MOON_DISC_RADIUS, MOON_LEGEND, SUN_LEGEND, bandRatio, bandSkyColorAt, moonArcPosition, moonUpSpans } from '../lib/astro.js';
import { BAND_HEIGHT, BAND_KNOB_R, BAND_NOW_H, BAND_NOW_W, BAND_RADIUS, BAND_STOPS, drawMoonDisc, roundedRectPath, themeColor } from '../lib/drawing.js';
import { formatClock } from '../lib/util.js';

export class SunMoonBands {
    constructor(owner) {
        this._owner = owner;
        this._astro = null;
        this._nowMinutes = 0;
        this._moonPosition = null;
        this._sunItem = null;
        this._sunArea = null;
        this._sunRepaintId = 0;
        this._sunLabels = [];
        this._moonItem = null;
        this._moonArea = null;
        this._moonRepaintId = 0;
        this._moonLabels = [];
    }

    build() {
        this._buildSun();
        this._buildMoon();
    }

    setData(astro) {
        this._astro = astro;
        const now = GLib.DateTime.new_now_local();
        this._nowMinutes = now.get_hour() * 60 + now.get_minute();
        this._moonPosition = this._astro?.moon
            ? moonArcPosition(this._nowMinutes, this._astro.moon) : null;

        if (this._sunItem) {
            this._sunItem.visible = this._astro !== null;
            if (this._astro) {
                SUN_LEGEND.forEach((ev, i) => {
                    this._sunLabels[i].text = formatClock(this._astro[ev.field]);
                });
                this._sunArea.queue_repaint();
            }
        }

        const moon = this._astro?.moon ?? null;
        if (this._moonItem) {
            this._moonItem.visible = moon !== null;
            if (moon) {
                this._moonLabels[0].text = formatClock(moon.moonrise);
                this._moonLabels[1].text = formatClock(moon.moonset);
                this._moonLabels[2].text = moon.phase?.name || '--';
                this._moonArea.queue_repaint();
            }
        }
    }

    clear() {
        this._astro = null;
        this._nowMinutes = 0;
        this._moonPosition = null;
        if (this._sunItem)
            this._sunItem.visible = false;
        if (this._moonItem)
            this._moonItem.visible = false;
    }

    destroy() {
        if (this._sunRepaintId) {
            this._sunArea?.disconnect(this._sunRepaintId);
            this._sunRepaintId = 0;
        }
        if (this._moonRepaintId) {
            this._moonArea?.disconnect(this._moonRepaintId);
            this._moonRepaintId = 0;
        }
        this._sunArea?.destroy();
        this._sunArea = null;
        this._sunLabels = [];
        this._sunItem?.destroy();
        this._sunItem = null;
        this._moonArea?.destroy();
        this._moonArea = null;
        this._moonLabels = [];
        this._moonItem?.destroy();
        this._moonItem = null;
    }

    _buildLegendItem(spec, legend) {
        const item = new St.BoxLayout({
            style_class: 'climacn-band-legend-item',
            vertical: true,
            x_expand: true
        });
        const head = new St.BoxLayout({ style_class: 'climacn-band-legend-head' });
        head.add_child(new St.Widget({
            style_class: `climacn-band-dot climacn-band-dot-${spec.key}`
        }));
        head.add_child(new St.Label({
            text: _(spec.label),
            style_class: 'climacn-band-legend-label'
        }));
        item.add_child(head);
        const time = new St.Label({
            text: '--:--',
            style_class: 'climacn-band-legend-time'
        });
        item.add_child(time);
        legend.add_child(item);
        return time;
    }

    _buildSun() {
        const outer = new St.BoxLayout({
            style_class: 'climacn-sun-arc',
            vertical: true,
            x_expand: true
        });

        this._sunArea = new St.DrawingArea({
            style_class: 'climacn-sun-arc-canvas',
            x_expand: true,
            height: BAND_HEIGHT
        });
        this._sunRepaintId = this._sunArea.connect('repaint', () => this._drawSun());
        outer.add_child(this._sunArea);

        const legend = new St.BoxLayout({
            style_class: 'climacn-band-legend',
            x_expand: true
        });
        this._sunLabels = SUN_LEGEND.map(ev => this._buildLegendItem(ev, legend));
        outer.add_child(legend);

        this._sunItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        this._sunItem.add_child(outer);
        this._sunItem.visible = false;
        this._owner._indicator.menu.addMenuItem(this._sunItem);
    }

    _buildMoon() {
        const outer = new St.BoxLayout({
            style_class: 'climacn-moon-arc',
            vertical: true,
            x_expand: true
        });

        this._moonArea = new St.DrawingArea({
            style_class: 'climacn-sun-arc-canvas',
            x_expand: true,
            height: BAND_HEIGHT
        });
        this._moonRepaintId = this._moonArea.connect('repaint', () => this._drawMoon());
        outer.add_child(this._moonArea);

        const legend = new St.BoxLayout({
            style_class: 'climacn-band-legend',
            x_expand: true
        });
        this._moonLabels = MOON_LEGEND.map(ev => this._buildLegendItem(ev, legend));
        outer.add_child(legend);

        this._moonItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        this._moonItem.add_child(outer);
        this._moonItem.visible = false;
        this._owner._indicator.menu.addMenuItem(this._moonItem);
    }

    _drawNowMark(cr, width, cy, height, scaleFactor) {
        const now = bandRatio(this._nowMinutes);
        if (now === null)
            return;
        const w = Math.max(2, BAND_NOW_W * scaleFactor);
        const h = Math.min(height, BAND_NOW_H * scaleFactor);
        const x = Math.min(Math.max(now * width, w / 2), width - w / 2);
        cr.setSourceRGBA(1, 1, 1, 0.95);
        roundedRectPath(cr, x - w / 2, cy - h / 2, w, h, w / 2);
        cr.fill();
    }

    _drawSun() {
        const area = this._sunArea;
        const astro = this._astro;
        if (!area || !astro)
            return;
        const [width, height] = area.get_surface_size();
        if (width <= 0 || height <= 0)
            return;
        const cr = area.get_context();
        try {
            const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);
            const bandH = Math.min(height, BAND_HEIGHT * scaleFactor);
            const y = (height - bandH) / 2;
            const cy = height / 2;

            const grad = new Cairo.LinearGradient(0, 0, width, 0);
            for (let i = 0; i <= BAND_STOPS; i++) {
                const t = i / BAND_STOPS;
                const c = bandSkyColorAt(t, astro);
                grad.addColorStopRGBA(t, c[0], c[1], c[2], 1);
            }
            cr.setSource(grad);
            roundedRectPath(cr, 0, y, width, bandH,
                                  BAND_RADIUS * scaleFactor);
            cr.fill();

            cr.setSourceRGBA(1, 1, 1, 0.45);
            cr.setLineWidth(Math.max(1, 1.5 * scaleFactor));
            cr.moveTo(0, cy);
            cr.lineTo(width, cy);
            cr.stroke();

            const knobR = BAND_KNOB_R * scaleFactor;
            const ringW = Math.max(1.2, 1.6 * scaleFactor);
            for (const ev of SUN_LEGEND) {
                const r = bandRatio(astro[ev.field]);
                if (r === null)
                    continue;
                const color = BAND_DOT_COLORS[ev.key];
                const x = r * width;
                cr.setSourceRGBA(0, 0, 0, 0.45);
                cr.setLineWidth(Math.max(1, 1.2 * scaleFactor));
                cr.arc(x, cy, knobR + ringW, 0, 2 * Math.PI);
                cr.stroke();
                cr.setSourceRGBA(color[0], color[1], color[2], 1);
                cr.arc(x, cy, knobR, 0, 2 * Math.PI);
                cr.fill();
                cr.setSourceRGBA(1, 1, 1, 0.9);
                cr.setLineWidth(ringW);
                cr.arc(x, cy, knobR, 0, 2 * Math.PI);
                cr.stroke();
            }

            this._drawNowMark(cr, width, cy, height, scaleFactor);
        } finally {
            cr.$dispose();
        }
    }

    _drawMoon() {
        const area = this._moonArea;
        const moon = this._astro?.moon;
        if (!area || !moon)
            return;
        const [width, height] = area.get_surface_size();
        if (width <= 0 || height <= 0)
            return;
        const cr = area.get_context();
        try {
            const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);
            const bandH = Math.min(height, BAND_HEIGHT * scaleFactor);
            const y = (height - bandH) / 2;
            const cy = height / 2;
            const fg = themeColor(area);
            const radius = BAND_RADIUS * scaleFactor;

            cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.16);
            roundedRectPath(cr, 0, y, width, bandH, radius);
            cr.fill();

            for (const [start, end] of moonUpSpans(moon)) {
                const x0 = (start / DAY_MINUTES) * width;
                const x1 = (end / DAY_MINUTES) * width;
                cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.42);
                roundedRectPath(cr, x0, y, x1 - x0, bandH, radius);
                cr.fill();
            }

            cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.45);
            cr.setLineWidth(Math.max(1, 1.5 * scaleFactor));
            cr.moveTo(0, cy);
            cr.lineTo(width, cy);
            cr.stroke();

            cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.30);
            cr.setLineWidth(Math.max(1, 1 * scaleFactor));
            roundedRectPath(cr, 0, y, width, bandH, radius);
            cr.stroke();

            const knobR = BAND_KNOB_R * scaleFactor;
            const ringW = Math.max(1.2, 1.6 * scaleFactor);
            const knobColor = BAND_DOT_COLORS.moon;
            for (const m of [moon.moonrise, moon.moonset % DAY_MINUTES]) {
                const r = bandRatio(m);
                if (r === null)
                    continue;
                const x = r * width;
                cr.setSourceRGBA(0, 0, 0, 0.45);
                cr.setLineWidth(Math.max(1, 1.2 * scaleFactor));
                cr.arc(x, cy, knobR + ringW, 0, 2 * Math.PI);
                cr.stroke();
                cr.setSourceRGBA(knobColor[0], knobColor[1], knobColor[2], 1);
                cr.arc(x, cy, knobR, 0, 2 * Math.PI);
                cr.fill();
                cr.setSourceRGBA(1, 1, 1, 0.9);
                cr.setLineWidth(ringW);
                cr.arc(x, cy, knobR, 0, 2 * Math.PI);
                cr.stroke();
            }

            const now = bandRatio(this._nowMinutes);
            if (now === null)
                return;
            const discR = MOON_DISC_RADIUS * scaleFactor;
            const x = Math.min(Math.max(now * width, discR), width - discR);
            drawMoonDisc(cr, x, cy, discR, moon.phase, fg,
                               this._moonPosition?.isUp ? 1 : 0.4);
        } finally {
            cr.$dispose();
        }
    }
}

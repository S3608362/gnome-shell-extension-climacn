import St from 'gi://St';
import Cairo from 'gi://cairo';
import PangoCairo from 'gi://PangoCairo';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { COLOR_HIGH, COLOR_LOW, MOON_STRIP_HEIGHT, TEMP_RAMP, TREND_CHART_HEIGHT, TREND_CHART_WIDTH, TREND_LABEL_PX, cairoFontDescription, drawCenteredText, drawMoonDisc, themeColor } from '../lib/drawing.js';

export class TrendChart {
    constructor(owner) {
        this._owner = owner;
        this._item = null;
        this._area = null;
        this._repaintId = 0;
        this._moonArea = null;
        this._moonRepaintId = 0;
        this._points = [];
        this._phases = [];
    }

    setData(points, phases) {
        this._points = points;
        this._phases = phases;
        const show = Array.isArray(points) && points.filter(Boolean).length >= 2;
        if (this._item)
            this._item.visible = show;
        if (show) {
            this._area?.queue_repaint();
            this._moonArea?.queue_repaint();
        }
    }

    clear() {
        this._points = [];
        this._phases = [];
        if (this._item)
            this._item.visible = false;
    }

    destroy() {
        if (this._moonRepaintId) {
            this._moonArea?.disconnect(this._moonRepaintId);
            this._moonRepaintId = 0;
        }
        if (this._repaintId) {
            this._area?.disconnect(this._repaintId);
            this._repaintId = 0;
        }
        this._area?.destroy();
        this._area = null;
        this._moonArea?.destroy();
        this._moonArea = null;
        this._item?.destroy();
        this._item = null;
        this._points = [];
        this._phases = [];
    }

    build() {
        this._item = new PopupMenu.PopupSubMenuMenuItem(_('10 天趋势'), false);
        this._item.visible = false;

        this._area = new St.DrawingArea({
            style_class: 'climacn-trend-chart',
            width: TREND_CHART_WIDTH,
            height: TREND_CHART_HEIGHT
        });
        this._repaintId = this._area.connect('repaint', () => this._drawChart());

        const box = new St.BoxLayout({
            style_class: 'climacn-trend-box',
            vertical: true
        });
        box.add_child(this._area);

        this._moonArea = new St.DrawingArea({
            style_class: 'climacn-trend-moons',
            width: TREND_CHART_WIDTH,
            height: MOON_STRIP_HEIGHT
        });
        this._moonRepaintId =
            this._moonArea.connect('repaint', () => this._drawMoons());
        box.add_child(this._moonArea);

        const item = new PopupMenu.PopupBaseMenuItem({ activate: false });
        item.add_child(box);
        this._item.menu.addMenuItem(item);
        this._owner._indicator.menu.addMenuItem(this._item);
    }

    _drawChart() {
        const area = this._area;
        if (!area)
            return;
        const points = this._points;
        if (!Array.isArray(points) || points.length < 2)
            return;
        const [width, height] = area.get_surface_size();
        const cr = area.get_context();
        try {
            const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);
            const themeNode = area.get_theme_node();
            const dotR = Math.max(1.5, 1.8 * scaleFactor);
            const labelH = TREND_LABEL_PX * scaleFactor + 2;
            const padX = 10 * scaleFactor;
            const plotTop = dotR + labelH + 2;
            const plotBottom = height - dotR - labelH - 2;
            const plotW = width - 2 * padX;
            const plotH = plotBottom - plotTop;
            if (plotW <= 0 || plotH <= 0)
                return;

            const days = points.filter(Boolean);
            if (days.length < 2)
                return;
            const lo = Math.min(...days.map(p => p.min));
            const hi = Math.max(...days.map(p => p.max));
            const span = hi - lo || 1;

            const xAt = i => padX + (plotW * i) / (points.length - 1);
            const yAt = v => plotTop + plotH * (1 - (v - lo) / span);

            const segments = [];
            let seg = null;
            for (let i = 0; i < points.length; i++) {
                if (points[i]) {
                    if (!seg)
                        segments.push(seg = []);
                    seg.push(i);
                } else {
                    seg = null;
                }
            }

            const HIGH = [...COLOR_HIGH, 0.95];
            const LOW = [...COLOR_LOW, 0.95];

            cr.newSubPath();
            for (const s of segments) {
                cr.moveTo(xAt(s[0]), yAt(points[s[0]].max));
                for (const i of s)
                    cr.lineTo(xAt(i), yAt(points[i].max));
                for (let k = s.length - 1; k >= 0; k--)
                    cr.lineTo(xAt(s[k]), yAt(points[s[k]].min));
                cr.closePath();
            }
            const bandGrad = new Cairo.LinearGradient(0, plotTop, 0, plotBottom);
            for (const [off, r, g, b] of TEMP_RAMP)
                bandGrad.addColorStopRGBA(1 - off, r, g, b, 0.30);
            cr.setSource(bandGrad);
            cr.fill();

            cr.newSubPath();
            for (const s of segments) {
                cr.moveTo(xAt(s[0]), yAt(points[s[0]].min));
                for (const i of s)
                    cr.lineTo(xAt(i), yAt(points[i].min));
                cr.lineTo(xAt(s[s.length - 1]), plotBottom);
                cr.lineTo(xAt(s[0]), plotBottom);
                cr.closePath();
            }
            const groundGrad = new Cairo.LinearGradient(0, plotTop, 0, plotBottom);
            groundGrad.addColorStopRGBA(0, COLOR_LOW[0], COLOR_LOW[1], COLOR_LOW[2], 0.18);
            groundGrad.addColorStopRGBA(1, COLOR_LOW[0], COLOR_LOW[1], COLOR_LOW[2], 0.0);
            cr.setSource(groundGrad);
            cr.fill();

            const polyline = (key, rgba) => {
                cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], rgba[3]);
                cr.setLineWidth(Math.max(1.2, 1.6 * scaleFactor));
                cr.setLineJoin(Cairo.LineJoin.ROUND);
                cr.newSubPath();
                for (const s of segments) {
                    cr.moveTo(xAt(s[0]), yAt(points[s[0]][key]));
                    for (const i of s)
                        cr.lineTo(xAt(i), yAt(points[i][key]));
                }
                cr.stroke();
            };

            polyline('max', HIGH);
            polyline('min', LOW);

            const layout = PangoCairo.create_layout(cr);
            let themeFont = null;
            try {
                themeFont = themeNode.get_font();
            } catch (_e) {
                themeFont = null;
            }
            layout.set_font_description(cairoFontDescription(themeFont, TREND_LABEL_PX, scaleFactor));

            for (const s of segments) {
                for (const i of s) {
                    const p = points[i];
                    cr.setSourceRGBA(HIGH[0], HIGH[1], HIGH[2], 1);
                    cr.arc(xAt(i), yAt(p.max), dotR, 0, 2 * Math.PI);
                    cr.fill();
                    cr.setSourceRGBA(LOW[0], LOW[1], LOW[2], 1);
                    cr.arc(xAt(i), yAt(p.min), dotR, 0, 2 * Math.PI);
                    cr.fill();

                    cr.setSourceRGBA(HIGH[0], HIGH[1], HIGH[2], 0.95);
                    drawCenteredText(cr, layout, `${Math.round(p.max)}°`,
                                     xAt(i), yAt(p.max) - dotR - labelH / 2);
                    cr.setSourceRGBA(LOW[0], LOW[1], LOW[2], 0.95);
                    drawCenteredText(cr, layout, `${Math.round(p.min)}°`,
                                     xAt(i), yAt(p.min) + dotR + labelH / 2);
                }
            }
        } finally {
            cr.$dispose();
        }
    }

    _drawMoons() {
        const area = this._moonArea;
        const phases = this._phases;
        if (!area || !Array.isArray(phases) || phases.length === 0)
            return;
        const [width, height] = area.get_surface_size();
        if (width <= 0 || height <= 0)
            return;
        const cr = area.get_context();
        try {
            const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);
            const fg = themeColor(area);
            const r = Math.max(3, 6 * scaleFactor);
            const cy = r + 2 * scaleFactor;

            const padX = 10 * scaleFactor;
            const step = phases.length > 1
                ? (width - 2 * padX) / (phases.length - 1)
                : 0;
            const cxAt = i => phases.length > 1 ? padX + step * i : width / 2;

            const layout = PangoCairo.create_layout(cr);
            let themeFont = null;
            try {
                themeFont = area.get_theme_node().get_font();
            } catch (_e) {
                themeFont = null;
            }
            layout.set_font_description(cairoFontDescription(themeFont, 7, scaleFactor));

            for (let i = 0; i < phases.length; i++) {
                const phase = phases[i];
                if (!phase)
                    continue;
                const cx = cxAt(i);
                drawMoonDisc(cr, cx, cy, r, phase, fg, 0.95);
                cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.6);
                drawCenteredText(cr, layout, `${Math.round(phase.lit * 100)}%`,
                                 cx, height - 5 * scaleFactor);
            }
        } finally {
            cr.$dispose();
        }
    }
}

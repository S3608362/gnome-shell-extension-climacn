import { MOON_DARK_ALPHA, MOON_LIT_ALPHA } from './astro.js';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
export const BAND_HEIGHT = 34;
export const BAND_RADIUS = 6;
export const BAND_KNOB_R = 5;
export const BAND_NOW_W = 3;
export const BAND_NOW_H = 22;
export const BAND_STOPS = 96;
export const TREND_CHART_HEIGHT = 64;
export const TREND_CHART_WIDTH = 400;
export const TREND_LABEL_PX = 8;
export const MOON_STRIP_HEIGHT = 30;
export const TEMP_BAR_HEIGHT = 8;
export const TEMP_BAR_WIDTH = 110;
export const COLOR_HIGH = [0.95, 0.55, 0.20];
export const COLOR_LOW = [0.30, 0.60, 0.95];
export const TEMP_RAMP = [
    [0.00, 0.30, 0.60, 0.95],
    [0.35, 0.35, 0.80, 0.85],
    [0.60, 0.95, 0.85, 0.30],
    [1.00, 0.95, 0.55, 0.20],
];
export function cairoFontDescription(themeFont, sizePx, scaleFactor) {
    let font = null;
    try {
        font = themeFont?.copy() ?? null;
    } catch (_e) {
        font = null;
    }
    if (!font || !font.get_family())
        font = Pango.FontDescription.from_string('Sans');
    font.set_absolute_size(Math.round(sizePx * scaleFactor) * Pango.SCALE);
    return font;
}
export function drawCenteredText(cr, layout, text, x, y) {
    layout.set_text(String(text), -1);
    const [textW, textH] = layout.get_pixel_size();
    cr.moveTo(Math.round(x - textW / 2), Math.round(y - textH / 2));
    PangoCairo.show_layout(cr, layout);
}

export function drawMoonDisc(cr, cx, cy, r, phase, fg, alpha = 1) {
    if (!(r > 0))
        return;
    const lit = Math.min(Math.max(phase?.lit ?? 0, 0), 1);

    cr.setSourceRGBA(fg[0], fg[1], fg[2], MOON_DARK_ALPHA * alpha);
    cr.arc(cx, cy, r, 0, 2 * Math.PI);
    cr.fill();

    if (lit > 0.001) {
        cr.save();
        if (!(phase?.waxing ?? true)) {
            cr.translate(cx, cy);
            cr.scale(-1, 1);
            cr.translate(-cx, -cy);
        }
        const a = Math.max(Math.abs(1 - 2 * lit), 0.001);
        cr.newSubPath();
        cr.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2);
        cr.save();
        cr.translate(cx, cy);
        cr.scale(a, 1);
        if (lit > 0.5)
            cr.arc(0, 0, r, Math.PI / 2, 3 * Math.PI / 2);
        else
            cr.arcNegative(0, 0, r, Math.PI / 2, -Math.PI / 2);
        cr.restore();
        cr.closePath();
        cr.setSourceRGBA(fg[0], fg[1], fg[2], MOON_LIT_ALPHA * alpha);
        cr.fill();
        cr.restore();
    }

    cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.45 * alpha);
    cr.setLineWidth(Math.max(0.8, r * 0.14));
    cr.arc(cx, cy, r, 0, 2 * Math.PI);
    cr.stroke();
}

export function themeColor(area) {
    const [hasFg, fg] = area.get_theme_node().lookup_color('color', false);
    return hasFg ? [fg.red / 255, fg.green / 255, fg.blue / 255] : [0.5, 0.5, 0.5];
}

export function roundedRectPath(cr, x, y, w, h, radius) {
    const r = Math.max(0, Math.min(radius, h / 2, w / 2));
    cr.newSubPath();
    if (r <= 0) {
        cr.rectangle(x, y, w, h);
        return;
    }
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
    cr.closePath();
}

export function roundedBarPath(cr, x, y, w, h) {
    const r = Math.min(h / 2, w / 2);
    if (r <= 0)
        return;
    cr.newSubPath();
    cr.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5);
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
    cr.closePath();
}

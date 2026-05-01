/**
 * Insights view — two visualizations rolled up from the existing
 * AnalyticsService:
 *   1. Volume by muscle category over the trailing 4 weeks (horizontal
 *      bars), sized so the heaviest category fills the available width.
 *   2. A 12-month calendar heatmap colored by total daily volume.
 *
 * Both are inline SVG / DOM grid — no chart library, no extra deps.
 * The view registers itself with `app.viewControllers.insights` so the
 * navigation path in app.js can re-render it on every show.
 */

import { app } from '../app.js';
import { AnalyticsService } from '../services/AnalyticsService.js';
import { escapeHtml, parseLocalDate } from '../utils/helpers.js';

const CATEGORY_LABEL = {
    chest: 'Chest', back: 'Back', shoulders: 'Shoulders',
    biceps: 'Biceps', triceps: 'Triceps', forearms: 'Forearms',
    quads: 'Quads', hamstrings: 'Hamstrings', glutes: 'Glutes', calves: 'Calves',
    core: 'Core', abs: 'Abs', obliques: 'Obliques', traps: 'Traps', neck: 'Neck',
    'full-body': 'Full body', cardio: 'Cardio', other: 'Other',
};

class InsightsView {
    constructor() {
        this.app = app;
        this.app.viewControllers.insights = this;
    }

    render() {
        const sessions = this.app.workoutSessions || [];
        const empty = document.getElementById('insights-empty');
        const volumeSection = document.getElementById('insights-volume-section');
        const heatmapSection = document.getElementById('insights-heatmap-section');

        if (sessions.length === 0) {
            if (empty) empty.hidden = false;
            if (volumeSection) volumeSection.hidden = true;
            if (heatmapSection) heatmapSection.hidden = true;
            return;
        }
        if (empty) empty.hidden = true;
        if (volumeSection) volumeSection.hidden = false;
        if (heatmapSection) heatmapSection.hidden = false;

        this.renderVolumeBars(sessions);
        this.renderHeatmap(sessions);
    }

    /**
     * Trailing-4-week volume by category, horizontal bars normalized to
     * the heaviest bucket so widths read at a glance. Buckets with zero
     * volume in the window are dropped.
     */
    renderVolumeBars(sessions) {
        const grid = document.getElementById('insights-volume-grid');
        const caption = document.getElementById('insights-volume-caption');
        if (!grid) return;
        const now = new Date();
        const start = new Date(now);
        start.setDate(now.getDate() - 28);
        start.setHours(0, 0, 0, 0);
        const end = new Date(now);
        end.setHours(0, 0, 0, 0);
        end.setDate(end.getDate() + 1); // inclusive of today

        const totals = AnalyticsService.getVolumeByCategoryInRange(
            sessions, this.app.exerciseDatabase || [], start, end,
        );
        const unit = this.app.settings?.weightUnit || 'kg';

        if (caption) {
            const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            caption.textContent = `${fmt(start)} – ${fmt(now)}`;
        }

        if (totals.length === 0) {
            grid.innerHTML = `<p class="insights-empty-line">No volume in the last 4 weeks.</p>`;
            return;
        }
        const max = totals[0].volume;
        grid.innerHTML = totals.map(({ category, volume }) => {
            const label = CATEGORY_LABEL[category] || (category[0]?.toUpperCase() + category.slice(1));
            const pct = Math.max(2, Math.round((volume / max) * 100));
            return `
                <div class="insights-bar-row" role="group" aria-label="${escapeHtml(label)}">
                    <div class="insights-bar-label">${escapeHtml(label)}</div>
                    <div class="insights-bar-track">
                        <span class="insights-bar-fill" style="width: ${pct}%"></span>
                    </div>
                    <div class="insights-bar-value">${Math.round(volume).toLocaleString()} ${escapeHtml(unit)}</div>
                </div>
            `;
        }).join('');
    }

    /**
     * 365-day calendar heatmap. Renders a row of week-columns from oldest
     * (left) to newest (right). Each column is a Sun..Sat stack of seven
     * day cells. Cell intensity = volume relative to the 95th-percentile
     * non-zero volume in the year — outliers don't wash out the bulk.
     */
    renderHeatmap(sessions) {
        const host = document.getElementById('insights-heatmap');
        const caption = document.getElementById('insights-heatmap-caption');
        if (!host) return;

        const dailyMap = AnalyticsService.getDailyVolumeMap(sessions);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const start = new Date(today);
        start.setDate(today.getDate() - 364);

        // 95th percentile of non-zero daily volume to set the color scale.
        const values = [...dailyMap.values()].filter(v => v > 0).sort((a, b) => a - b);
        const p95 = values.length ? values[Math.floor(values.length * 0.95)] : 0;
        const cap = p95 || 1;

        const cursor = new Date(start);
        // Roll cursor back to the most-recent Sunday so columns align.
        cursor.setDate(cursor.getDate() - cursor.getDay());

        const monthLabels = [];
        const cells = [];
        let lastMonth = -1;
        let weekIdx = 0;
        while (cursor <= today) {
            const weekHTML = [];
            const weekStartLabel = cursor.getMonth();
            for (let dow = 0; dow < 7; dow++) {
                const inRange = cursor >= start && cursor <= today;
                const dateStr = AnalyticsService.toLocalDateKey(cursor);
                const vol = inRange ? (dailyMap.get(dateStr) || 0) : 0;
                const intensity = Math.min(1, vol / cap);
                const level = vol === 0 ? 0 : Math.max(1, Math.ceil(intensity * 4));
                const label = inRange
                    ? `${dateStr}: ${Math.round(vol).toLocaleString()}`
                    : '';
                weekHTML.push(
                    `<div class="hm-cell hm-cell-l${level}${inRange ? '' : ' hm-cell-out'}" title="${escapeHtml(label)}"></div>`,
                );
                cursor.setDate(cursor.getDate() + 1);
            }
            cells.push(`<div class="hm-week">${weekHTML.join('')}</div>`);
            // Month label appears on the first column of a new month.
            if (weekStartLabel !== lastMonth) {
                monthLabels.push({ idx: weekIdx, month: weekStartLabel });
                lastMonth = weekStartLabel;
            }
            weekIdx += 1;
        }

        const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const monthLabelsHTML = monthLabels.map(({ idx, month }) =>
            `<span class="hm-month-label" style="grid-column-start: ${idx + 1};">${monthNames[month]}</span>`,
        ).join('');

        host.innerHTML = `
            <div class="hm-month-row" style="grid-template-columns: repeat(${weekIdx}, 1fr);">${monthLabelsHTML}</div>
            <div class="hm-grid" style="grid-template-columns: repeat(${weekIdx}, 1fr);">${cells.join('')}</div>
            <div class="hm-legend">
                <span class="hm-legend-label">Less</span>
                <span class="hm-cell hm-cell-l0"></span>
                <span class="hm-cell hm-cell-l1"></span>
                <span class="hm-cell hm-cell-l2"></span>
                <span class="hm-cell hm-cell-l3"></span>
                <span class="hm-cell hm-cell-l4"></span>
                <span class="hm-legend-label">More</span>
            </div>
        `;

        if (caption) {
            const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
            caption.textContent = `${fmt(start)} – ${fmt(today)}`;
        }
    }
}

new InsightsView();

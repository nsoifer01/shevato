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
import { on, EVENTS } from '../utils/event-bus.js';

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
        // Re-render when the underlying data changes — but only when this
        // view is currently visible. Off-screen renders are pure waste.
        const refresh = () => {
            if (this.app.currentView === 'insights') this.render();
        };
        on(EVENTS.SESSIONS_CHANGED, refresh);
        on(EVENTS.CUSTOM_EXERCISES_CHANGED, refresh);
    }

    render() {
        const sessions = this.app.workoutSessions || [];
        const empty = document.getElementById('insights-empty');
        const volumeSection = document.getElementById('insights-volume-section');
        const heatmapSection = document.getElementById('insights-heatmap-section');
        const progressionSection = document.getElementById('insights-progression-section');

        if (sessions.length === 0) {
            if (empty) empty.hidden = false;
            if (volumeSection) volumeSection.hidden = true;
            if (heatmapSection) heatmapSection.hidden = true;
            if (progressionSection) progressionSection.hidden = true;
            return;
        }
        if (empty) empty.hidden = true;
        if (volumeSection) volumeSection.hidden = false;
        if (heatmapSection) heatmapSection.hidden = false;
        if (progressionSection) progressionSection.hidden = false;

        this.renderVolumeBars(sessions);
        this.renderHeatmap(sessions);
        this.renderProgressionChart(sessions);
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

    /**
     * Exercise progression section: dropdown of all logged exercises,
     * chart of top-set weight over time using the same inline-SVG pattern
     * used by the heatmap and measurements sparklines.
     */
    renderProgressionChart(sessions) {
        const section = document.getElementById('insights-progression-section');
        if (!section) return;

        // Build ordered list of exercises the user has actually logged,
        // sorted by most-recent session descending (most-used first).
        const exMap = new Map();
        sessions.forEach(s => {
            (s.exercises || []).forEach(ex => {
                if (!exMap.has(ex.exerciseId)) {
                    exMap.set(ex.exerciseId, ex.exerciseName || ex.exerciseId);
                }
            });
        });

        if (exMap.size === 0) return;

        const selectEl = section.querySelector('.insights-progression-select');
        const chartEl = section.querySelector('#insights-prog-chart-host');
        if (!selectEl || !chartEl) return;

        // Populate dropdown if not yet done (preserve selection across renders).
        const currentVal = selectEl.value;
        const optionIds = new Set([...selectEl.options].map(o => o.value));
        exMap.forEach((name, id) => {
            const key = String(id);
            if (!optionIds.has(key)) {
                const opt = document.createElement('option');
                opt.value = key;
                opt.textContent = escapeHtml(name);
                selectEl.appendChild(opt);
            }
        });
        if (!selectEl.value && selectEl.options.length > 0) {
            selectEl.value = selectEl.options[0].value;
        }

        if (!selectEl.dataset.wired) {
            selectEl.dataset.wired = '1';
            selectEl.addEventListener('change', () => this._drawProgression(sessions, selectEl, chartEl));
        }

        this._drawProgression(sessions, selectEl, chartEl);
    }

    _drawProgression(sessions, selectEl, chartEl) {
        const exerciseId = Number(selectEl.value) || selectEl.value;
        const unit = this.app.settings?.weightUnit || 'kg';

        const points = AnalyticsService.getExerciseProgression(exerciseId, sessions);
        if (points.length < 2) {
            chartEl.innerHTML = `<p class="insights-prog-empty">Log more sessions to see progress.</p>`;
            return;
        }

        const W = 560;
        const H = 120;
        const padL = 36;
        const padR = 10;
        const padT = 8;
        const padB = 22;
        const plotW = W - padL - padR;
        const plotH = H - padT - padB;

        const weights = points.map(p => p.maxWeight);
        const minW = Math.min(...weights);
        const maxW = Math.max(...weights);
        const rangeW = Math.max(1, maxW - minW);

        const dates = points.map(p => AnalyticsService.toLocalDate(p.date).getTime());
        const minD = Math.min(...dates);
        const maxD = Math.max(...dates);
        const rangeD = Math.max(1, maxD - minD);

        const toX = (d) => padL + ((AnalyticsService.toLocalDate(d).getTime() - minD) / rangeD) * plotW;
        const toY = (w) => padT + plotH - ((w - minW) / rangeW) * plotH;

        const polyPts = points.map(p => `${toX(p.date).toFixed(1)},${toY(p.maxWeight).toFixed(1)}`).join(' ');
        const dots = points.map(p =>
            `<circle class="insights-prog-dot" cx="${toX(p.date).toFixed(1)}" cy="${toY(p.maxWeight).toFixed(1)}" r="3" />`
        ).join('');

        const fmtDate = (d) => {
            const dt = AnalyticsService.toLocalDate(d);
            return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        };

        const yTicks = [minW, Math.round((minW + maxW) / 2), maxW];
        const yLabels = yTicks.map(v =>
            `<text class="insights-prog-label" x="${padL - 4}" y="${toY(v).toFixed(1)}" text-anchor="end" dominant-baseline="middle">${Math.round(v)}</text>`
        ).join('');

        chartEl.innerHTML = `
            <svg class="insights-progression-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-label="Exercise progression chart">
                <line class="insights-prog-axis" x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" />
                <line class="insights-prog-axis" x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" />
                ${yLabels}
                <text class="insights-prog-label" x="${toX(points[0].date).toFixed(1)}" y="${H - 4}" text-anchor="start">${escapeHtml(fmtDate(points[0].date))}</text>
                <text class="insights-prog-label" x="${toX(points[points.length - 1].date).toFixed(1)}" y="${H - 4}" text-anchor="end">${escapeHtml(fmtDate(points[points.length - 1].date))}</text>
                <polyline class="insights-prog-line" points="${polyPts}" />
                ${dots}
            </svg>
            <p style="font-size:0.72rem;color:var(--gt-muted-2);margin:0.2rem 0 0 ${padL}px;">Top-set weight (${escapeHtml(unit)})</p>
        `;
    }
}

new InsightsView();

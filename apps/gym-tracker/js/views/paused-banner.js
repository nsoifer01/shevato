/**
 * Active Workout Recovery Banner
 * Shared renderer consumed by Home and Workout views so there is one
 * source of truth for the resume-a-workout UI.
 *
 * It used to render ONLY for a workout the user had explicitly paused
 * (`if (!pausedWorkout.paused) return null`), which is half of why an
 * interrupted session was unrecoverable (GT-01). It now renders for any
 * recoverable workout and adapts its wording: a paused workout is something
 * the lifter chose, an interrupted one is something that happened to them
 * and needs a sentence of explanation.
 */
import { storageService } from '../services/StorageService.js';
import { escapeHtml } from '../utils/helpers.js';
import {
    activeWorkoutBannerCopy,
    readableActiveWorkout,
    wasExplicitlyPaused,
} from '../utils/active-workout.js';

function formatTimeAgo(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins} min ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
}

/**
 * Returns the banner HTML for the recoverable workout, or null if there
 * isn't one.
 *
 * @param {object} [opts]
 * @param {'home'|'workout'} [opts.location='workout'] Hint used for telemetry
 *        and allows each host to later tailor its affordances if needed.
 * @param {boolean} [opts.withCalendarMeta=true] Show the "Paused N days ago" meta
 */
export function renderPausedBannerHTML(opts = {}) {
    const { withCalendarMeta = true } = opts;
    const workout = readableActiveWorkout(storageService.getActiveWorkout());
    if (!workout) return null;

    const copy = activeWorkoutBannerCopy(workout);
    const elapsed = workout.elapsedBeforePause || 0;
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    const name = escapeHtml(workout.workoutDayName || 'Workout');

    // An interrupted workout has no pausedAt; fall back to when it started so
    // the "how long ago" chip still says something true.
    const stamp = workout.pausedAt || workout.startTime || workout.timestamp;
    const when = stamp ? new Date(stamp) : null;
    const whenLabel = wasExplicitlyPaused(workout) ? 'Paused' : 'Started';

    return `
        <div class="paused-workout-banner${wasExplicitlyPaused(workout) ? '' : ' paused-workout-banner--interrupted'}">
            <div class="paused-workout-icon">
                <i class="fas ${copy.icon}"></i>
            </div>
            <div class="paused-workout-info">
                <h3>${copy.title}</h3>
                <p><strong>${name}</strong></p>
                <p class="paused-workout-meta">
                    <span><i class="fas fa-clock"></i> ${minutes}:${String(seconds).padStart(2, '0')} elapsed</span>
                    <span><i class="fas fa-dumbbell"></i> ${copy.sets} set${copy.sets !== 1 ? 's' : ''}</span>
                    ${withCalendarMeta && when && !Number.isNaN(when.getTime())
                        ? `<span><i class="fas fa-calendar"></i> ${whenLabel} ${formatTimeAgo(when)}</span>`
                        : ''}
                </p>
                ${copy.note ? `<p class="paused-workout-note">${escapeHtml(copy.note)}</p>` : ''}
            </div>
            <div class="paused-workout-actions">
                <button class="btn btn-primary" data-paused-action="resume">
                    <i class="fas fa-play"></i> Resume
                </button>
                <button class="btn btn-outline btn-danger-outline" data-paused-action="discard">
                    <i class="fas fa-trash"></i> Discard
                </button>
            </div>
        </div>
    `;
}

/**
 * Bind click handlers on a recovery banner's action buttons. The host view
 * supplies onResume/onDiscard so control flow stays with each view.
 */
export function wirePausedBannerActions(container, { onResume, onDiscard }) {
    if (!container) return;
    const resumeBtn = container.querySelector('[data-paused-action="resume"]');
    const discardBtn = container.querySelector('[data-paused-action="discard"]');
    if (resumeBtn && onResume) resumeBtn.addEventListener('click', onResume);
    if (discardBtn && onDiscard) discardBtn.addEventListener('click', onDiscard);
}

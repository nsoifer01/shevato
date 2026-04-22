/**
 * Paused Workout Banner
 * Shared renderer consumed by Home and Workout views so there is one
 * source of truth for the paused-workout UI.
 */
import { storageService } from '../services/StorageService.js';
import { escapeHtml } from '../utils/helpers.js';

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
 * Returns the banner HTML for the currently paused workout, or null if
 * no paused workout exists.
 *
 * @param {object} [opts]
 * @param {'home'|'workout'} [opts.location='workout'] Hint used for telemetry
 *        and allows each host to later tailor its affordances if needed.
 * @param {boolean} [opts.withCalendarMeta=true] Show the "Paused N days ago" meta
 */
export function renderPausedBannerHTML(opts = {}) {
    const { withCalendarMeta = true } = opts;
    const pausedWorkout = storageService.getActiveWorkout();
    if (!pausedWorkout || !pausedWorkout.paused) return null;

    const pausedAt = new Date(pausedWorkout.pausedAt);
    const elapsed = pausedWorkout.elapsedBeforePause;
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    const totalSets = pausedWorkout.exercises.reduce(
        (sum, ex) => sum + (ex.sets ? ex.sets.length : 0), 0
    );
    const name = escapeHtml(pausedWorkout.workoutDayName || 'Workout');

    return `
        <div class="paused-workout-banner">
            <div class="paused-workout-icon">
                <i class="fas fa-pause-circle"></i>
            </div>
            <div class="paused-workout-info">
                <h3>Paused Workout</h3>
                <p><strong>${name}</strong></p>
                <p class="paused-workout-meta">
                    <span><i class="fas fa-clock"></i> ${minutes}:${String(seconds).padStart(2, '0')} elapsed</span>
                    <span><i class="fas fa-dumbbell"></i> ${totalSets} set${totalSets !== 1 ? 's' : ''}</span>
                    ${withCalendarMeta
                        ? `<span><i class="fas fa-calendar"></i> Paused ${formatTimeAgo(pausedAt)}</span>`
                        : ''}
                </p>
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
 * Bind click handlers on a paused banner's action buttons. The host view
 * supplies onResume/onDiscard so control flow stays with each view.
 */
export function wirePausedBannerActions(container, { onResume, onDiscard }) {
    if (!container) return;
    const resumeBtn = container.querySelector('[data-paused-action="resume"]');
    const discardBtn = container.querySelector('[data-paused-action="discard"]');
    if (resumeBtn && onResume) resumeBtn.addEventListener('click', onResume);
    if (discardBtn && onDiscard) discardBtn.addEventListener('click', onDiscard);
}

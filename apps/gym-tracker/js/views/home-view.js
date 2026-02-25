/**
 * Home View Controller
 * Dashboard and overview
 */
import { app } from '../app.js';
import { storageService } from '../services/StorageService.js';
import { formatDate, formatWeight } from '../utils/helpers.js';

class HomeView {
  constructor() {
    this.app = app;
    this.init();
  }

  init() {
    this.app.viewControllers.home = this;
  }

  render() {
    this.renderPausedWorkoutBanner();
    this.renderActiveProgram();
    this.renderRecentWorkouts();
    this.renderRecentAchievements();
  }

  renderPausedWorkoutBanner() {
    const container = document.getElementById('active-program-card');
    const pausedWorkout = storageService.getActiveWorkout();

    // Remove any existing banner first
    const existingBanner = document.querySelector('.paused-workout-banner');
    if (existingBanner) {
      existingBanner.remove();
    }

    if (!pausedWorkout || !pausedWorkout.paused) {
      return;
    }

    const pausedAt = new Date(pausedWorkout.pausedAt);
    const elapsed = pausedWorkout.elapsedBeforePause;
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;

    // Count total sets saved
    const totalSets = pausedWorkout.exercises.reduce(
      (sum, ex) => sum + (ex.sets ? ex.sets.length : 0),
      0,
    );

    const banner = document.createElement('div');
    banner.className = 'paused-workout-banner';

    const iconDiv = document.createElement('div');
    iconDiv.className = 'paused-workout-icon';
    const iconI = document.createElement('i');
    iconI.className = 'fas fa-pause-circle';
    iconDiv.appendChild(iconI);

    const infoDiv = document.createElement('div');
    infoDiv.className = 'paused-workout-info';
    const h3 = document.createElement('h3');
    h3.textContent = 'Paused Workout';
    const nameP = document.createElement('p');
    const nameStrong = document.createElement('strong');
    nameStrong.textContent = pausedWorkout.workoutDayName;
    nameP.appendChild(nameStrong);
    const metaP = document.createElement('p');
    metaP.className = 'paused-workout-meta';
    const timeSpan = document.createElement('span');
    const clockIcon = document.createElement('i');
    clockIcon.className = 'fas fa-clock';
    timeSpan.append(clockIcon, ` ${minutes}:${String(seconds).padStart(2, '0')} elapsed`);
    const setsSpan = document.createElement('span');
    const dumbbellIcon = document.createElement('i');
    dumbbellIcon.className = 'fas fa-dumbbell';
    setsSpan.append(dumbbellIcon, ` ${totalSets} set${totalSets !== 1 ? 's' : ''}`);
    metaP.append(timeSpan, setsSpan);
    infoDiv.append(h3, nameP, metaP);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'paused-workout-actions';
    const resumeBtn = document.createElement('button');
    resumeBtn.className = 'btn btn-primary';
    const playIcon = document.createElement('i');
    playIcon.className = 'fas fa-play';
    resumeBtn.append(playIcon, ' Resume');
    resumeBtn.addEventListener('click', () => this.resumeWorkout());
    const discardBtn = document.createElement('button');
    discardBtn.className = 'btn btn-outline btn-danger-outline';
    const trashIcon = document.createElement('i');
    trashIcon.className = 'fas fa-trash';
    discardBtn.append(trashIcon, ' Discard');
    discardBtn.addEventListener('click', () => this.discardPausedWorkout());
    actionsDiv.append(resumeBtn, discardBtn);

    banner.append(iconDiv, infoDiv, actionsDiv);

    // Insert banner before the container
    container.parentNode.insertBefore(banner, container);
  }

  resumeWorkout() {
    this.app.showView('workout');
    setTimeout(() => {
      if (this.app.viewControllers.workout) {
        this.app.viewControllers.workout.resumeWorkout();
      }
    }, 100);
  }

  async discardPausedWorkout() {
    const { showConfirmModal } = await import('../utils/helpers.js');
    const confirmed = await showConfirmModal({
      title: 'Discard Paused Workout',
      message:
        'Are you sure you want to discard this paused workout?<br><br><strong>All progress will be lost.</strong>',
      confirmText: 'Discard',
      cancelText: 'Keep',
      isDangerous: true,
    });

    if (confirmed) {
      storageService.clearActiveWorkout();
      this.render();
      const { showToast } = await import('../utils/helpers.js');
      showToast('Paused workout discarded', 'info');
    }
  }

  renderActiveProgram() {
    const container = document.getElementById('active-program-card');
    const programs = this.app.programs;
    const pausedWorkout = storageService.getActiveWorkout();

    if (programs.length === 0) {
      container.textContent = '';
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      const icon = document.createElement('i');
      icon.className = 'fas fa-folder-open';
      const p = document.createElement('p');
      p.textContent = 'No programs yet';
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.dataset.view = 'programs';
      btn.textContent = 'Create Program';
      empty.append(icon, p, btn);
      container.appendChild(empty);
      return;
    }

    container.textContent = '';
    const summary = document.createElement('div');
    summary.className = 'program-summary';
    const h3 = document.createElement('h3');
    h3.textContent = 'Your Programs';
    const quickPrograms = document.createElement('div');
    quickPrograms.className = 'quick-programs';

    programs.forEach((program) => {
      const isPaused =
        pausedWorkout && pausedWorkout.paused && pausedWorkout.programId === program.id;
      const hasExercises = program.exercises.length > 0;

      const item = document.createElement('div');
      item.className = 'quick-program-item' + (isPaused ? ' paused' : '');

      const info = document.createElement('div');
      info.className = 'program-info';
      const strong = document.createElement('strong');
      strong.textContent = program.name;
      info.appendChild(strong);

      const actionIcon = document.createElement('i');

      if (isPaused) {
        const span = document.createElement('span');
        span.className = 'paused-label';
        const pauseIcon = document.createElement('i');
        pauseIcon.className = 'fas fa-pause';
        span.append(pauseIcon, ' Paused');
        info.appendChild(span);
        actionIcon.className = 'fas fa-play-circle';
        item.addEventListener('click', () => this.resumeWorkout());
      } else if (hasExercises) {
        const span = document.createElement('span');
        span.textContent = `${program.exercises.length} exercises`;
        info.appendChild(span);
        actionIcon.className = 'fas fa-play-circle';
        item.addEventListener('click', () => this.startWorkoutWithProgram(program.id));
      } else {
        const span = document.createElement('span');
        span.textContent = `${program.exercises.length} exercises`;
        info.appendChild(span);
        actionIcon.className = 'fas fa-edit';
        actionIcon.addEventListener('click', (e) => {
          e.stopPropagation();
          window.gymApp.viewControllers.programs.editProgram(program.id);
        });
      }

      item.append(info, actionIcon);
      quickPrograms.appendChild(item);
    });

    summary.append(h3, quickPrograms);
    container.appendChild(summary);
  }

  renderRecentWorkouts() {
    const container = document.getElementById('recent-workouts');
    const recentSessions = [...this.app.workoutSessions]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 5);

    if (recentSessions.length === 0) {
      container.textContent = '';
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      const icon = document.createElement('i');
      icon.className = 'fas fa-dumbbell';
      const p = document.createElement('p');
      p.textContent = 'No workouts yet';
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.dataset.view = 'workout';
      btn.textContent = 'Start Workout';
      empty.append(icon, p, btn);
      container.appendChild(empty);
      return;
    }

    const unit = this.app.settings.weightUnit;
    container.textContent = '';

    recentSessions.forEach((session) => {
      const card = document.createElement('div');
      card.className = 'workout-card clickable';
      card.addEventListener('click', () => this.showWorkoutDetails(session.id));

      const header = document.createElement('div');
      header.className = 'workout-card-header';
      const h4 = document.createElement('h4');
      h4.textContent = session.workoutDayName;
      const dateSpan = document.createElement('span');
      dateSpan.className = 'date';
      dateSpan.textContent = formatDate(session.date);
      header.append(h4, dateSpan);

      const stats = document.createElement('div');
      stats.className = 'workout-card-stats';

      const volStat = document.createElement('div');
      volStat.className = 'stat';
      const weightIcon = document.createElement('i');
      weightIcon.className = 'fas fa-weight';
      volStat.append(weightIcon, ` ${Math.round(session.totalVolume).toLocaleString()}${unit}`);

      const exStat = document.createElement('div');
      exStat.className = 'stat';
      const listIcon = document.createElement('i');
      listIcon.className = 'fas fa-list';
      exStat.append(listIcon, ` ${session.exercises.length} exercises`);

      stats.append(volStat, exStat);

      if (session.duration) {
        const durStat = document.createElement('div');
        durStat.className = 'stat';
        const clockIcon = document.createElement('i');
        clockIcon.className = 'fas fa-clock';
        durStat.append(clockIcon, ` ${session.duration} min`);
        stats.appendChild(durStat);
      }

      card.append(header, stats);
      container.appendChild(card);
    });
  }

  showWorkoutDetails(sessionId) {
    // Navigate to history view and show the workout details
    this.app.showView('history');
    // Small delay to ensure view is rendered
    setTimeout(() => {
      if (this.app.viewControllers.history) {
        this.app.viewControllers.history.showWorkoutDetails(sessionId);
      }
    }, 100);
  }

  renderRecentAchievements() {
    const container = document.getElementById('recent-achievements');
    const unlockedAchievements = this.app.achievements
      .filter((a) => a.unlocked)
      .sort((a, b) => new Date(b.unlockedAt) - new Date(a.unlockedAt))
      .slice(0, 3);

    if (unlockedAchievements.length === 0) {
      container.textContent = '';
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      const icon = document.createElement('i');
      icon.className = 'fas fa-trophy';
      const p = document.createElement('p');
      p.textContent = 'No achievements unlocked yet';
      empty.append(icon, p);
      container.appendChild(empty);
      return;
    }

    container.textContent = '';
    unlockedAchievements.forEach((achievement) => {
      const card = document.createElement('div');
      card.className = 'achievement-card unlocked';

      const iconDiv = document.createElement('div');
      iconDiv.className = 'achievement-icon';
      iconDiv.textContent = achievement.icon;

      const infoDiv = document.createElement('div');
      infoDiv.className = 'achievement-info';
      const h3 = document.createElement('h3');
      h3.textContent = achievement.name;
      const p = document.createElement('p');
      p.textContent = achievement.description;
      const small = document.createElement('small');
      small.textContent = `Unlocked ${formatDate(achievement.unlockedAt)}`;
      infoDiv.append(h3, p, small);

      card.append(iconDiv, infoDiv);
      container.appendChild(card);
    });
  }

  async startWorkoutWithProgram(programId) {
    const pausedWorkout = storageService.getActiveWorkout();

    // Check if there's a paused workout
    if (pausedWorkout && pausedWorkout.paused) {
      const { showConfirmModal } = await import('../utils/helpers.js');
      const confirmed = await showConfirmModal({
        title: 'Workout In Progress',
        message: `You have a paused workout "<strong>${pausedWorkout.workoutDayName}</strong>" with saved progress.<br><br>Starting a new workout will <strong>discard</strong> your paused workout.<br><br>Do you want to continue?`,
        confirmText: 'Start New Workout',
        cancelText: 'Cancel',
        isDangerous: true,
      });

      if (!confirmed) {
        return;
      }

      // Clear the paused workout
      storageService.clearActiveWorkout();
    }

    // Navigate to workout view and start the workout
    this.app.showView('workout');
    // Small delay to ensure view is rendered
    setTimeout(() => {
      if (this.app.viewControllers.workout) {
        this.app.viewControllers.workout.startWorkout(programId);
      }
    }, 100);
  }
}

// Initialize
new HomeView();

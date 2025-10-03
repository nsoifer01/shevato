// Gym Tracker - Calendar Management

class GymCalendar {
  constructor() {
    this.currentDate = new Date();
    this.currentMonth = this.currentDate.getMonth();
    this.currentYear = this.currentDate.getFullYear();
    this.init();
  }

  init() {
    this.setupEventListeners();
    this.renderCalendar();
    this.updateWeeklySchedule();
  }

  setupEventListeners() {
    // Calendar navigation
    document.getElementById('prevMonthBtn')?.addEventListener('click', () => {
      this.navigateMonth(-1);
    });

    document.getElementById('nextMonthBtn')?.addEventListener('click', () => {
      this.navigateMonth(1);
    });
  }

  navigateMonth(direction) {
    this.currentMonth += direction;
    
    if (this.currentMonth < 0) {
      this.currentMonth = 11;
      this.currentYear--;
    } else if (this.currentMonth > 11) {
      this.currentMonth = 0;
      this.currentYear++;
    }
    
    this.renderCalendar();
  }

  renderCalendar() {
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                       'July', 'August', 'September', 'October', 'November', 'December'];
    
    // Update month display
    const monthDisplay = document.getElementById('currentMonth');
    if (monthDisplay) {
      monthDisplay.textContent = `${monthNames[this.currentMonth]} ${this.currentYear}`;
    }

    // Get calendar grid
    const grid = document.getElementById('calendarGrid');
    if (!grid) return;

    // Clear existing calendar
    grid.innerHTML = '';

    // Get first day of month and number of days
    const firstDay = new Date(this.currentYear, this.currentMonth, 1).getDay();
    const daysInMonth = new Date(this.currentYear, this.currentMonth + 1, 0).getDate();
    const daysInPrevMonth = new Date(this.currentYear, this.currentMonth, 0).getDate();

    // Get workouts for this month
    const monthStart = new Date(this.currentYear, this.currentMonth, 1);
    const monthEnd = new Date(this.currentYear, this.currentMonth + 1, 0);
    const workouts = gymData.getWorkoutsByDateRange(monthStart, monthEnd);
    
    // Create a map of workouts by date
    const workoutsByDate = {};
    workouts.forEach(workout => {
      const date = new Date(workout.date).getDate();
      if (!workoutsByDate[date]) {
        workoutsByDate[date] = [];
      }
      workoutsByDate[date].push(workout);
    });

    // Get scheduled workout days from settings
    const settings = gymData.getSettings();
    const scheduledDays = settings.preferredDays || [];
    
    // Get training plan
    const trainingPlan = window.trainingPlans ? window.trainingPlans.currentPlan : {};
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    // Add previous month's trailing days
    for (let i = firstDay - 1; i >= 0; i--) {
      const day = daysInPrevMonth - i;
      const dayEl = this.createDayElement(day, 'other-month');
      grid.appendChild(dayEl);
    }

    // Add current month's days
    const today = new Date();
    const isCurrentMonth = today.getMonth() === this.currentMonth && today.getFullYear() === this.currentYear;
    
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(this.currentYear, this.currentMonth, day);
      const dayOfWeek = date.getDay();
      const dayName = dayNames[dayOfWeek];
      const classes = [];
      
      // Check if today
      if (isCurrentMonth && day === today.getDate()) {
        classes.push('today');
      }
      
      // Check if scheduled workout day from settings
      if (scheduledDays.includes(dayOfWeek)) {
        classes.push('scheduled');
      }
      
      // Check if has training plan for this day
      const planForDay = trainingPlan[dayName];
      if (planForDay && planForDay.length > 0) {
        classes.push('has-plan');
      }
      
      // Check if workout completed
      if (workoutsByDate[day]) {
        classes.push('completed');
      }
      
      const dayEl = this.createDayElement(day, classes.join(' '), workoutsByDate[day], planForDay);
      grid.appendChild(dayEl);
    }

    // Add next month's leading days
    const totalCells = grid.children.length;
    const remainingCells = 42 - totalCells; // 6 weeks * 7 days
    
    for (let day = 1; day <= remainingCells; day++) {
      const dayEl = this.createDayElement(day, 'other-month');
      grid.appendChild(dayEl);
    }
  }

  createDayElement(day, className = '', workouts = null, trainingPlan = null) {
    const dayEl = document.createElement('div');
    dayEl.className = `cal-date ${className}`;
    
    const dayNumber = document.createElement('span');
    dayNumber.className = 'cal-date-number';
    dayNumber.textContent = day;
    dayEl.appendChild(dayNumber);
    
    // Show indicators for workouts or plans
    if (workouts && workouts.length > 0) {
      const indicator = document.createElement('div');
      indicator.className = 'cal-date-indicator';
      indicator.title = `${workouts.length} workout${workouts.length > 1 ? 's' : ''} completed`;
      dayEl.appendChild(indicator);
    }
    
    if (trainingPlan && trainingPlan.length > 0) {
      const planIndicator = document.createElement('div');
      planIndicator.className = 'cal-date-plan-indicator';
      planIndicator.title = `Training plan: ${trainingPlan.length} exercise${trainingPlan.length > 1 ? 's' : ''}`;
      planIndicator.textContent = '📋';
      dayEl.appendChild(planIndicator);
    }
    
    // Add click handler if there's data to show
    if ((workouts && workouts.length > 0) || (trainingPlan && trainingPlan.length > 0)) {
      dayEl.addEventListener('click', () => {
        this.showDayDetails(day, workouts, trainingPlan);
      });
    }
    
    return dayEl;
  }

  showDayDetails(day, workouts, trainingPlan) {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    const date = `${monthNames[this.currentMonth]} ${day}, ${this.currentYear}`;
    const dayDate = new Date(this.currentYear, this.currentMonth, day);
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = dayNames[dayDate.getDay()];
    
    // Build workout details
    const workoutDetails = workouts && workouts.length > 0 ? workouts.map(workout => {
      const duration = this.formatDuration(workout.duration);
      const exerciseCount = workout.exercises.length;
      const totalSets = workout.exercises.reduce((sum, ex) => sum + ex.sets.length, 0);
      
      return `
        <div class="day-workout-item">
          <div class="workout-time">${new Date(workout.date).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</div>
          <div class="workout-stats">
            <span>${exerciseCount} exercises</span>
            <span>${totalSets} sets</span>
            <span>${duration}</span>
          </div>
        </div>
      `;
    }).join('') : '';
    
    // Build training plan details
    const planDetails = trainingPlan && trainingPlan.length > 0 ? `
      <div class="training-plan-section">
        <h4>Training Plan (${dayName})</h4>
        <div class="plan-exercises">
          ${trainingPlan.map(exercise => `
            <div class="plan-exercise-item">
              <strong>${exercise.exercise}</strong>
              ${exercise.sets && exercise.reps ? ` - ${exercise.sets} sets × ${exercise.reps} reps` : ''}
            </div>
          `).join('')}
        </div>
        <button class="btn-primary" onclick="window.gymCalendar.startWorkoutFromPlan('${dayName}')">
          Start This Workout
        </button>
      </div>
    ` : '';
    
    const modalContent = `
      <div class="day-details">
        <h3>${date}</h3>
        ${planDetails}
        ${workoutDetails ? `
          <div class="completed-workouts">
            <h4>Completed Workouts</h4>
            <div class="day-workouts">
              ${workoutDetails}
            </div>
          </div>
        ` : ''}
      </div>
    `;
    
    window.gymUI.showModal('Workout Details', modalContent);
  }

  updateWeeklySchedule() {
    const container = document.getElementById('weeklySchedule');
    if (!container) return;

    const settings = gymData.getSettings();
    const scheduledDays = settings.preferredDays || [];
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    
    if (scheduledDays.length === 0) {
      container.innerHTML = `
        <p class="empty-state">No workout days scheduled. Go to Settings to set your schedule.</p>
      `;
      return;
    }

    // Get current week's workouts
    const today = new Date();
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    endOfWeek.setHours(23, 59, 59, 999);
    
    const weekWorkouts = gymData.getWorkoutsByDateRange(startOfWeek, endOfWeek);
    
    // Create workout map by day
    const workoutsByDay = {};
    weekWorkouts.forEach(workout => {
      const day = new Date(workout.date).getDay();
      workoutsByDay[day] = workout;
    });

    container.innerHTML = scheduledDays.map(dayIndex => {
      const isCompleted = workoutsByDay[dayIndex];
      const isToday = dayIndex === today.getDay();
      
      return `
        <div class="schedule-item ${isCompleted ? 'completed' : ''} ${isToday ? 'today' : ''}">
          <div class="schedule-day">
            ${dayNames[dayIndex].substring(0, 3).toUpperCase()}
          </div>
          <div class="schedule-details">
            <div class="schedule-workout">${dayNames[dayIndex]}</div>
            <div class="schedule-status">
              ${isCompleted ? '✅ Completed' : (isToday ? '📍 Today' : '⏳ Scheduled')}
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  formatDuration(seconds) {
    if (!seconds) return '0m';
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }

  startWorkoutFromPlan(dayName) {
    const trainingPlan = window.trainingPlans ? window.trainingPlans.currentPlan : {};
    const planForDay = trainingPlan[dayName];
    
    if (!planForDay || planForDay.length === 0) {
      window.gymUI.showNotification('No training plan found for this day', 'error');
      return;
    }
    
    // Close the modal
    const modal = document.querySelector('.modal.active');
    if (modal) {
      modal.remove();
    }
    
    // Start a new workout with the exercises from the plan
    window.gymUI.showSection('workout');
    
    // Create workout with plan exercises
    const workout = {
      id: window.gymData.generateId(),
      date: new Date().toISOString(),
      exercises: planForDay.map(planExercise => {
        // Find matching exercise in database
        const exercise = window.gymData.getAllExercises().find(
          ex => ex.name.toLowerCase() === planExercise.exercise.toLowerCase()
        );
        
        return {
          exerciseId: exercise ? exercise.id : null,
          exerciseName: planExercise.exercise,
          sets: [],
          targetSets: planExercise.sets,
          targetReps: planExercise.reps
        };
      }),
      duration: 0,
      fromPlan: dayName
    };
    
    // Start the workout
    if (window.gymWorkout) {
      window.gymWorkout.currentWorkout = workout;
      window.gymWorkout.renderCurrentWorkout();
      window.gymWorkout.startTimer();
    }
    
    window.gymUI.showNotification(`Started ${dayName} workout from training plan`, 'success');
  }

  scheduleWorkout(date, workoutTemplate = null) {
    // This could be expanded to actually schedule future workouts
    // For now, it just provides a way to plan workouts
    const scheduledWorkout = {
      date: date.toISOString(),
      templateId: workoutTemplate,
      status: 'scheduled'
    };
    
    // Could save to a separate scheduled workouts array
    console.log('Workout scheduled:', scheduledWorkout);
  }
}

// Calendar styles
const calendarStyles = `
<style>
.cal-date.other-month {
  opacity: 0.3;
}

.cal-date.other-month .cal-date-number {
  color: var(--text-muted);
}

.schedule-status {
  font-size: 0.875rem;
  color: var(--text-secondary);
  margin-top: 0.25rem;
}

.schedule-item.completed {
  opacity: 0.7;
}

.schedule-item.completed .schedule-day {
  background: var(--gym-success);
  color: var(--bg-primary);
}

.schedule-item.today {
  border: 2px solid var(--gym-primary);
}

.day-details {
  padding: 1rem;
}

.day-workouts {
  margin-top: 1.5rem;
}

.day-workout-item {
  padding: 1rem;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  margin-bottom: 1rem;
}

.workout-time {
  font-weight: 600;
  color: var(--gym-primary);
  margin-bottom: 0.5rem;
}

.workout-stats {
  display: flex;
  gap: 1rem;
  font-size: 0.875rem;
  color: var(--text-secondary);
}

.workout-stats span {
  padding: 0.25rem 0.75rem;
  background: var(--bg-tertiary);
  border-radius: var(--radius-full);
}
</style>
`;

document.head.insertAdjacentHTML('beforeend', calendarStyles);

// Export class to global scope for initialization
window.GymCalendar = GymCalendar;
// Note: Actual instantiation happens in gym-init.js
// Gym Tracker - Progress Tracking

class GymProgress {
  constructor() {
    this.charts = {};
    this.currentTimeFilter = 'month';
    this.init();
  }

  init() {
    this.setupEventListeners();
  }

  setupEventListeners() {
    const timeFilter = document.getElementById('progressTimeFilter');
    if (timeFilter) {
      timeFilter.addEventListener('change', (e) => {
        this.currentTimeFilter = e.target.value;
        this.updateAllCharts();
      });
    }
  }

  initializeCharts() {
    // Initialize frequency chart
    const frequencyCtx = document.getElementById('frequencyChart');
    if (frequencyCtx) {
      this.charts.frequency = new Chart(frequencyCtx, {
        type: 'bar',
        data: {
          labels: [],
          datasets: [{
            label: 'Workouts',
            data: [],
            backgroundColor: 'rgba(255, 107, 107, 0.6)',
            borderColor: 'rgba(255, 107, 107, 1)',
            borderWidth: 2,
            borderRadius: 8
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: false
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                stepSize: 1,
                color: '#B0B0B0'
              },
              grid: {
                color: 'rgba(255, 255, 255, 0.1)'
              }
            },
            x: {
              ticks: {
                color: '#B0B0B0'
              },
              grid: {
                display: false
              }
            }
          }
        }
      });
    }

    // Initialize volume chart
    const volumeCtx = document.getElementById('volumeChart');
    if (volumeCtx) {
      this.charts.volume = new Chart(volumeCtx, {
        type: 'line',
        data: {
          labels: [],
          datasets: [{
            label: 'Total Volume',
            data: [],
            borderColor: 'rgba(78, 205, 196, 1)',
            backgroundColor: 'rgba(78, 205, 196, 0.1)',
            borderWidth: 3,
            tension: 0.4,
            fill: true
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: false
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                color: '#B0B0B0'
              },
              grid: {
                color: 'rgba(255, 255, 255, 0.1)'
              }
            },
            x: {
              ticks: {
                color: '#B0B0B0'
              },
              grid: {
                display: false
              }
            }
          }
        }
      });
    }

    this.updateAllCharts();
  }

  updateAllCharts() {
    this.updateFrequencyChart();
    this.updateVolumeChart();
    this.updatePersonalRecords();
    this.updateAchievements();
  }

  updateFrequencyChart() {
    if (!this.charts.frequency) return;

    const data = this.getFrequencyData();
    this.charts.frequency.data.labels = data.labels;
    this.charts.frequency.data.datasets[0].data = data.values;
    this.charts.frequency.update();
  }

  updateVolumeChart() {
    if (!this.charts.volume) return;

    const data = this.getVolumeData();
    this.charts.volume.data.labels = data.labels;
    this.charts.volume.data.datasets[0].data = data.values;
    this.charts.volume.update();
  }

  getFrequencyData() {
    const endDate = new Date();
    let startDate, groupBy;

    switch (this.currentTimeFilter) {
      case 'week':
        startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
        groupBy = 'day';
        break;
      case 'month':
        startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
        groupBy = 'day';
        break;
      case '3months':
        startDate = new Date(endDate.getTime() - 90 * 24 * 60 * 60 * 1000);
        groupBy = 'week';
        break;
      case 'year':
        startDate = new Date(endDate.getTime() - 365 * 24 * 60 * 60 * 1000);
        groupBy = 'month';
        break;
    }

    const workouts = gymData.getWorkoutsByDateRange(startDate, endDate);
    const grouped = this.groupWorkoutsByPeriod(workouts, groupBy);

    return {
      labels: Object.keys(grouped),
      values: Object.values(grouped)
    };
  }

  getVolumeData() {
    const endDate = new Date();
    let startDate;

    switch (this.currentTimeFilter) {
      case 'week':
        startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '3months':
        startDate = new Date(endDate.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      case 'year':
        startDate = new Date(endDate.getTime() - 365 * 24 * 60 * 60 * 1000);
        break;
    }

    const workouts = gymData.getWorkoutsByDateRange(startDate, endDate);
    const volumeByDate = {};

    workouts.forEach(workout => {
      const date = new Date(workout.date).toLocaleDateString();
      const volume = this.calculateWorkoutVolume(workout);
      volumeByDate[date] = (volumeByDate[date] || 0) + volume;
    });

    const sortedDates = Object.keys(volumeByDate).sort((a, b) => new Date(a) - new Date(b));

    return {
      labels: sortedDates,
      values: sortedDates.map(date => volumeByDate[date])
    };
  }

  groupWorkoutsByPeriod(workouts, groupBy) {
    const grouped = {};

    workouts.forEach(workout => {
      const date = new Date(workout.date);
      let key;

      switch (groupBy) {
        case 'day':
          key = date.toLocaleDateString();
          break;
        case 'week':
          const weekStart = new Date(date);
          weekStart.setDate(date.getDate() - date.getDay());
          key = `Week of ${weekStart.toLocaleDateString()}`;
          break;
        case 'month':
          key = date.toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
          break;
      }

      grouped[key] = (grouped[key] || 0) + 1;
    });

    return grouped;
  }

  calculateWorkoutVolume(workout) {
    return workout.exercises.reduce((total, exercise) => {
      return total + exercise.sets.reduce((exerciseTotal, set) => {
        return exerciseTotal + (set.weight * set.reps);
      }, 0);
    }, 0);
  }

  updatePersonalRecords() {
    const container = document.getElementById('personalRecords');
    if (!container) return;

    const records = gymData.getPersonalRecords();

    if (records.length === 0) {
      container.innerHTML = '<p class="empty-state">No personal records yet. Keep lifting!</p>';
      return;
    }

    container.innerHTML = records.slice(0, 5).map(record => `
      <div class="pr-item hover-lift">
        <div>
          <div class="pr-exercise">${record.exerciseName}</div>
          <div class="pr-date">${new Date(record.date).toLocaleDateString()}</div>
        </div>
        <div class="pr-value">${record.weight} ${gymData.getSettings().weightUnit}</div>
      </div>
    `).join('');
  }

  updateAchievements() {
    const container = document.getElementById('achievements');
    if (!container) return;

    const achievements = gymData.getAchievements();

    container.innerHTML = Object.values(achievements).map(achievement => `
      <div class="achievement-item ${achievement.unlocked ? 'unlocked' : ''}" 
           title="${achievement.description}">
        <div class="achievement-icon">${achievement.icon}</div>
        <div class="achievement-name">${achievement.name}</div>
      </div>
    `).join('');
  }

  celebrateAchievement(achievement) {
    const notification = document.createElement('div');
    notification.className = 'achievement-notification scale-in';
    notification.innerHTML = `
      <div class="achievement-content">
        <div class="achievement-icon-large">${achievement.icon}</div>
        <h3>Achievement Unlocked!</h3>
        <p>${achievement.name}</p>
        <small>${achievement.description}</small>
      </div>
    `;

    document.body.appendChild(notification);

    setTimeout(() => {
      notification.classList.add('fade-out');
      setTimeout(() => notification.remove(), 300);
    }, 5000);
  }
}

// Progress styles
const progressStyles = `
<style>
.pr-date {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.achievement-notification {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  padding: 2rem;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.8);
  z-index: 2000;
  text-align: center;
  border: 2px solid var(--gym-accent);
}

.achievement-content {
  max-width: 300px;
}

.achievement-icon-large {
  font-size: 4rem;
  margin-bottom: 1rem;
  filter: drop-shadow(0 0 20px rgba(255, 230, 109, 0.5));
}

.achievement-notification h3 {
  color: var(--gym-accent);
  margin-bottom: 0.5rem;
}

.achievement-notification p {
  font-weight: 600;
  margin-bottom: 0.5rem;
}

.achievement-notification small {
  color: var(--text-secondary);
}

canvas {
  max-height: 300px;
}
</style>
`;

document.head.insertAdjacentHTML('beforeend', progressStyles);

// Export class to global scope for initialization
window.GymProgress = GymProgress;
// Note: Actual instantiation happens in gym-init.js
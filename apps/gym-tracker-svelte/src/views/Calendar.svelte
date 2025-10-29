<script>
  import { workoutSessions } from '../stores/gymStore.js';

  // Get current month/year
  let currentDate = new Date();
  let currentMonth = currentDate.getMonth();
  let currentYear = currentDate.getFullYear();

  $: sessions = $workoutSessions;

  function getWorkoutsForDate(date) {
    return sessions.filter(s => {
      const sessionDate = new Date(s.date);
      return sessionDate.toDateString() === date.toDateString();
    });
  }

  function previousMonth() {
    if (currentMonth === 0) {
      currentMonth = 11;
      currentYear--;
    } else {
      currentMonth--;
    }
  }

  function nextMonth() {
    if (currentMonth === 11) {
      currentMonth = 0;
      currentYear++;
    } else {
      currentMonth++;
    }
  }

  // Get days in month
  $: daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
  $: firstDayOfMonth = new Date(currentYear, currentMonth, 1).getDay();

  $: monthName = new Date(currentYear, currentMonth).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
</script>

<div class="calendar-view">
  <div class="view-header">
    <h1>Workout Calendar</h1>
    <p class="subtitle">Track your workout consistency</p>
  </div>

  <div class="calendar-container">
    <div class="calendar-header">
      <button class="nav-btn" on:click={previousMonth}>
        <i class="fas fa-chevron-left"></i>
      </button>
      <h2>{monthName}</h2>
      <button class="nav-btn" on:click={nextMonth}>
        <i class="fas fa-chevron-right"></i>
      </button>
    </div>

    <div class="calendar-grid">
      <!-- Weekday headers -->
      {#each ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as day}
        <div class="weekday-header">{day}</div>
      {/each}

      <!-- Empty cells for days before month starts -->
      {#each Array(firstDayOfMonth) as _}
        <div class="calendar-day empty"></div>
      {/each}

      <!-- Days of the month -->
      {#each Array(daysInMonth) as _, i}
        {@const dayDate = new Date(currentYear, currentMonth, i + 1)}
        {@const workouts = getWorkoutsForDate(dayDate)}
        {@const isToday = dayDate.toDateString() === new Date().toDateString()}
        <div class="calendar-day" class:today={isToday} class:has-workout={workouts.length > 0}>
          <div class="day-number">{i + 1}</div>
          {#if workouts.length > 0}
            <div class="workout-indicator">
              <i class="fas fa-dumbbell"></i>
              {#if workouts.length > 1}
                <span class="workout-count">{workouts.length}</span>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </div>

  <div class="legend">
    <div class="legend-item">
      <div class="legend-box today-box"></div>
      <span>Today</span>
    </div>
    <div class="legend-item">
      <div class="legend-box workout-box"></div>
      <span>Workout Day</span>
    </div>
  </div>
</div>

<style>
  .calendar-view {
    max-width: 1000px;
    margin: 0 auto;
  }

  .view-header {
    margin-bottom: 2rem;
  }

  .view-header h1 {
    font-size: 2.5rem;
    background: linear-gradient(135deg, #00ffff, #00aaff);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .subtitle {
    color: rgba(255, 255, 255, 0.6);
    font-size: 1.1rem;
  }

  .calendar-container {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 2rem;
    margin-bottom: 2rem;
  }

  .calendar-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2rem;
  }

  .calendar-header h2 {
    font-size: 1.5rem;
    color: #00ffff;
  }

  .nav-btn {
    background: rgba(255, 255, 255, 0.1);
    border: none;
    color: #fff;
    padding: 0.75rem 1rem;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.3s;
  }

  .nav-btn:hover {
    background: rgba(255, 255, 255, 0.2);
  }

  .calendar-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 0.5rem;
  }

  .weekday-header {
    text-align: center;
    font-weight: bold;
    padding: 0.75rem;
    color: #00ffff;
    font-size: 0.9rem;
  }

  .calendar-day {
    aspect-ratio: 1;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    position: relative;
    transition: all 0.3s;
  }

  .calendar-day.empty {
    background: transparent;
    border: none;
  }

  .calendar-day.today {
    border-color: #00ffff;
    box-shadow: 0 0 10px rgba(0, 255, 255, 0.3);
  }

  .calendar-day.has-workout {
    background: rgba(0, 255, 136, 0.1);
    border-color: #00ff88;
  }

  .calendar-day:not(.empty):hover {
    background: rgba(255, 255, 255, 0.1);
    transform: translateY(-2px);
  }

  .day-number {
    font-size: 1.1rem;
    font-weight: bold;
  }

  .workout-indicator {
    margin-top: 0.25rem;
    color: #00ff88;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.75rem;
  }

  .workout-count {
    background: #00ff88;
    color: #000;
    padding: 0.1rem 0.4rem;
    border-radius: 10px;
    font-weight: bold;
  }

  .legend {
    display: flex;
    gap: 2rem;
    justify-content: center;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: rgba(255, 255, 255, 0.7);
  }

  .legend-box {
    width: 24px;
    height: 24px;
    border-radius: 4px;
  }

  .today-box {
    border: 2px solid #00ffff;
    background: rgba(255, 255, 255, 0.05);
  }

  .workout-box {
    background: rgba(0, 255, 136, 0.1);
    border: 1px solid #00ff88;
  }

  @media (max-width: 768px) {
    .calendar-container {
      padding: 1rem;
    }

    .calendar-grid {
      gap: 0.25rem;
    }

    .weekday-header {
      font-size: 0.75rem;
      padding: 0.5rem 0;
    }

    .calendar-day {
      padding: 0.25rem;
    }

    .day-number {
      font-size: 0.9rem;
    }

    .workout-indicator {
      font-size: 0.6rem;
    }
  }
</style>

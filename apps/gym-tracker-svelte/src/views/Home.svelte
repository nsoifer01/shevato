<script>
  import { activeProgram, workoutStats, recentWorkouts } from '../stores/gymStore.js';
</script>

<div class="home-view">
  <div class="view-header">
    <h1>Dashboard</h1>
    <p class="subtitle">Track your fitness journey</p>
  </div>

  <!-- Stats Cards -->
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-icon">🏋️</div>
      <div class="stat-content">
        <div class="stat-value">{$workoutStats.totalWorkouts}</div>
        <div class="stat-label">Total Workouts</div>
      </div>
    </div>

    <div class="stat-card">
      <div class="stat-icon">⏱️</div>
      <div class="stat-content">
        <div class="stat-value">{Math.round($workoutStats.totalDuration / 60)}h</div>
        <div class="stat-label">Total Time</div>
      </div>
    </div>

    <div class="stat-card">
      <div class="stat-icon">🔥</div>
      <div class="stat-content">
        <div class="stat-value">{$workoutStats.currentStreak}</div>
        <div class="stat-label">Day Streak</div>
      </div>
    </div>

    <div class="stat-card">
      <div class="stat-icon">⏰</div>
      <div class="stat-content">
        <div class="stat-value">{$workoutStats.avgDuration}min</div>
        <div class="stat-label">Avg Duration</div>
      </div>
    </div>
  </div>

  <!-- Active Program -->
  <section class="section">
    <h2>Active Program</h2>
    {#if $activeProgram}
      <div class="program-card">
        <h3>{$activeProgram.name}</h3>
        <p>{$activeProgram.description}</p>
        <div class="program-meta">
          <span>{$activeProgram.exercises.length} Exercises</span>
        </div>
      </div>
    {:else}
      <div class="empty-state">
        <p>No active program. Create one to get started!</p>
      </div>
    {/if}
  </section>

  <!-- Recent Workouts -->
  <section class="section">
    <h2>Recent Workouts</h2>
    {#if $recentWorkouts.length > 0}
      <div class="workout-list">
        {#each $recentWorkouts as workout}
          <div class="workout-item">
            <div class="workout-date">
              {new Date(workout.date).toLocaleDateString()}
            </div>
            <div class="workout-info">
              <div class="workout-duration">{workout.duration} min</div>
              <div class="workout-status">
                {workout.completed ? '✓ Completed' : '⏳ In Progress'}
              </div>
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <div class="empty-state">
        <p>No workouts yet. Start your first workout!</p>
      </div>
    {/if}
  </section>
</div>

<style>
  .home-view {
    max-width: 1200px;
    margin: 0 auto;
  }

  .view-header {
    margin-bottom: 2rem;
  }

  .view-header h1 {
    font-size: 2.5rem;
    margin-bottom: 0.5rem;
    background: linear-gradient(135deg, #00ffff, #00aaff);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .subtitle {
    color: rgba(255, 255, 255, 0.6);
    font-size: 1.1rem;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 1.5rem;
    margin-bottom: 2rem;
  }

  .stat-card {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 1.5rem;
    display: flex;
    align-items: center;
    gap: 1rem;
    transition: all 0.3s;
  }

  .stat-card:hover {
    background: rgba(255, 255, 255, 0.08);
    transform: translateY(-2px);
  }

  .stat-icon {
    font-size: 2.5rem;
  }

  .stat-value {
    font-size: 2rem;
    font-weight: bold;
    color: #00ffff;
  }

  .stat-label {
    color: rgba(255, 255, 255, 0.6);
    font-size: 0.9rem;
  }

  .section {
    margin-bottom: 2rem;
  }

  .section h2 {
    font-size: 1.5rem;
    margin-bottom: 1rem;
    color: #00ffff;
  }

  .program-card {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 1.5rem;
  }

  .program-card h3 {
    font-size: 1.3rem;
    margin-bottom: 0.5rem;
  }

  .program-meta {
    margin-top: 1rem;
    color: rgba(255, 255, 255, 0.6);
  }

  .workout-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .workout-item {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 1rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .workout-date {
    font-weight: bold;
  }

  .workout-info {
    display: flex;
    gap: 1rem;
    align-items: center;
  }

  .workout-status {
    color: #00ff88;
  }

  .empty-state {
    background: rgba(255, 255, 255, 0.03);
    border: 2px dashed rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 3rem;
    text-align: center;
    color: rgba(255, 255, 255, 0.5);
  }

  @media (max-width: 768px) {
    .stats-grid {
      grid-template-columns: repeat(2, 1fr);
      gap: 1rem;
    }

    .stat-card {
      padding: 1rem;
    }

    .stat-icon {
      font-size: 2rem;
    }

    .stat-value {
      font-size: 1.5rem;
    }
  }
</style>

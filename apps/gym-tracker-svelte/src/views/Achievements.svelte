<script>
  import { achievements, workoutStats } from '../stores/gymStore.js';

  // Default achievements if none exist
  const defaultAchievements = [
    { id: 'first-workout', name: 'First Steps', description: 'Complete your first workout', icon: '🎯', unlocked: false },
    { id: '5-workouts', name: 'Getting Started', description: 'Complete 5 workouts', icon: '🔥', unlocked: false },
    { id: '10-workouts', name: 'Building Momentum', description: 'Complete 10 workouts', icon: '💪', unlocked: false },
    { id: '25-workouts', name: 'Quarter Century', description: 'Complete 25 workouts', icon: '⭐', unlocked: false },
    { id: '50-workouts', name: 'Half Century', description: 'Complete 50 workouts', icon: '🏆', unlocked: false },
    { id: '100-workouts', name: 'Century Club', description: 'Complete 100 workouts', icon: '👑', unlocked: false },
    { id: '7-day-streak', name: 'Weekly Warrior', description: 'Maintain a 7-day workout streak', icon: '🔥', unlocked: false },
    { id: '30-day-streak', name: 'Monthly Master', description: 'Maintain a 30-day workout streak', icon: '💎', unlocked: false },
    { id: '10-hours', name: 'Time Investment', description: 'Complete 10 hours of workouts', icon: '⏱️', unlocked: false },
    { id: '50-hours', name: 'Time Dedication', description: 'Complete 50 hours of workouts', icon: '⏰', unlocked: false },
  ];

  // Check which achievements should be unlocked
  $: unlockedAchievements = defaultAchievements.map(ach => {
    let shouldUnlock = false;

    switch(ach.id) {
      case 'first-workout':
        shouldUnlock = $workoutStats.totalWorkouts >= 1;
        break;
      case '5-workouts':
        shouldUnlock = $workoutStats.totalWorkouts >= 5;
        break;
      case '10-workouts':
        shouldUnlock = $workoutStats.totalWorkouts >= 10;
        break;
      case '25-workouts':
        shouldUnlock = $workoutStats.totalWorkouts >= 25;
        break;
      case '50-workouts':
        shouldUnlock = $workoutStats.totalWorkouts >= 50;
        break;
      case '100-workouts':
        shouldUnlock = $workoutStats.totalWorkouts >= 100;
        break;
      case '7-day-streak':
        shouldUnlock = $workoutStats.currentStreak >= 7;
        break;
      case '30-day-streak':
        shouldUnlock = $workoutStats.currentStreak >= 30;
        break;
      case '10-hours':
        shouldUnlock = $workoutStats.totalDuration >= 600; // 10 hours in minutes
        break;
      case '50-hours':
        shouldUnlock = $workoutStats.totalDuration >= 3000; // 50 hours in minutes
        break;
    }

    return { ...ach, unlocked: shouldUnlock };
  });

  $: unlockedCount = unlockedAchievements.filter(a => a.unlocked).length;
  $: progressPercentage = (unlockedCount / defaultAchievements.length) * 100;
</script>

<div class="achievements-view">
  <div class="view-header">
    <div>
      <h1>Achievements</h1>
      <p class="subtitle">Track your fitness milestones</p>
    </div>
  </div>

  <!-- Progress Overview -->
  <div class="progress-card">
    <div class="progress-header">
      <h2>Your Progress</h2>
      <div class="progress-stats">
        <span class="unlocked-count">{unlockedCount} / {defaultAchievements.length}</span>
        <span class="progress-percentage">{Math.round(progressPercentage)}%</span>
      </div>
    </div>
    <div class="progress-bar">
      <div class="progress-fill" style="width: {progressPercentage}%"></div>
    </div>
  </div>

  <!-- Achievements Grid -->
  <div class="achievements-grid">
    {#each unlockedAchievements as achievement}
      <div class="achievement-card" class:unlocked={achievement.unlocked}>
        <div class="achievement-icon">
          {achievement.icon}
        </div>
        <div class="achievement-info">
          <h3>{achievement.name}</h3>
          <p>{achievement.description}</p>
        </div>
        {#if achievement.unlocked}
          <div class="unlocked-badge">
            <i class="fas fa-check-circle"></i>
          </div>
        {:else}
          <div class="locked-overlay">
            <i class="fas fa-lock"></i>
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .achievements-view {
    max-width: 1200px;
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

  .progress-card {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 2rem;
    margin-bottom: 2rem;
  }

  .progress-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .progress-header h2 {
    font-size: 1.3rem;
    color: #00ffff;
  }

  .progress-stats {
    display: flex;
    gap: 1rem;
    align-items: center;
  }

  .unlocked-count {
    font-size: 1.5rem;
    font-weight: bold;
    color: #00ff88;
  }

  .progress-percentage {
    font-size: 1.2rem;
    color: rgba(255, 255, 255, 0.7);
  }

  .progress-bar {
    height: 20px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 10px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #00ff88, #00ffff);
    transition: width 1s ease;
  }

  .achievements-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1.5rem;
  }

  .achievement-card {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 1.5rem;
    position: relative;
    transition: all 0.3s;
  }

  .achievement-card:not(.unlocked) {
    opacity: 0.5;
    filter: grayscale(100%);
  }

  .achievement-card.unlocked {
    background: rgba(0, 255, 136, 0.05);
    border-color: #00ff88;
  }

  .achievement-card.unlocked:hover {
    transform: translateY(-4px);
    box-shadow: 0 8px 20px rgba(0, 255, 136, 0.2);
  }

  .achievement-icon {
    font-size: 3rem;
    margin-bottom: 1rem;
  }

  .achievement-info h3 {
    font-size: 1.2rem;
    margin-bottom: 0.5rem;
  }

  .achievement-info p {
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.9rem;
  }

  .unlocked-badge {
    position: absolute;
    top: 1rem;
    right: 1rem;
    color: #00ff88;
    font-size: 1.5rem;
  }

  .locked-overlay {
    position: absolute;
    top: 1rem;
    right: 1rem;
    color: rgba(255, 255, 255, 0.3);
    font-size: 1.5rem;
  }

  @media (max-width: 768px) {
    .achievements-grid {
      grid-template-columns: 1fr;
    }

    .progress-header {
      flex-direction: column;
      align-items: flex-start;
      gap: 1rem;
    }
  }
</style>

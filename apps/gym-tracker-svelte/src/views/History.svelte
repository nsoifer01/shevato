<script>
  import { workoutSessions } from '../stores/gymStore.js';

  $: sortedSessions = $workoutSessions
    .sort((a, b) => new Date(b.date) - new Date(a.date));
</script>

<div class="history-view">
  <div class="view-header">
    <h1>Workout History</h1>
    <p class="subtitle">View all your past workouts</p>
  </div>

  {#if sortedSessions.length > 0}
    <div class="history-list">
      {#each sortedSessions as session}
        <div class="session-card" class:completed={session.completed}>
          <div class="session-header">
            <div class="session-date">
              {new Date(session.date).toLocaleDateString('en-US', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric'
              })}
            </div>
            <div class="session-status">
              {session.completed ? '✓ Completed' : '⏳ In Progress'}
            </div>
          </div>

          <div class="session-info">
            <div class="info-item">
              <span class="icon">⏱️</span>
              <span>{session.duration} minutes</span>
            </div>
            {#if session.notes}
              <div class="session-notes">
                💭 {session.notes}
              </div>
            {/if}
          </div>

          {#if session.exercises && session.exercises.length > 0}
            <div class="session-exercises">
              <strong>{session.exercises.length} exercises</strong>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {:else}
    <div class="empty-state">
      <p>No workout history yet. Complete your first workout to see it here!</p>
    </div>
  {/if}
</div>

<style>
  .history-view {
    max-width: 900px;
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

  .history-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .session-card {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 1.5rem;
    transition: all 0.3s;
  }

  .session-card.completed {
    border-left: 4px solid #00ff88;
  }

  .session-card:hover {
    background: rgba(255, 255, 255, 0.08);
    transform: translateY(-2px);
  }

  .session-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .session-date {
    font-weight: bold;
    font-size: 1.1rem;
  }

  .session-status {
    color: #00ff88;
    font-size: 0.9rem;
  }

  .session-info {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    color: rgba(255, 255, 255, 0.7);
  }

  .info-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .session-notes {
    margin-top: 0.5rem;
    padding: 0.75rem;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 8px;
    font-style: italic;
  }

  .session-exercises {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.6);
  }

  .empty-state {
    background: rgba(255, 255, 255, 0.03);
    border: 2px dashed rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 4rem 2rem;
    text-align: center;
    color: rgba(255, 255, 255, 0.5);
  }

  @media (max-width: 768px) {
    .session-header {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.5rem;
    }
  }
</style>

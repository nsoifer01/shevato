<script>
  import { createEventDispatcher } from 'svelte';

  export let view;
  const dispatch = createEventDispatcher();

  function navigate(newView) {
    dispatch('navigate', newView);
  }
</script>

<nav class="navigation">
  <div class="nav-header">
    <h2>💪 Gym Tracker</h2>
  </div>

  <div class="nav-links">
    <button
      class="nav-link"
      class:active={view === 'home'}
      on:click={() => navigate('home')}
    >
      <i class="fas fa-home"></i>
      <span>Dashboard</span>
    </button>

    <button
      class="nav-link"
      class:active={view === 'programs'}
      on:click={() => navigate('programs')}
    >
      <i class="fas fa-list"></i>
      <span>Programs</span>
    </button>

    <button
      class="nav-link"
      class:active={view === 'exercises'}
      on:click={() => navigate('exercises')}
    >
      <i class="fas fa-dumbbell"></i>
      <span>Exercises</span>
    </button>

    <button
      class="nav-link"
      class:active={view === 'history'}
      on:click={() => navigate('history')}
    >
      <i class="fas fa-chart-line"></i>
      <span>History</span>
    </button>

    <button
      class="nav-link"
      class:active={view === 'calendar'}
      on:click={() => navigate('calendar')}
    >
      <i class="fas fa-calendar"></i>
      <span>Calendar</span>
    </button>

    <button
      class="nav-link"
      class:active={view === 'achievements'}
      on:click={() => navigate('achievements')}
    >
      <i class="fas fa-trophy"></i>
      <span>Achievements</span>
    </button>

    <button
      class="nav-link"
      class:active={view === 'settings'}
      on:click={() => navigate('settings')}
    >
      <i class="fas fa-cog"></i>
      <span>Settings</span>
    </button>
  </div>
</nav>

<style>
  .navigation {
    width: 250px;
    background: rgba(0, 0, 0, 0.3);
    border-right: 1px solid rgba(255, 255, 255, 0.1);
    display: flex;
    flex-direction: column;
  }

  .nav-header {
    padding: 2rem 1.5rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  .nav-header h2 {
    font-size: 1.5rem;
    color: #00ffff;
  }

  .nav-links {
    padding: 1rem 0;
  }

  .nav-link {
    width: 100%;
    padding: 1rem 1.5rem;
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.7);
    font-size: 1rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 1rem;
    transition: all 0.3s;
    text-align: left;
  }

  .nav-link:hover {
    background: rgba(255, 255, 255, 0.05);
    color: #ffffff;
  }

  .nav-link.active {
    background: rgba(0, 255, 255, 0.1);
    color: #00ffff;
    border-left: 3px solid #00ffff;
  }

  .nav-link i {
    font-size: 1.3rem;
  }

  @media (max-width: 768px) {
    .navigation {
      width: 100%;
      flex-direction: row;
      position: fixed;
      bottom: 0;
      z-index: 100;
      border-right: none;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(10, 10, 30, 0.95);
      backdrop-filter: blur(10px);
    }

    .nav-header {
      display: none;
    }

    .nav-links {
      display: flex;
      width: 100%;
      padding: 0;
    }

    .nav-link {
      flex: 1;
      flex-direction: column;
      padding: 0.75rem;
      gap: 0.25rem;
      font-size: 0.75rem;
    }

    .nav-link.active {
      border-left: none;
      border-top: 3px solid #00ffff;
    }

    .nav-link i {
      font-size: 1.25rem;
    }
  }
</style>

<script>
  import { currentView } from './stores/gymStore.js';

  import Home from './views/Home.svelte';
  import Programs from './views/Programs.svelte';
  import Exercises from './views/Exercises.svelte';
  import History from './views/History.svelte';
  import Calendar from './views/Calendar.svelte';
  import Achievements from './views/Achievements.svelte';
  import Workout from './views/Workout.svelte';
  import Settings from './views/Settings.svelte';
  import Navigation from './components/Navigation.svelte';

  let view = 'home';
  currentView.subscribe(value => view = value);

  function changeView(newView) {
    currentView.set(newView);
  }
</script>

<div class="app">
  <Navigation {view} on:navigate={(e) => changeView(e.detail)} />

  <main class="main-content">
    {#if view === 'home'}
      <Home />
    {:else if view === 'programs'}
      <Programs />
    {:else if view === 'exercises'}
      <Exercises />
    {:else if view === 'history'}
      <History />
    {:else if view === 'calendar'}
      <Calendar />
    {:else if view === 'achievements'}
      <Achievements />
    {:else if view === 'workout'}
      <Workout />
    {:else if view === 'settings'}
      <Settings />
    {/if}
  </main>
</div>

<style>
  :global(*) {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  :global(body) {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    color: #ffffff;
    min-height: 100vh;
    padding-top: 3.25rem; /* Account for fixed header */
  }

  .app {
    display: flex;
    min-height: calc(100vh - 3.25rem); /* Subtract header height */
  }

  .main-content {
    flex: 1;
    padding: 2rem;
    overflow-y: auto;
  }

  @media (max-width: 768px) {
    .app {
      flex-direction: column;
    }

    .main-content {
      padding: 1rem;
      padding-bottom: 5rem;
    }
  }
</style>

<script>
  import { settings, programs, workoutSessions } from '../stores/gymStore.js';

  function exportData() {
    const data = {
      programs: $programs,
      sessions: $workoutSessions,
      settings: $settings,
      exportDate: new Date().toISOString()
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gym-tracker-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function clearAllData() {
    if (confirm('⚠️ This will delete ALL your data. Are you absolutely sure?')) {
      if (confirm('This cannot be undone. Continue?')) {
        programs.set([]);
        workoutSessions.set([]);
        alert('All data has been cleared.');
      }
    }
  }
</script>

<div class="settings-view">
  <div class="view-header">
    <h1>Settings</h1>
    <p class="subtitle">Manage your preferences</p>
  </div>

  <div class="settings-sections">
    <!-- Display Settings -->
    <section class="settings-section">
      <h2>Display</h2>
      <div class="setting-item">
        <div class="setting-info">
          <label>Weight Unit</label>
          <span class="setting-description">Choose your preferred weight unit</span>
        </div>
        <select bind:value={$settings.weightUnit}>
          <option value="lbs">Pounds (lbs)</option>
          <option value="kg">Kilograms (kg)</option>
        </select>
      </div>
    </section>

    <!-- Timer Settings -->
    <section class="settings-section">
      <h2>Timer</h2>
      <div class="setting-item">
        <div class="setting-info">
          <label>Rest Timer (seconds)</label>
          <span class="setting-description">Default rest time between sets</span>
        </div>
        <input
          type="number"
          bind:value={$settings.restTimer}
          min="30"
          max="300"
          step="15"
        />
      </div>
    </section>

    <!-- Notifications -->
    <section class="settings-section">
      <h2>Notifications</h2>
      <div class="setting-item">
        <div class="setting-info">
          <label>Enable Notifications</label>
          <span class="setting-description">Get notified about rest timers and achievements</span>
        </div>
        <label class="toggle">
          <input type="checkbox" bind:checked={$settings.notifications} />
          <span class="slider"></span>
        </label>
      </div>
    </section>

    <!-- Data Management -->
    <section class="settings-section">
      <h2>Data Management</h2>
      <div class="setting-actions">
        <button class="btn-secondary" on:click={exportData}>
          📥 Export Data
        </button>
        <button class="btn-danger" on:click={clearAllData}>
          🗑️ Clear All Data
        </button>
      </div>
    </section>

    <!-- About -->
    <section class="settings-section">
      <h2>About</h2>
      <div class="about-info">
        <p><strong>Gym Tracker</strong></p>
        <p>Version 2.0 (Svelte)</p>
        <p class="credits">Built with ❤️ using Svelte</p>
      </div>
    </section>
  </div>
</div>

<style>
  .settings-view {
    max-width: 800px;
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

  .settings-sections {
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .settings-section {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 1.5rem;
  }

  .settings-section h2 {
    font-size: 1.3rem;
    margin-bottom: 1.5rem;
    color: #00ffff;
  }

  .setting-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .setting-info {
    flex: 1;
  }

  .setting-info label {
    display: block;
    font-weight: 600;
    margin-bottom: 0.25rem;
  }

  .setting-description {
    font-size: 0.9rem;
    color: rgba(255, 255, 255, 0.6);
  }

  select, input[type="number"] {
    padding: 0.5rem;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 8px;
    color: #fff;
    font-size: 1rem;
  }

  select:focus, input:focus {
    outline: none;
    border-color: #00ffff;
  }

  .toggle {
    position: relative;
    display: inline-block;
    width: 60px;
    height: 34px;
  }

  .toggle input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .slider {
    position: absolute;
    cursor: pointer;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: rgba(255, 255, 255, 0.2);
    transition: 0.4s;
    border-radius: 34px;
  }

  .slider:before {
    position: absolute;
    content: "";
    height: 26px;
    width: 26px;
    left: 4px;
    bottom: 4px;
    background-color: white;
    transition: 0.4s;
    border-radius: 50%;
  }

  input:checked + .slider {
    background-color: #00ffff;
  }

  input:checked + .slider:before {
    transform: translateX(26px);
  }

  .setting-actions {
    display: flex;
    gap: 1rem;
  }

  .btn-secondary, .btn-danger {
    padding: 0.75rem 1.5rem;
    border: none;
    border-radius: 8px;
    font-size: 1rem;
    cursor: pointer;
    transition: all 0.3s;
    font-weight: 600;
    flex: 1;
  }

  .btn-secondary {
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
  }

  .btn-secondary:hover {
    background: rgba(255, 255, 255, 0.15);
    transform: translateY(-2px);
  }

  .btn-danger {
    background: rgba(255, 50, 50, 0.2);
    color: #ff5555;
    border: 1px solid #ff5555;
  }

  .btn-danger:hover {
    background: rgba(255, 50, 50, 0.3);
  }

  .about-info {
    color: rgba(255, 255, 255, 0.7);
  }

  .about-info p {
    margin-bottom: 0.5rem;
  }

  .credits {
    margin-top: 1rem;
    font-style: italic;
    color: rgba(255, 255, 255, 0.5);
  }

  @media (max-width: 768px) {
    .setting-item {
      flex-direction: column;
      align-items: flex-start;
      gap: 1rem;
    }

    .setting-actions {
      flex-direction: column;
    }
  }
</style>

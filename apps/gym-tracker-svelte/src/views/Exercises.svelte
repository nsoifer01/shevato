<script>
  import { exercises } from '../stores/gymStore.js';

  let searchTerm = '';
  let categoryFilter = '';
  let equipmentFilter = '';
  let difficultyFilter = '';

  // Get unique values for filters
  $: categories = [...new Set($exercises.map(e => e.category))].sort();
  $: equipmentTypes = [...new Set($exercises.map(e => e.equipment))].sort();
  $: difficulties = ['beginner', 'intermediate', 'advanced'];

  // Filtered exercises
  $: filteredExercises = $exercises.filter(ex => {
    const matchesSearch = ex.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         ex.muscleGroup?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         ex.category.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = !categoryFilter || ex.category === categoryFilter;
    const matchesEquipment = !equipmentFilter || ex.equipment === equipmentFilter;
    const matchesDifficulty = !difficultyFilter || ex.difficulty === difficultyFilter;

    return matchesSearch && matchesCategory && matchesEquipment && matchesDifficulty;
  });

  function clearFilters() {
    searchTerm = '';
    categoryFilter = '';
    equipmentFilter = '';
    difficultyFilter = '';
  }

  function getDifficultyColor(difficulty) {
    switch(difficulty) {
      case 'beginner': return '#00ff88';
      case 'intermediate': return '#ffaa00';
      case 'advanced': return '#ff5252';
      default: return '#ffffff';
    }
  }
</script>

<div class="exercises-view">
  <div class="view-header">
    <div>
      <h1>Exercise Library</h1>
      <p class="subtitle">{$exercises.length} exercises available</p>
    </div>
  </div>

  <!-- Filters -->
  <div class="filters-section">
    <div class="search-box">
      <i class="fas fa-search"></i>
      <input
        type="text"
        bind:value={searchTerm}
        placeholder="Search exercises by name, muscle group, or category..."
      />
      {#if searchTerm}
        <button class="clear-btn" on:click={() => searchTerm = ''}>
          <i class="fas fa-times"></i>
        </button>
      {/if}
    </div>

    <div class="filter-row">
      <select bind:value={categoryFilter}>
        <option value="">All Categories</option>
        {#each categories as category}
          <option value={category}>{category.charAt(0).toUpperCase() + category.slice(1)}</option>
        {/each}
      </select>

      <select bind:value={equipmentFilter}>
        <option value="">All Equipment</option>
        {#each equipmentTypes as equipment}
          <option value={equipment}>
            {equipment.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
          </option>
        {/each}
      </select>

      <select bind:value={difficultyFilter}>
        <option value="">All Difficulties</option>
        {#each difficulties as difficulty}
          <option value={difficulty}>{difficulty.charAt(0).toUpperCase() + difficulty.slice(1)}</option>
        {/each}
      </select>

      {#if searchTerm || categoryFilter || equipmentFilter || difficultyFilter}
        <button class="clear-filters-btn" on:click={clearFilters}>
          <i class="fas fa-times-circle"></i> Clear Filters
        </button>
      {/if}
    </div>

    <div class="results-count">
      Showing {filteredExercises.length} of {$exercises.length} exercises
    </div>
  </div>

  <!-- Exercise Grid -->
  <div class="exercises-grid">
    {#each filteredExercises as exercise (exercise.id)}
      <div class="exercise-card">
        <div class="exercise-header">
          <h3>{exercise.name}</h3>
          <span
            class="difficulty-badge"
            style="background-color: {getDifficultyColor(exercise.difficulty)}"
          >
            {exercise.difficulty}
          </span>
        </div>

        <div class="exercise-details">
          <div class="detail-item">
            <i class="fas fa-bullseye"></i>
            <span>{exercise.category}</span>
          </div>

          <div class="detail-item">
            <i class="fas fa-dumbbell"></i>
            <span>{exercise.equipment.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}</span>
          </div>

          <div class="detail-item">
            <i class="fas fa-crosshairs"></i>
            <span>{exercise.muscleGroup?.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}</span>
          </div>
        </div>

        {#if exercise.secondaryMuscles && exercise.secondaryMuscles.length > 0}
          <div class="secondary-muscles">
            <small>
              <i class="fas fa-plus-circle"></i>
              {exercise.secondaryMuscles.slice(0, 2).join(', ')}
              {#if exercise.secondaryMuscles.length > 2}
                <span class="more">+{exercise.secondaryMuscles.length - 2}</span>
              {/if}
            </small>
          </div>
        {/if}
      </div>
    {:else}
      <div class="no-results">
        <i class="fas fa-search"></i>
        <p>No exercises found matching your filters</p>
        <button class="btn-primary" on:click={clearFilters}>
          Clear Filters
        </button>
      </div>
    {/each}
  </div>
</div>

<style>
  .exercises-view {
    max-width: 1400px;
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

  .filters-section {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 1.5rem;
    margin-bottom: 2rem;
  }

  .search-box {
    position: relative;
    margin-bottom: 1rem;
  }

  .search-box i.fa-search {
    position: absolute;
    left: 1rem;
    top: 50%;
    transform: translateY(-50%);
    color: rgba(255, 255, 255, 0.5);
  }

  .search-box input {
    width: 100%;
    padding: 0.875rem 1rem 0.875rem 3rem;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 8px;
    color: #fff;
    font-size: 1rem;
  }

  .search-box input:focus {
    outline: none;
    border-color: #00ffff;
    background: rgba(255, 255, 255, 0.15);
  }

  .clear-btn {
    position: absolute;
    right: 0.75rem;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.5);
    cursor: pointer;
    padding: 0.5rem;
  }

  .clear-btn:hover {
    color: #ff5252;
  }

  .filter-row {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    align-items: center;
  }

  select {
    flex: 1;
    min-width: 150px;
    padding: 0.75rem;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 8px;
    color: #fff;
    font-size: 0.9rem;
    cursor: pointer;
  }

  select:focus {
    outline: none;
    border-color: #00ffff;
  }

  .clear-filters-btn {
    padding: 0.75rem 1.5rem;
    background: rgba(255, 50, 50, 0.2);
    border: 1px solid #ff5252;
    border-radius: 8px;
    color: #ff5555;
    cursor: pointer;
    font-size: 0.9rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    white-space: nowrap;
  }

  .clear-filters-btn:hover {
    background: rgba(255, 50, 50, 0.3);
  }

  .results-count {
    margin-top: 1rem;
    color: rgba(255, 255, 255, 0.6);
    font-size: 0.9rem;
  }

  .exercises-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1.5rem;
  }

  .exercise-card {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 1.5rem;
    transition: all 0.3s;
  }

  .exercise-card:hover {
    background: rgba(255, 255, 255, 0.08);
    transform: translateY(-4px);
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.3);
  }

  .exercise-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .exercise-header h3 {
    font-size: 1.1rem;
    flex: 1;
  }

  .difficulty-badge {
    padding: 0.25rem 0.75rem;
    border-radius: 20px;
    font-size: 0.75rem;
    font-weight: bold;
    color: #000;
    text-transform: capitalize;
  }

  .exercise-details {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .detail-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    color: rgba(255, 255, 255, 0.8);
    font-size: 0.9rem;
  }

  .detail-item i {
    color: #00ffff;
    width: 16px;
  }

  .secondary-muscles {
    padding-top: 0.75rem;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    font-size: 0.85rem;
    color: rgba(255, 255, 255, 0.6);
  }

  .secondary-muscles i {
    margin-right: 0.5rem;
  }

  .more {
    color: #00ffff;
    font-weight: bold;
  }

  .no-results {
    grid-column: 1 / -1;
    text-align: center;
    padding: 4rem 2rem;
    color: rgba(255, 255, 255, 0.5);
  }

  .no-results i {
    font-size: 4rem;
    margin-bottom: 1rem;
    opacity: 0.3;
  }

  .no-results p {
    font-size: 1.2rem;
    margin-bottom: 1.5rem;
  }

  .btn-primary {
    padding: 0.75rem 1.5rem;
    background: linear-gradient(135deg, #00ffff, #00aaff);
    color: #000;
    border: none;
    border-radius: 8px;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.3s;
  }

  .btn-primary:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 20px rgba(0, 255, 255, 0.4);
  }

  @media (max-width: 768px) {
    .exercises-grid {
      grid-template-columns: 1fr;
    }

    .filter-row {
      flex-direction: column;
    }

    .filter-row select {
      width: 100%;
    }

    .clear-filters-btn {
      width: 100%;
      justify-content: center;
    }
  }
</style>

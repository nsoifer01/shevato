<script>
  import { programs, workoutSessions, settings, exercises } from '../stores/gymStore.js';
  import { WorkoutSession, WorkoutExercise, Set } from '../lib/models.js';

  let activeWorkout = null;
  let selectedProgram = null;
  let startTime = null;
  let elapsedSeconds = 0;
  let timerInterval = null;
  let showFinishModal = false;

  // For editing sets
  let editingSet = null; // { exerciseIndex, setIndex }

  $: formattedTime = formatTime(elapsedSeconds);

  function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  function selectProgram(program) {
    if (!program.exercises || program.exercises.length === 0) {
      alert('This program has no exercises!');
      return;
    }

    selectedProgram = program;

    // Create workout session with exercises from program
    activeWorkout = new WorkoutSession({
      id: Date.now(),
      programId: program.id,
      workoutDayId: null,
      date: new Date().toISOString(),
      exercises: program.exercises.map((ex, idx) => new WorkoutExercise({
        exerciseId: ex.exerciseId,
        exerciseName: ex.exerciseName,
        sets: [],
        targetSets: ex.targetSets || 3,
        notes: '',
        order: idx,
        completed: false
      })),
      duration: 0,
      notes: '',
      completed: false
    });

    // Start timer
    startTime = Date.now();
    timerInterval = setInterval(() => {
      elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    }, 1000);
  }

  function getPreviousExerciseData(exerciseId) {
    // Get all workout sessions sorted by date (most recent first)
    const sortedSessions = [...$workoutSessions]
      .filter(s => s.completed)
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    // Find the most recent workout that has this exercise with completed sets
    for (const session of sortedSessions) {
      const exercise = session.exercises.find(ex => ex.exerciseId === exerciseId);
      if (exercise && exercise.sets && exercise.sets.length > 0) {
        return exercise.sets.filter(set => set.completed);
      }
    }
    return [];
  }

  function getExerciseById(exerciseId) {
    return $exercises.find(ex => ex.id === exerciseId);
  }

  function addSet(exerciseIndex) {
    const exercise = activeWorkout.exercises[exerciseIndex];
    const exerciseData = getExerciseById(exercise.exerciseId);
    const isDuration = exerciseData && exerciseData.exerciseType === 'duration';

    const weightInput = document.getElementById(`weight-${exerciseIndex}`);
    const repsInput = document.getElementById(`reps-${exerciseIndex}`);
    const minInput = document.getElementById(`duration-min-${exerciseIndex}`);
    const secInput = document.getElementById(`duration-sec-${exerciseIndex}`);

    let set;
    if (isDuration) {
      const minutes = parseInt(minInput?.value || 0);
      const seconds = parseInt(secInput?.value || 0);
      const totalSeconds = (minutes * 60) + seconds;

      if (totalSeconds === 0) {
        alert('Please enter a duration');
        return;
      }

      set = new Set({
        weight: 0,
        reps: 0,
        duration: totalSeconds,
        completed: true,
        restTime: 0,
        notes: ''
      });
    } else {
      const weight = parseFloat(weightInput?.value || 0);
      const reps = parseInt(repsInput?.value || 0);

      if (!weight || !reps) {
        alert('Please enter weight and reps');
        return;
      }

      set = new Set({
        weight,
        reps,
        duration: 0,
        completed: true,
        restTime: 0,
        notes: ''
      });
    }

    exercise.sets.push(set);
    activeWorkout = activeWorkout; // Trigger reactivity
  }

  function deleteSet(exerciseIndex, setIndex) {
    if (confirm('Delete this set?')) {
      activeWorkout.exercises[exerciseIndex].sets.splice(setIndex, 1);
      activeWorkout = activeWorkout; // Trigger reactivity
    }
  }

  function usePreviousSet(exerciseIndex, weight, reps) {
    const weightInput = document.getElementById(`weight-${exerciseIndex}`);
    const repsInput = document.getElementById(`reps-${exerciseIndex}`);

    if (weightInput) weightInput.value = weight;
    if (repsInput) repsInput.value = reps;
  }

  function usePreviousDuration(exerciseIndex, durationSeconds) {
    const minutes = Math.floor(durationSeconds / 60);
    const seconds = durationSeconds % 60;

    const minInput = document.getElementById(`duration-min-${exerciseIndex}`);
    const secInput = document.getElementById(`duration-sec-${exerciseIndex}`);

    if (minInput) minInput.value = minutes;
    if (secInput) secInput.value = seconds;
  }

  function openFinishModal() {
    const hasCompletedSets = activeWorkout.exercises.some(ex =>
      ex.sets && ex.sets.length > 0
    );

    if (!hasCompletedSets) {
      alert('Please complete at least one set before finishing');
      return;
    }

    showFinishModal = true;
  }

  function finishWorkout() {
    if (!activeWorkout) return;

    // Update duration
    activeWorkout.duration = Math.floor(elapsedSeconds / 60);
    activeWorkout.completed = true;
    activeWorkout.date = new Date().toISOString();

    // Save to store
    workoutSessions.update(sessions => [...sessions, activeWorkout]);

    // Stop timer
    clearInterval(timerInterval);

    // Reset state
    activeWorkout = null;
    selectedProgram = null;
    startTime = null;
    elapsedSeconds = 0;
    showFinishModal = false;

    alert('Workout completed! Great job! 💪');
  }

  function cancelWorkout() {
    if (confirm('Are you sure you want to cancel this workout? Your progress will not be saved.')) {
      clearInterval(timerInterval);
      activeWorkout = null;
      selectedProgram = null;
      startTime = null;
      elapsedSeconds = 0;
    }
  }

  function startEditSet(exerciseIndex, setIndex) {
    editingSet = { exerciseIndex, setIndex };
  }

  function saveEditSet(exerciseIndex, setIndex) {
    const set = activeWorkout.exercises[exerciseIndex].sets[setIndex];
    const exerciseData = getExerciseById(activeWorkout.exercises[exerciseIndex].exerciseId);
    const isDuration = exerciseData && exerciseData.exerciseType === 'duration';

    const weightInput = document.getElementById(`edit-weight-${exerciseIndex}-${setIndex}`);
    const repsInput = document.getElementById(`edit-reps-${exerciseIndex}-${setIndex}`);
    const minInput = document.getElementById(`edit-duration-min-${exerciseIndex}-${setIndex}`);
    const secInput = document.getElementById(`edit-duration-sec-${exerciseIndex}-${setIndex}`);

    if (isDuration) {
      const minutes = parseInt(minInput?.value || 0);
      const seconds = parseInt(secInput?.value || 0);
      const totalSeconds = (minutes * 60) + seconds;

      if (totalSeconds === 0) {
        alert('Please enter a valid duration');
        return;
      }

      set.duration = totalSeconds;
    } else {
      const weight = parseFloat(weightInput?.value || 0);
      const reps = parseInt(repsInput?.value || 0);

      if (!weight || !reps) {
        alert('Please enter valid weight and reps');
        return;
      }

      set.weight = weight;
      set.reps = reps;
    }

    editingSet = null;
    activeWorkout = activeWorkout; // Trigger reactivity
  }

  function cancelEditSet() {
    editingSet = null;
  }
</script>

<div class="workout-view">
  <div class="view-header">
    <h1>Workout</h1>
    <p class="subtitle">Start your workout session</p>
  </div>

  {#if activeWorkout}
    <!-- Active Workout Screen -->
    <div class="active-workout">
      <div class="workout-header">
        <h2>{selectedProgram?.name || 'Workout'}</h2>
        <div class="timer-display">{formattedTime}</div>
      </div>

      <div class="exercises-list">
        {#each activeWorkout.exercises as exercise, exerciseIndex}
          {@const exerciseData = getExerciseById(exercise.exerciseId)}
          {@const isDuration = exerciseData && exerciseData.exerciseType === 'duration'}
          {@const previousSets = getPreviousExerciseData(exercise.exerciseId)}

          <div class="exercise-entry">
            <div class="exercise-header">
              <h3>{exercise.exerciseName}</h3>
              {#if exerciseData}
                <span class="exercise-meta">{exerciseData.muscleGroup} • {exerciseData.equipment}</span>
              {/if}
            </div>

            <!-- Previous Workout Data -->
            {#if previousSets.length > 0}
              <div class="previous-data">
                <div class="previous-label">Last time:</div>
                <div class="previous-sets">
                  {#each previousSets as prevSet, i}
                    {#if isDuration}
                      {@const mins = Math.floor(prevSet.duration / 60)}
                      {@const secs = prevSet.duration % 60}
                      <button
                        class="previous-set-badge"
                        on:click={() => usePreviousDuration(exerciseIndex, prevSet.duration)}
                        title="Click to use this duration"
                      >
                        <span class="set-num">{i + 1}</span>
                        <span class="set-val">{mins}:{secs.toString().padStart(2, '0')}</span>
                      </button>
                    {:else}
                      <button
                        class="previous-set-badge"
                        on:click={() => usePreviousSet(exerciseIndex, prevSet.weight, prevSet.reps)}
                        title="Click to use these values"
                      >
                        <span class="set-num">{i + 1}</span>
                        <span class="set-val">{prevSet.weight}{$settings.weightUnit} × {prevSet.reps}</span>
                      </button>
                    {/if}
                  {/each}
                </div>
              </div>
            {:else}
              <div class="previous-data">
                <div class="previous-label">Last time: <span class="no-data">No previous data</span></div>
              </div>
            {/if}

            <!-- Add Set Inputs -->
            <div class="set-inputs">
              {#if isDuration}
                <div class="input-group duration-group">
                  <label>Duration</label>
                  <div class="duration-inputs">
                    <input
                      type="number"
                      id="duration-min-{exerciseIndex}"
                      placeholder="Min"
                      min="0"
                      value={previousSets[0] ? Math.floor(previousSets[0].duration / 60) : 0}
                    />
                    <span>:</span>
                    <input
                      type="number"
                      id="duration-sec-{exerciseIndex}"
                      placeholder="Sec"
                      min="0"
                      max="59"
                      value={previousSets[0] ? previousSets[0].duration % 60 : 0}
                    />
                  </div>
                </div>
              {:else}
                <div class="input-group">
                  <label>Weight ({$settings.weightUnit})</label>
                  <input
                    type="number"
                    id="weight-{exerciseIndex}"
                    placeholder="0"
                    step="0.5"
                    min="0"
                    value={previousSets[0]?.weight || ''}
                  />
                </div>
                <div class="input-group">
                  <label>Reps</label>
                  <input
                    type="number"
                    id="reps-{exerciseIndex}"
                    placeholder="0"
                    min="1"
                    value={previousSets[0]?.reps || ''}
                  />
                </div>
              {/if}
              <button class="btn-add-set" on:click={() => addSet(exerciseIndex)}>
                Add Set
              </button>
            </div>

            <!-- Completed Sets -->
            <div class="completed-sets">
              {#if exercise.sets.length === 0}
                <p class="no-sets">No sets completed</p>
              {:else}
                {#each exercise.sets as set, setIndex}
                  <div class="completed-set">
                    {#if editingSet && editingSet.exerciseIndex === exerciseIndex && editingSet.setIndex === setIndex}
                      <!-- Edit Mode -->
                      <div class="set-edit-form">
                        <span class="set-number">{isDuration ? 'Round' : 'Set'} {setIndex + 1}:</span>
                        {#if isDuration}
                          {@const mins = Math.floor(set.duration / 60)}
                          {@const secs = set.duration % 60}
                          <input
                            type="number"
                            id="edit-duration-min-{exerciseIndex}-{setIndex}"
                            value={mins}
                            min="0"
                            class="edit-input"
                          />
                          <span>:</span>
                          <input
                            type="number"
                            id="edit-duration-sec-{exerciseIndex}-{setIndex}"
                            value={secs}
                            min="0"
                            max="59"
                            class="edit-input"
                          />
                        {:else}
                          <input
                            type="number"
                            id="edit-weight-{exerciseIndex}-{setIndex}"
                            value={set.weight}
                            step="0.5"
                            min="0"
                            class="edit-input"
                          />
                          <span>×</span>
                          <input
                            type="number"
                            id="edit-reps-{exerciseIndex}-{setIndex}"
                            value={set.reps}
                            min="1"
                            class="edit-input"
                          />
                        {/if}
                        <div class="edit-actions">
                          <button class="btn-icon-save" on:click={() => saveEditSet(exerciseIndex, setIndex)} title="Save">
                            <i class="fas fa-check"></i>
                          </button>
                          <button class="btn-icon-cancel" on:click={cancelEditSet} title="Cancel">
                            <i class="fas fa-times"></i>
                          </button>
                        </div>
                      </div>
                    {:else}
                      <!-- Display Mode -->
                      <div class="set-info">
                        <span class="set-number">{isDuration ? 'Round' : 'Set'} {setIndex + 1}:</span>
                        {#if isDuration}
                          {@const mins = Math.floor(set.duration / 60)}
                          {@const secs = set.duration % 60}
                          <span class="set-details">{mins}:{secs.toString().padStart(2, '0')} min</span>
                        {:else}
                          <span class="set-details">{set.weight}{$settings.weightUnit} × {set.reps} reps</span>
                        {/if}
                      </div>
                      <div class="set-actions">
                        <button class="btn-icon" on:click={() => startEditSet(exerciseIndex, setIndex)} title="Edit">
                          <i class="fas fa-edit"></i>
                        </button>
                        <button class="btn-icon btn-delete" on:click={() => deleteSet(exerciseIndex, setIndex)} title="Delete">
                          <i class="fas fa-trash"></i>
                        </button>
                      </div>
                    {/if}
                  </div>
                {/each}
              {/if}
            </div>
          </div>
        {/each}
      </div>

      <div class="workout-footer">
        <button class="btn-danger" on:click={cancelWorkout}>
          Cancel Workout
        </button>
        <button class="btn-success" on:click={openFinishModal}>
          Finish Workout
        </button>
      </div>
    </div>
  {:else}
    <!-- Program Selection Screen -->
    <div class="program-selection">
      {#if $programs.length === 0}
        <div class="empty-state">
          <i class="fas fa-folder-open"></i>
          <p>No programs yet. Create a program first.</p>
        </div>
      {:else}
        <h2>Select a Program</h2>
        <p class="select-subtitle">Choose which program you want to do today</p>
        <div class="programs-grid">
          {#each $programs as program}
            <div class="program-card">
              <h3>{program.name}</h3>
              <p>{program.description || 'No description'}</p>
              <div class="program-stats">
                <span><i class="fas fa-dumbbell"></i> {program.exercises.length} exercises</span>
              </div>
              {#if program.exercises.length === 0}
                <p class="warning-text"><i class="fas fa-exclamation-triangle"></i> No exercises in this program</p>
              {:else}
                <button class="btn-primary btn-large" on:click={() => selectProgram(program)}>
                  <i class="fas fa-play"></i> Start Workout
                </button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<!-- Finish Workout Modal -->
{#if showFinishModal && activeWorkout}
  <div class="modal-overlay" on:click={() => showFinishModal = false}>
    <div class="modal" on:click|stopPropagation>
      <h2>Finish Workout</h2>
      <div class="workout-summary">
        <div class="summary-stat">
          <span class="stat-label">Duration:</span>
          <span class="stat-value">{Math.floor(elapsedSeconds / 60)} min</span>
        </div>
        <div class="summary-stat">
          <span class="stat-label">Total Sets:</span>
          <span class="stat-value">{activeWorkout.exercises.reduce((sum, ex) => sum + ex.sets.length, 0)}</span>
        </div>
        <div class="summary-stat">
          <span class="stat-label">Total Volume:</span>
          <span class="stat-value">{Math.round(activeWorkout.exercises.reduce((sum, ex) => sum + ex.sets.reduce((s, set) => s + (set.weight * set.reps), 0), 0))} {$settings.weightUnit}</span>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" on:click={() => showFinishModal = false}>
          Back to Workout
        </button>
        <button class="btn-success" on:click={finishWorkout}>
          Save Workout
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .workout-view {
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

  /* Program Selection */
  .program-selection h2 {
    font-size: 1.8rem;
    margin-bottom: 0.5rem;
    color: #00ffff;
  }

  .select-subtitle {
    color: rgba(255, 255, 255, 0.6);
    margin-bottom: 2rem;
  }

  .programs-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1.5rem;
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
    color: #fff;
  }

  .program-card p {
    color: rgba(255, 255, 255, 0.6);
    margin-bottom: 1rem;
  }

  .program-stats {
    margin-bottom: 1rem;
    color: rgba(255, 255, 255, 0.7);
  }

  .warning-text {
    color: #ff9800;
    font-size: 0.9rem;
  }

  /* Active Workout */
  .active-workout {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .workout-header {
    background: rgba(0, 255, 255, 0.1);
    border: 2px solid #00ffff;
    border-radius: 12px;
    padding: 1.5rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .workout-header h2 {
    color: #00ffff;
    font-size: 1.5rem;
  }

  .timer-display {
    font-size: 2rem;
    font-weight: bold;
    color: #00ffff;
    font-family: 'Courier New', monospace;
  }

  .exercises-list {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .exercise-entry {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 1.5rem;
  }

  .exercise-header h3 {
    font-size: 1.2rem;
    margin-bottom: 0.25rem;
    color: #fff;
  }

  .exercise-meta {
    color: rgba(255, 255, 255, 0.5);
    font-size: 0.85rem;
  }

  .previous-data {
    margin: 1rem 0;
  }

  .previous-label {
    color: rgba(255, 255, 255, 0.6);
    font-size: 0.9rem;
    margin-bottom: 0.5rem;
  }

  .no-data {
    color: rgba(255, 255, 255, 0.4);
  }

  .previous-sets {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .previous-set-badge {
    background: rgba(0, 255, 255, 0.1);
    border: 1px solid rgba(0, 255, 255, 0.3);
    border-radius: 6px;
    padding: 0.4rem 0.8rem;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }

  .previous-set-badge:hover {
    background: rgba(0, 255, 255, 0.2);
    border-color: rgba(0, 255, 255, 0.5);
  }

  .set-num {
    background: rgba(0, 255, 255, 0.2);
    border-radius: 4px;
    padding: 0.1rem 0.4rem;
    font-size: 0.8rem;
    font-weight: bold;
  }

  .set-val {
    font-size: 0.9rem;
    color: #00ffff;
  }

  .set-inputs {
    display: flex;
    gap: 1rem;
    margin: 1rem 0;
    align-items: flex-end;
  }

  .input-group {
    flex: 1;
  }

  .input-group label {
    display: block;
    font-size: 0.85rem;
    color: rgba(255, 255, 255, 0.7);
    margin-bottom: 0.3rem;
  }

  .input-group input {
    width: 100%;
    padding: 0.6rem;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    color: #fff;
    font-size: 1rem;
  }

  .duration-group {
    flex: 2;
  }

  .duration-inputs {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .duration-inputs input {
    width: 60px;
  }

  .duration-inputs span {
    color: rgba(255, 255, 255, 0.5);
  }

  .btn-add-set {
    padding: 0.6rem 1.5rem;
    background: linear-gradient(135deg, #00ffff, #00aaff);
    color: #000;
    border: none;
    border-radius: 6px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
  }

  .btn-add-set:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 15px rgba(0, 255, 255, 0.4);
  }

  .completed-sets {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .no-sets {
    color: rgba(255, 255, 255, 0.4);
    font-style: italic;
    font-size: 0.9rem;
  }

  .completed-set {
    background: rgba(0, 255, 136, 0.1);
    border: 1px solid rgba(0, 255, 136, 0.3);
    border-radius: 6px;
    padding: 0.6rem 1rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .set-info {
    display: flex;
    gap: 1rem;
  }

  .set-number {
    font-weight: 600;
    color: #00ff88;
  }

  .set-details {
    color: rgba(255, 255, 255, 0.9);
  }

  .set-actions {
    display: flex;
    gap: 0.5rem;
  }

  .btn-icon {
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    padding: 0.3rem 0.6rem;
    color: #fff;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn-icon:hover {
    background: rgba(255, 255, 255, 0.2);
  }

  .btn-delete {
    color: #ff5555;
  }

  .btn-delete:hover {
    background: rgba(255, 50, 50, 0.2);
    border-color: #ff5555;
  }

  .set-edit-form {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex: 1;
  }

  .edit-input {
    width: 70px;
    padding: 0.3rem 0.5rem;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 4px;
    color: #fff;
  }

  .edit-actions {
    display: flex;
    gap: 0.5rem;
  }

  .btn-icon-save {
    background: rgba(0, 255, 136, 0.2);
    border: 1px solid rgba(0, 255, 136, 0.4);
    border-radius: 4px;
    padding: 0.3rem 0.6rem;
    color: #00ff88;
    cursor: pointer;
  }

  .btn-icon-cancel {
    background: rgba(255, 50, 50, 0.2);
    border: 1px solid rgba(255, 50, 50, 0.4);
    border-radius: 4px;
    padding: 0.3rem 0.6rem;
    color: #ff5555;
    cursor: pointer;
  }

  .workout-footer {
    display: flex;
    gap: 1rem;
    padding: 1rem 0;
  }

  .btn-primary, .btn-success, .btn-danger, .btn-secondary {
    padding: 1rem 2rem;
    border: none;
    border-radius: 8px;
    font-size: 1.1rem;
    cursor: pointer;
    transition: all 0.3s;
    font-weight: 600;
    flex: 1;
  }

  .btn-large {
    padding: 1rem 2rem;
    width: 100%;
  }

  .btn-primary {
    background: linear-gradient(135deg, #00ffff, #00aaff);
    color: #000;
  }

  .btn-primary:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 20px rgba(0, 255, 255, 0.4);
  }

  .btn-success {
    background: linear-gradient(135deg, #00ff88, #00cc66);
    color: #000;
  }

  .btn-success:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 20px rgba(0, 255, 136, 0.4);
  }

  .btn-danger {
    background: rgba(255, 50, 50, 0.2);
    color: #ff5555;
    border: 1px solid #ff5555;
  }

  .btn-danger:hover {
    background: rgba(255, 50, 50, 0.3);
  }

  .btn-secondary {
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
    border: 1px solid rgba(255, 255, 255, 0.2);
  }

  .btn-secondary:hover {
    background: rgba(255, 255, 255, 0.15);
  }

  /* Modal */
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal {
    background: #1a1a2e;
    border: 2px solid rgba(0, 255, 255, 0.3);
    border-radius: 16px;
    padding: 2rem;
    max-width: 500px;
    width: 90%;
  }

  .modal h2 {
    color: #00ffff;
    margin-bottom: 1.5rem;
    font-size: 1.8rem;
  }

  .workout-summary {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin-bottom: 2rem;
  }

  .summary-stat {
    display: flex;
    justify-content: space-between;
    padding: 0.8rem;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 8px;
  }

  .stat-label {
    color: rgba(255, 255, 255, 0.7);
  }

  .stat-value {
    color: #00ffff;
    font-weight: bold;
    font-size: 1.1rem;
  }

  .modal-actions {
    display: flex;
    gap: 1rem;
  }

  .empty-state {
    background: rgba(255, 255, 255, 0.03);
    border: 2px dashed rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 4rem 2rem;
    text-align: center;
    color: rgba(255, 255, 255, 0.5);
  }

  .empty-state i {
    font-size: 3rem;
    margin-bottom: 1rem;
    display: block;
  }

  @media (max-width: 768px) {
    .workout-header {
      flex-direction: column;
      gap: 1rem;
      text-align: center;
    }

    .timer-display {
      font-size: 1.5rem;
    }

    .set-inputs {
      flex-direction: column;
      align-items: stretch;
    }

    .btn-add-set {
      width: 100%;
    }

    .programs-grid {
      grid-template-columns: 1fr;
    }

    .workout-footer {
      flex-direction: column;
    }
  }
</style>

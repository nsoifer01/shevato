<script>
  import { programs } from '../stores/gymStore.js';
  import { Program, WorkoutDay, WorkoutExercise } from '../lib/models.js';

  let showModal = false;
  let programName = '';
  let programDescription = '';

  function createProgram() {
    if (!programName.trim()) return;

    const newProgram = new Program({
      name: programName,
      description: programDescription,
      exercises: []
    });

    programs.update(p => [...p, newProgram]);

    // Reset form
    programName = '';
    programDescription = '';
    showModal = false;
  }

  function toggleActive(programId) {
    programs.update(progs => {
      return progs.map(p => ({
        ...p,
        isActive: p.id === programId ? !p.isActive : false
      }));
    });
  }

  function deleteProgram(programId) {
    if (confirm('Are you sure you want to delete this program?')) {
      programs.update(p => p.filter(prog => prog.id !== programId));
    }
  }
</script>

<div class="programs-view">
  <div class="view-header">
    <div>
      <h1>Programs</h1>
      <p class="subtitle">Manage your workout programs</p>
    </div>
    <button class="btn-primary" on:click={() => showModal = true}>
      + Create Program
    </button>
  </div>

  {#if $programs.length > 0}
    <div class="programs-grid">
      {#each $programs as program}
        <div class="program-card" class:active={program.isActive}>
          <div class="program-header">
            <h3>{program.name}</h3>
            {#if program.isActive}
              <span class="badge">Active</span>
            {/if}
          </div>
          <p class="program-description">{program.description}</p>
          <div class="program-meta">
            <span>{program.exercises.length} Exercises</span>
          </div>
          <div class="program-actions">
            <button class="btn-secondary" on:click={() => toggleActive(program.id)}>
              {program.isActive ? 'Deactivate' : 'Activate'}
            </button>
            <button class="btn-danger" on:click={() => deleteProgram(program.id)}>
              Delete
            </button>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="empty-state">
      <p>No programs yet. Create your first workout program!</p>
      <button class="btn-primary" on:click={() => showModal = true}>
        + Create Program
      </button>
    </div>
  {/if}
</div>

{#if showModal}
  <div class="modal-overlay" on:click={() => showModal = false}>
    <div class="modal" on:click|stopPropagation>
      <h2>Create New Program</h2>

      <div class="form-group">
        <label>Program Name</label>
        <input
          type="text"
          bind:value={programName}
          placeholder="e.g., Push Pull Legs"
        />
      </div>

      <div class="form-group">
        <label>Description</label>
        <textarea
          bind:value={programDescription}
          placeholder="Describe your program..."
          rows="4"
        ></textarea>
      </div>

      <div class="modal-actions">
        <button class="btn-secondary" on:click={() => showModal = false}>
          Cancel
        </button>
        <button class="btn-primary" on:click={createProgram}>
          Create
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .programs-view {
    max-width: 1200px;
    margin: 0 auto;
  }

  .view-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
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
    transition: all 0.3s;
  }

  .program-card.active {
    border-color: #00ffff;
    box-shadow: 0 0 20px rgba(0, 255, 255, 0.2);
  }

  .program-card:hover {
    transform: translateY(-4px);
    background: rgba(255, 255, 255, 0.08);
  }

  .program-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .program-header h3 {
    font-size: 1.3rem;
  }

  .badge {
    background: #00ffff;
    color: #000;
    padding: 0.25rem 0.75rem;
    border-radius: 20px;
    font-size: 0.8rem;
    font-weight: bold;
  }

  .program-description {
    color: rgba(255, 255, 255, 0.7);
    margin-bottom: 1rem;
  }

  .program-meta {
    color: rgba(255, 255, 255, 0.5);
    font-size: 0.9rem;
    margin-bottom: 1rem;
  }

  .program-actions {
    display: flex;
    gap: 0.5rem;
  }

  .btn-primary, .btn-secondary, .btn-danger {
    padding: 0.75rem 1.5rem;
    border: none;
    border-radius: 8px;
    font-size: 1rem;
    cursor: pointer;
    transition: all 0.3s;
    font-weight: 600;
  }

  .btn-primary {
    background: linear-gradient(135deg, #00ffff, #00aaff);
    color: #000;
  }

  .btn-primary:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 20px rgba(0, 255, 255, 0.4);
  }

  .btn-secondary {
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
    flex: 1;
  }

  .btn-secondary:hover {
    background: rgba(255, 255, 255, 0.15);
  }

  .btn-danger {
    background: rgba(255, 50, 50, 0.2);
    color: #ff5555;
  }

  .btn-danger:hover {
    background: rgba(255, 50, 50, 0.3);
  }

  .empty-state {
    background: rgba(255, 255, 255, 0.03);
    border: 2px dashed rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 4rem 2rem;
    text-align: center;
  }

  .empty-state p {
    color: rgba(255, 255, 255, 0.5);
    margin-bottom: 1.5rem;
    font-size: 1.1rem;
  }

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
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 2rem;
    max-width: 500px;
    width: 90%;
  }

  .modal h2 {
    margin-bottom: 1.5rem;
    color: #00ffff;
  }

  .form-group {
    margin-bottom: 1.5rem;
  }

  .form-group label {
    display: block;
    margin-bottom: 0.5rem;
    color: rgba(255, 255, 255, 0.8);
  }

  .form-group input,
  .form-group textarea {
    width: 100%;
    padding: 0.75rem;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    color: #fff;
    font-size: 1rem;
    font-family: inherit;
  }

  .form-group input:focus,
  .form-group textarea:focus {
    outline: none;
    border-color: #00ffff;
  }

  .modal-actions {
    display: flex;
    gap: 1rem;
    justify-content: flex-end;
  }

  @media (max-width: 768px) {
    .view-header {
      flex-direction: column;
      align-items: flex-start;
      gap: 1rem;
    }

    .programs-grid {
      grid-template-columns: 1fr;
    }
  }
</style>

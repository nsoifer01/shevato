// Gym Tracker JavaScript

// Data structure for workouts
let workouts = [];

// LocalStorage keys
const STORAGE_KEY = 'gymTrackerWorkouts';

// Initialize app on page load
document.addEventListener('DOMContentLoaded', function() {
    // Initialize app data - always load, sync system will handle updates
    function initializeAppData() {
        loadWorkouts();
        updateUI();
    }

    // Always initialize data immediately
    // The sync system will handle keeping data up to date
    initializeAppData();

    // Also refresh data when sync system becomes ready (for first-time setup)
    if (!window.syncSystemInitialized) {
        window.addEventListener('syncSystemReady', () => {
            console.log('🔄 Sync system ready, refreshing Gym Tracker data');
            // Give sync a moment to pull latest data, then refresh UI
            setTimeout(() => {
                initializeAppData();
            }, 1000);
        }, { once: true });
    }

    // Set initial date to today
    const dateInput = document.getElementById('workoutDate');
    if (dateInput) {
        dateInput.valueAsDate = new Date();
    }

    // Set up form submission
    const form = document.getElementById('quickAddForm');
    if (form) {
        form.addEventListener('submit', handleFormSubmit);
    }
});

// Load workouts from localStorage
function loadWorkouts() {
    const savedWorkouts = localStorage.getItem(STORAGE_KEY);
    if (savedWorkouts) {
        try {
            workouts = JSON.parse(savedWorkouts);
        } catch (e) {
            console.error('Error loading workouts:', e);
            workouts = [];
        }
    } else {
        workouts = [];
    }
}

// Save workouts to localStorage
function saveWorkouts() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workouts));
}

// Update UI
function updateUI() {
    updateStats();
    updateWorkoutTable();
}

// Update statistics
function updateStats() {
    const totalWorkouts = workouts.length;
    const totalExercises = new Set(workouts.map(w => w.exercise)).size;
    const totalVolume = workouts.reduce((sum, w) => {
        return sum + (w.sets * w.reps * w.weight);
    }, 0);

    document.getElementById('totalWorkouts').textContent = totalWorkouts;
    document.getElementById('totalExercises').textContent = totalExercises;
    document.getElementById('totalVolume').textContent = Math.round(totalVolume);
}

// Update workout table
function updateWorkoutTable() {
    const tableBody = document.getElementById('workoutsTableBody');
    const noWorkouts = document.getElementById('noWorkouts');

    if (workouts.length === 0) {
        tableBody.innerHTML = '';
        noWorkouts.style.display = 'block';
        return;
    }

    noWorkouts.style.display = 'none';

    // Sort workouts by date (newest first), then by timestamp
    const sortedWorkouts = [...workouts].sort((a, b) => {
        const dateCompare = new Date(b.date) - new Date(a.date);
        if (dateCompare !== 0) return dateCompare;
        return new Date(b.timestamp) - new Date(a.timestamp);
    });

    tableBody.innerHTML = sortedWorkouts.map((workout, index) => {
        const volume = workout.sets * workout.reps * workout.weight;
        const originalIndex = workouts.indexOf(workout);

        return `
            <tr>
                <td>${formatDate(workout.date)}</td>
                <td><strong>${escapeHtml(workout.exercise)}</strong></td>
                <td>${workout.sets}</td>
                <td>${workout.reps}</td>
                <td>${workout.weight}</td>
                <td><strong>${volume}</strong></td>
                <td>${workout.notes ? escapeHtml(workout.notes) : '-'}</td>
                <td>
                    <button class="action-btn delete-btn" onclick="deleteWorkout(${originalIndex})">Delete</button>
                </td>
            </tr>
        `;
    }).join('');
}

// Format date for display
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Handle form submission
function handleFormSubmit(e) {
    e.preventDefault();

    const exercise = document.getElementById('exerciseName').value.trim();
    const sets = parseInt(document.getElementById('sets').value);
    const reps = parseInt(document.getElementById('reps').value);
    const weight = parseFloat(document.getElementById('weight').value);
    const notes = document.getElementById('notes').value.trim();
    const date = document.getElementById('workoutDate').value;
    const errorDiv = document.getElementById('formError');

    // Clear previous error
    errorDiv.textContent = '';
    errorDiv.classList.remove('show');

    // Validation
    if (!exercise) {
        showError('Please enter an exercise name');
        return;
    }

    if (!date) {
        showError('Please select a date');
        return;
    }

    if (sets < 1) {
        showError('Sets must be at least 1');
        return;
    }

    if (reps < 1) {
        showError('Reps must be at least 1');
        return;
    }

    if (weight < 0) {
        showError('Weight cannot be negative');
        return;
    }

    // Create workout object
    const workout = {
        id: Date.now(),
        date: date,
        exercise: exercise,
        sets: sets,
        reps: reps,
        weight: weight,
        notes: notes,
        timestamp: new Date().toISOString()
    };

    console.log('Adding workout:', workout);

    // Add to workouts array
    workouts.push(workout);

    console.log('Total workouts now:', workouts.length);

    // Save to localStorage
    saveWorkouts();

    console.log('Saved to localStorage');

    // Update UI
    updateUI();

    console.log('UI updated');

    // Reset form
    document.getElementById('quickAddForm').reset();

    // Reset date to today
    document.getElementById('workoutDate').valueAsDate = new Date();

    // Focus on exercise name for quick next entry
    document.getElementById('exerciseName').focus();
}

// Show error message
function showError(message) {
    const errorDiv = document.getElementById('formError');
    errorDiv.textContent = message;
    errorDiv.classList.add('show');
}

// Delete workout
function deleteWorkout(index) {
    if (confirm('Are you sure you want to delete this workout?')) {
        workouts.splice(index, 1);
        saveWorkouts();
        updateUI();
    }
}

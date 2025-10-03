// Gym Tracker - Unified Initialization
// This file ensures all components are initialized AFTER Firebase sync has loaded data

(function() {
  let initialized = false;
  
  // Function to initialize all gym components in the correct order
  function initializeGymComponents() {
    if (initialized) return;
    
    console.log('🏋️ Initializing Gym Tracker components...');
    
    // 1. First initialize data (if not already done)
    if (!window.gymData && window.GymDataEnhanced) {
      window.gymData = new GymDataEnhanced();
      console.log('✅ Gym data initialized');
    }
    
    // 2. Initialize other components that depend on gymData
    if (window.gymData) {
      // Initialize UI
      if (!window.gymUI && window.GymUI) {
        window.gymUI = new GymUI();
        console.log('✅ Gym UI initialized');
      }
      
      // Initialize Workout manager
      if (!window.gymWorkout && window.GymWorkout) {
        window.gymWorkout = new GymWorkout();
        console.log('✅ Gym Workout initialized');
      }
      
      // Initialize Calendar
      if (!window.gymCalendar && window.GymCalendar) {
        window.gymCalendar = new GymCalendar();
        console.log('✅ Gym Calendar initialized');
      }
      
      // Initialize Progress
      if (!window.gymProgress && window.GymProgress) {
        window.gymProgress = new GymProgress();
        console.log('✅ Gym Progress initialized');
      }
      
      // Initialize Exercises
      if (!window.gymExercises && window.GymExercises) {
        window.gymExercises = new GymExercises();
        console.log('✅ Gym Exercises initialized');
      }
      
      // Initialize Training Plans
      if (!window.trainingPlans && window.GymTrainingPlans) {
        window.trainingPlans = new GymTrainingPlans();
        console.log('✅ Gym Training Plans initialized');
      }
      
      // Initialize main app last
      if (!window.gymApp && window.GymApp) {
        window.gymApp = new GymApp();
        console.log('✅ Gym App initialized');
      }
      
      initialized = true;
      console.log('🎉 Gym Tracker fully initialized!');
      
      // Dispatch event to notify that gym app is ready
      window.dispatchEvent(new CustomEvent('gymAppReady'));
    }
  }
  
  // Wait for sync system, then initialize
  function waitForSyncAndInitialize() {
    if (window.syncSystemInitialized) {
      console.log('🏋️ Sync system ready, initializing Gym Tracker components...');
      initializeGymComponents();
    } else {
      console.log('⏳ Gym Tracker: Waiting for sync system to be ready...');
      window.addEventListener('syncSystemReady', () => {
        console.log('✅ Sync system ready, initializing Gym Tracker components...');
        // Give sync system a moment to set up, then initialize
        setTimeout(() => {
          initializeGymComponents();
        }, 500);
      }, { once: true });
      
      // Fallback timeout
      setTimeout(() => {
        if (!window.syncSystemInitialized) {
          console.warn('⚠️ Sync system not ready after 5s, initializing gym anyway');
          initializeGymComponents();
        }
      }, 5000);
    }
  }
  
  // Start initialization process
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForSyncAndInitialize);
  } else {
    waitForSyncAndInitialize();
  }
})();
// Global sync loading modal - shows while waiting for Firebase data to sync
// This modal appears when user signs in and waits for data to load

(function() {
  'use strict';
  
  const MODAL_ID = 'syncLoadingModal';
  let modalElement = null;
  let isShowing = false;
  let syncStartTime = null;
  
  // Create modal HTML and CSS
  function createModal() {
    if (modalElement) return;
    
    // Create modal container
    modalElement = document.createElement('div');
    modalElement.id = MODAL_ID;
    modalElement.innerHTML = `
      <div class="sync-modal-backdrop">
        <div class="sync-modal-container">
          <div class="sync-modal-content">
            <div class="sync-spinner">
              <div class="sync-spinner-ring"></div>
              <div class="sync-spinner-ring"></div>
              <div class="sync-spinner-ring"></div>
            </div>
            <h3 class="sync-modal-title">Syncing Your Data</h3>
            <p class="sync-modal-message">Please wait while we load your latest data...</p>
            <div class="sync-progress-dots">
              <span class="dot"></span>
              <span class="dot"></span>
              <span class="dot"></span>
            </div>
          </div>
        </div>
      </div>
    `;
    
    // Add CSS styles
    const styles = `
      <style id="syncModalStyles">
        #${MODAL_ID} {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 10000;
          display: none;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
        }
        
        .sync-modal-backdrop {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.7);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        
        .sync-modal-container {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          border-radius: 20px;
          padding: 2px;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
          animation: syncModalSlideIn 0.3s ease-out;
          max-width: 400px;
          width: 100%;
        }
        
        .sync-modal-content {
          background: white;
          border-radius: 18px;
          padding: 40px 30px;
          text-align: center;
          position: relative;
        }
        
        .sync-spinner {
          position: relative;
          width: 80px;
          height: 80px;
          margin: 0 auto 30px;
        }
        
        .sync-spinner-ring {
          position: absolute;
          width: 100%;
          height: 100%;
          border: 3px solid transparent;
          border-top: 3px solid #667eea;
          border-radius: 50%;
          animation: syncSpin 1s linear infinite;
        }
        
        .sync-spinner-ring:nth-child(2) {
          width: 60px;
          height: 60px;
          top: 10px;
          left: 10px;
          border-top-color: #764ba2;
          animation-duration: 0.8s;
          animation-direction: reverse;
        }
        
        .sync-spinner-ring:nth-child(3) {
          width: 40px;
          height: 40px;
          top: 20px;
          left: 20px;
          border-top-color: #f093fb;
          animation-duration: 0.6s;
        }
        
        .sync-modal-title {
          margin: 0 0 15px 0;
          font-size: 24px;
          font-weight: 700;
          color: #333;
          letter-spacing: -0.5px;
        }
        
        .sync-modal-message {
          margin: 0 0 30px 0;
          font-size: 16px;
          color: #666;
          line-height: 1.5;
        }
        
        .sync-progress-dots {
          display: flex;
          justify-content: center;
          gap: 8px;
        }
        
        .sync-progress-dots .dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #667eea;
          animation: syncDotPulse 1.4s ease-in-out infinite both;
        }
        
        .sync-progress-dots .dot:nth-child(2) {
          animation-delay: 0.2s;
        }
        
        .sync-progress-dots .dot:nth-child(3) {
          animation-delay: 0.4s;
        }
        
        @keyframes syncModalSlideIn {
          from {
            transform: translateY(30px) scale(0.95);
            opacity: 0;
          }
          to {
            transform: translateY(0) scale(1);
            opacity: 1;
          }
        }
        
        @keyframes syncSpin {
          to {
            transform: rotate(360deg);
          }
        }
        
        @keyframes syncDotPulse {
          0%, 80%, 100% {
            transform: scale(0.8);
            opacity: 0.6;
          }
          40% {
            transform: scale(1.2);
            opacity: 1;
          }
        }
        
        /* Mobile responsiveness */
        @media (max-width: 480px) {
          .sync-modal-backdrop {
            padding: 15px;
          }
          
          .sync-modal-content {
            padding: 30px 20px;
          }
          
          .sync-modal-title {
            font-size: 20px;
          }
          
          .sync-modal-message {
            font-size: 14px;
          }
          
          .sync-spinner {
            width: 60px;
            height: 60px;
            margin-bottom: 25px;
          }
          
          .sync-spinner-ring:nth-child(2) {
            width: 45px;
            height: 45px;
            top: 7.5px;
            left: 7.5px;
          }
          
          .sync-spinner-ring:nth-child(3) {
            width: 30px;
            height: 30px;
            top: 15px;
            left: 15px;
          }
        }
        
        /* Tablet adjustments */
        @media (min-width: 481px) and (max-width: 768px) {
          .sync-modal-content {
            padding: 35px 25px;
          }
        }
        
        /* High DPI displays */
        @media (-webkit-min-device-pixel-ratio: 2), (min-resolution: 192dpi) {
          .sync-modal-container {
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.6);
          }
        }
        
        /* Dark mode support */
        @media (prefers-color-scheme: dark) {
          .sync-modal-backdrop {
            background: rgba(0, 0, 0, 0.85);
          }
          
          .sync-modal-content {
            background: #1a1a1a;
          }
          
          .sync-modal-title {
            color: #fff;
          }
          
          .sync-modal-message {
            color: #ccc;
          }
        }
        
        /* Reduced motion accessibility */
        @media (prefers-reduced-motion: reduce) {
          .sync-spinner-ring {
            animation: none;
          }
          
          .sync-progress-dots .dot {
            animation: none;
            opacity: 0.8;
          }
          
          .sync-modal-container {
            animation: none;
          }
        }
      </style>
    `;
    
    // Add styles to head
    document.head.insertAdjacentHTML('beforeend', styles);
    
    // Add modal to body
    document.body.appendChild(modalElement);
  }
  
  // Show the modal
  function showModal() {
    if (isShowing) return;
    
    createModal();
    isShowing = true;
    syncStartTime = Date.now();
    
    modalElement.style.display = 'block';
    
    // Prevent body scrolling
    document.body.style.overflow = 'hidden';
    
    console.log('🔄 Sync loading modal shown');
  }
  
  // Hide the modal
  function hideModal() {
    if (!isShowing || !modalElement) return;
    
    isShowing = false;
    modalElement.style.display = 'none';
    
    // Restore body scrolling
    document.body.style.overflow = '';
    
    if (syncStartTime) {
      const duration = Date.now() - syncStartTime;
      console.log(`✅ Sync loading modal hidden after ${duration}ms`);
      syncStartTime = null;
    }
  }
  
  // Update modal message
  function updateMessage(title, message) {
    if (!modalElement) return;
    
    const titleEl = modalElement.querySelector('.sync-modal-title');
    const messageEl = modalElement.querySelector('.sync-modal-message');
    
    if (titleEl && title) titleEl.textContent = title;
    if (messageEl && message) messageEl.textContent = message;
  }
  
  // Global API
  window.SyncLoadingModal = {
    show: showModal,
    hide: hideModal,
    updateMessage: updateMessage,
    isVisible: () => isShowing
  };
  
  console.log('✅ Global sync loading modal initialized');
  
})();
// scripts.js

document.addEventListener('DOMContentLoaded', () => {
  // Test Netlify environment variable - REMOVE AFTER TESTING
  console.log('Netlify ENV Test - process.env:', typeof process !== 'undefined' ? process.env : 'process not defined');
  console.log('Netlify ENV Test - window.env:', window.env || 'window.env not defined');
  
  const navLinks = document.querySelectorAll('nav ul li a');

  navLinks.forEach(link => {
    link.addEventListener('mouseover', () => {
      link.style.color = '#77aaff';
    });

    link.addEventListener('mouseout', () => {
      link.style.color = '#fff';
    });
  });
});

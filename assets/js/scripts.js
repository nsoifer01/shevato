// scripts.js

document.addEventListener('DOMContentLoaded', () => {
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

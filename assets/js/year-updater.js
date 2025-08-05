(function(){
  const y = new Date().getFullYear();
  const yearElements = {
    'year': document.getElementById('year'),
    'year-ru': document.getElementById('year-ru'),
    'year-he': document.getElementById('year-he')
  };
  
  Object.entries(yearElements).forEach(([id, element]) => {
    if (element) {
      element.textContent = y;
    }
  });
})();
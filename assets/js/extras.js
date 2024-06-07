document.addEventListener("DOMContentLoaded", function() {
  const fetchDataButton = document.getElementById("fetch-data");
  const endpointInput = document.getElementById("endpoint");
  const responseContainer = document.getElementById("response");

  fetchDataButton.addEventListener("click", function() {
    const endpoint = endpointInput.value;
    fetch(endpoint)
      .then(response => response.json())
      .then(data => {
        responseContainer.textContent = JSON.stringify(data, null, 2);
      })
      .catch(error => {
        responseContainer.textContent = "Error: " + error;
      });
  });
});

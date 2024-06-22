async function fetchData(url) {
    const proxyUrl = `https://api.scraperapi.com?api_key=95fd0396c5d5aacfa0b34b20c2cc6727&url=`;
    const response = await fetch(proxyUrl + encodeURIComponent(url));
    return response.json();
}

async function getData() {
    const teamID = 4602825;
    const leagueID = 1028577;

    const teamData = await fetchData(`https://fantasy.premierleague.com/api/entry/${teamID}/`);
    const leagueData = await fetchData(`https://fantasy.premierleague.com/api/leagues-classic/${leagueID}/standings/`);

    return { teamData, leagueData };
}

async function displayData() {
    try {
        const data = await getData();

        // Display data for debugging purposes
        console.log('Team Data:', data.teamData);
        console.log('League Data:', data.leagueData);

        document.getElementById('team-info').innerHTML = `
            <h2>Team Info</h2>
            <p>Team Name: ${data.teamData.name}</p>
            <p>Overall Points: ${data.teamData.summary_overall_points}</p>
            <p>Overall Rank: ${data.teamData.summary_overall_rank}</p>
        `;

        let leagueHTML = '<h2>League Standings</h2><ul>';
        data.leagueData.standings.results.forEach(team => {
            leagueHTML += `<li>${team.entry_name}: ${team.total} points</li>`;
        });
        leagueHTML += '</ul>';

        document.getElementById('team-info').innerHTML += leagueHTML;
    } catch (error) {
        console.error('Error fetching data:', error);
    }
}

// Call the displayData function to fetch and display the data
displayData();

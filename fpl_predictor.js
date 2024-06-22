async function fetchData(url) {
    const response = await fetch(url);
    return response.json();
}

async function getData() {
    const teamID = 4602825;
    const leagueID = 1028577;

    const teamData = await fetchData(`https://fantasy.premierleague.com/api/entry/${teamID}/`);
    const leagueData = await fetchData(`https://fantasy.premierleague.com/api/leagues-classic/${leagueID}/standings/`);

    // Fetch additional data if needed, such as fixtures, player stats, etc.

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

async function fetchData(url) {
    const proxyUrl = `https://api.scraperapi.com?api_key=95fd0396c5d5aacfa0b34b20c2cc6727&url=`;
    const response = await fetch(proxyUrl + encodeURIComponent(url));
    return response.json();
}

async function getData() {
    const teamID = 4602825;

    const teamData = await fetchData(`https://fantasy.premierleague.com/api/entry/${teamID}/`);
    const historyData = await fetchData(`https://fantasy.premierleague.com/api/entry/${teamID}/history/`);
    const playerData = await fetchData('https://fantasy.premierleague.com/api/bootstrap-static/'); // Fetch general player data

    return { teamData, historyData, playerData };
}

function preprocessData(historyData) {
    const features = historyData.current.map(gameweek => ({
        points: gameweek.points,
        transfers: gameweek.event_transfers,
        chip: gameweek.active_chip ? 1 : 0
    }));

    return features;
}

async function createAndTrainModel(features) {
    const inputs = features.map(f => [f.transfers, f.chip]);
    const labels = features.map(f => f.points);

    const inputTensor = tf.tensor2d(inputs, [inputs.length, 2]);
    const labelTensor = tf.tensor2d(labels, [labels.length, 1]);

    const model = tf.sequential();
    model.add(tf.layers.dense({ units: 100, activation: 'relu', inputShape: [2] }));
    model.add(tf.layers.dense({ units: 1 }));

    model.compile({ optimizer: 'adam', loss: 'meanSquaredError' });

    await model.fit(inputTensor, labelTensor, { epochs: 50, shuffle: true });

    return model;
}

async function predictPoints(model, playerData) {
    const playerFeatures = playerData.elements.map(player => ({
        id: player.id,
        transfers: player.transfers_in_event,
        chip: 0 // Placeholder: replace with actual feature values
    }));

    const inputs = playerFeatures.map(f => [f.transfers, f.chip]);
    const inputTensor = tf.tensor2d(inputs, [inputs.length, 2]);

    const predictions = model.predict(inputTensor).dataSync();

    playerFeatures.forEach((player, index) => {
        player.predicted_points = predictions[index];
    });

    return playerFeatures;
}

function optimizeTeam(playerFeatures, budget) {
    const sortedPlayers = playerFeatures.sort((a, b) => b.predicted_points - a.predicted_points);
    let selectedTeam = [];
    let remainingBudget = budget;

    for (const player of sortedPlayers) {
        if (remainingBudget >= player.now_cost / 10) {
            selectedTeam.push(player);
            remainingBudget -= player.now_cost / 10;
        }
    }

    return selectedTeam;
}

async function displayData() {
    try {
        const data = await getData();

        const features = preprocessData(data.historyData);

        const model = await createAndTrainModel(features);

        const playerFeatures = await predictPoints(model, data.playerData);

        console.log('Player Data:', data.playerData.elements); // Debug player data
        console.log('Player Features:', playerFeatures); // Debug predictions

        const budget = 100; // Example budget
        const selectedTeam = optimizeTeam(playerFeatures, budget);

        console.log('Selected Team:', selectedTeam); // Debug selected team

        document.getElementById('team-info').innerHTML = `
            <h2>Team Info</h2>
            <p>Team Name: ${data.teamData.name}</p>
            <p>Overall Points: ${data.teamData.summary_overall_points}</p>
            <p>Overall Rank: ${data.teamData.summary_overall_rank}</p>
            <h2>Selected Team</h2>
            ${selectedTeam.map(player => `<p>${player.web_name}: ${player.predicted_points.toFixed(2)} points</p>`).join('')}
        `;

    } catch (error) {
        console.error('Error fetching data:', error);
    }
}

displayData();

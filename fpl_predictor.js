async function fetchData(url) {
    const proxyUrl = `https://api.scraperapi.com?api_key=95fd0396c5d5aacfa0b34b20c2cc6727&url=`;
    const response = await fetch(proxyUrl + encodeURIComponent(url));
    return response.json();
}

async function getData() {
    const teamID = 4602825;

    const teamData = await fetchData(`https://fantasy.premierleague.com/api/entry/${teamID}/`);
    const historyData = await fetchData(`https://fantasy.premierleague.com/api/entry/${teamID}/history/`);
    const playerData = JSON.parse(localStorage.getItem('historicalData'));

    if (!playerData || !playerData.elements) {
        console.error('No historical data found or data is invalid.');
        return { teamData, historyData, playerData: { elements: [] } };
    }

    return { teamData, historyData, playerData };
}

function preprocessData(historyData) {
    const features = historyData.current.map(gameweek => ({
        points: gameweek.points,
        transfers: gameweek.event_transfers,
        chip: gameweek.active_chip ? 1 : 0
    }));

    console.log('Preprocessed Features:', features);
    return features;
}

async function createAndTrainModel(features) {
    const inputs = features.map(f => [f.transfers, f.chip, 0, 0]); // Adjust this as needed
    const labels = features.map(f => f.points);

    const inputTensor = tf.tensor2d(inputs, [inputs.length, 4]); // Adjust to 4 dimensions
    const labelTensor = tf.tensor2d(labels, [labels.length, 1]);

    console.log('Training model with input tensor:', inputTensor.shape);
    console.log('Training model with label tensor:', labelTensor.shape);

    const model = tf.sequential();
    model.add(tf.layers.dense({ units: 100, activation: 'relu', inputShape: [4] })); // Adjust to 4 dimensions
    model.add(tf.layers.dense({ units: 1 }));

    model.compile({ optimizer: 'adam', loss: 'meanSquaredError' });

    await model.fit(inputTensor, labelTensor, { epochs: 50, shuffle: true });

    return model;
}

async function predictPoints(model, playerData) {
    const positionMap = {
        1: "GK",
        2: "DEF",
        3: "MID",
        4: "FWD"
    };

    const playerFeatures = playerData.elements.map(player => ({
        id: player.id,
        web_name: player.web_name,
        now_cost: player.now_cost,
        transfers: player.transfers_in_event || 0,
        chip: 0,
        position: positionMap[player.element_type] || "UNK",
        form: parseFloat(player.form) || 0,
        xG: parseFloat(player.xG) || 0,
        xA: parseFloat(player.xA) || 0,
        xGA: parseFloat(player.xGA) || 0
    }));

    console.log('Player Features:', playerFeatures);

    const inputs = playerFeatures.map(f => [f.transfers, f.chip, f.now_cost, f.form, f.xG, f.xA, f.xGA]);
    const inputTensor = tf.tensor2d(inputs, [inputs.length, 7]);

    console.log('Predicting points with input tensor:', inputTensor.shape);

    const predictions = model.predict(inputTensor).dataSync();

    playerFeatures.forEach((player, index) => {
        player.predicted_points = predictions[index];
    });

    return playerFeatures;
}

function optimizeTeam(playerFeatures, budget) {
    const uniquePlayers = new Set();
    const sortedPlayers = playerFeatures.sort((a, b) => b.predicted_points - a.predicted_points);
    let selectedTeam = [];
    let remainingBudget = budget;

    const teamStructure = {
        GK: parseInt(document.getElementById('gk').value),
        DEF: parseInt(document.getElementById('def').value),
        MID: parseInt(document.getElementById('mid').value),
        FWD: parseInt(document.getElementById('fwd').value)
    };

    for (const player of sortedPlayers) {
        const position = player.position;

        if (teamStructure[position] > 0 && remainingBudget >= player.now_cost / 10 && !uniquePlayers.has(player.web_name)) {
            selectedTeam.push(player);
            uniquePlayers.add(player.web_name);
            remainingBudget -= player.now_cost / 10;
            teamStructure[position]--;
        }

        if (selectedTeam.length >= 11) break; // Ensure team has 11 players
    }

    return selectedTeam;
}

async function displayData() {
    try {
        const data = await getData();

        console.log('Team Data:', data.teamData);
        console.log('History Data:', data.historyData);
        console.log('Player Data:', data.playerData.elements);

        if (!data.playerData || !data.playerData.elements.length) {
            console.error('No player data available for prediction.');
            return;
        }

        const features = preprocessData(data.historyData);

        const model = await createAndTrainModel(features);

        const playerFeatures = await predictPoints(model, data.playerData);

        console.log('Player Features:', playerFeatures);

        const budget = parseFloat(document.getElementById('budget').value);
        const selectedTeam = optimizeTeam(playerFeatures, budget);

        console.log('Selected Team:', selectedTeam);

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

document.getElementById('update-team').addEventListener('click', displayData);

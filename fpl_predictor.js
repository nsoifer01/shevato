async function fetchData(url) {
    const proxyUrl = `https://api.scraperapi.com?api_key=95fd0396c5d5aacfa0b34b20c2cc6727&url=`;
    const response = await fetch(proxyUrl + encodeURIComponent(url));
    return response.json();
}

async function getData() {
    const teamID = 4602825;

    const teamData = await fetchData(`https://fantasy.premierleague.com/api/entry/${teamID}/`);
    const historyData = await fetchData(`https://fantasy.premierleague.com/api/entry/${teamID}/history/`);

    return { teamData, historyData };
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

async function displayData() {
    try {
        const data = await getData();

        const features = preprocessData(data.historyData);

        const model = await createAndTrainModel(features);

        console.log('Team Data:', data.teamData);
        console.log('Features:', features);
        console.log('Trained Model:', model);

        document.getElementById('team-info').innerHTML = `
            <h2>Team Info</h2>
            <p>Team Name: ${data.teamData.name}</p>
            <p>Overall Points: ${data.teamData.summary_overall_points}</p>
            <p>Overall Rank: ${data.teamData.summary_overall_rank}</p>
        `;

    } catch (error) {
        console.error('Error fetching data:', error);
    }
}

displayData();

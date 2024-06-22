const fetch = require('node-fetch');
const fs = require('fs');

const proxyUrl = `https://api.scraperapi.com?api_key=95fd0396c5d5aacfa0b34b20c2cc6727&url=`;
const seasons = ['2013-14', '2014-15', '2015-16', '2016-17', '2017-18', '2018-19', '2019-20', '2020-21', '2021-22', '2022-23'];

async function fetchSeasonData(season) {
    const url = `https://fantasy.premierleague.com/api/bootstrap-static/`;
    const response = await fetch(proxyUrl + encodeURIComponent(url));
    const data = await response.json();
    return data;
}

async function collectHistoricalData() {
    let historicalData = [];

    for (const season of seasons) {
        console.log(`Fetching data for season ${season}...`);
        const data = await fetchSeasonData(season);
        historicalData = historicalData.concat(data.elements.map(player => ({
            id: player.id,
            web_name: player.web_name,
            now_cost: player.now_cost,
            transfers_in_event: player.transfers_in_event,
            points: player.total_points,
            position: player.element_type,
            form: player.form
        })));
    }

    fs.writeFileSync('historical_data.json', JSON.stringify({ elements: historicalData }, null, 2));
    console.log('Historical data collected and saved to historical_data.json');
}

collectHistoricalData().catch(console.error);

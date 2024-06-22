async function fetchData(url) {
    const proxyUrl = `https://api.scraperapi.com?api_key=95fd0396c5d5aacfa0b34b20c2cc6727&url=`;
    const response = await fetch(proxyUrl + encodeURIComponent(url));
    return response.json();
}

async function fetchSeasonData(season) {
    const url = `https://fantasy.premierleague.com/api/bootstrap-static/`;
    const data = await fetchData(url);
    return data;
}

async function collectHistoricalData() {
    const seasons = ['2013-14', '2014-15', '2015-16', '2016-17', '2017-18', '2018-19', '2019-20', '2020-21', '2021-22', '2022-23'];
    let historicalData = [];

    for (const season of seasons) {
        console.log(`Fetching data for season ${season}...`);
        const data = await fetchSeasonData(season);

        if (data && data.elements) {
            historicalData = historicalData.concat(data.elements.map(player => ({
                id: player.id,
                web_name: player.web_name,
                now_cost: player.now_cost,
                transfers_in_event: player.transfers_in_event,
                points: player.total_points,
                position: player.element_type,
                form: player.form
            })));
        } else {
            console.error(`Failed to fetch data for season ${season}`);
        }
    }

    localStorage.setItem('historicalData', JSON.stringify({ elements: historicalData }));
    console.log('Historical data collected and saved to localStorage');
}

collectHistoricalData().catch(console.error);

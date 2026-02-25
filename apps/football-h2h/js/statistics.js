// Statistics calculation for Football H2H

import { state } from './store.js';

export function updateStatistics() {
  const gamesToAnalyze = window.getFilteredGames ? window.getFilteredGames() : state.games;
  updateStatisticsWithData(gamesToAnalyze);
}

export function updateStatisticsWithData(gamesData) {
  let player1Wins = 0;
  let player2Wins = 0;
  let player1Wins90 = 0;
  let player2Wins90 = 0;
  let player1PenaltyWins = 0;
  let player2PenaltyWins = 0;
  let draws = 0;
  let totalGoals = 0;
  let penaltyShootouts = 0;

  gamesData.forEach((game) => {
    totalGoals += game.player1Goals + game.player2Goals;

    if (game.player1Goals > game.player2Goals) {
      player1Wins++;
      player1Wins90++;
    } else if (game.player2Goals > game.player1Goals) {
      player2Wins++;
      player2Wins90++;
    } else {
      if (game.penaltyWinner && game.penaltyWinner !== 'draw') {
        penaltyShootouts++;
        if (game.penaltyWinner === 1) {
          player1Wins++;
          player1PenaltyWins++;
        } else {
          player2Wins++;
          player2PenaltyWins++;
        }
      } else {
        draws++;
        if (game.penaltyWinner === 'draw') {
          penaltyShootouts++;
        }
      }
    }
  });

  const totalGames = gamesData.length;
  const goalsPerGameValue = totalGames > 0 ? totalGoals / totalGames : 0;
  const goalsPerGame =
    goalsPerGameValue % 1 === 0 ? goalsPerGameValue.toFixed(0) : goalsPerGameValue.toFixed(1);

  const elements = {
    totalGames: document.getElementById('totalGames'),
    player1Wins: document.getElementById('player1Wins'),
    player2Wins: document.getElementById('player2Wins'),
    player1Wins90: document.getElementById('player1Wins90'),
    player2Wins90: document.getElementById('player2Wins90'),
    player1PenaltyWins: document.getElementById('player1PenaltyWins'),
    player2PenaltyWins: document.getElementById('player2PenaltyWins'),
    totalDraws: document.getElementById('totalDraws'),
    goalsPerGame: document.getElementById('goalsPerGame'),
    penaltyShootouts: document.getElementById('penaltyShootouts'),
    player1StatsName: document.getElementById('player1StatsName'),
    player2StatsName: document.getElementById('player2StatsName'),
    player1StatsName90: document.getElementById('player1StatsName90'),
    player2StatsName90: document.getElementById('player2StatsName90'),
    player1StatsNamePen: document.getElementById('player1StatsNamePen'),
    player2StatsNamePen: document.getElementById('player2StatsNamePen'),
  };

  if (elements.totalGames) elements.totalGames.textContent = totalGames;
  if (elements.player1Wins) elements.player1Wins.textContent = player1Wins;
  if (elements.player2Wins) elements.player2Wins.textContent = player2Wins;
  if (elements.player1Wins90) elements.player1Wins90.textContent = player1Wins90;
  if (elements.player2Wins90) elements.player2Wins90.textContent = player2Wins90;
  if (elements.player1PenaltyWins) elements.player1PenaltyWins.textContent = player1PenaltyWins;
  if (elements.player2PenaltyWins) elements.player2PenaltyWins.textContent = player2PenaltyWins;
  if (elements.totalDraws) elements.totalDraws.textContent = draws;
  if (elements.goalsPerGame) elements.goalsPerGame.textContent = goalsPerGame;
  if (elements.penaltyShootouts) elements.penaltyShootouts.textContent = penaltyShootouts;
  if (elements.player1StatsName) elements.player1StatsName.textContent = state.player1Name;
  if (elements.player2StatsName) elements.player2StatsName.textContent = state.player2Name;
  if (elements.player1StatsName90) elements.player1StatsName90.textContent = state.player1Name;
  if (elements.player2StatsName90) elements.player2StatsName90.textContent = state.player2Name;
  if (elements.player1StatsNamePen) elements.player1StatsNamePen.textContent = state.player1Name;
  if (elements.player2StatsNamePen) elements.player2StatsNamePen.textContent = state.player2Name;

  // Update border colors based on win comparison
  const player1Card = document.querySelector('.player1-card');
  const player2Card = document.querySelector('.player2-card');
  const player1Card90 = document.querySelector('.player1-90min-card');
  const player2Card90 = document.querySelector('.player2-90min-card');

  if (player1Card && player2Card) {
    player1Card.classList.remove('winning', 'losing', 'tied');
    player2Card.classList.remove('winning', 'losing', 'tied');

    if (player1Wins > player2Wins) {
      player1Card.classList.add('winning');
      player2Card.classList.add('losing');
    } else if (player2Wins > player1Wins) {
      player2Card.classList.add('winning');
      player1Card.classList.add('losing');
    } else {
      player1Card.classList.add('tied');
      player2Card.classList.add('tied');
    }
  }

  if (player1Card90 && player2Card90) {
    player1Card90.classList.remove('winning', 'losing', 'tied');
    player2Card90.classList.remove('winning', 'losing', 'tied');

    if (player1Wins90 > player2Wins90) {
      player1Card90.classList.add('winning');
      player2Card90.classList.add('losing');
    } else if (player2Wins90 > player1Wins90) {
      player2Card90.classList.add('winning');
      player1Card90.classList.add('losing');
    } else {
      player1Card90.classList.add('tied');
      player2Card90.classList.add('tied');
    }
  }

  const player1CardPen = document.querySelector('.player1-penalty-card');
  const player2CardPen = document.querySelector('.player2-penalty-card');

  if (player1CardPen && player2CardPen) {
    player1CardPen.classList.remove('winning', 'losing', 'tied');
    player2CardPen.classList.remove('winning', 'losing', 'tied');

    if (player1PenaltyWins > player2PenaltyWins) {
      player1CardPen.classList.add('winning');
      player2CardPen.classList.add('losing');
    } else if (player2PenaltyWins > player1PenaltyWins) {
      player2CardPen.classList.add('winning');
      player1CardPen.classList.add('losing');
    } else {
      player1CardPen.classList.add('tied');
      player2CardPen.classList.add('tied');
    }
  }
}

export function switchStatsTab(tabName) {
  document.querySelectorAll('.stats-tab').forEach((tab) => {
    tab.classList.remove('active');
    tab.setAttribute('aria-selected', 'false');
  });
  document.querySelectorAll('.stats-tab-content').forEach((content) => {
    content.classList.remove('active');
    content.style.display = 'none';
  });

  const activeTab = Array.from(document.querySelectorAll('.stats-tab')).find((tab) =>
    tab.getAttribute('onclick')?.includes(tabName),
  );
  const activeContent = document.getElementById(`${tabName}-stats`);

  if (activeTab) {
    activeTab.classList.add('active');
    activeTab.setAttribute('aria-selected', 'true');
  }
  if (activeContent) {
    activeContent.classList.add('active');
    activeContent.style.display = 'block';
  }
}

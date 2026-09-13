// The bootstrap-static element fields the committed lifecycle fixtures keep,
// shared by every script that derives them from a live capture
// (derive-gw1-fixtures.mjs, derive-gw4-fixtures.mjs). One list, so two
// fixture sets can never disagree about what a trimmed player carries.

// Element metadata that does NOT change between lifecycle states.
export const META = [
  'id', 'code', 'web_name', 'first_name', 'second_name', 'team', 'element_type',
  'now_cost', 'cost_change_start', 'status', 'chance_of_playing_next_round',
  'news', 'news_added', 'selected_by_percent',
  'penalties_order', 'direct_freekicks_order', 'corners_and_indirect_freekicks_order',
];

// Totals that DO change: these are what FPL rewrote at the rollover, and what
// it credits from kickoff while a match is being played.
export const TOTALS = [
  'minutes', 'starts', 'total_points', 'bonus', 'bps', 'saves', 'goals_scored',
  'assists', 'clean_sheets', 'goals_conceded', 'yellow_cards', 'red_cards',
  'own_goals', 'penalties_saved', 'penalties_missed',
  'clearances_blocks_interceptions', 'recoveries', 'tackles', 'defensive_contribution',
  'expected_goals', 'expected_assists', 'expected_goal_involvements', 'expected_goals_conceded',
  'expected_goals_per_90', 'expected_assists_per_90', 'expected_goal_involvements_per_90',
  'expected_goals_conceded_per_90', 'saves_per_90', 'goals_conceded_per_90',
  'starts_per_90', 'clean_sheets_per_90', 'defensive_contribution_per_90',
];

export const pick = (o, keys) => { const r = {}; for (const k of keys) if (k in o) r[k] = o[k]; return r; };

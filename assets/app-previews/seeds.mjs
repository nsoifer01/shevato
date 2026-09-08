// Sample datasets for the apps whose interesting state needs seeded storage.
// Shapes are taken from each app's own unit-test fixtures, not invented.
const iso = (d) => new Date(d).toISOString();

export const SEEDS = {
  'football-h2h': {
    footballH2HPlayers: { player1: 'Nikita', player2: 'Alex' },
    footballH2HGames: [
      { id: 1, player1Goals: 2, player2Goals: 1, dateTime: iso('2026-08-02T19:30:00Z') },
      { id: 2, player1Goals: 0, player2Goals: 3, dateTime: iso('2026-08-05T20:00:00Z') },
      { id: 3, player1Goals: 1, player2Goals: 1, penaltyWinner: '2', dateTime: iso('2026-08-08T19:45:00Z') },
      { id: 4, player1Goals: 4, player2Goals: 2, dateTime: iso('2026-08-11T21:00:00Z') },
      { id: 5, player1Goals: 2, player2Goals: 2, penaltyWinner: '1', dateTime: iso('2026-08-14T19:15:00Z') },
      { id: 6, player1Goals: 1, player2Goals: 3, dateTime: iso('2026-08-17T20:30:00Z') },
      { id: 7, player1Goals: 3, player2Goals: 0, dateTime: iso('2026-08-20T19:00:00Z') },
      { id: 8, player1Goals: 2, player2Goals: 4, dateTime: iso('2026-08-23T20:45:00Z') },
      { id: 9, player1Goals: 5, player2Goals: 3, dateTime: iso('2026-08-26T19:30:00Z') },
      { id: 10, player1Goals: 1, player2Goals: 2, dateTime: iso('2026-08-29T21:15:00Z') },
      { id: 11, player1Goals: 3, player2Goals: 3, penaltyWinner: '2', dateTime: iso('2026-09-01T19:30:00Z') },
      { id: 12, player1Goals: 2, player2Goals: 0, dateTime: iso('2026-09-04T20:00:00Z') },
    ],
  },

  'maptap-rivals': {
    maptapRivalsMe: '"Nikita"',
    maptapRivalsRivals: [
      { id: 'r1', name: 'Dan', color: '#f59e0b', icon: 'D', createdAt: 1 },
      { id: 'r2', name: 'Priya', color: '#22d3ee', icon: 'P', createdAt: 2 },
      { id: 'r3', name: 'Marcus', color: '#f87171', icon: 'M', createdAt: 3 },
    ],
    maptapRivalsGames: [
          {
                "id": "g1",
                "rivalId": "r1",
                "date": "2026-08-28",
                "createdAt": 1,
                "myScores": [
                      88,
                      92,
                      76,
                      84,
                      90
                ],
                "theirScores": [
                      70,
                      81,
                      72,
                      79,
                      74
                ],
                "myScore": 854,
                "theirScore": 754
          },
          {
                "id": "g2",
                "rivalId": "r1",
                "date": "2026-08-30",
                "createdAt": 2,
                "myScores": [
                      64,
                      71,
                      68,
                      73,
                      70
                ],
                "theirScores": [
                      82,
                      88,
                      79,
                      85,
                      83
                ],
                "myScore": 700,
                "theirScore": 832
          },
          {
                "id": "g3",
                "rivalId": "r1",
                "date": "2026-09-02",
                "createdAt": 3,
                "myScores": [
                      95,
                      89,
                      91,
                      93,
                      88
                ],
                "theirScores": [
                      86,
                      84,
                      88,
                      87,
                      85
                ],
                "myScore": 909,
                "theirScore": 862
          },
          {
                "id": "g4",
                "rivalId": "r1",
                "date": "2026-09-04",
                "createdAt": 4,
                "myScores": [
                      77,
                      82,
                      74,
                      80,
                      78
                ],
                "theirScores": [
                      69,
                      73,
                      70,
                      72,
                      68
                ],
                "myScore": 781,
                "theirScore": 702
          },
          {
                "id": "g5",
                "rivalId": "r1",
                "date": "2026-09-06",
                "createdAt": 5,
                "myScores": [
                      85,
                      88,
                      83,
                      87,
                      86
                ],
                "theirScores": [
                      92,
                      90,
                      94,
                      91,
                      93
                ],
                "myScore": 858,
                "theirScore": 922
          },
          {
                "id": "g6",
                "rivalId": "r2",
                "date": "2026-08-29",
                "createdAt": 6,
                "myScores": [
                      74,
                      79,
                      72,
                      77,
                      75
                ],
                "theirScores": [
                      81,
                      84,
                      79,
                      83,
                      80
                ],
                "myScore": 753,
                "theirScore": 812
          },
          {
                "id": "g7",
                "rivalId": "r2",
                "date": "2026-09-01",
                "createdAt": 7,
                "myScores": [
                      94,
                      91,
                      96,
                      93,
                      95
                ],
                "theirScores": [
                      83,
                      87,
                      81,
                      85,
                      84
                ],
                "myScore": 941,
                "theirScore": 839
          },
          {
                "id": "g8",
                "rivalId": "r2",
                "date": "2026-09-03",
                "createdAt": 8,
                "myScores": [
                      82,
                      85,
                      80,
                      84,
                      83
                ],
                "theirScores": [
                      80,
                      83,
                      79,
                      82,
                      81
                ],
                "myScore": 828,
                "theirScore": 810
          },
          {
                "id": "g9",
                "rivalId": "r2",
                "date": "2026-09-05",
                "createdAt": 9,
                "myScores": [
                      70,
                      74,
                      68,
                      72,
                      71
                ],
                "theirScores": [
                      93,
                      90,
                      95,
                      92,
                      94
                ],
                "myScore": 709,
                "theirScore": 931
          },
          {
                "id": "g10",
                "rivalId": "r3",
                "date": "2026-08-31",
                "createdAt": 10,
                "myScores": [
                      89,
                      92,
                      87,
                      90,
                      88
                ],
                "theirScores": [
                      72,
                      75,
                      70,
                      74,
                      73
                ],
                "myScore": 889,
                "theirScore": 728
          },
          {
                "id": "g11",
                "rivalId": "r3",
                "date": "2026-09-02",
                "createdAt": 11,
                "myScores": [
                      96,
                      94,
                      97,
                      95,
                      93
                ],
                "theirScores": [
                      88,
                      86,
                      90,
                      87,
                      89
                ],
                "myScore": 948,
                "theirScore": 882
          },
          {
                "id": "g12",
                "rivalId": "r3",
                "date": "2026-09-06",
                "createdAt": 12,
                "myScores": [
                      83,
                      86,
                      81,
                      85,
                      84
                ],
                "theirScores": [
                      79,
                      82,
                      77,
                      81,
                      80
                ],
                "myScore": 838,
                "theirScore": 798
          }
    ],
  },

  'mario-kart': {
    marioKartPlayerCount: 3,
    marioKartPlayerNames: { player1: 'Nikita', player2: 'Alex', player3: 'Sam', player4: 'Player 4' },
    marioKartRaces: [
      { date: '2026-08-24', timestamp: 1, player1: 1, player2: 3, player3: 5, player4: null },
      { date: '2026-08-24', timestamp: 2, player1: 2, player2: 1, player3: 6, player4: null },
      { date: '2026-08-26', timestamp: 3, player1: 4, player2: 2, player3: 1, player4: null },
      { date: '2026-08-26', timestamp: 4, player1: 1, player2: 5, player3: 3, player4: null },
      { date: '2026-08-28', timestamp: 5, player1: 3, player2: 1, player3: 2, player4: null },
      { date: '2026-08-28', timestamp: 6, player1: 1, player2: 4, player3: 7, player4: null },
      { date: '2026-08-31', timestamp: 7, player1: 2, player2: 3, player3: 1, player4: null },
      { date: '2026-08-31', timestamp: 8, player1: 5, player2: 1, player3: 4, player4: null },
      { date: '2026-09-02', timestamp: 9, player1: 1, player2: 2, player3: 6, player4: null },
      { date: '2026-09-02', timestamp: 10, player1: 3, player2: 6, player3: 2, player4: null },
      { date: '2026-09-04', timestamp: 11, player1: 2, player2: 1, player3: 5, player4: null },
      { date: '2026-09-04', timestamp: 12, player1: 1, player2: 4, player3: 3, player4: null },
      { date: '2026-09-06', timestamp: 13, player1: 4, player2: 2, player3: 1, player4: null },
      { date: '2026-09-06', timestamp: 14, player1: 1, player2: 3, player3: 2, player4: null },
    ],
  },

  'gym-tracker': {
      "gymTrackerSettings": {
          "weightUnit": "kg",
          "theme": "dark",
          "firstDayOfWeek": 1,
          "barWeight": 20,
          "timeFormat": "24"
      },
      "gymTrackerCustomExercises": [
          {
              "id": 9001,
              "name": "Bench Press",
              "category": "chest",
              "muscleGroup": "Chest",
              "equipment": "barbell",
              "isCustom": true
          },
          {
              "id": 9002,
              "name": "Back Squat",
              "category": "legs",
              "muscleGroup": "Quads",
              "equipment": "barbell",
              "isCustom": true
          },
          {
              "id": 9003,
              "name": "Deadlift",
              "category": "back",
              "muscleGroup": "Back",
              "equipment": "barbell",
              "isCustom": true
          },
          {
              "id": 9004,
              "name": "Overhead Press",
              "category": "shoulders",
              "muscleGroup": "Shoulders",
              "equipment": "barbell",
              "isCustom": true
          },
          {
              "id": 9005,
              "name": "Barbell Row",
              "category": "back",
              "muscleGroup": "Back",
              "equipment": "barbell",
              "isCustom": true
          },
          {
              "id": 9006,
              "name": "Pull Up",
              "category": "back",
              "muscleGroup": "Back",
              "equipment": "barbell",
              "isCustom": true
          },
          {
              "id": 9007,
              "name": "Incline Dumbbell Press",
              "category": "chest",
              "muscleGroup": "Chest",
              "equipment": "barbell",
              "isCustom": true
          },
          {
              "id": 9008,
              "name": "Romanian Deadlift",
              "category": "legs",
              "muscleGroup": "Hamstrings",
              "equipment": "barbell",
              "isCustom": true
          }
      ],
      "gymTrackerPrograms": [
          {
              "id": 8001,
              "name": "Push Pull Legs",
              "exercises": [],
              "createdAt": "2025-09-08T10:00:00.000Z"
          }
      ],
      "gymTrackerActiveProgram": 8001,
      "gymTrackerSessions": [
          {
              "id": 7144,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2025-10-09",
              "startTime": "2025-10-09T18:00:00.000Z",
              "endTime": "2025-10-09T19:07:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 100.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 100.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 100.0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 90.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 90.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 90.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7143,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2025-10-11",
              "startTime": "2025-10-11T18:00:00.000Z",
              "endTime": "2025-10-11T19:06:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 120.0,
                              "reps": 3,
                              "completed": true
                          },
                          {
                              "weight": 120.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 120.0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 60.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 60.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 60.0,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7142,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2025-10-13",
              "startTime": "2025-10-13T18:00:00.000Z",
              "endTime": "2025-10-13T19:00:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 80.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 80.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 80.0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 50.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 50.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 50.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 30.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 30.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 30.0,
                              "reps": 14,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7141,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2025-10-16",
              "startTime": "2025-10-16T18:00:00.000Z",
              "endTime": "2025-10-16T19:07:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 100.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 100.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 100.0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 90.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 90.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 90.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7140,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2025-10-18",
              "startTime": "2025-10-18T18:00:00.000Z",
              "endTime": "2025-10-18T19:02:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 120.0,
                              "reps": 5,
                              "completed": true
                          },
                          {
                              "weight": 120.0,
                              "reps": 4,
                              "completed": true
                          },
                          {
                              "weight": 120.0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 60.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 60.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 60.0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7139,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2025-10-20",
              "startTime": "2025-10-20T18:00:00.000Z",
              "endTime": "2025-10-20T18:57:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 80.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 80.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 80.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 50.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 50.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 50.0,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 30.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 30.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 30.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7138,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2025-10-23",
              "startTime": "2025-10-23T18:00:00.000Z",
              "endTime": "2025-10-23T19:05:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 100.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 100.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 100.0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 90.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 90.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 90.0,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7137,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2025-10-25",
              "startTime": "2025-10-25T18:00:00.000Z",
              "endTime": "2025-10-25T18:51:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 122.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 122.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 122.5,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 60.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 60.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 60.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7136,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2025-10-27",
              "startTime": "2025-10-27T18:00:00.000Z",
              "endTime": "2025-10-27T18:55:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 80.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 80.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 80.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 50.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 50.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 50.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 30.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 30.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 30.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7135,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2025-10-30",
              "startTime": "2025-10-30T18:00:00.000Z",
              "endTime": "2025-10-30T18:52:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 102.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 92.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7134,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2025-11-01",
              "startTime": "2025-11-01T18:00:00.000Z",
              "endTime": "2025-11-01T18:57:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 122.5,
                              "reps": 4,
                              "completed": true
                          },
                          {
                              "weight": 122.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 122.5,
                              "reps": 5,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 60.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 60.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 60.0,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7133,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2025-11-03",
              "startTime": "2025-11-03T18:00:00.000Z",
              "endTime": "2025-11-03T19:00:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 82.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 82.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 82.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 50.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 50.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 50.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 30.0,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 30.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 30.0,
                              "reps": 14,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7132,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2025-11-06",
              "startTime": "2025-11-06T18:00:00.000Z",
              "endTime": "2025-11-06T19:04:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 102.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 92.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7131,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2025-11-08",
              "startTime": "2025-11-08T18:00:00.000Z",
              "endTime": "2025-11-08T19:07:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 122.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 122.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 122.5,
                              "reps": 4,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 60.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 60.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 60.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7130,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2025-11-10",
              "startTime": "2025-11-10T18:00:00.000Z",
              "endTime": "2025-11-10T18:58:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 82.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 82.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 82.5,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 50.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 50.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 50.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 30.0,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 30.0,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 30.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7129,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2025-11-13",
              "startTime": "2025-11-13T18:00:00.000Z",
              "endTime": "2025-11-13T19:06:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 102.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 92.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7128,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2025-11-15",
              "startTime": "2025-11-15T18:00:00.000Z",
              "endTime": "2025-11-15T18:52:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 122.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 122.5,
                              "reps": 5,
                              "completed": true
                          },
                          {
                              "weight": 122.5,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 62.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 62.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 62.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7127,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2025-11-17",
              "startTime": "2025-11-17T18:00:00.000Z",
              "endTime": "2025-11-17T19:06:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 82.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 82.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 82.5,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 50.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 50.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 50.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 30.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 30.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 30.0,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7126,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2025-11-20",
              "startTime": "2025-11-20T18:00:00.000Z",
              "endTime": "2025-11-20T19:09:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 102.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 92.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7125,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2025-11-22",
              "startTime": "2025-11-22T18:00:00.000Z",
              "endTime": "2025-11-22T19:08:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 122.5,
                              "reps": 5,
                              "completed": true
                          },
                          {
                              "weight": 122.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 122.5,
                              "reps": 3,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 62.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 62.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 62.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7124,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2025-11-24",
              "startTime": "2025-11-24T18:00:00.000Z",
              "endTime": "2025-11-24T18:55:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 82.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 82.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 82.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 52.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 30.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 30.0,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 30.0,
                              "reps": 13,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7123,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2025-11-27",
              "startTime": "2025-11-27T18:00:00.000Z",
              "endTime": "2025-11-27T19:09:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 102.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 92.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7122,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2025-11-29",
              "startTime": "2025-11-29T18:00:00.000Z",
              "endTime": "2025-11-29T18:50:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 125.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 125.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 125.0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 62.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 62.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 62.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7121,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2025-12-01",
              "startTime": "2025-12-01T18:00:00.000Z",
              "endTime": "2025-12-01T18:49:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 82.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 82.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 82.5,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 52.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 30.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 30.0,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 30.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7120,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2025-12-04",
              "startTime": "2025-12-04T18:00:00.000Z",
              "endTime": "2025-12-04T19:05:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 102.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 92.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7119,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2025-12-06",
              "startTime": "2025-12-06T18:00:00.000Z",
              "endTime": "2025-12-06T19:10:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 125.0,
                              "reps": 4,
                              "completed": true
                          },
                          {
                              "weight": 125.0,
                              "reps": 3,
                              "completed": true
                          },
                          {
                              "weight": 125.0,
                              "reps": 4,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 62.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 62.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 62.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7118,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2025-12-08",
              "startTime": "2025-12-08T18:00:00.000Z",
              "endTime": "2025-12-08T19:06:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 82.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 82.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 82.5,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 52.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 30.0,
                              "reps": 14,
                              "completed": true
                          },
                          {
                              "weight": 30.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 30.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7117,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2025-12-11",
              "startTime": "2025-12-11T18:00:00.000Z",
              "endTime": "2025-12-11T18:52:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 105.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 92.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7116,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2025-12-13",
              "startTime": "2025-12-13T18:00:00.000Z",
              "endTime": "2025-12-13T18:55:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 125.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 125.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 125.0,
                              "reps": 5,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 62.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 62.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 62.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7115,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2025-12-15",
              "startTime": "2025-12-15T18:00:00.000Z",
              "endTime": "2025-12-15T19:00:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 82.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 82.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 82.5,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 52.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 30.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 30.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 30.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7114,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2025-12-18",
              "startTime": "2025-12-18T18:00:00.000Z",
              "endTime": "2025-12-18T19:00:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 105.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 95.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7113,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2025-12-20",
              "startTime": "2025-12-20T18:00:00.000Z",
              "endTime": "2025-12-20T19:12:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 125.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 125.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 125.0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 62.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 62.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 62.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7112,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2025-12-22",
              "startTime": "2025-12-22T18:00:00.000Z",
              "endTime": "2025-12-22T19:10:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 82.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 82.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 82.5,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 52.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 32.5,
                              "reps": 14,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 14,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7111,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2025-12-25",
              "startTime": "2025-12-25T18:00:00.000Z",
              "endTime": "2025-12-25T18:49:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 105.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 95.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7110,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2025-12-27",
              "startTime": "2025-12-27T18:00:00.000Z",
              "endTime": "2025-12-27T19:12:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 125.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 125.0,
                              "reps": 5,
                              "completed": true
                          },
                          {
                              "weight": 125.0,
                              "reps": 5,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 62.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 62.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 62.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7109,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2025-12-29",
              "startTime": "2025-12-29T18:00:00.000Z",
              "endTime": "2025-12-29T19:01:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 85.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 85.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 85.0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 52.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 32.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 13,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7108,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-01-01",
              "startTime": "2026-01-01T18:00:00.000Z",
              "endTime": "2026-01-01T19:01:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 105.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 95.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7107,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-01-03",
              "startTime": "2026-01-03T18:00:00.000Z",
              "endTime": "2026-01-03T19:02:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 125.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 125.0,
                              "reps": 3,
                              "completed": true
                          },
                          {
                              "weight": 125.0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 62.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 62.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 62.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7106,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-01-05",
              "startTime": "2026-01-05T18:00:00.000Z",
              "endTime": "2026-01-05T19:03:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 85.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 85.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 85.0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 52.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 32.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 13,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7105,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-01-08",
              "startTime": "2026-01-08T18:00:00.000Z",
              "endTime": "2026-01-08T19:12:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 105.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 95.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7104,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-01-10",
              "startTime": "2026-01-10T18:00:00.000Z",
              "endTime": "2026-01-10T18:48:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 127.5,
                              "reps": 5,
                              "completed": true
                          },
                          {
                              "weight": 127.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 127.5,
                              "reps": 3,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 62.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 62.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 62.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7103,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-01-12",
              "startTime": "2026-01-12T18:00:00.000Z",
              "endTime": "2026-01-12T19:05:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 85.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 85.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 85.0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 52.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 32.5,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 14,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7102,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-01-15",
              "startTime": "2026-01-15T18:00:00.000Z",
              "endTime": "2026-01-15T19:04:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 105.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 95.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7101,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-01-17",
              "startTime": "2026-01-17T18:00:00.000Z",
              "endTime": "2026-01-17T18:53:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 127.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 127.5,
                              "reps": 4,
                              "completed": true
                          },
                          {
                              "weight": 127.5,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 62.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 62.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 62.5,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7100,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-01-19",
              "startTime": "2026-01-19T18:00:00.000Z",
              "endTime": "2026-01-19T19:06:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 85.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 85.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 85.0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 52.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 32.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 13,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7099,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-01-22",
              "startTime": "2026-01-22T18:00:00.000Z",
              "endTime": "2026-01-22T18:55:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 107.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 107.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 107.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 95.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7098,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-01-24",
              "startTime": "2026-01-24T18:00:00.000Z",
              "endTime": "2026-01-24T19:07:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 127.5,
                              "reps": 4,
                              "completed": true
                          },
                          {
                              "weight": 127.5,
                              "reps": 4,
                              "completed": true
                          },
                          {
                              "weight": 127.5,
                              "reps": 5,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 65.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 65.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 65.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7097,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-01-26",
              "startTime": "2026-01-26T18:00:00.000Z",
              "endTime": "2026-01-26T18:57:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 85.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 85.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 85.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 52.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 32.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7096,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-01-29",
              "startTime": "2026-01-29T18:00:00.000Z",
              "endTime": "2026-01-29T19:12:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 107.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 107.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 107.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 95.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7095,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-01-31",
              "startTime": "2026-01-31T18:00:00.000Z",
              "endTime": "2026-01-31T18:50:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 127.5,
                              "reps": 4,
                              "completed": true
                          },
                          {
                              "weight": 127.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 127.5,
                              "reps": 5,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 65.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 65.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 65.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7094,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-02-02",
              "startTime": "2026-02-02T18:00:00.000Z",
              "endTime": "2026-02-02T19:12:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 85.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 85.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 85.0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 52.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 32.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 14,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7093,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-02-05",
              "startTime": "2026-02-05T18:00:00.000Z",
              "endTime": "2026-02-05T19:11:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 107.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 107.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 107.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 97.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 97.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 97.5,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7092,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-02-07",
              "startTime": "2026-02-07T18:00:00.000Z",
              "endTime": "2026-02-07T18:50:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 127.5,
                              "reps": 5,
                              "completed": true
                          },
                          {
                              "weight": 127.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 127.5,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 65.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 65.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 65.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7091,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-02-09",
              "startTime": "2026-02-09T18:00:00.000Z",
              "endTime": "2026-02-09T18:55:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 85.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 85.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 85.0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 52.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 52.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 32.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 14,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7090,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-02-12",
              "startTime": "2026-02-12T18:00:00.000Z",
              "endTime": "2026-02-12T19:07:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 107.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 107.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 107.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 97.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 97.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 97.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7089,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-02-14",
              "startTime": "2026-02-14T18:00:00.000Z",
              "endTime": "2026-02-14T19:08:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 130.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 130.0,
                              "reps": 4,
                              "completed": true
                          },
                          {
                              "weight": 130.0,
                              "reps": 5,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 65.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 65.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 65.0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7088,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-02-16",
              "startTime": "2026-02-16T18:00:00.000Z",
              "endTime": "2026-02-16T19:10:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 85.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 85.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 85.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 55.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 32.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 14,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 14,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7087,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-02-19",
              "startTime": "2026-02-19T18:00:00.000Z",
              "endTime": "2026-02-19T18:51:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 107.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 107.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 107.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 97.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 97.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 97.5,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7086,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-02-21",
              "startTime": "2026-02-21T18:00:00.000Z",
              "endTime": "2026-02-21T18:59:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 130.0,
                              "reps": 5,
                              "completed": true
                          },
                          {
                              "weight": 130.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 130.0,
                              "reps": 4,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 65.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 65.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 65.0,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7085,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-02-23",
              "startTime": "2026-02-23T18:00:00.000Z",
              "endTime": "2026-02-23T18:51:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 87.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 87.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 87.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 55.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 32.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 14,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7084,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-02-26",
              "startTime": "2026-02-26T18:00:00.000Z",
              "endTime": "2026-02-26T18:49:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 107.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 107.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 107.5,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 97.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 97.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 97.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7083,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-02-28",
              "startTime": "2026-02-28T18:00:00.000Z",
              "endTime": "2026-02-28T19:04:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 130.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 130.0,
                              "reps": 5,
                              "completed": true
                          },
                          {
                              "weight": 130.0,
                              "reps": 3,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 65.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 65.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 65.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7082,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-03-02",
              "startTime": "2026-03-02T18:00:00.000Z",
              "endTime": "2026-03-02T18:49:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 87.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 87.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 87.5,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 55.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 32.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 13,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7081,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-03-05",
              "startTime": "2026-03-05T18:00:00.000Z",
              "endTime": "2026-03-05T18:48:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 110.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 110.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 110.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 97.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 97.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 97.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7080,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-03-07",
              "startTime": "2026-03-07T18:00:00.000Z",
              "endTime": "2026-03-07T18:57:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 130.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 130.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 130.0,
                              "reps": 5,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 65.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 65.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 65.0,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7079,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-03-09",
              "startTime": "2026-03-09T18:00:00.000Z",
              "endTime": "2026-03-09T19:01:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 87.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 87.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 87.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 55.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 32.5,
                              "reps": 14,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 14,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7078,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-03-12",
              "startTime": "2026-03-12T18:00:00.000Z",
              "endTime": "2026-03-12T19:00:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 110.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 110.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 110.0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 97.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 97.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 97.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7077,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-03-14",
              "startTime": "2026-03-14T18:00:00.000Z",
              "endTime": "2026-03-14T19:06:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 130.0,
                              "reps": 5,
                              "completed": true
                          },
                          {
                              "weight": 130.0,
                              "reps": 5,
                              "completed": true
                          },
                          {
                              "weight": 130.0,
                              "reps": 5,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 65.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 65.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 65.0,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7076,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-03-16",
              "startTime": "2026-03-16T18:00:00.000Z",
              "endTime": "2026-03-16T18:51:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 87.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 87.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 87.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 55.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 32.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7075,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-03-19",
              "startTime": "2026-03-19T18:00:00.000Z",
              "endTime": "2026-03-19T18:51:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 110.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 110.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 110.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 97.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 97.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 97.5,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7074,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-03-21",
              "startTime": "2026-03-21T18:00:00.000Z",
              "endTime": "2026-03-21T19:10:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 132.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 132.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 132.5,
                              "reps": 4,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 65.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 65.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 65.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7073,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-03-23",
              "startTime": "2026-03-23T18:00:00.000Z",
              "endTime": "2026-03-23T19:09:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 87.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 87.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 87.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 55.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 32.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7072,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-03-26",
              "startTime": "2026-03-26T18:00:00.000Z",
              "endTime": "2026-03-26T18:51:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 110.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 110.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 110.0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 100.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 100.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 100.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7071,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-03-28",
              "startTime": "2026-03-28T18:00:00.000Z",
              "endTime": "2026-03-28T19:00:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 132.5,
                              "reps": 3,
                              "completed": true
                          },
                          {
                              "weight": 132.5,
                              "reps": 4,
                              "completed": true
                          },
                          {
                              "weight": 132.5,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 65.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 65.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 65.0,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7070,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-03-30",
              "startTime": "2026-03-30T18:00:00.000Z",
              "endTime": "2026-03-30T18:56:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 87.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 87.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 87.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 55.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 32.5,
                              "reps": 14,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7069,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-04-02",
              "startTime": "2026-04-02T18:00:00.000Z",
              "endTime": "2026-04-02T18:58:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 110.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 110.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 110.0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 100.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 100.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 100.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7068,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-04-04",
              "startTime": "2026-04-04T18:00:00.000Z",
              "endTime": "2026-04-04T19:00:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 132.5,
                              "reps": 5,
                              "completed": true
                          },
                          {
                              "weight": 132.5,
                              "reps": 3,
                              "completed": true
                          },
                          {
                              "weight": 132.5,
                              "reps": 3,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 65.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 65.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 65.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7067,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-04-06",
              "startTime": "2026-04-06T18:00:00.000Z",
              "endTime": "2026-04-06T19:07:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 87.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 87.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 87.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 55.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 32.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7066,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-04-09",
              "startTime": "2026-04-09T18:00:00.000Z",
              "endTime": "2026-04-09T19:12:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 110.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 110.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 110.0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 100.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 100.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 100.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7065,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-04-11",
              "startTime": "2026-04-11T18:00:00.000Z",
              "endTime": "2026-04-11T19:09:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 132.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 132.5,
                              "reps": 4,
                              "completed": true
                          },
                          {
                              "weight": 132.5,
                              "reps": 4,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 67.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 67.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 67.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7064,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-04-13",
              "startTime": "2026-04-13T18:00:00.000Z",
              "endTime": "2026-04-13T19:06:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 87.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 87.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 87.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 55.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 32.5,
                              "reps": 14,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 14,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 14,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7063,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-04-16",
              "startTime": "2026-04-16T18:00:00.000Z",
              "endTime": "2026-04-16T19:04:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 110.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 110.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 110.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 100.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 100.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 100.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7062,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-04-18",
              "startTime": "2026-04-18T18:00:00.000Z",
              "endTime": "2026-04-18T18:54:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 132.5,
                              "reps": 3,
                              "completed": true
                          },
                          {
                              "weight": 132.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 132.5,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 67.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 67.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 67.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7061,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-04-20",
              "startTime": "2026-04-20T18:00:00.000Z",
              "endTime": "2026-04-20T19:00:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 90.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 90.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 90.0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 55.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 32.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7060,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-04-23",
              "startTime": "2026-04-23T18:00:00.000Z",
              "endTime": "2026-04-23T18:58:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 112.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 112.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 112.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 100.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 100.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 100.0,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7059,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-04-25",
              "startTime": "2026-04-25T18:00:00.000Z",
              "endTime": "2026-04-25T19:06:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 135.0,
                              "reps": 4,
                              "completed": true
                          },
                          {
                              "weight": 135.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 135.0,
                              "reps": 4,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 67.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 67.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 67.5,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7058,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-04-27",
              "startTime": "2026-04-27T18:00:00.000Z",
              "endTime": "2026-04-27T19:07:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 90.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 90.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 90.0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 55.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 32.5,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 14,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7057,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-04-30",
              "startTime": "2026-04-30T18:00:00.000Z",
              "endTime": "2026-04-30T19:04:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 112.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 112.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 112.5,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 100.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 100.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 100.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7056,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-05-02",
              "startTime": "2026-05-02T18:00:00.000Z",
              "endTime": "2026-05-02T18:55:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 135.0,
                              "reps": 3,
                              "completed": true
                          },
                          {
                              "weight": 135.0,
                              "reps": 3,
                              "completed": true
                          },
                          {
                              "weight": 135.0,
                              "reps": 4,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 67.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 67.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 67.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7055,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-05-04",
              "startTime": "2026-05-04T18:00:00.000Z",
              "endTime": "2026-05-04T19:10:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 90.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 90.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 90.0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 55.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 32.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7054,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-05-07",
              "startTime": "2026-05-07T18:00:00.000Z",
              "endTime": "2026-05-07T19:03:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 112.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 112.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 112.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 100.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 100.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 100.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7053,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-05-09",
              "startTime": "2026-05-09T18:00:00.000Z",
              "endTime": "2026-05-09T18:56:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 135.0,
                              "reps": 3,
                              "completed": true
                          },
                          {
                              "weight": 135.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 135.0,
                              "reps": 3,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 67.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 67.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 67.5,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7052,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-05-11",
              "startTime": "2026-05-11T18:00:00.000Z",
              "endTime": "2026-05-11T19:06:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 90.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 90.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 90.0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 55.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 55.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 32.5,
                              "reps": 14,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 32.5,
                              "reps": 14,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7051,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-05-14",
              "startTime": "2026-05-14T18:00:00.000Z",
              "endTime": "2026-05-14T19:04:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 112.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 112.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 112.5,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 102.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7050,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-05-16",
              "startTime": "2026-05-16T18:00:00.000Z",
              "endTime": "2026-05-16T18:56:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 135.0,
                              "reps": 5,
                              "completed": true
                          },
                          {
                              "weight": 135.0,
                              "reps": 5,
                              "completed": true
                          },
                          {
                              "weight": 135.0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 67.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 67.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 67.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7049,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-05-18",
              "startTime": "2026-05-18T18:00:00.000Z",
              "endTime": "2026-05-18T19:05:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 90.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 90.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 90.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 57.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 35.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 14,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 14,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7048,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-05-21",
              "startTime": "2026-05-21T18:00:00.000Z",
              "endTime": "2026-05-21T19:12:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 112.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 112.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 112.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 102.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7047,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-05-23",
              "startTime": "2026-05-23T18:00:00.000Z",
              "endTime": "2026-05-23T18:52:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 135.0,
                              "reps": 4,
                              "completed": true
                          },
                          {
                              "weight": 135.0,
                              "reps": 3,
                              "completed": true
                          },
                          {
                              "weight": 135.0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 67.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 67.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 67.5,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7046,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-05-25",
              "startTime": "2026-05-25T18:00:00.000Z",
              "endTime": "2026-05-25T18:48:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 90.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 90.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 90.0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 57.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 35.0,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 13,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7045,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-05-28",
              "startTime": "2026-05-28T18:00:00.000Z",
              "endTime": "2026-05-28T18:59:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 112.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 112.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 112.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 102.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7044,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-05-30",
              "startTime": "2026-05-30T18:00:00.000Z",
              "endTime": "2026-05-30T19:00:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 137.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 137.5,
                              "reps": 5,
                              "completed": true
                          },
                          {
                              "weight": 137.5,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 67.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 67.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 67.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7043,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-06-01",
              "startTime": "2026-06-01T18:00:00.000Z",
              "endTime": "2026-06-01T19:06:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 90.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 90.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 90.0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 57.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 35.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 14,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7042,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-06-04",
              "startTime": "2026-06-04T18:00:00.000Z",
              "endTime": "2026-06-04T18:50:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 115.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 115.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 115.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 102.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7041,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-06-06",
              "startTime": "2026-06-06T18:00:00.000Z",
              "endTime": "2026-06-06T19:10:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 137.5,
                              "reps": 3,
                              "completed": true
                          },
                          {
                              "weight": 137.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 137.5,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 67.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 67.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 67.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7040,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-06-08",
              "startTime": "2026-06-08T18:00:00.000Z",
              "endTime": "2026-06-08T19:10:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 90.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 90.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 90.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 57.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 35.0,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7039,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-06-11",
              "startTime": "2026-06-11T18:00:00.000Z",
              "endTime": "2026-06-11T19:02:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 115.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 115.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 115.0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 102.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7038,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-06-13",
              "startTime": "2026-06-13T18:00:00.000Z",
              "endTime": "2026-06-13T18:54:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 137.5,
                              "reps": 5,
                              "completed": true
                          },
                          {
                              "weight": 137.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 137.5,
                              "reps": 5,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 67.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 67.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 67.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7037,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-06-15",
              "startTime": "2026-06-15T18:00:00.000Z",
              "endTime": "2026-06-15T19:09:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 92.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 57.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 35.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 14,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7036,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-06-18",
              "startTime": "2026-06-18T18:00:00.000Z",
              "endTime": "2026-06-18T19:03:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 115.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 115.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 115.0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 102.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7035,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-06-20",
              "startTime": "2026-06-20T18:00:00.000Z",
              "endTime": "2026-06-20T19:02:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 137.5,
                              "reps": 4,
                              "completed": true
                          },
                          {
                              "weight": 137.5,
                              "reps": 4,
                              "completed": true
                          },
                          {
                              "weight": 137.5,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 70.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 70.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 70.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7034,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-06-22",
              "startTime": "2026-06-22T18:00:00.000Z",
              "endTime": "2026-06-22T18:54:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 92.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 57.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 35.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 14,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7033,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-06-25",
              "startTime": "2026-06-25T18:00:00.000Z",
              "endTime": "2026-06-25T19:09:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 115.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 115.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 115.0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 102.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 102.5,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7032,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-06-27",
              "startTime": "2026-06-27T18:00:00.000Z",
              "endTime": "2026-06-27T18:53:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 137.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 137.5,
                              "reps": 5,
                              "completed": true
                          },
                          {
                              "weight": 137.5,
                              "reps": 3,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 70.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 70.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 70.0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7031,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-06-29",
              "startTime": "2026-06-29T18:00:00.000Z",
              "endTime": "2026-06-29T19:09:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 92.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 57.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 35.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 14,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7030,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-07-02",
              "startTime": "2026-07-02T18:00:00.000Z",
              "endTime": "2026-07-02T18:48:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 115.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 115.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 115.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 105.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7029,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-07-04",
              "startTime": "2026-07-04T18:00:00.000Z",
              "endTime": "2026-07-04T19:02:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 137.5,
                              "reps": 3,
                              "completed": true
                          },
                          {
                              "weight": 137.5,
                              "reps": 3,
                              "completed": true
                          },
                          {
                              "weight": 137.5,
                              "reps": 3,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 70.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 70.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 70.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7028,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-07-06",
              "startTime": "2026-07-06T18:00:00.000Z",
              "endTime": "2026-07-06T19:07:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 92.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 57.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 35.0,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 14,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7027,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-07-09",
              "startTime": "2026-07-09T18:00:00.000Z",
              "endTime": "2026-07-09T19:01:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 115.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 115.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 115.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 105.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7026,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-07-11",
              "startTime": "2026-07-11T18:00:00.000Z",
              "endTime": "2026-07-11T19:11:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 140.0,
                              "reps": 5,
                              "completed": true
                          },
                          {
                              "weight": 140.0,
                              "reps": 5,
                              "completed": true
                          },
                          {
                              "weight": 140.0,
                              "reps": 4,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 70.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 70.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 70.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7025,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-07-13",
              "startTime": "2026-07-13T18:00:00.000Z",
              "endTime": "2026-07-13T19:11:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 92.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 57.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 35.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7024,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-07-16",
              "startTime": "2026-07-16T18:00:00.000Z",
              "endTime": "2026-07-16T18:48:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 117.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 117.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 117.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 105.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7023,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-07-18",
              "startTime": "2026-07-18T18:00:00.000Z",
              "endTime": "2026-07-18T19:02:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 140.0,
                              "reps": 4,
                              "completed": true
                          },
                          {
                              "weight": 140.0,
                              "reps": 5,
                              "completed": true
                          },
                          {
                              "weight": 140.0,
                              "reps": 5,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 70.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 70.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 70.0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7022,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-07-20",
              "startTime": "2026-07-20T18:00:00.000Z",
              "endTime": "2026-07-20T18:49:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 92.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 57.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 35.0,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7021,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-07-23",
              "startTime": "2026-07-23T18:00:00.000Z",
              "endTime": "2026-07-23T18:56:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 117.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 117.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 117.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 105.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7020,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-07-25",
              "startTime": "2026-07-25T18:00:00.000Z",
              "endTime": "2026-07-25T18:52:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 140.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 140.0,
                              "reps": 5,
                              "completed": true
                          },
                          {
                              "weight": 140.0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 70.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 70.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 70.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7019,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-07-27",
              "startTime": "2026-07-27T18:00:00.000Z",
              "endTime": "2026-07-27T19:11:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 92.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 92.5,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 57.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 35.0,
                              "reps": 14,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7018,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-07-30",
              "startTime": "2026-07-30T18:00:00.000Z",
              "endTime": "2026-07-30T19:07:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 117.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 117.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 117.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 105.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7017,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-08-01",
              "startTime": "2026-08-01T18:00:00.000Z",
              "endTime": "2026-08-01T19:11:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 140.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 140.0,
                              "reps": 4,
                              "completed": true
                          },
                          {
                              "weight": 140.0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 70.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 70.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 70.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7016,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-08-03",
              "startTime": "2026-08-03T18:00:00.000Z",
              "endTime": "2026-08-03T19:03:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 95.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 57.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 57.5,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 35.0,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 14,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7015,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-08-06",
              "startTime": "2026-08-06T18:00:00.000Z",
              "endTime": "2026-08-06T19:06:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 117.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 117.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 117.5,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 105.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7014,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-08-08",
              "startTime": "2026-08-08T18:00:00.000Z",
              "endTime": "2026-08-08T18:58:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 140.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 140.0,
                              "reps": 3,
                              "completed": true
                          },
                          {
                              "weight": 140.0,
                              "reps": 3,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 70.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 70.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 70.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7013,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-08-10",
              "startTime": "2026-08-10T18:00:00.000Z",
              "endTime": "2026-08-10T19:08:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 95.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 60.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 60.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 60.0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 35.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 14,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7012,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-08-13",
              "startTime": "2026-08-13T18:00:00.000Z",
              "endTime": "2026-08-13T18:54:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 117.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 117.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 117.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 105.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 105.0,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7011,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-08-15",
              "startTime": "2026-08-15T18:00:00.000Z",
              "endTime": "2026-08-15T19:11:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 142.5,
                              "reps": 3,
                              "completed": true
                          },
                          {
                              "weight": 142.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 142.5,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 70.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 70.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 70.0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7010,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-08-17",
              "startTime": "2026-08-17T18:00:00.000Z",
              "endTime": "2026-08-17T18:48:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 95.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 60.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 60.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 60.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 35.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7009,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-08-20",
              "startTime": "2026-08-20T18:00:00.000Z",
              "endTime": "2026-08-20T18:58:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 117.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 117.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 117.5,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 107.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 107.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 107.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7008,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-08-22",
              "startTime": "2026-08-22T18:00:00.000Z",
              "endTime": "2026-08-22T19:10:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 142.5,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 142.5,
                              "reps": 3,
                              "completed": true
                          },
                          {
                              "weight": 142.5,
                              "reps": 3,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 70.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 70.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 70.0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7007,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-08-24",
              "startTime": "2026-08-24T18:00:00.000Z",
              "endTime": "2026-08-24T18:57:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 95.0,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 60.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 60.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 60.0,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 35.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7006,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-08-27",
              "startTime": "2026-08-27T18:00:00.000Z",
              "endTime": "2026-08-27T19:12:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 120.0,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 120.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 120.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 107.5,
                              "reps": 8,
                              "completed": true
                          },
                          {
                              "weight": 107.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 107.5,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7005,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-08-29",
              "startTime": "2026-08-29T18:00:00.000Z",
              "endTime": "2026-08-29T19:08:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 142.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 142.5,
                              "reps": 4,
                              "completed": true
                          },
                          {
                              "weight": 142.5,
                              "reps": 7,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 72.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 72.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 72.5,
                              "reps": 11,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7004,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-08-31",
              "startTime": "2026-08-31T18:00:00.000Z",
              "endTime": "2026-08-31T19:02:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 95.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 60.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 60.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 60.0,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 35.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 13,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7003,
              "programId": 8001,
              "workoutDayName": "Leg Day",
              "date": "2026-09-03",
              "startTime": "2026-09-03T18:00:00.000Z",
              "endTime": "2026-09-03T19:04:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9002,
                      "sets": [
                          {
                              "weight": 120.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 120.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 120.0,
                              "reps": 10,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9008,
                      "sets": [
                          {
                              "weight": 107.5,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 107.5,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 107.5,
                              "reps": 8,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7002,
              "programId": 8001,
              "workoutDayName": "Pull Day",
              "date": "2026-09-05",
              "startTime": "2026-09-05T18:00:00.000Z",
              "endTime": "2026-09-05T19:07:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9003,
                      "sets": [
                          {
                              "weight": 142.5,
                              "reps": 7,
                              "completed": true
                          },
                          {
                              "weight": 142.5,
                              "reps": 4,
                              "completed": true
                          },
                          {
                              "weight": 142.5,
                              "reps": 3,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9005,
                      "sets": [
                          {
                              "weight": 72.5,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 72.5,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 72.5,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9006,
                      "sets": [
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 0,
                              "reps": 6,
                              "completed": true
                          }
                      ]
                  }
              ]
          },
          {
              "id": 7001,
              "programId": 8001,
              "workoutDayName": "Push Day",
              "date": "2026-09-07",
              "startTime": "2026-09-07T18:00:00.000Z",
              "endTime": "2026-09-07T19:03:00.000Z",
              "completed": true,
              "exercises": [
                  {
                      "exerciseId": 9001,
                      "sets": [
                          {
                              "weight": 95.0,
                              "reps": 9,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 10,
                              "completed": true
                          },
                          {
                              "weight": 95.0,
                              "reps": 9,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9004,
                      "sets": [
                          {
                              "weight": 60.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 60.0,
                              "reps": 12,
                              "completed": true
                          },
                          {
                              "weight": 60.0,
                              "reps": 12,
                              "completed": true
                          }
                      ]
                  },
                  {
                      "exerciseId": 9007,
                      "sets": [
                          {
                              "weight": 35.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 11,
                              "completed": true
                          },
                          {
                              "weight": 35.0,
                              "reps": 14,
                              "completed": true
                          }
                      ]
                  }
              ]
          }
      ]
  },
};

// Track lists for MK8 Deluxe and Mario Kart World
// Cup-grouped for the track picker UI.

const MK8DX_TRACKS = {
    'Mushroom Cup': [
        'Mario Kart Stadium', 'Water Park', 'Sweet Sweet Canyon', 'Thwomp Ruins'
    ],
    'Flower Cup': [
        'Mario Circuit', 'Toad Harbor', 'Twisted Mansion', 'Shy Guy Falls'
    ],
    'Star Cup': [
        'Sunshine Airport', 'Dolphin Shoals', 'Electrodrome', 'Mount Wario'
    ],
    'Special Cup': [
        'Cloudtop Cruise', 'Bone-Dry Dunes', 'Bowser\'s Castle', 'Rainbow Road'
    ],
    'Egg Cup': [
        'Yoshi Circuit', 'Excitebike Arena', 'Dragon Driftway', 'Mute City'
    ],
    'Crossing Cup': [
        'Baby Park', 'Cheese Land', 'Wild Woods', 'Animal Crossing'
    ],
    'Shell Cup': [
        'Moo Moo Meadows', 'Mario Circuit (GBA)', 'Cheep Cheep Beach', 'Toad\'s Turnpike'
    ],
    'Banana Cup': [
        'Dry Plain', 'Donut Plains 3', 'Royal Raceway', 'DK Jungle'
    ],
    'Leaf Cup': [
        'Wario Stadium', 'Sherbet Land', 'Music Park', 'Yoshi Valley'
    ],
    'Lightning Cup': [
        'Tick-Tock Clock', 'Piranha Plant Slide', 'Grumble Volcano', 'Rainbow Road (N64)'
    ],
    'Triforce Cup': [
        'Wario\'s Gold Mine', 'Rainbow Road (SNES)', 'Ice Ice Outpost', 'Hyrule Circuit'
    ],
    'Bell Cup': [
        'Neo Bowser City', 'Ribbon Road', 'Super Bell Subway', 'Big Blue'
    ],
    'Golden Dash Cup': [
        'Paris Promenade', 'Toad Circuit', 'Choco Mountain', 'Coconut Mall'
    ],
    'Lucky Cat Cup': [
        'Tokyo Blur', 'Shroom Ridge', 'Sky Garden', 'Ninja Hideaway'
    ],
    'Turnip Cup': [
        'New York Minute', 'Mario Circuit 3', 'Kalimari Desert', 'Waluigi Pinball'
    ],
    'Propeller Cup': [
        'Sydney Sprint', 'Snow Land', 'Mushroom Gorge', 'Sky-High Sundae'
    ],
    'Rock Cup': [
        'London Loop', 'Boo Lake', 'Rock Rock Mountain', 'Maple Treeway'
    ],
    'Moon Cup': [
        'Berlin Byways', 'Peach Gardens', 'Merry Mountain', 'Rainbow Road (3DS)'
    ],
    'Fruit Cup': [
        'Amsterdam Drift', 'Riverside Park', 'DK Summit', 'Yoshi\'s Island'
    ],
    'Boomerang Cup': [
        'Bangkok Rush', 'Mario Circuit (DS)', 'Waluigi Stadium', 'Singapore Speedway'
    ],
    'Feather Cup': [
        'Athens Dash', 'Daisy Cruiser', 'Moonview Highway', 'Koopa Cape'
    ],
    'Cherry Cup': [
        'Los Angeles Laps', 'Koopa Troopa Beach', 'Maple Treeway (Wii)', 'Koopa City'
    ],
    'Acorn Cup': [
        'Vancouver Velocity', 'Rainbow Road (GBA)', 'Boo Lake (GBA)', 'Rome Avanti'
    ],
    'Spiny Cup': [
        'Madrid Drive', 'Rosalina\'s Ice World', 'Bowser Castle 3', 'Rainbow Road (Wii)'
    ]
};

const MKWORLD_TRACKS = {
    'Mushroom Cup': [
        'Mario Bros. Circuit', 'Crown City', 'Whistletop Summit', 'Salty Sea'
    ],
    'Flower Cup': [
        'Starview Peak', 'Boo Cinema', 'Faraway Oasis', 'DK Pass'
    ],
    'Star Cup': [
        'Acorn Heights', 'Koopa Troopa Beach', 'Wario Shipyard', 'Dandelion Depths'
    ],
    'Special Cup': [
        'Dry Bones Burnway', 'Bowser\'s Castle', 'Super Mario Bros. Wonder', 'Rainbow Road'
    ],
    'Shell Cup': [
        'Mario Circuit', 'Toad\'s Factory', 'Koopa Cape', 'Moonview Highway'
    ],
    'Banana Cup': [
        'Daisy Circuit', 'Maple Treeway', 'Grumble Volcano', 'Rainbow Road (Wii)'
    ],
    'Leaf Cup': [
        'DK Summit', 'Wario\'s Gold Mine', 'Coconut Mall', 'Mushroom Gorge'
    ],
    'Lightning Cup': [
        'Toad\'s Turnpike', 'Cheep Cheep Beach', 'Moo Moo Meadows', 'N64 Rainbow Road'
    ]
};

// Flat arrays for search
const MK8DX_TRACKS_FLAT = Object.values(MK8DX_TRACKS).flat();
const MKWORLD_TRACKS_FLAT = Object.values(MKWORLD_TRACKS).flat();

function getTracksForVersion(gameVersion) {
    return gameVersion === 'mkworld' ? MKWORLD_TRACKS : MK8DX_TRACKS;
}

function getTracksFlatForVersion(gameVersion) {
    return gameVersion === 'mkworld' ? MKWORLD_TRACKS_FLAT : MK8DX_TRACKS_FLAT;
}

window.MK8DX_TRACKS = MK8DX_TRACKS;
window.MKWORLD_TRACKS = MKWORLD_TRACKS;
window.MK8DX_TRACKS_FLAT = MK8DX_TRACKS_FLAT;
window.MKWORLD_TRACKS_FLAT = MKWORLD_TRACKS_FLAT;
window.getTracksForVersion = getTracksForVersion;
window.getTracksFlatForVersion = getTracksFlatForVersion;

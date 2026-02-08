"use strict";
/**
 * Known Series Test Data
 * These are series with verified correct information for testing accuracy
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.knownSeries = void 0;
exports.getKnownSeriesByGenre = getKnownSeriesByGenre;
exports.getKnownSeries = getKnownSeries;
exports.knownSeries = [
    // ==========================================================================
    // FANTASY
    // ==========================================================================
    {
        name: "The Stormlight Archive",
        author: "Brandon Sanderson",
        bookCount: 4,
        genre: "fantasy",
        books: [
            { position: 1, title: "The Way of Kings" },
            { position: 2, title: "Words of Radiance" },
            { position: 3, title: "Oathbringer" },
            { position: 4, title: "Rhythm of War" },
        ],
    },
    {
        name: "Mistborn",
        author: "Brandon Sanderson",
        bookCount: 7,
        genre: "fantasy",
        books: [
            { position: 1, title: "The Final Empire" },
            { position: 2, title: "The Well of Ascension" },
            { position: 3, title: "The Hero of Ages" },
            { position: 4, title: "The Alloy of Law" },
            { position: 5, title: "Shadows of Self" },
            { position: 6, title: "The Bands of Mourning" },
            { position: 7, title: "The Lost Metal" },
        ],
    },
    {
        name: "The Kingkiller Chronicle",
        author: "Patrick Rothfuss",
        bookCount: 3,
        genre: "fantasy",
        books: [
            { position: 1, title: "The Name of the Wind" },
            { position: 2, title: "The Wise Man's Fear" },
            { position: 3, title: "The Doors of Stone" }, // Unreleased but part of series
        ],
    },
    {
        name: "The First Law",
        author: "Joe Abercrombie",
        bookCount: 3,
        genre: "fantasy",
        books: [
            { position: 1, title: "The Blade Itself" },
            { position: 2, title: "Before They Are Hanged" },
            { position: 3, title: "Last Argument of Kings" },
        ],
    },
    // ==========================================================================
    // SCIENCE FICTION
    // ==========================================================================
    {
        name: "The Expanse",
        author: "James S.A. Corey",
        bookCount: 9,
        genre: "science-fiction",
        books: [
            { position: 1, title: "Leviathan Wakes" },
            { position: 2, title: "Caliban's War" },
            { position: 3, title: "Abaddon's Gate" },
            { position: 4, title: "Cibola Burn" },
            { position: 5, title: "Nemesis Games" },
            { position: 6, title: "Babylon's Ashes" },
            { position: 7, title: "Persepolis Rising" },
            { position: 8, title: "Tiamat's Wrath" },
            { position: 9, title: "Leviathan Falls" },
        ],
    },
    {
        name: "Red Rising Saga",
        author: "Pierce Brown",
        bookCount: 6,
        genre: "science-fiction",
        books: [
            { position: 1, title: "Red Rising" },
            { position: 2, title: "Golden Son" },
            { position: 3, title: "Morning Star" },
            { position: 4, title: "Iron Gold" },
            { position: 5, title: "Dark Age" },
            { position: 6, title: "Light Bringer" },
        ],
    },
    {
        name: "Bobiverse",
        author: "Dennis E. Taylor",
        bookCount: 5,
        genre: "science-fiction",
        books: [
            { position: 1, title: "We Are Legion (We Are Bob)" },
            { position: 2, title: "For We Are Many" },
            { position: 3, title: "All These Worlds" },
            { position: 4, title: "Heaven's River" },
            { position: 5, title: "Not Till We Are Lost" },
        ],
    },
    // ==========================================================================
    // LITRPG
    // ==========================================================================
    {
        name: "Dungeon Crawler Carl",
        author: "Matt Dinniman",
        bookCount: 6,
        genre: "litrpg",
        books: [
            { position: 1, title: "Dungeon Crawler Carl" },
            { position: 2, title: "Carl's Doomsday Scenario" },
            { position: 3, title: "The Dungeon Anarchist's Cookbook" },
            { position: 4, title: "The Gate of the Feral Gods" },
            { position: 5, title: "The Butcher's Masquerade" },
            { position: 6, title: "The Eye of the Bedlam Bride" },
        ],
    },
    {
        name: "He Who Fights with Monsters",
        author: "Shirtaloon",
        bookCount: 12,
        genre: "litrpg",
        books: [
            { position: 1, title: "He Who Fights with Monsters" },
            { position: 2, title: "He Who Fights with Monsters 2" },
            { position: 3, title: "He Who Fights with Monsters 3" },
            { position: 4, title: "He Who Fights with Monsters 4" },
            { position: 5, title: "He Who Fights with Monsters 5" },
            { position: 6, title: "He Who Fights with Monsters 6" },
            { position: 7, title: "He Who Fights with Monsters 7" },
            { position: 8, title: "He Who Fights with Monsters 8" },
            { position: 9, title: "He Who Fights with Monsters 9" },
            { position: 10, title: "He Who Fights with Monsters 10" },
            { position: 11, title: "He Who Fights with Monsters 11" },
            { position: 12, title: "He Who Fights with Monsters 12" },
        ],
    },
    {
        name: "Defiance of the Fall",
        author: "TheFirstDefier",
        bookCount: 12,
        genre: "litrpg",
        books: [
            { position: 1, title: "Defiance of the Fall" },
            { position: 2, title: "Defiance of the Fall 2" },
            { position: 3, title: "Defiance of the Fall 3" },
            { position: 4, title: "Defiance of the Fall 4" },
            { position: 5, title: "Defiance of the Fall 5" },
            { position: 6, title: "Defiance of the Fall 6" },
            { position: 7, title: "Defiance of the Fall 7" },
            { position: 8, title: "Defiance of the Fall 8" },
            { position: 9, title: "Defiance of the Fall 9" },
            { position: 10, title: "Defiance of the Fall 10" },
            { position: 11, title: "Defiance of the Fall 11" },
            { position: 12, title: "Defiance of the Fall 12" },
        ],
    },
    {
        name: "Cradle",
        author: "Will Wight",
        bookCount: 12,
        genre: "litrpg",
        books: [
            { position: 1, title: "Unsouled" },
            { position: 2, title: "Soulsmith" },
            { position: 3, title: "Blackflame" },
            { position: 4, title: "Skysworn" },
            { position: 5, title: "Ghostwater" },
            { position: 6, title: "Underlord" },
            { position: 7, title: "Uncrowned" },
            { position: 8, title: "Wintersteel" },
            { position: 9, title: "Bloodline" },
            { position: 10, title: "Reaper" },
            { position: 11, title: "Dreadgod" },
            { position: 12, title: "Waybound" },
        ],
    },
    // ==========================================================================
    // POST-APOCALYPTIC
    // ==========================================================================
    {
        name: "The Remaining",
        author: "D.J. Molles",
        bookCount: 9,
        genre: "post-apocalyptic",
        books: [
            { position: 1, title: "The Remaining" },
            { position: 2, title: "The Remaining: Aftermath" },
            { position: 3, title: "The Remaining: Refugees" },
            { position: 4, title: "The Remaining: Fractured" },
            { position: 5, title: "The Remaining: Allegiance" },
            { position: 6, title: "The Remaining: Extinction" },
            { position: 7, title: "The Remaining: Trust" },
            { position: 8, title: "The Remaining: Faith" },
            { position: 9, title: "The Remaining: Embers" },
        ],
    },
    {
        name: "Mountain Man",
        author: "Keith C. Blackmore",
        bookCount: 5,
        genre: "post-apocalyptic",
        books: [
            { position: 1, title: "Mountain Man" },
            { position: 2, title: "Safari" },
            { position: 3, title: "Hellifax" },
            { position: 4, title: "Infinity" },
            { position: 5, title: "Coal" },
        ],
    },
    {
        name: "The Borrowed World",
        author: "Franklin Horton",
        bookCount: 10,
        genre: "post-apocalyptic",
        books: [
            { position: 1, title: "The Borrowed World" },
            { position: 2, title: "Ashes of the Unspeakable" },
            { position: 3, title: "Legion of the Apocalypse" },
            { position: 4, title: "Compound Fracture" },
            { position: 5, title: "Cold Mountain Rising" },
            { position: 6, title: "Warpath" },
            { position: 7, title: "Trial by Fire" },
            { position: 8, title: "Day Zero" },
            { position: 9, title: "Scorched Earth" },
            { position: 10, title: "The Broken Promise" },
        ],
    },
];
/**
 * Get known series by genre
 */
function getKnownSeriesByGenre(genre) {
    return exports.knownSeries.filter(s => s.genre === genre);
}
/**
 * Get a specific known series by name
 */
function getKnownSeries(name) {
    return exports.knownSeries.find(s => s.name.toLowerCase() === name.toLowerCase());
}
//# sourceMappingURL=knownSeries.js.map
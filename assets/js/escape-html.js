// Shared HTML-escape helper. Exposed as window.escapeHtml so non-module
// app scripts (football-h2h, mario-kart) can sanitize user-typed strings
// (player names, team names) before interpolating into innerHTML.
(function () {
    'use strict';

    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/[&<>"']/g, function (ch) {
            switch (ch) {
                case '&': return '&amp;';
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '"': return '&quot;';
                case "'": return '&#39;';
                default: return ch;
            }
        });
    }

    window.escapeHtml = escapeHtml;
})();

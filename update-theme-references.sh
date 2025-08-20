#!/bin/bash

# Update all CSS files to change dark-theme to theme
files=(
    "/home/nikita/projects/shevato/apps/mario-kart/css/mario-kart-overrides.css"
    "/home/nikita/projects/shevato/apps/mario-kart/css/sidebar.css"
    "/home/nikita/projects/shevato/apps/mario-kart/css/stats.css"
    "/home/nikita/projects/shevato/apps/mario-kart/css/forms.css"
    "/home/nikita/projects/shevato/apps/mario-kart/css/charts.css"
    "/home/nikita/projects/shevato/apps/mario-kart/css/control-panel.css"
    "/home/nikita/projects/shevato/apps/mario-kart/css/player-display.css"
    "/home/nikita/projects/shevato/apps/mario-kart/css/players-dropdown-new.css"
    "/home/nikita/projects/shevato/apps/mario-kart/css/race-history.css"
    "/home/nikita/projects/shevato/apps/mario-kart/css/tooltip.css"
    "/home/nikita/projects/shevato/apps/mario-kart/css/visualizations-modern.css"
    "/home/nikita/projects/shevato/apps/football-h2h/css/sidebar.css"
    "/home/nikita/projects/shevato/apps/mario-kart/css/responsive.css"
)

for file in "${files[@]}"; do
    if [ -f "$file" ]; then
        echo "Updating $file"
        # Replace dark-theme with theme in CSS selectors
        sed -i 's/body\.dark-theme/body.theme/g' "$file"
        sed -i 's/\.dark-theme/\.theme/g' "$file"
        # Update comments
        sed -i 's/Dark theme/Theme/g' "$file"
        sed -i 's/dark theme/theme/g' "$file"
    else
        echo "File not found: $file"
    fi
done

# Update JS file
echo "Updating mobileMenu.js"
sed -i "s/'dark-theme'/'theme'/g" "/home/nikita/projects/shevato/apps/mario-kart/js/mobileMenu.js"

echo "Theme update complete!"
#!/bin/bash

# Remove light-theme CSS rules from mario-kart-overrides.css
file="/home/nikita/projects/shevato/apps/mario-kart/css/mario-kart-overrides.css"
temp_file=$(mktemp)

# Remove light-theme rules and their content
awk '
/^\.light-theme|^[[:space:]]*\.light-theme/ {
    # Skip this rule and all content until the closing brace
    brace_count = 0
    found_open = 0
    while ((getline) > 0) {
        if (/\{/) {
            found_open = 1
            brace_count++
        }
        if (/\}/) {
            brace_count--
            if (found_open && brace_count <= 0) {
                break
            }
        }
    }
    next
}
{ print }
' "$file" > "$temp_file" && mv "$temp_file" "$file"

echo "Removed light-theme CSS rules from mario-kart-overrides.css"

# Remove light-theme rules from football-h2h.css
file="/home/nikita/projects/shevato/apps/football-h2h/css/football-h2h.css"
temp_file=$(mktemp)

awk '
/^\.form-label\.light-theme|^\.form-input.*\.light-theme/ {
    # Skip this rule and all content until the closing brace
    brace_count = 0
    found_open = 0
    while ((getline) > 0) {
        if (/\{/) {
            found_open = 1
            brace_count++
        }
        if (/\}/) {
            brace_count--
            if (found_open && brace_count <= 0) {
                break
            }
        }
    }
    next
}
{ print }
' "$file" > "$temp_file" && mv "$temp_file" "$file"

echo "Removed light-theme CSS rules from football-h2h.css"
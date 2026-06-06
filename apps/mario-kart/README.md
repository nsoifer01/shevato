# 🏁 Mario Kart Race Tracker

A comprehensive web application for tracking Mario Kart race results, analyzing performance statistics, and competing for achievements with friends.

## 🎮 Overview

Mario Kart Race Tracker is a feature-rich web application that allows you to:
- Record race results for 1-4 players
- Track detailed statistics and performance metrics
- Compete for achievements and milestones
- Analyze head-to-head matchups
- View trends and patterns over time
- Export/import data for backup and sharing

## 🚀 Features

### Core Functionality
- **Race Recording**: Quick and easy race result entry with multiple input methods
- **Player Management**: Customizable player names and emoji/icons
- **Date Filtering**: View stats for specific time periods
- **Undo/Redo**: Full history support for all actions
- **Data Persistence**: Automatic saving to browser localStorage, with account sync across devices when signed in
- **Export/Import**: JSON file support for data backup and transfer
- **Restore**: One-click recovery from the rolling auto-backup snapshot (taken every 10 minutes)
- **Safe Deletes**: Deleting a race asks for confirmation first; undo/redo still covers every action

### Statistics & Analytics
- **Comprehensive Stats**: Win rates, average positions, streaks, and more
- **Achievement System**: 5 achievement categories with progress tracking; records show the live active streak count alongside the best, e.g. "10 (3)"
- **Head-to-Head Analysis**: Detailed matchup statistics between players, including when each longest win streak ended (or that it is still active)
- **Performance Trends**: Visual charts showing improvement over time
- **Activity Heatmaps**: Calendar view of racing activity and performance
- **Position Analysis**: Heat maps and sweet spot visualizations

### User Interface
- **Theme**: Single cohesive dark theme
- **Responsive Design**: Works on desktop, tablet, and mobile devices
- **Modern UI**: Card-based layouts with smooth animations
- **Multiple Views**: 8 different tabs for various statistics and analyses

## 📱 Browser Compatibility

The tracker works best on modern browsers:
- Chrome (recommended)
- Firefox
- Safari
- Edge

## ⚠️ Important Notes

### Mobile Support
- Fully responsive: desktop table views switch to card layouts on smaller screens
- Charts (Trends, Activity) render at all screen sizes
- Touch targets meet the 40px guideline throughout

### Player System
- Players are tracked by their slot position (Player 1, 2, 3, 4)
- Changing a player's name doesn't affect their historical data
- Statistics are tied to the player slot, not the name
- This design choice simplifies data management but may be improved in future versions

### Data Storage
- All data is stored locally in your browser's localStorage
- Data persists between sessions on the same device/browser
- Clearing browser data will delete all local race history
- Sign in to sync your data to your account across devices
- A rolling auto-backup snapshot is taken every 10 minutes (recoverable via Restore)
- Regular backups via Export are still recommended

### Optimal Configuration
- **Players**: Supports 1-4 players; layouts verified at all player counts
- **Browser**: Chrome or Firefox on desktop for best experience

## 🛠️ Technical Details

### Technologies Used
- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **Charts**: Chart.js for data visualization
- **Icons**: Font Awesome for UI icons
- **Storage**: Browser localStorage, synced to the account when signed in (Firebase sync system)
- **Backup**: Rolling auto-backup snapshot in localStorage every 10 minutes, plus JSON export/import

### File Structure
```
mario-kart/
├── index.html            # Main application file
├── css/                  # All styling files
│   ├── base.css         # Base styles and resets
│   ├── theme.css        # Theme variables and dark/alternative theme
│   ├── charts.css       # Chart and visualization styles
│   └── ...              # Other component-specific styles
├── js/                   # JavaScript modules
│   ├── main.js          # Main application logic
│   ├── dataManager.js   # Data handling and storage
│   ├── statistics.js    # Statistics calculations
│   └── ...              # Other feature modules
└── README.md            # This file
```

## 🚀 Getting Started

1. **Access the Tracker**: Navigate to `https://www.shevato.com/apps/mario-kart/`
2. **Set Up Players**: Open the sidebar and use "Manage Players" to configure player names and icons
3. **Record a Race**: Enter finishing positions and click "Add Race"
4. **View Statistics**: Explore different tabs to see various analyses
5. **Backup Your Data**: Use the Export button regularly to save your data

## 💡 Tips & Tricks

- Use the Quick Add widget (🏁+) for faster race entry
- Click on achievements to see detailed progress
- Use date filters to analyze specific time periods
- Export your data regularly as backup
- Try different player icons for better visual distinction
- Use keyboard shortcuts for faster navigation

## 🔮 Future Improvements

Planned enhancements include:
- Player profiles independent of slot positions
- More achievement categories
- Additional chart types
- Custom race configurations
- Tournament mode

## 🤝 Feedback

This is a personal project created to track Mario Kart races with friends. Feedback and suggestions are welcome! The tracker will continue to evolve based on usage patterns and user input.

## 📄 License

This project is for personal use. Feel free to use it for tracking your own Mario Kart races!

---

*Happy Racing! 🏎️*

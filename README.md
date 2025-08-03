# Shevato - Interactive Web Platform

## Overview

Shevato is a modern, responsive web platform built with vanilla JavaScript, HTML5, and CSS3. The project features a modular architecture with reusable components, responsive design, and multiple interactive applications including games and utilities.

## Recent Updates

- **Directory Reorganization**: `includes/` folder renamed to `partials/` for clarity
- **New Tic-Tac-Toe Game**: Modularized game moved to its own directory under `/extras/tic-tac-toe/`
- **Extras Landing Page**: Redesigned as a hub for all interactive applications
- **Consistent Navigation**: All navigation links now use proper `.html` extensions
- **JavaScript Consolidation**: Root-level JS files moved to `assets/js/`

## Directory Structure

```
shevato/
│
├── assets/                    # Static assets and resources
│   ├── css/                  # Stylesheets
│   │   ├── extras.css        # Extras page styles (minimal)
│   │   ├── font-awesome.min.css  # Icon library
│   │   ├── main.css          # Primary stylesheet with dark background
│   │   └── styles.css        # Component styles
│   │
│   ├── fonts/                # Web fonts
│   │   └── fontawesome-*     # FontAwesome font files
│   │
│   ├── js/                   # JavaScript files
│   │   ├── breakpoints.min.js    # Responsive breakpoint handler
│   │   ├── browser.min.js        # Browser detection utilities
│   │   ├── fetch_historical_data.js  # Data fetching utilities
│   │   ├── fpl_predictor.js      # FPL prediction module
│   │   ├── jquery.min.js         # jQuery library
│   │   ├── main.js               # Main application logic (includes partials loader)
│   │   ├── scripts.js            # Utility scripts
│   │   └── util.js               # Helper functions
│   │
│   └── sass/                 # SASS source files
│       ├── base/             # Base styles
│       ├── components/       # Component styles
│       ├── layout/           # Layout styles
│       ├── libs/             # SASS libraries
│       └── main.scss         # Main SASS file
│
├── extras/                   # Interactive applications and games
│   ├── mario-kart/          # Mario Kart race tracker (standalone app)
│   │   ├── css/             # 19 tracker-specific stylesheets
│   │   ├── js/              # 28 JavaScript modules
│   │   ├── tracker.html     # Main tracker interface
│   │   └── README.md        # Tracker documentation
│   │
│   └── tic-tac-toe/         # Tic-Tac-Toe game
│       ├── css/
│       │   └── tic-tac-toe.css  # Game-specific styles
│       ├── js/
│       │   └── tic-tac-toe.js   # AI-powered game logic
│       └── index.html            # Game interface
│
├── images/                   # Image assets
│   ├── bg.jpg               # Dark background image (site-wide)
│   ├── background.png       # Alternative background
│   ├── logo*.svg/png        # Various logo formats
│   ├── player.png/webp      # Game assets
│   └── moadon-alef*         # Moadon Alef branding
│
├── partials/                # Reusable HTML components
│   ├── header.html          # Site header with navigation
│   └── footer.html          # Site footer with contact info
│
├── index.html               # Redirects to home.html
├── home.html                # Main landing page
├── extras.html              # Games and extras hub (uses highlights layout)
├── product.html             # Product showcase
├── moadon-alef.html         # Medical services page (separate branding)
├── towerbound.html          # Icy Tower game (standalone)
└── historical_data.json     # Data storage file
```

## Key Features

- **Responsive Design**: Mobile-first approach with breakpoint handling
- **Dark Theme**: Consistent dark background (`bg.jpg`) across all main pages
- **Modular Architecture**: Clear separation between main site and extras
- **Dynamic Content Loading**: Partials system for headers/footers
- **Interactive Games**: 
  - Tic-Tac-Toe with AI opponent
  - Mario Kart race tracker with extensive features
  - Towerbound (Icy Tower clone)
- **Multi-language Support**: Moadon Alef page supports English, Russian, and Hebrew

## Navigation Structure

- **Main Site**: Home → Product → Extras
- **Extras Hub**: Lists all available games and applications
- **Standalone Apps**: Mario Kart tracker and Towerbound maintain their own UI

## Technical Details

### Partials System
The site uses jQuery to dynamically load header and footer components:
```javascript
var includes = $('[data-include]');
jQuery.each(includes, function(){
  var file = 'partials/' + $(this).data('include') + '.html';
  $(this).load(file);
});
```

### Background Implementation
Dark background applied via CSS pseudo-element:
```css
body:before {
  background-image: url(../../images/bg.jpg);
  background-attachment: fixed;
  /* ... */
}
```

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/shevato.git
   cd shevato
   ```

2. No build process required - this is a static site. Simply open `index.html` in a web browser or serve the directory with any static file server.

3. For development with SASS:
   ```bash
   # Install SASS if not already installed
   npm install -g sass
   
   # Watch for SASS changes
   sass --watch assets/sass/main.scss:assets/css/main.css
   ```

## Usage

### Local Development

Using Python's built-in server:
```bash
python -m http.server 8000
# Visit http://localhost:8000
```

Using Node.js http-server:
```bash
npx http-server
# Visit http://localhost:8080
```

### Deployment

The project can be deployed to any static hosting service:
- GitHub Pages
- Netlify
- Vercel
- AWS S3
- Traditional web hosting

Simply upload all files maintaining the directory structure.

## Browser Support

- Chrome/Edge (latest)
- Firefox (latest)
- Safari (latest)
- Mobile browsers (iOS Safari, Chrome Mobile)

## Technologies Used

- **HTML5**: Semantic markup
- **CSS3/SASS**: Modern styling with preprocessing
- **JavaScript**: Vanilla JS with jQuery for DOM manipulation
- **FontAwesome**: Icon library (v6.4.0 and v4.7.0)
- **Chart.js**: Used in Mario Kart tracker
- **Google Analytics**: Site tracking (UA-140119780-1)

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

This project is proprietary. All rights reserved.

## Contact

For questions or support, please contact:
- Email: nikita@shevato.com
- Phone: +1 (504) 638-3370
- LinkedIn: [nikitasoifer](https://www.linkedin.com/in/nikitasoifer/)
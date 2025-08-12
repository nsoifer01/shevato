(function($) {
	
	// TEST NETLIFY ENV VARIABLES - REMOVE AFTER TESTING
	console.log('=== NETLIFY ENV TEST ===');
	console.log('1. process.env:', typeof process !== 'undefined' ? process.env : 'process not defined');
	console.log('2. window.env:', window.env || 'window.env not defined');
	console.log('3. Checking common Netlify patterns...');
	console.log('   - window.NETLIFY_ENV:', window.NETLIFY_ENV || 'not found');
	console.log('   - window._env_:', window._env_ || 'not found');
	console.log('=== END ENV TEST ===');

	var	$window = $(window),
		$banner = $('#banner'),
		$body = $('body');

	// Breakpoints.
		breakpoints({
			default:   ['1681px',   null       ],
			xlarge:    ['1281px',   '1680px'   ],
			large:     ['981px',    '1280px'   ],
			medium:    ['737px',    '980px'    ],
			small:     ['481px',    '736px'    ],
			xsmall:    ['361px',    '480px'    ],
			xxsmall:   [null,       '360px'    ]
		});

	// Play initial animations on page load.
		$window.on('load', function() {
			window.setTimeout(function() {
				$body.removeClass('is-preload');
			}, 100);
		});

	// Function to initialize menu
	function initializeMenu() {
		$('#menu')
			.append('<a href="#menu" class="close"></a>')
			.appendTo($body)
			.panel({
				target: $body,
				visibleClass: 'is-menu-visible',
				delay: 500,
				hideOnClick: true,
				hideOnSwipe: true,
				resetScroll: true,
				resetForms: true,
				side: 'right'
			});
	}

  var includes = $('[data-include]');
  var includesLoaded = 0;
  var totalIncludes = includes.length;
  
  jQuery.each(includes, function(){
    var includeFile = $(this).data('include') + '.html';
    var basePath = window.location.pathname.includes('/apps/') ? '../../partials/' : 'partials/';
    var file = basePath + includeFile;
    var $element = $(this);
    
    $element.load(file, function() {
      includesLoaded++;
      // Initialize menu after header is loaded
      if (includeFile === 'header.html' && $('#menu').length > 0) {
        initializeMenu();
      }
    });
  });

})(jQuery);

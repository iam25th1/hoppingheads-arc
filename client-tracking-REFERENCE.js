/**
 * CLIENT-SIDE TRACKING -- Add to client/index.html
 * =================================================
 * 
 * 1. Add the track() function in a <script> tag near the top
 * 2. Sprinkle track() calls at the game lifecycle points listed below
 * 
 * The track() function is fire-and-forget (doesn't block gameplay).
 * Uses navigator.sendBeacon as primary (survives tab close), 
 * falls back to fetch.
 */

// ── ADD THIS NEAR THE TOP OF YOUR <script> SECTION ──────────────────────────

function track(eventName, data) {
  var payload = JSON.stringify({
    event_name: eventName,
    data: data || undefined
  });

  // sendBeacon survives page unload -- ideal for tracking
  if (navigator.sendBeacon) {
    navigator.sendBeacon('/track', new Blob([payload], { type: 'application/json' }));
  } else {
    fetch('/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true
    }).catch(function() {});  // silent fail -- never block gameplay
  }
}


// ── WHERE TO ADD track() CALLS ──────────────────────────────────────────────
//
// Below are the exact spots in your existing game code. Find each location
// and add the track() call. Don't remove any existing code.
//
//
// 1. PAGE VIEW -- at the end of DOMContentLoaded or the initial script load
//    -----------------------------------------------------------------------
track('page_view');


// 2. COIN INSERT -- inside powerOn() after the coin animation starts
//    ----------------------------------------------------------------
// Find: function powerOn() { ...
// Add after the coin animation/sound:
track('coin_insert');


// 3. QUICKMATCH JOIN -- inside the socket.on('joined') handler
//    ----------------------------------------------------------
// Find: socket.on('joined', ...
// Add inside the handler:
track('quickmatch_join', {
  map: currentMapIndex,
  playerCount: Object.keys(lobby || {}).length || 1
});


// 4. GAME START -- where the countdown ends and gameplay begins
//    -----------------------------------------------------------
// Find: where gamePhase changes to 'playing' or 'active'
// Add right after:
track('game_start', {
  map: currentMapIndex,
  mapName: MAP_NAMES ? MAP_NAMES[currentMapIndex] : currentMapIndex
});


// 5. FRAGMENT COLLECTED -- inside the fragment collection handler
//    -------------------------------------------------------------
// Find: where fragments[] gets incremented or the frag:collected emit
// Add after the collection logic:
track('fragment_collected', {
  rarity: rarity,
  map: currentMapIndex
});
// NOTE: This fires a lot. The server rate limiter (120/min) handles abuse.
// If you want to reduce noise, you can debounce or only track every 3rd:
//   if (totalFrags % 3 === 0) track('fragment_collected', { rarity, map: currentMapIndex });


// 6. ROUND END -- inside the round end / game over handler
//    -------------------------------------------------------
// Find: socket.on('round:end') or where the scoreboard displays
// Add inside:
track('round_end', {
  map: currentMapIndex,
  score: myScore,
  fragments: myFragCount,
  minted: myMintCount,
  placement: myPlacement,
  duration: Math.round((Date.now() - roundStartTime) / 1000)
});


// 7. MENU INTERACTIONS -- inside menu button handlers
//    --------------------------------------------------
// Leaderboard button:
track('leaderboard_view');

// Skin change:
track('skin_change', { skin: selectedSkin });

// Settings change:
track('settings_change', { setting: settingName, value: newValue });


// 8. MAP LOAD -- when a map finishes generating/loading
//    ----------------------------------------------------
// Find: where the map generation completes
track('map_load', { map: currentMapIndex });


// 9. ERROR TRACKING -- catch unexpected errors
//    --------------------------------------------
window.addEventListener('error', function(e) {
  track('error', {
    message: (e.message || '').substring(0, 200),
    source: (e.filename || '').split('/').pop()
  });
});


// 10. PAGE UNLOAD -- track when players leave
//     -----------------------------------------
window.addEventListener('beforeunload', function() {
  track('page_unload', {
    timeOnPage: Math.round((Date.now() - pageLoadTime) / 1000),
    map: currentMapIndex || null
  });
});
// NOTE: Add `var pageLoadTime = Date.now();` near the top of your script.


/**
 * VARIABLES REFERENCED ABOVE
 * ==========================
 * These should already exist in your game code:
 * - currentMapIndex  (number: 0-3)
 * - MAP_NAMES        (array or object mapping index to name)
 * - myScore          (number: player's final score)
 * - myFragCount      (number: fragments collected)
 * - myMintCount      (number: mints completed)
 * - myPlacement      (number: 1st, 2nd, 3rd, etc.)
 * - roundStartTime   (Date.now() captured when round starts)
 * - pageLoadTime     (Date.now() captured on page load -- add this)
 *
 * If a variable name differs in your code, just swap it.
 * The track() function silently handles undefined values.
 */

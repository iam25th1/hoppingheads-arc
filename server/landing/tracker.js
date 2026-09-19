// Hopping Heads tracker - tiny client-side analytics
(function(){
  var API = 'https://hoppingheads.fun/api/track';
  var SID_KEY = 'hh_sid';
  var sid = localStorage.getItem(SID_KEY);
  if (!sid) {
    sid = Date.now().toString(36) + Math.random().toString(36).slice(2,10);
    try { localStorage.setItem(SID_KEY, sid); } catch(e) {}
  }

  function getDevice() {
    var w = window.innerWidth || 0;
    if (w < 600) return 'mobile';
    if (w < 1024) return 'tablet';
    return 'desktop';
  }

  window.hhTrack = function(event, props) {
    try {
      var body = {
        event: event,
        sessionId: sid,
        session: localStorage.getItem('hh_session') || null,
        props: props || {},
        referrer: document.referrer || null,
        device: getDevice()
      };
      // Fire and forget - use sendBeacon if available for reliability
      if (navigator.sendBeacon) {
        var blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
        navigator.sendBeacon(API, blob);
      } else {
        fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          keepalive: true
        }).catch(function(){});
      }
    } catch(e) {}
  };

  // Auto-fire pageview
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function(){ window.hhTrack('page_view'); });
  } else {
    window.hhTrack('page_view');
  }
})();
